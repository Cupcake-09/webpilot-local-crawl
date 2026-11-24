import os, sys, asyncio, hashlib, json, re
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from dotenv import load_dotenv
import httpx

import tts_service

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

from crawl4ai import AsyncWebCrawler
from browser_use import Agent, Browser
from langchain_openai import ChatOpenAI

load_dotenv()

@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Warm Kokoro once at startup so the first Play click has no cold start."""
    warmup = asyncio.create_task(tts_service.warmup())
    _app.state.tts_warmup = warmup
    try:
        yield
    finally:
        warmup.cancel()


app = FastAPI(title="Rivet Local Engine", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

CACHE_DIR = Path("audio_cache")
CACHE_DIR.mkdir(exist_ok=True)

from research_routes import router as research_router  # noqa: E402

app.include_router(research_router)


class ResearchRequest(BaseModel):
    goal: str
    target_url: str = "https://devfolio.co/hackathons"
    mode: str = "crawl4ai"


class VoiceRequest(BaseModel):
    text: str


class CentipedeBrainRequest(BaseModel):
    goal: str
    sentences: list[str] = []
    links: list[str] = []


def _resolve_llm(request: Request | None = None):
    """Pick the active model from forwarded settings, then fall back to .env."""
    headers = request.headers if request is not None else {}
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


BRAIN_SYSTEM_PROMPT = """You are the brain of an autonomous DOM-crawling centipede inside a research dashboard.
You read a page alongside a human mission goal and decide what the creature should walk to next.

Return ONE JSON object and nothing else. No markdown fences, no commentary. Schema:
{
  "highlights": ["exact phrase or sentence copied verbatim from the supplied sentences", ...],
  "next_urls": ["url copied from the supplied links", ...],
  "structured_items": [
    {"entity": "short entity name", "detail": "one or two sentence factual detail", "source": "url or page label"}
  ]
}

Rules:
- highlights: 3 to 6 items, each an EXACT substring of one supplied sentence (never paraphrased).
- structured_items: exactly one row per highlight, same order, factual and concise.
- next_urls: at most 3 URLs, ONLY from the supplied links list, most useful for the goal first.
- Prefer phrases that state concrete facts, numbers, names or definitions relevant to the goal.
"""

STOPWORDS = {
    "the", "and", "for", "with", "from", "that", "this", "what", "which", "into", "about", "your",
    "their", "have", "has", "are", "was", "were", "will", "can", "how", "why", "who", "when",
    "all", "any", "best", "top", "find", "show", "list", "map", "most", "more", "than", "then",
    "over", "under", "using", "use", "should", "could", "would", "of", "in",
    "on", "to", "a", "an", "is", "it", "be", "by", "or", "as", "at", "we", "you", "our",
    "where", "next", "map", "page", "pages", "here", "these", "those", "also", "than", "its",
}


def _brain_json(raw):
    if isinstance(raw, list):
        raw = "".join(str(part) for part in raw)
    text = str(raw or "").strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("model did not return a JSON object")
    return json.loads(text[start : end + 1])


def _tokens(text):
    return [t for t in re.findall(r"[\w'-]+", str(text).lower()) if len(t) > 2 and t not in STOPWORDS]


def _norm(text):
    return re.sub(r"\s+", " ", str(text or "")).strip().lower()


def _clean_links(links):
    out, seen = [], set()
    for link in links or []:
        url = str(link or "").strip()
        if not url.startswith(("http://", "https://")):
            continue
        if url in seen:
            continue
        seen.add(url)
        out.append(url)
    return out[:40]


def _fallback_entity(text, source):
    words = _tokens(text)[:2]
    if words:
        return " ".join(w.capitalize() for w in words)
    match = re.match(r"https?://([^/]+)", source or "")
    return (match.group(1) if match else "Page").replace("www.", "")


def _fallback_brain(goal, sentences, links, note=None):
    """Deterministic extractive fallback: keyword overlap picks the best sentences."""
    goal_terms = set(_tokens(goal))
    scored = []
    for index, sentence in enumerate(sentences):
        words = _tokens(sentence)
        overlap = len(goal_terms.intersection(words))
        density = overlap / (len(words) ** 0.5 + 1)
        scored.append((density + overlap * 0.35 - index * 0.001, index, sentence))
    scored.sort(reverse=True)
    top = [row for row in scored if row[0] > 0][:5]
    if len(top) < 3:
        seen = {row[1] for row in top}
        for row in scored:
            if row[1] in seen:
                continue
            top.append(row)
            seen.add(row[1])
            if len(top) >= 3:
                break
    top.sort(key=lambda row: row[1])
    highlights = [row[2][:400] for row in top]
    if not highlights and sentences:
        highlights = [sentences[0][:400]]

    next_urls = []
    for url in links:
        if len(next_urls) >= 3:
            break
        if goal_terms and goal_terms.intersection(set(_tokens(url.replace('-', ' ').replace('/', ' ')))):
            next_urls.append(url)
    for url in links:
        if len(next_urls) >= 3:
            break
        if url not in next_urls:
            next_urls.append(url)

    items = []
    for index, phrase in enumerate(highlights):
        source = next_urls[index % len(next_urls)] if next_urls else "scraped page"
        items.append(
            {
                "entity": _fallback_entity(phrase or goal, source),
                "detail": phrase.strip(),
                "source": source,
            }
        )

    return {
        "status": "success",
        "engine": "keyword-fallback",
        "model": None,
        "highlights": highlights,
        "next_urls": next_urls,
        "structured_items": items,
        "note": note or "Local LLM offline - extractive keyword fallback engaged.",
    }


@app.post("/api/run-agent")
async def run_agent(req: ResearchRequest, request: Request):
    try:
        extracted_markdown = ""
        agent_summary = ""

        if req.mode == "browser_use":
            base_url, api_key, model = _resolve_llm(request)
            llm = ChatOpenAI(model=model, base_url=base_url, api_key=api_key)
            browser = Browser("chromium")
            agent = Agent(task=f"{req.goal} starting at {req.target_url}", llm=llm, browser=browser)
            history = await agent.run(max_steps=6)
            agent_summary = history.final_result() or "Autonomous browser task completed."
            extracted_markdown = agent_summary
        else:
            async with AsyncWebCrawler(verbose=False) as crawler:
                result = await crawler.arun(url=req.target_url)
                extracted_markdown = (result.markdown or "")[:4000]
                agent_summary = f"Crawled {req.target_url} successfully ({len(result.markdown or '')} chars)."

        rows = [
            {"Topic": req.goal[:40], "Source": req.target_url, "Status": "Verified", "Chars_Extracted": len(extracted_markdown)},
        ]

        zapier_url = os.getenv("ZAPIER_WEBHOOK_URL")
        zapier_status = "Not configured"
        if zapier_url:
            async with httpx.AsyncClient() as client:
                r = await client.post(zapier_url, json={"goal": req.goal, "summary": agent_summary, "url": req.target_url})
                zapier_status = f"Triggered ({r.status_code})"

        return {
            "status": "success",
            "summary": agent_summary,
            "markdown": extracted_markdown,
            "rows": rows,
            "zapier_status": zapier_status,
        }
    except Exception as e:
        return JSONResponse(status_code=500, content={"status": "error", "detail": str(e)})


@app.post("/api/centipede-brain")
async def centipede_brain(req: CentipedeBrainRequest, request: Request):
    """Steer the DOM centipede: pick verbatim highlights + a crawl frontier.

    Talks to the local OpenAI-compatible server (Qwen 2.5 Coder). When that server
    is unreachable or returns unusable JSON, an extractive keyword fallback keeps
    the UI running with the same response shape.
    """
    goal = (req.goal or "Find the most important facts").strip()
    sentences = [re.sub(r"\s+", " ", s).strip() for s in (req.sentences or [])]
    sentences = [s for s in sentences if len(s) > 2][:90]
    links = _clean_links(req.links)

    if not sentences:
        return {
            "status": "success",
            "engine": "empty",
            "model": None,
            "highlights": [],
            "next_urls": links[:3],
            "structured_items": [],
            "note": "No page text supplied yet.",
        }

    base_url, api_key, model = _resolve_llm(request)
    endpoint = _chat_endpoint(base_url)

    payload = {
        "model": model,
        "temperature": 0.1,
        "max_tokens": 900,
        "messages": [
            {"role": "system", "content": BRAIN_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": json.dumps(
                    {"goal": goal, "sentences": sentences, "links": links}, ensure_ascii=False
                ),
            },
        ],
    }
    headers = _llm_headers(api_key)

    try:
        async with httpx.AsyncClient(timeout=40.0) as client:
            response = await client.post(endpoint, headers=headers, json=payload)
        if response.status_code != 200:
            raise RuntimeError(f"LLM HTTP {response.status_code}")
        body = response.json()
        content = body["choices"][0]["message"]["content"]
        data = _brain_json(content)
    except Exception as exc:  # offline server, bad JSON, timeout, schema drift
        return _fallback_brain(
            goal, sentences, links, note=f"Local LLM unavailable ({type(exc).__name__}) - keyword fallback engaged."
        )

    joined = _norm(" ".join(sentences))
    highlights = []
    for raw in data.get("highlights") or []:
        phrase = re.sub(r"\s+", " ", str(raw or "")).strip()
        if len(phrase) < 4:
            continue
        if _norm(phrase) not in joined:
            continue
        if phrase not in highlights:
            highlights.append(phrase)
        if len(highlights) >= 6:
            break

    if len(highlights) < 2:
        return _fallback_brain(goal, sentences, links, note="LLM highlights were not verbatim - keyword fallback engaged.")

    if len(highlights) < 3:
        for filler in _fallback_brain(goal, sentences, links)["highlights"]:
            if filler not in highlights:
                highlights.append(filler)
            if len(highlights) >= 3:
                break

    allowed = set(links)
    next_urls = []
    for raw in data.get("next_urls") or []:
        url = str(raw or "").strip()
        if url in allowed and url not in next_urls:
            next_urls.append(url)
        if len(next_urls) >= 3:
            break
    if not next_urls:
        next_urls = links[:3]

    raw_items = data.get("structured_items")
    if not isinstance(raw_items, list):
        raw_items = []
    items = []
    for index, phrase in enumerate(highlights):
        raw = raw_items[index] if index < len(raw_items) and isinstance(raw_items[index], dict) else {}
        entity = str(raw.get("entity") or "").strip() or _fallback_entity(goal, next_urls[0] if next_urls else "")
        detail = str(raw.get("detail") or "").strip() or phrase
        source = str(raw.get("source") or "").strip() or (next_urls[index % len(next_urls)] if next_urls else "scraped page")
        items.append({"entity": entity[:120], "detail": detail[:400], "source": source[:300]})

    return {
        "status": "success",
        "engine": "qwen",
        "model": model,
        "highlights": highlights,
        "next_urls": next_urls,
        "structured_items": items,
        "note": f"{len(highlights)} targets selected by {model}.",
    }


@app.post("/api/speak")
async def speak_summary(req: VoiceRequest):
    api_key = os.getenv("ELEVENLABS_API_KEY")
    if not api_key:
        return {"fallback": True, "text": req.text}

    text_hash = hashlib.md5(req.text.encode()).hexdigest()
    mp3_path = CACHE_DIR / f"{text_hash}.mp3"

    if not mp3_path.exists():
        voice_id = "21m00Tcm4TlvDq8ikWAM"
        url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
        headers = {"xi-api-key": api_key, "Content-Type": "application/json"}
        payload = {"text": req.text[:500], "model_id": "eleven_flash_v2_5"}

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(url, headers=headers, json=payload)
            if resp.status_code != 200:
                raise HTTPException(status_code=resp.status_code, detail=resp.text)
            mp3_path.write_bytes(resp.content)

    return FileResponse(mp3_path, media_type="audio/mpeg")
