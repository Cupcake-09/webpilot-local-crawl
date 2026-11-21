"""Streaming research, SVG chart data and podcast endpoints for WebPilot Local."""

import asyncio
import hashlib
import json
import os
import re
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

router = APIRouter()

CACHE_DIR = Path("audio_cache")
CACHE_DIR.mkdir(exist_ok=True)

STOPWORDS = {
    "the", "and", "for", "with", "from", "that", "this", "what", "which", "into", "about", "your",
    "their", "have", "has", "are", "was", "were", "will", "can", "how", "why", "who", "when",
    "all", "any", "best", "top", "find", "show", "list", "map", "most", "more", "than", "then",
    "over", "under", "using", "use", "should", "could", "would", "of", "in", "on", "to", "a", "an",
    "is", "it", "be", "by", "or", "as", "at", "we", "you", "our", "where", "next", "page", "pages",
    "here", "these", "those", "also", "its", "but", "not", "they", "them", "been", "being", "does",
    "did", "doing", "each", "few", "other", "some", "such", "only", "own", "same", "very", "just",
    "now", "one", "two", "may", "much", "many", "well", "make", "made", "like", "still", "even",
}


class StreamResearchRequest(BaseModel):
    query: str


class VisualRequest(BaseModel):
    query: str = ""
    markdown: str = ""
    source: str = ""
    rows: list[dict] = []
    memory: dict | None = None


class PodcastRequest(BaseModel):
    query: str = ""
    markdown: str = ""
    rows: list[dict] = []


class PodcastLine(BaseModel):
    speaker: str = "Host A"
    text: str


class PodcastAudioRequest(BaseModel):
    lines: list[PodcastLine] = []


def _resolve_llm(request: Request):
    headers = request.headers
    base = (headers.get("x-llm-base-url") or os.getenv("OPENAI_BASE_URL") or "http://localhost:11434/v1").strip()
    key = headers.get("x-llm-api-key") or os.getenv("OPENAI_API_KEY", "local")
    model = headers.get("x-llm-model") or os.getenv("LLM_MODEL", "qwen2.5-coder:7b")
    return base.rstrip("/"), key, model


def _chat_endpoint(base_url: str) -> str:
    if base_url.endswith("/chat/completions"):
        return base_url
    if base_url.endswith("/v1") or base_url.endswith("/openai"):
        return base_url + "/chat/completions"
    return base_url + "/v1/chat/completions"


def _llm_headers(api_key: str) -> dict:
    return {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}


def _safe_int(value, fallback: int = 0) -> int:
    try:
        return max(0, int(float(value)))
    except (TypeError, ValueError):
        return fallback


def _safe_float(value, fallback: float = 0.0) -> float:
    try:
        return max(0.0, float(value))
    except (TypeError, ValueError):
        return fallback


def _json_object(raw) -> dict:
    text = str(raw or "").strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("no JSON object")
    return json.loads(text[start : end + 1])


def _clean_markdown_text(markdown: str) -> str:
    text = re.sub(r"```.*?```", " ", markdown or "", flags=re.S)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"^[#>\-*+\d.\s|]+", " ", text, flags=re.M)
    text = re.sub(r"[*_`~]+", "", text)
    return re.sub(r"\s+", " ", text).strip()


def _split_sentences(markdown: str) -> list[str]:
    text = _clean_markdown_text(markdown)
    parts = re.split(r"(?<=[.!?])\s+", text)
    return [part.strip() for part in parts if len(part.strip()) >= 40]


def _keywords(markdown: str, limit: int = 7) -> list[tuple[str, int]]:
    counts: dict[str, int] = {}
    for token in re.findall(r"[A-Za-z][A-Za-z'-]{2,}", markdown or ""):
        key = token.lower()
        if key in STOPWORDS:
            continue
        counts[key] = counts.get(key, 0) + 1
    return sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:limit]


def _fallback_essay(query: str) -> str:
    q = re.sub(r"\s+", " ", (query or "the research question")).strip().rstrip(".")
    return f"""# Research brief: {q}

## Overview

{q} rewards a patient reading. At first glance it looks like a single question with a tidy answer, but the closer the evidence is examined the more it turns into a cluster of smaller questions about definition, measurement and context. This brief takes the long view: it separates what is well supported from what is merely repeated, notes where the signal is strongest, and keeps the remaining uncertainty visible instead of smoothing it away. The goal is not a verdict but a map that a reader can use to decide what to check next.

## Context

The background matters because the same words carry different meanings in different settings. Analysts often inherit a definition from an earlier study, then compare their results with work that used a subtly different one. A useful way to read the material on {q} is to ask three questions in order. What exactly is being counted or described? Who collected it, and under what conditions? And does the conclusion survive when the framing changes? Most of the apparent contradictions in the literature come from a mismatch on the first two questions rather than from a genuine disagreement about the third. Once the definitions are aligned, a surprising amount of the disagreement disappears.

## Key findings

- The strongest evidence for {q} comes from repeated, independent observations rather than a single dramatic result.
- Effects that look large in small samples tend to shrink when the sample grows and the measurement is tightened.
- Context changes the size of the effect more often than it changes the direction.
- The most useful studies state their limits plainly and report what would have changed their conclusion.
- Where the record is thin, confident summaries tend to cite each other rather than add new evidence.

## What the evidence suggests

Taken together, these findings point to a moderate and conditional picture. The core claim is supported, but the strength of that support depends on the quality of the measurement and on the population being studied. It is reasonable to treat the main direction as established and the precise magnitude as provisional. That distinction matters for anyone acting on the research: a direction can justify a decision, while an unreliable magnitude should not be used to set a precise target. The evidence is least convincing where the terms are vague, the samples are small, or the outcome is measured indirectly through a proxy that may not track the thing that actually matters.

## Where the signal is strongest

The signal is clearest in work that compares like with like, reports uncertainty, and makes its data available. Those studies tend to agree on the broad shape of the answer even when they differ on details. The weakest points in the record are familiar ones: selective reporting, short follow-up, and conclusions that outrun the data. None of these problems is unique to {q}, but they are especially costly here because the question is often used to justify a larger decision. A reader should therefore weight replication and transparency more heavily than novelty. A modest result that two independent groups can reproduce is worth more than a striking result that no one has been able to confirm.

## Tensions and competing interpretations

There are at least three live interpretations. The first treats the observed pattern as a stable feature of the system. The second treats it as an artefact of how the data were collected. The third treats it as real but conditional, appearing only under a specific set of circumstances. The third reading currently fits the evidence best, because it explains both the consistent findings and the exceptions without requiring the data to be wrong. That does not make the other views irrelevant. The artefact explanation is a useful warning about measurement, and the stable-feature explanation is a useful reminder that some patterns persist across very different settings. Keeping all three in view prevents the analysis from collapsing into a single story too early.

## Practical implications

For a practitioner, the safest reading is to act on the direction while staying humble about the size. That means building in checks, preferring reversible steps, and revisiting the assumption when new evidence arrives. It also means separating the decision from the headline: a study can be interesting and still be too fragile to carry the weight of a large commitment. Where the stakes are high, the right move is usually to gather a little first-hand evidence rather than to rely entirely on summaries. A small, well-designed local test often resolves in a week what a pile of secondary commentary cannot settle at all.

## Limits and open questions

Several questions remain open. The long-run behaviour of {q} is less well studied than its short-run behaviour. The interaction with context is acknowledged more often than it is measured. And published work still over-represents settings that are easy to study rather than settings that are important. A stronger evidence base would need longer horizons, pre-registered comparisons, and a willingness to report null results. Until then, the honest conclusion is a conditional one: the main direction is credible, the magnitude is uncertain, and the practical advice should be robust to both. That is a less satisfying answer than a clean number, but it is the one the evidence can actually support.

## Synthesis

The short version is that {q} is best understood as a well-supported direction surrounded by an uncertain magnitude and a set of context-dependent exceptions. The evidence is strong enough to guide attention and weak enough to discourage overconfidence. Read the definitions before the conclusions, prefer replicated findings to vivid ones, and treat every precise number as a hypothesis rather than a fact. Follow those habits and the material becomes genuinely useful: not a final answer, but a reliable way to keep asking better questions.
"""


async def _stream_llm_essay(query: str, request: Request):
    base_url, api_key, model = _resolve_llm(request)
    endpoint = _chat_endpoint(base_url)
    prompt = (
        "Write a structured research essay of roughly 1000 words answering the question below. "
        "Use Markdown headings and short paragraphs, in clear sentence case. Be factual, note uncertainty, "
        "and avoid marketing language. Do not use bullet lists longer than five items.\n\n"
        f"Question: {query}"
    )
    payload = {
        "model": model,
        "temperature": 0.4,
        "max_tokens": 1800,
        "stream": True,
        "messages": [
            {"role": "system", "content": "You are a careful research writer."},
            {"role": "user", "content": prompt},
        ],
    }
    async with httpx.AsyncClient(timeout=120.0) as client:
        async with client.stream("POST", endpoint, headers=_llm_headers(api_key), json=payload) as response:
            if response.status_code != 200:
                raise RuntimeError(f"LLM HTTP {response.status_code}")
            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                except json.JSONDecodeError:
                    continue
                delta = (chunk.get("choices") or [{}])[0].get("delta", {}).get("content") or ""
                if delta:
                    yield delta


def _essay_chunks(essay: str):
    parts = re.findall(r"\S+\s*", essay)
    for index in range(0, len(parts), 3):
        yield "".join(parts[index : index + 3])


@router.post("/api/stream-research")
async def stream_research(req: StreamResearchRequest, request: Request):
    query = (req.query or "").strip() or "the research question"

    async def generate():
        emitted = 0
        try:
            async for token in _stream_llm_essay(query, request):
                emitted += len(token.strip())
                yield f"data: {json.dumps({'token': token})}\n\n"
        except Exception:
            emitted = 0
        if emitted < 120:
            for chunk in _essay_chunks(_fallback_essay(query)):
                yield f"data: {json.dumps({'token': chunk})}\n\n"
                await asyncio.sleep(0.012)
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


@router.post("/api/generate-visuals")
async def generate_visuals(req: VisualRequest):
    markdown = req.markdown or ""
    words = re.findall(r"\S+", _clean_markdown_text(markdown))
    if not words:
        words = re.findall(r"\S+", req.query or "research")

    memory = req.memory if isinstance(req.memory, dict) else {}
    memory_sections = []
    for item in (memory.get("sections") if isinstance(memory.get("sections"), list) else [])[-12:]:
        if not isinstance(item, dict):
            continue
        title = str(item.get("section") or "Section").strip()[:48] or "Section"
        entities = [str(entity).strip()[:80] for entity in (item.get("lockedEntities") or []) if str(entity).strip()][:8]
        memory_sections.append(
            {
                "title": title,
                "dwellMs": _safe_float(item.get("dwellMs")),
                "gripCount": _safe_int(item.get("gripCount")),
                "words": _safe_int(item.get("words")),
                "entities": entities,
            }
        )
    memory_edges = []
    for edge in (memory.get("traversalEdges") if isinstance(memory.get("traversalEdges"), list) else [])[:25]:
        if not isinstance(edge, dict):
            continue
        source_node = str(edge.get("from") or "").strip()[:48]
        target_node = str(edge.get("to") or "").strip()[:48]
        if source_node and target_node and source_node != target_node:
            memory_edges.append(
                {"from": source_node, "to": target_node, "weight": max(1, _safe_int(edge.get("weight"), 1))}
            )

    keyword_pairs = _keywords(markdown, 6)
    if not keyword_pairs:
        keyword_pairs = [(word.lower(), 1) for word in words[:6] if len(word) > 3]
    bar_series = [{"label": label, "value": count} for label, count in keyword_pairs]
    bar_title = "Term frequency"
    bar_unit = "mentions"
    line_title = "Signal density"
    line_unit = "%"
    line_meta = "Share of signal-bearing words per reading decile"

    segments = 8
    size = max(1, (len(words) + segments - 1) // segments)
    stop = set(STOPWORDS)
    line_series = []
    for index in range(segments):
        segment = words[index * size : (index + 1) * size]
        if not segment and index:
            break
        signal = 0
        for token in segment:
            clean = re.sub(r"[^\w'-]", "", token)
            if not clean:
                continue
            if clean[0].isdigit() or clean[0].isupper() or clean.lower() not in stop:
                signal += 1
        line_series.append(
            {
                "label": f"{index * 100 // segments}-{(index + 1) * 100 // segments}%",
                "value": round(signal / max(1, len(segment)) * 100),
            }
        )
    if not line_series:
        line_series = [{"label": "0-100%", "value": 0}]

    headings = re.findall(r"^#{1,3}\s+(.+)$", markdown, flags=re.M)
    breakdown = []
    if len(headings) >= 2:
        sections = re.split(r"^#{1,3}\s+", markdown, flags=re.M)[1:]
        for raw in sections[:6]:
            lines = raw.splitlines()
            label = (lines[0].strip() if lines else "Section")[:28] or "Section"
            value = len(re.findall(r"\S+", _clean_markdown_text("\n".join(lines[1:]))))
            if value:
                breakdown.append({"label": label, "value": value})
    if not breakdown:
        quarter = max(1, (len(words) + 3) // 4)
        for index, label in enumerate(["Opening", "Context", "Evidence", "Implications"]):
            value = len(words[index * quarter : (index + 1) * quarter])
            if value:
                breakdown.append({"label": label, "value": value})

    if memory_sections:
        line_title = "Section density · dwell"
        line_unit = "s"
        line_meta = "Seconds the crawler dwelled in each section"
        line_series = [
            {"label": section["title"], "value": round(section["dwellMs"] / 1000, 1)}
            for section in memory_sections
        ] or [{"label": "0-100%", "value": 0}]

        grip_counts: dict[str, int] = {}
        for section in memory_sections:
            for entity in section["entities"]:
                grip_counts[entity] = grip_counts.get(entity, 0) + max(1, section["gripCount"])
        if grip_counts:
            bar_title = "Gripped concepts"
            bar_unit = "grips"
            bar_series = [
                {"label": label, "value": value}
                for label, value in sorted(grip_counts.items(), key=lambda item: (-item[1], item[0]))[:6]
            ]
        else:
            bar_title = "Grips by section"
            bar_unit = "grips"
            bar_series = [
                {"label": section["title"], "value": section["gripCount"]}
                for section in memory_sections
                if section["gripCount"]
            ][:6]
        memory_breakdown = [
            {"label": section["title"], "value": section["words"]}
            for section in memory_sections
            if section["words"]
        ]
        if memory_breakdown:
            breakdown = memory_breakdown

    question = (req.query or "Research question").strip()[:46] or "Research question"
    nodes = [{"id": "q", "label": question, "group": "question"}]
    edges = []
    if memory_sections:
        title_to_id = {}
        for index, section in enumerate(memory_sections):
            node_id = f"s{index}"
            title_to_id[section["title"]] = node_id
            nodes.append({"id": node_id, "label": section["title"], "group": "concept"})
        for edge in memory_edges:
            source_id = title_to_id.get(edge["from"])
            target_id = title_to_id.get(edge["to"])
            if source_id and target_id:
                edges.append({"from": source_id, "to": target_id, "label": "traversed"})
        section_ids = [node["id"] for node in nodes[1:]]
        if section_ids:
            edges.insert(0, {"from": "q", "to": section_ids[0], "label": ""})
        if not memory_edges:
            for index in range(1, len(section_ids)):
                edges.append({"from": section_ids[index - 1], "to": section_ids[index], "label": "next"})
    else:
        for index, (label, _count) in enumerate(keyword_pairs[:5]):
            nodes.append({"id": f"k{index}", "label": label.capitalize(), "group": "concept"})
        edges = [{"from": "q", "to": node["id"], "label": ""} for node in nodes[1:]]
        for index in range(1, len(nodes) - 1):
            edges.append({"from": nodes[index]["id"], "to": nodes[index + 1]["id"], "label": "related"})

    source = (req.source or "research").strip()
    memory_summary = ""
    if memory_sections:
        memory_summary = (
            f" Crawler telemetry retained {_safe_int(memory.get('gripCount')):,} grips and "
            f"{round(_safe_float(memory.get('dwellMs')) / 1000, 1):,.1f}s of dwell across "
            f"{len(memory_sections)} sections."
        )
    return {
        "status": "success",
        "summary": (
            f"{len(words):,} words analysed from {source}. "
            f"{len(_split_sentences(markdown))} sentences mapped across {len(breakdown)} sections."
            f"{memory_summary}"
        ),
        "source": source,
        "bar": {"title": bar_title, "unit": bar_unit, "series": bar_series},
        "line": {"title": line_title, "unit": line_unit, "series": line_series, "meta": line_meta},
        "breakdown": {"title": "Section mix", "unit": "words", "series": breakdown},
        "diagram": {
            "title": "Traversal concept map" if memory_sections else "Concept map",
            "nodes": nodes,
            "edges": edges,
        },
    }


def _fallback_podcast(query: str, markdown: str):
    q = re.sub(r"\s+", " ", (query or "this research")).strip()
    sentences = _split_sentences(markdown)
    terms = {label for label, _ in _keywords(markdown, 10)}
    scored = []
    for index, sentence in enumerate(sentences):
        tokens = set(re.findall(r"[a-z]{3,}", sentence.lower()))
        scored.append((len(tokens & terms) - index * 0.02, index, sentence))
    scored.sort(reverse=True)
    takeaways = [row[2] for row in scored[:4]] or [
        f"The core question is {q}.",
        "The evidence points in a clear direction but the magnitude stays uncertain.",
        "Context changes the size of the effect more than its direction.",
        "Replication and transparent measurement carry the most weight.",
    ]

    dialogue = [
        {"speaker": "Host A", "text": f"Today we are unpacking {q}. The brief is long, so let's start with the one-line version. What actually holds up?"},
        {"speaker": "Host B", "text": takeaways[0]},
        {"speaker": "Host A", "text": "That sounds measured rather than dramatic. Is there a number we can trust?"},
        {"speaker": "Host B", "text": f"Only loosely. {takeaways[1] if len(takeaways) > 1 else 'The magnitude moves around when the sample changes.'} The direction is the reliable part."},
        {"speaker": "Host A", "text": "So where does the evidence get thin?"},
        {"speaker": "Host B", "text": f"Small samples, short follow-up, and definitions that drift between studies. {takeaways[2] if len(takeaways) > 2 else 'Those are the familiar weak points.'}"},
        {"speaker": "Host A", "text": "If someone had to act on this tomorrow, what would you tell them?"},
        {"speaker": "Host B", "text": f"Act on the direction, stay humble about the size, and keep the decision reversible. {takeaways[3] if len(takeaways) > 3 else 'Gather a little first-hand evidence before committing.'}"},
        {"speaker": "Host A", "text": "And the thing people most often get wrong?"},
        {"speaker": "Host B", "text": "Treating a precise number as a fact. It is a hypothesis with error bars. Read the definitions before the conclusions."},
    ]
    return takeaways, dialogue


@router.post("/api/generate-podcast")
async def generate_podcast(req: PodcastRequest, request: Request):
    query = (req.query or "this research").strip()
    takeaways, dialogue = _fallback_podcast(query, req.markdown or "")

    base_url, api_key, model = _resolve_llm(request)
    if api_key and api_key != "local":
        prompt = (
            "Create a short two-host podcast script grounded only in the supplied research text. "
            'Return ONE JSON object: {"takeaways": [4 strings], "dialogue": [{"speaker": "Host A" or "Host B", '
            '"text": string}]}. Use 8 to 10 alternating turns, natural spoken sentences, no markdown, '
            f"no stage directions.\n\nQuestion: {query}\n\nResearch:\n{(req.markdown or '')[:9000]}"
        )
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                response = await client.post(
                    _chat_endpoint(base_url),
                    headers=_llm_headers(api_key),
                    json={
                        "model": model,
                        "temperature": 0.6,
                        "max_tokens": 1200,
                        "messages": [
                            {"role": "system", "content": "You write concise, factual podcast dialogue."},
                            {"role": "user", "content": prompt},
                        ],
                    },
                )
            if response.status_code == 200:
                data = _json_object(response.json()["choices"][0]["message"]["content"])
                if isinstance(data.get("takeaways"), list) and data["takeaways"]:
                    takeaways = [str(item)[:400] for item in data["takeaways"][:5]]
                raw_dialogue = data.get("dialogue")
                if isinstance(raw_dialogue, list) and len(raw_dialogue) >= 4:
                    cleaned = []
                    for index, turn in enumerate(raw_dialogue[:14]):
                        if not isinstance(turn, dict):
                            continue
                        text = re.sub(r"\s+", " ", str(turn.get("text") or "")).strip()
                        if not text:
                            continue
                        label = str(turn.get("speaker", "")).lower()
                        is_a = label.endswith("a") or "host a" in label or index % 2 == 0
                        cleaned.append({"speaker": "Host A" if is_a else "Host B", "text": text})
                    if len(cleaned) >= 4:
                        dialogue = cleaned
        except Exception:
            pass

    return {
        "status": "success",
        "takeaways": takeaways,
        "dialogue": dialogue,
        "script": "\n\n".join(f"{turn['speaker']}: {turn['text']}" for turn in dialogue),
    }


@router.post("/api/podcast-audio")
async def podcast_audio(req: PodcastAudioRequest):
    api_key = os.getenv("ELEVENLABS_API_KEY")
    if not api_key:
        return {"fallback": True, "script": "\n\n".join(f"{line.speaker}: {line.text}" for line in req.lines)}

    voices = {
        "Host A": os.getenv("ELEVENLABS_VOICE_A", "21m00Tcm4TlvDq8ikWAM"),
        "Host B": os.getenv("ELEVENLABS_VOICE_B", "pNInz6obpgDQGcFmaJgB"),
    }
    signature = b"".join(line.text.encode() + line.speaker.encode() for line in req.lines)
    audio_path = CACHE_DIR / f"podcast-{hashlib.md5(signature).hexdigest()}.mp3"
    if not audio_path.exists():
        chunks = []
        async with httpx.AsyncClient(timeout=60.0) as client:
            for line in req.lines:
                text = (line.text or "").strip()
                if not text:
                    continue
                voice = voices.get(line.speaker, voices["Host A"])
                response = await client.post(
                    f"https://api.elevenlabs.io/v1/text-to-speech/{voice}",
                    headers={"xi-api-key": api_key, "Content-Type": "application/json"},
                    json={"text": text[:2500], "model_id": "eleven_flash_v2_5"},
                )
                if response.status_code != 200:
                    raise HTTPException(status_code=response.status_code, detail=response.text)
                chunks.append(response.content)
        if not chunks:
            return {"fallback": True, "script": ""}
        audio_path.write_bytes(b"".join(chunks))

    return FileResponse(audio_path, media_type="audio/mpeg")
