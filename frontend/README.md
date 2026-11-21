# WebPilot Local — Frontend

ChatGPT-style monochrome research workspace for the local FastAPI research engine.

Stack: React 18 + Vite 5 + Tailwind CSS 3 + HTML5 Canvas (no other runtime deps).

## Run

```bash
cd frontend
npm install
npm run dev        # http://localhost:3000 (strict port)
```

The backend must be running separately:

```bash
cd backend
uvicorn main:app --reload --port 8000
```

Override the engine URL with `VITE_API_BASE` in `frontend/.env` if needed.

## Workspace

The `#171717` sidebar holds **Research**, **Julius & Napkin** and **NotebookLM & Podcast**.
**Model & API settings** sits at the bottom and switches between:

- **Local Qwen 2.5 Coder** — reads `OPENAI_BASE_URL`, `LLM_MODEL` and `OPENAI_API_KEY` from `backend/.env`.
- **Google Gemini** — `https://generativelanguage.googleapis.com/v1beta/openai/` with
  `gemini-3.5-flash-lite` or `gemini-4-hydrogen`. The AI Studio key is stored in
  `localStorage` and forwarded to FastAPI as `X-LLM-Base-Url`, `X-LLM-Api-Key` and
  `X-LLM-Model`.

### Research

The reading stage renders markdown as centered prose with every word a DOM span.
The crawler is the original open-source engine from
[`cyohei9907/web-crawlers`](../web-crawlers) (`js/crawler.js`): 8 legs + 2 palps,
two-bone IK with fixed knee sides, the abdomen/spine chain and the original gait,
with feet gripping real words. It was ported into React with two changes:

- word boxes are measured once and cached; the `requestAnimationFrame` loop never
  calls `getBoundingClientRect()`;
- filler mutations use only composited `transform` and `opacity`.

The segmented pill above the prompt switches modes:

| Mode | Behaviour |
| --- | --- |
| **Auto-Iterate (LLM Reader)** | sweeps through streamed/scraped words, marks key phrases in `#1E293B` with a `#38BDF8` underline, and streams `{ Entity, Detail, Source }` rows into the `#171717` notes drawer with CSV export. |
| **Follow Cursor** | pauses extraction and steers the same spider toward the pointer at ~48 px/s, stepping on nearby cached words. |

Submitting a URL calls `POST /api/run-agent` and loads the scraped markdown.
Submitting a question calls the new `POST /api/stream-research` SSE route, which
streams a ~1,000-word research essay token by token.

### Julius & Napkin

Automatically calls `POST /api/generate-visuals` when research completes and renders
data-derived bar, line and breakdown charts plus a concept map as interactive
monochrome SVG inside `#212121` rounded cards, each with CSV download.

### NotebookLM & Podcast

Automatically calls `POST /api/generate-podcast` to pool takeaways and a Host A /
Host B dialogue. Playback fetches `POST /api/podcast-audio` (ElevenLabs with two
voices when configured) or falls back to dual-voice `speechSynthesis` with live
line/word transcript highlighting.

## Backend routes used

`/api/run-agent`, `/api/stream-research`, `/api/generate-visuals`,
`/api/generate-podcast`, `/api/podcast-audio`, `/api/centipede-brain`, `/api/speak`.
