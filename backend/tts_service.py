"""Multi-voice text-to-speech for Rivet's NotebookLM & Podcast studio.

Two engines sit behind one registry:

* ``kokoro-onnx`` - fully offline 82M ONNX model in ``backend/models/``.
* ``edge-tts``    - Microsoft Edge neural voices, streamed over the network.

Every clip is cached under ``audio_cache/`` keyed by a SHA-256 hash of
(voice, language, rate, text), so identical requests return the existing file
instantly. ``warmup()`` loads the ONNX session once at startup and runs a
single-word inference, which removes the cold start from the first Play click.
"""

from __future__ import annotations

import asyncio
import functools
import hashlib
import importlib.util
import logging
import os
import threading
import time
import uuid
import wave
from pathlib import Path

import numpy as np

BASE_DIR = Path(__file__).resolve().parent
MODELS_DIR = BASE_DIR / "models"
CACHE_DIR = BASE_DIR / "audio_cache"
KOKORO_MODEL = MODELS_DIR / "kokoro-v1.0.onnx"
KOKORO_VOICES = MODELS_DIR / "voices-v1.0.bin"

# Bounded fan-out when a whole dialogue has to be voiced.
MAX_CONCURRENT_SYNTH = 3
# Kokoro and Edge both synthesize at 24 kHz, so the joined episode stays native.
TARGET_RATE = 24_000
LINE_GAP_SECONDS = 0.18
MIN_SPEED, MAX_SPEED = 0.5, 2.0

# Kokoro wants an espeak language per voice family, not a single global one.
KOKORO_LANG_BY_PREFIX = (
    ("hf_", "hi"),
    ("hm_", "hi"),
    ("bf_", "en-gb"),
    ("bm_", "en-gb"),
    ("af_", "en-us"),
    ("am_", "en-us"),
)

logger = logging.getLogger("rivet.tts")

KOKORO_GROUP = "Offline Kokoro"
EDGE_GROUP = "Online Edge Neural"
KOKORO_PRESETS = ("af_heart", "af_bella", "am_fenrir", "am_michael", "bf_emma", "bm_fable", "hf_alpha", "hm_omega")
EDGE_PRESETS = ("en-US-AndrewNeural", "en-US-AvaNeural", "en-GB-SoniaNeural", "en-IN-NeerjaNeural")
DEFAULT_PAIR = ("af_heart", "am_fenrir")

PREVIEW_SENTENCE = "Hi, I'm {label}. This is how I sound in Rivet's podcast studio."
WARMUP_WORD = "Hi"
# A dialogue-length pass settles the dynamic shapes the first real turn will use.
WARMUP_SENTENCE = "Welcome back to the brief - today the numbers stay provisional, and that gap is the point."


def _voice(voice_id, label, engine, group, language, gender, description, lang="en-us"):
    return {
        "voice_id": voice_id,
        "label": label,
        "engine": engine,
        "group": group,
        "language": language,
        "gender": gender,
        "description": description,
        "lang": lang,
    }


VOICE_CATALOG: dict[str, dict] = {
    # ---- Offline Kokoro (models/kokoro-v1.0.onnx + models/voices-v1.0.bin) ----
    "af_heart": _voice(
        "af_heart", "Heart", "kokoro", KOKORO_GROUP, "en-US", "female",
        "Warm, balanced American female - the safest default narrator.",
    ),
    "af_bella": _voice(
        "af_bella", "Bella", "kokoro", KOKORO_GROUP, "en-US", "female",
        "Bright, expressive American female with a little more energy.",
    ),
    "am_fenrir": _voice(
        "am_fenrir", "Fenrir", "kokoro", KOKORO_GROUP, "en-US", "male",
        "Deep, assertive American male - good counterweight to a soft co-host.",
    ),
    "am_michael": _voice(
        "am_michael", "Michael", "kokoro", KOKORO_GROUP, "en-US", "male",
        "Steady, conversational American male for explainer segments.",
    ),
    "bf_emma": _voice(
        "bf_emma", "Emma", "kokoro", KOKORO_GROUP, "en-GB", "female",
        "Clear, composed British female.",
        lang="en-gb",
    ),
    "bm_fable": _voice(
        "bm_fable", "Fable", "kokoro", KOKORO_GROUP, "en-GB", "male",
        "Gravelly British male with a storytelling cadence.",
        lang="en-gb",
    ),
    "hf_alpha": _voice(
        "hf_alpha", "Alpha", "kokoro", KOKORO_GROUP, "hi-IN", "female",
        "Light Hindi female voice.",
        lang="hi",
    ),
    "hm_omega": _voice(
        "hm_omega", "Omega", "kokoro", KOKORO_GROUP, "hi-IN", "male",
        "Resonant Hindi male voice.",
        lang="hi",
    ),
    # ---- Online Edge neural voices ----
    "en-US-AndrewNeural": _voice(
        "en-US-AndrewNeural", "Andrew", "edge", EDGE_GROUP, "en-US", "male",
        "Confident American male newsreader.",
    ),
    "en-US-AvaNeural": _voice(
        "en-US-AvaNeural", "Ava", "edge", EDGE_GROUP, "en-US", "female",
        "Friendly American female with crisp diction.",
    ),
    "en-GB-SoniaNeural": _voice(
        "en-GB-SoniaNeural", "Sonia", "edge", EDGE_GROUP, "en-GB", "female",
        "Polished British female.",
    ),
    "en-IN-NeerjaNeural": _voice(
        "en-IN-NeerjaNeural", "Neerja", "edge", EDGE_GROUP, "en-IN", "female",
        "Warm Indian English female.",
    ),
}


class TTSError(RuntimeError):
    """Synthesis failed for a reason the caller can report."""


class UnknownVoice(TTSError):
    """The requested voice_id is not in the catalog."""


class VoiceUnavailable(TTSError):
    """The voice exists but its engine cannot run on this machine."""


# --------------------------------------------------------------------------- #
# Engine availability
# --------------------------------------------------------------------------- #


@functools.lru_cache(maxsize=None)
def _installed(module: str) -> bool:
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):
        return False


def kokoro_files_present() -> bool:
    return KOKORO_MODEL.is_file() and KOKORO_VOICES.is_file()


def kokoro_available() -> bool:
    """Offline voices only work when the model files are on this machine."""
    return kokoro_files_present() and _installed("kokoro_onnx")


def edge_available() -> bool:
    return _installed("edge_tts")


def get_voice(voice_id) -> dict:
    entry = VOICE_CATALOG.get(str(voice_id or "").strip())
    if entry is None:
        raise UnknownVoice(f"Unknown voice '{voice_id}'.")
    return entry


def _ensure_engine(entry: dict) -> None:
    engine = entry["engine"]
    if engine == "kokoro" and not kokoro_available():
        raise VoiceUnavailable(
            "Kokoro is not available here - models/kokoro-v1.0.onnx and "
            "models/voices-v1.0.bin must exist and kokoro-onnx must be installed."
        )
    if engine == "edge" and not edge_available():
        raise VoiceUnavailable("edge-tts is not installed in the backend environment.")


def list_voices() -> list[dict]:
    """Catalog entries whose engine can actually run right now."""
    voices = []
    for entry in VOICE_CATALOG.values():
        if entry["engine"] == "kokoro" and not kokoro_available():
            continue
        if entry["engine"] == "edge" and not edge_available():
            continue
        voices.append(
            {
                "voice_id": entry["voice_id"],
                "label": entry["label"],
                "engine": entry["engine"],
                "group": entry["group"],
                "language": entry["language"],
                "gender": entry["gender"],
                "description": entry["description"],
            }
        )
    return voices


def default_voices() -> dict[str, str]:
    """A sensible Host A / Host B pair drawn from whatever is installed."""
    available = [entry["voice_id"] for entry in list_voices()]
    if not available:
        return {"host_a": DEFAULT_PAIR[0], "host_b": DEFAULT_PAIR[1]}
    host_a = next((voice for voice in DEFAULT_PAIR if voice in available), available[0])
    host_b = next(
        (voice for voice in DEFAULT_PAIR if voice in available and voice != host_a),
        next((voice for voice in available if voice != host_a), host_a),
    )
    return {"host_a": host_a, "host_b": host_b}


def resolve_voices(host_a_voice: str | None, host_b_voice: str | None) -> tuple[str, str]:
    """Keep requested voices when they are usable, otherwise fall back."""
    if not list_voices():
        raise VoiceUnavailable("No TTS engine is available on this machine.")
    available = {entry["voice_id"] for entry in list_voices()}
    defaults = default_voices()
    host_a = host_a_voice if host_a_voice in available else defaults["host_a"]
    host_b = host_b_voice if host_b_voice in available else defaults["host_b"]
    return host_a, host_b


def media_type_for(path) -> str:
    return "audio/wav" if Path(path).suffix.lower() == ".wav" else "audio/mpeg"


# --------------------------------------------------------------------------- #
# Kokoro (lazy singleton, CPU bound so it runs off the event loop)
# --------------------------------------------------------------------------- #

_kokoro = None
_kokoro_load_lock = threading.Lock()
_kokoro_run_lock = threading.Lock()


def _load_kokoro():
    global _kokoro
    if _kokoro is not None:
        return _kokoro
    with _kokoro_load_lock:
        if _kokoro is None:
            from kokoro_onnx import Kokoro

            _kokoro = Kokoro(str(KOKORO_MODEL), str(KOKORO_VOICES))
    return _kokoro


def _clamp_speed(speed) -> float:
    try:
        value = float(speed)
    except (TypeError, ValueError):
        return 1.0
    return min(MAX_SPEED, max(MIN_SPEED, value))


def kokoro_lang(voice_id: str) -> str:
    """Derive the espeak language from the voice prefix.

    hf_/hm_ are Hindi, bf_/bm_ British English, af_/am_ American English, so
    every Kokoro voice gets the language it was actually trained on.
    """
    key = str(voice_id or "").strip()
    lowered = key.lower()
    for prefix, lang in KOKORO_LANG_BY_PREFIX:
        if lowered.startswith(prefix):
            return lang
    entry = VOICE_CATALOG.get(key)
    if entry and entry.get("lang"):
        return entry["lang"]
    return "en-us"


def lang_tag(voice_id: str) -> str:
    """Language component of the cache key."""
    entry = VOICE_CATALOG.get(str(voice_id or "").strip())
    if entry is None:
        return "unknown"
    if entry["engine"] == "kokoro":
        return kokoro_lang(entry["voice_id"])
    return (entry.get("language") or "en-us").lower()


def rate_tag(voice_id: str, speed: float) -> str:
    """The rate value the engine actually receives, reused by the cache key."""
    entry = VOICE_CATALOG.get(str(voice_id or "").strip())
    clamped = _clamp_speed(speed)
    if entry and entry["engine"] == "edge":
        return f"{round((clamped - 1.0) * 100):+d}%"
    return f"{clamped:.3f}x"


# --------------------------------------------------------------------------- #
# Startup warmup
# --------------------------------------------------------------------------- #

_warm_state = {"done": False, "seconds": 0.0}
_warmup_lock = asyncio.Lock()


def _warm_kokoro() -> None:
    """Load the singleton and force inference so ORT, espeak and shapes are hot."""
    kokoro = _load_kokoro()
    lang = kokoro_lang(DEFAULT_PAIR[0])
    with _kokoro_run_lock:
        kokoro.create(WARMUP_WORD, voice=DEFAULT_PAIR[0], speed=1.0, lang=lang)
        kokoro.create(WARMUP_SENTENCE, voice=DEFAULT_PAIR[0], speed=1.0, lang=lang)


async def warmup() -> bool:
    """Initialize Kokoro once, off the event loop, then warm it with speech.

    Safe to call from several places; only the first call does the work.
    """
    if not kokoro_available():
        return False
    async with _warmup_lock:
        if _warm_state["done"]:
            return True
        started = time.perf_counter()
        try:
            await asyncio.to_thread(_warm_kokoro)
        except Exception as exc:
            logger.warning("Kokoro warmup failed: %s", exc)
            return False
        _warm_state["done"] = True
        _warm_state["seconds"] = time.perf_counter() - started
        logger.info("Kokoro session warm in %.2fs", _warm_state["seconds"])
        return True


def warmup_status() -> dict:
    return {"ready": _warm_state["done"], "seconds": round(_warm_state["seconds"], 3)}


# --------------------------------------------------------------------------- #
# Cache + synthesis
# --------------------------------------------------------------------------- #


def cache_path(text: str, voice_id: str, speed: float = 1.0) -> Path:
    """SHA-256 of (voice_id, lang, rate, text); extension follows the engine."""
    entry = VOICE_CATALOG.get(str(voice_id or "").strip())
    suffix = ".mp3" if entry and entry["engine"] == "edge" else ".wav"
    key = f"{voice_id}|{lang_tag(voice_id)}|{rate_tag(voice_id, speed)}|{text}"
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
    return CACHE_DIR / f"tts-{digest}{suffix}"


def _temp_path(final: Path) -> Path:
    return CACHE_DIR / f".{final.stem}.{uuid.uuid4().hex[:8]}.part{final.suffix}"


def _cached(path: Path) -> bool:
    return path.is_file() and path.stat().st_size > 0


def _write_wav(path: Path, samples, sample_rate: int) -> None:
    pcm = np.clip(np.asarray(samples, dtype="float32"), -1.0, 1.0)
    pcm = (pcm * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(int(sample_rate))
        handle.writeframes(pcm.tobytes())


async def _render_kokoro(text: str, entry: dict, speed: float, destination: Path) -> None:
    def worker():
        kokoro = _load_kokoro()
        with _kokoro_run_lock:  # the phonemizer is not documented as thread safe
            samples, sample_rate = kokoro.create(
                text,
                voice=entry["voice_id"],
                speed=speed,
                lang=kokoro_lang(entry["voice_id"]),
            )
        _write_wav(destination, samples, sample_rate)

    await asyncio.to_thread(worker)


async def _render_edge(text: str, entry: dict, speed: float, destination: Path) -> None:
    import edge_tts

    rate = rate_tag(entry["voice_id"], speed)
    await edge_tts.Communicate(text, entry["voice_id"], rate=rate).save(str(destination))
    if not _cached(destination):
        raise TTSError(f"{entry['label']} returned no audio.")


async def synthesize(text: str, voice_id: str, speed: float = 1.0) -> Path:
    """Return a cached clip path, synthesizing it only when missing."""
    entry = get_voice(voice_id)
    clean = " ".join(str(text or "").split())
    if not clean:
        raise TTSError("Cannot synthesize empty text.")
    speed = _clamp_speed(speed)

    path = cache_path(clean, voice_id, speed)
    if _cached(path):
        return path

    _ensure_engine(entry)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    temporary = _temp_path(path)
    try:
        if entry["engine"] == "kokoro":
            await _render_kokoro(clean, entry, speed, temporary)
        else:
            await _render_edge(clean, entry, speed, temporary)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    return path


def preview_text(voice_id: str) -> str:
    return PREVIEW_SENTENCE.format(label=get_voice(voice_id)["label"])


async def synthesize_preview(voice_id: str, text: str = "") -> Path:
    """One short sentence in the selected voice, cached like any other clip."""
    get_voice(voice_id)  # validate before touching the engines
    sample = " ".join(str(text or "").split())[:280] or preview_text(voice_id)
    return await synthesize(sample, voice_id, 1.0)


# --------------------------------------------------------------------------- #
# Dialogue rendering
# --------------------------------------------------------------------------- #


def _resample(samples: np.ndarray, source_rate: int, target_rate: int) -> np.ndarray:
    if source_rate == target_rate or samples.size == 0:
        return samples.astype("float32", copy=False)
    length = max(1, int(round(samples.size * target_rate / float(source_rate))))
    old_axis = np.linspace(0.0, 1.0, num=samples.size, endpoint=False)
    new_axis = np.linspace(0.0, 1.0, num=length, endpoint=False)
    return np.interp(new_axis, old_axis, samples).astype("float32")


def _combine(clips: list[Path], destination: Path) -> None:
    try:
        import soundfile as sf
    except ImportError as exc:  # pragma: no cover - requirements pin soundfile
        raise TTSError("soundfile is required to join the podcast clips.") from exc

    gap = np.zeros(int(TARGET_RATE * LINE_GAP_SECONDS), dtype="float32")
    with sf.SoundFile(str(destination), "w", samplerate=TARGET_RATE, channels=1, subtype="PCM_16") as out:
        for clip in clips:
            data, rate = sf.read(str(clip), dtype="float32", always_2d=True)
            mono = data.mean(axis=1) if data.shape[1] > 1 else data[:, 0]
            out.write(_resample(mono, rate, TARGET_RATE))
            out.write(gap)


async def render_dialogue(
    lines: list[dict],
    host_a_voice: str | None = None,
    host_b_voice: str | None = None,
    speed: float = 1.0,
) -> Path:
    """Voice every turn with at most MAX_CONCURRENT_SYNTH jobs in flight.

    Clips may come from different engines (Kokoro WAV + Edge MP3); they are
    decoded, resampled to 24 kHz and joined into one cached episode WAV.
    """
    host_a, host_b = resolve_voices(host_a_voice, host_b_voice)
    speed = _clamp_speed(speed)

    turns: list[tuple[str, str]] = []
    for line in lines or []:
        text = " ".join(str(line.get("text") or "").split())
        if not text:
            continue
        speaker = str(line.get("speaker") or "Host A").strip().lower()
        turns.append((text, host_b if speaker.endswith("b") else host_a))
    if not turns:
        raise TTSError("No dialogue to synthesize.")

    signature = "\n".join(f"{voice}|{text}" for text, voice in turns) + f"|{speed:.2f}"
    digest = hashlib.sha256(signature.encode("utf-8")).hexdigest()
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    destination = CACHE_DIR / f"podcast-{digest}.wav"
    if _cached(destination):
        return destination

    semaphore = asyncio.Semaphore(MAX_CONCURRENT_SYNTH)

    async def clip(text: str, voice_id: str) -> Path:
        async with semaphore:
            return await synthesize(text, voice_id, speed)

    clips = await asyncio.gather(*(clip(text, voice) for text, voice in turns))

    temporary = _temp_path(destination)
    try:
        await asyncio.to_thread(_combine, list(clips), temporary)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    return destination
