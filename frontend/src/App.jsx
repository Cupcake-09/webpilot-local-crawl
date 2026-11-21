import { useEffect, useRef, useState } from 'react'
import CentipedeCrawler from './components/CentipedeCrawler.jsx'
import JuliusNapkin from './components/JuliusNapkin.jsx'
import MemoryModal from './components/MemoryModal.jsx'
import PodcastStudio from './components/PodcastStudio.jsx'
import SettingsModal from './components/SettingsModal.jsx'
import { generatePodcast, generateVisuals, runAgent, streamResearch } from './lib/api.js'
import {
  activeSession,
  beginMemorySession,
  entityCount,
  gripTotal,
  loadInsectMemory,
  memoryForVisuals,
  mergeMemorySession,
  saveInsectMemory,
} from './lib/insectMemory.js'
import { loadLlmSettings, llmLabel } from './lib/llm.js'

const VIEWS = [
  { id: 'research', label: 'Research', description: 'Reading stage', icon: 'compass' },
  { id: 'julius', label: 'Julius & Napkin', description: 'Charts and concept map', icon: 'chart' },
  { id: 'podcast', label: 'NotebookLM & Podcast', description: 'Takeaways and audio overview', icon: 'headphones' },
]

const STARTER = `# WebPilot research

Ask a question and this page becomes a streaming research essay. Paste a URL and WebPilot reads that page instead. The spider above is the original open-source DOM crawler, walking real words as they arrive.

Auto-iterate keeps the spider moving through the incoming text, marking key phrases in slate blue and filing entities into the notes drawer. Follow cursor parks the autonomous reader and lets the same legs walk toward your pointer at a relaxed pace.`

function Icon({ name, className = 'h-4 w-4' }) {
  const paths = {
    compass: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="m15.2 8.8-2 4.4-4.4 2 2-4.4z" />
      </>
    ),
    chart: <path d="M4 19.5V13M10 19.5V7M16 19.5v-5M22 19.5V4" />,
    headphones: (
      <>
        <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
        <rect x="3" y="13.5" width="4" height="6" rx="1.5" />
        <rect x="17" y="13.5" width="4" height="6" rx="1.5" />
      </>
    ),
    panel: (
      <>
        <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
        <path d="M9 4.5v15" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    arrowUp: <path d="M12 19V5m-6 6 6-6 6 6" />,
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 3v2.5M12 18.5V21M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M3 12h2.5M18.5 12H21M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
      </>
    ),
  }
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  )
}

function hostLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return String(url || '')
  }
}

function unwrapMarkdownLinks(value) {
  const source = String(value ?? '')
  if (!/\[[^\]]*\]\([^)]+\)/.test(source)) return source
  return source.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (_match, label, href) => {
    const url = String(href || '').trim().replace(/^<|>$/g, '')
    return url || label
  })
}

function closeOnMobile(setSidebarOpen) {
  if (typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches) {
    setSidebarOpen(false)
  }
}

export default function App() {
  const [view, setView] = useState('research')
  const [sidebarOpen, setSidebarOpen] = useState(
    () => typeof window === 'undefined' || window.matchMedia('(min-width: 768px)').matches,
  )
  const [settings, setSettings] = useState(loadLlmSettings)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [mode, setMode] = useState('auto')
  const [research, setResearch] = useState(null)
  const [visuals, setVisuals] = useState(null)
  const [visualsBusy, setVisualsBusy] = useState(false)
  const [visualsError, setVisualsError] = useState('')
  const [podcast, setPodcast] = useState(null)
  const [podcastBusy, setPodcastBusy] = useState(false)
  const [podcastError, setPodcastError] = useState('')
  const [history, setHistory] = useState([])
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState('')
  const [memory, setMemory] = useState(loadInsectMemory)
  const [memoryOpen, setMemoryOpen] = useState(false)

  const sequenceRef = useRef(0)
  const memoryRef = useRef(memory)
  const telemetryExportRef = useRef(() => null)
  const memorySession = activeSession(memory)
  const memoryEntities = entityCount(memorySession)
  const memoryGrips = gripTotal(memorySession)

  const commitMemory = (next) => {
    memoryRef.current = next
    setMemory(next)
    saveInsectMemory(next)
  }

  const ingestTelemetry = (snapshot) => {
    if (!snapshot) return
    commitMemory(mergeMemorySession(memoryRef.current, snapshot))
  }

  const startMemorySession = (id, query, source) => {
    const next = beginMemorySession(memoryRef.current, { id: String(id), query, source })
    commitMemory(next)
  }
  const activeView = VIEWS.find((item) => item.id === view) ?? VIEWS[0]
  const busy = Boolean(research?.busy)

  useEffect(() => {
    if (view !== 'research') window.scrollTo(0, 0)
  }, [view])

  const addHistory = (label, source) => {
    setHistory((previous) => {
      const key = `${label}-${source}`
      return [{ id: `${Date.now()}-${key}`, label, source }, ...previous.filter((item) => `${item.label}-${item.source}` !== key)].slice(0, 6)
    })
  }

  const runGenerators = (id, markdown, meta, snapshot, memoryState) => {
    setVisuals(null)
    setPodcast(null)
    setVisualsError('')
    setPodcastError('')
    setVisualsBusy(true)
    setPodcastBusy(true)

    generateVisuals({
      query: meta.query,
      markdown,
      source: meta.source,
      settings: snapshot,
      memory: memoryForVisuals(memoryState),
    })
      .then((data) => {
        if (sequenceRef.current === id) setVisuals(data)
      })
      .catch((error) => {
        if (sequenceRef.current === id) setVisualsError(error?.message || 'Charts could not be generated.')
      })
      .finally(() => {
        if (sequenceRef.current === id) setVisualsBusy(false)
      })

    generatePodcast({
      query: meta.query,
      markdown,
      settings: snapshot,
    })
      .then((data) => {
        if (sequenceRef.current === id) setPodcast(data)
      })
      .catch((error) => {
        if (sequenceRef.current === id) setPodcastError(error?.message || 'The podcast could not be generated.')
      })
      .finally(() => {
        if (sequenceRef.current === id) setPodcastBusy(false)
      })
  }

  const completeResearch = (id, markdown, meta, snapshot) => {
    const finalTelemetry = telemetryExportRef.current?.()
    let settledMemory = memoryRef.current
    if (finalTelemetry) {
      settledMemory = mergeMemorySession(settledMemory, finalTelemetry)
      commitMemory(settledMemory)
    }
    setResearch((previous) =>
      previous && previous.id === id
        ? { ...previous, markdown, streaming: false, busy: false, completed: true, finishedAt: Date.now() }
        : previous,
    )
    runGenerators(id, markdown, meta, snapshot, settledMemory)
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    const value = unwrapMarkdownLinks(draft).trim()
    if (!value || busy) return

    const id = (sequenceRef.current += 1)
    const snapshot = settings
    setView('research')
    setMode('auto')
    setNotice('')
    setVisuals(null)
    setPodcast(null)
    setVisualsError('')
    setPodcastError('')
    setDraft('')
    closeOnMobile(setSidebarOpen)

    if (/^https?:\/\//i.test(value)) {
      const label = hostLabel(value)
      startMemorySession(id, value, label)
      addHistory(`Read ${label}`, label)
      setResearch({
        id,
        kind: 'url',
        query: value,
        source: label,
        markdown: `# Reading ${label}\n\nFetching the page and extracting its readable text.`,
        busy: true,
        streaming: false,
      })
      try {
        const data = await runAgent({
          goal: `Read and summarise ${value}`,
          targetUrl: value,
          mode: 'crawl4ai',
          settings: snapshot,
        })
        if (sequenceRef.current !== id) return
        const text =
          data.markdown?.trim() ||
          `# ${label}\n\n${data.summary?.trim() || 'The page returned no readable text.'}`
        completeResearch(id, text, { query: value, source: label }, snapshot)
        setNotice(`Loaded ${text.split(/\s+/).length.toLocaleString()} words from ${label}.`)
      } catch (error) {
        if (sequenceRef.current !== id) return
        setResearch((previous) =>
          previous && previous.id === id
            ? {
                ...previous,
                busy: false,
                completed: true,
                markdown: `# ${label}\n\n${error?.message || 'That page could not be read.'}`,
              }
            : previous,
        )
        setNotice(error?.message || 'That crawl did not complete. Check the engine and try again.')
      }
      return
    }

    startMemorySession(id, value, 'Research essay')
    addHistory(value, 'Research essay')
    setResearch({
      id,
      kind: 'question',
      query: value,
      source: 'Research essay',
      markdown: `# ${value}\n\n`,
      busy: true,
      streaming: true,
    })

    let accumulated = `# ${value}\n\n`
    let lastFlush = 0
    try {
      await streamResearch({
        query: value,
        settings: snapshot,
        onChunk: (token) => {
          accumulated += token
          const stamp = performance.now()
          if (stamp - lastFlush > 90) {
            lastFlush = stamp
            const snapshotText = accumulated
            setResearch((previous) =>
              previous && previous.id === id ? { ...previous, markdown: snapshotText } : previous,
            )
          }
        },
      })
      if (sequenceRef.current !== id) return
      completeResearch(id, accumulated, { query: value, source: 'Research essay' }, snapshot)
      setNotice(`${accumulated.split(/\s+/).length.toLocaleString()} words streamed onto the stage.`)
    } catch (error) {
      if (sequenceRef.current !== id) return
      setResearch((previous) =>
        previous && previous.id === id
          ? { ...previous, busy: false, streaming: false, markdown: `${accumulated}\n\n${error?.message || 'The stream stopped.'}` }
          : previous,
      )
      setNotice(error?.message || 'The research stream stopped. Check the engine and try again.')
    }
  }

  const handleNewResearch = () => {
    sequenceRef.current += 1
    setView('research')
    setResearch(null)
    setVisuals(null)
    setPodcast(null)
    setVisualsError('')
    setPodcastError('')
    setDraft('')
    setNotice('')
    closeOnMobile(setSidebarOpen)
  }

  const navigate = (id) => {
    setView(id)
    setNotice('')
    closeOnMobile(setSidebarOpen)
  }

  const stageMarkdown = research ? research.markdown : STARTER
  const stageSource = research?.source || 'Reading stage'
  // A URL run swaps its placeholder for the scraped page under the same id, so
  // remount once it lands to drop the old word-box cache.
  const stageKey = research ? `${research.id}-${research.kind === 'url' && research.completed ? 'loaded' : 'live'}` : 'starter'

  return (
    <div className="min-h-screen bg-[#0D0D0D] text-[#ECECEC]">
      <aside
        aria-label="Workspace navigation"
        className={`fixed inset-y-0 left-0 z-40 flex w-[260px] flex-col border-r border-[#2F2F2F] bg-[#171717] transition-transform duration-300 ease-out ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center gap-2.5 px-4 pb-2 pt-4">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#ECECEC] text-[13px] font-semibold text-[#0D0D0D]">
            W
          </span>
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold leading-tight text-[#ECECEC]">WebPilot</p>
            <p className="truncate text-[11px] leading-tight text-[#9B9B9B]">Local research</p>
          </div>
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            className="ml-auto grid h-8 w-8 place-items-center rounded-full text-[#9B9B9B] transition hover:bg-[#212121] hover:text-[#ECECEC]"
            aria-label="Collapse sidebar"
          >
            <Icon name="panel" />
          </button>
        </div>

        <div className="px-3 pt-2">
          <button
            type="button"
            onClick={handleNewResearch}
            className="flex w-full items-center gap-2 rounded-full border border-[#2F2F2F] px-3.5 py-2.5 text-left text-[13px] font-medium text-[#ECECEC] transition hover:bg-[#212121]"
          >
            <Icon name="plus" className="h-4 w-4 text-[#9B9B9B]" />
            New research
          </button>
        </div>

        <nav className="mt-5 flex flex-col gap-1 px-3">
          {VIEWS.map((item) => {
            const active = item.id === view
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => navigate(item.id)}
                aria-current={active ? 'page' : undefined}
                className={`flex items-center gap-3 rounded-full px-3 py-2.5 text-left text-[13px] transition-colors ${
                  active
                    ? 'bg-[#212121] font-medium text-[#ECECEC]'
                    : 'text-[#9B9B9B] hover:bg-[#212121]/70 hover:text-[#ECECEC]'
                }`}
              >
                <Icon name={item.icon} className={`h-4 w-4 shrink-0 ${active ? 'text-[#ECECEC]' : 'text-[#9B9B9B]'}`} />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
              </button>
            )
          })}
        </nav>

        <div className="mt-6 min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          <p className="px-3 pb-1.5 text-[11.5px] text-[#9B9B9B]">Recent</p>
          {history.length ? (
            <div className="flex flex-col gap-0.5">
              {history.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setView('research')
                    setDraft(item.label.startsWith('Read ') ? '' : item.label)
                    closeOnMobile(setSidebarOpen)
                  }}
                  className="min-w-0 rounded-xl px-3 py-2 text-left transition hover:bg-[#212121]"
                >
                  <span className="block truncate text-[12.5px] text-[#D6D6D6]">{item.label}</span>
                  <span className="block truncate text-[11px] text-[#7A7A7A]">{item.source}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="px-3 text-[12px] leading-relaxed text-[#6F6F6F]">
              Questions and crawled pages will collect here.
            </p>
          )}
        </div>

        <div className="border-t border-[#2F2F2F] p-3">
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition hover:bg-[#212121]"
          >
            <Icon name="settings" className="h-4 w-4 shrink-0 text-[#9B9B9B]" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-[#ECECEC]">Model &amp; API settings</span>
              <span className="block truncate text-[11px] text-[#9B9B9B]">{llmLabel(settings)}</span>
            </span>
          </button>
        </div>
      </aside>

      {sidebarOpen ? (
        <button
          type="button"
          aria-label="Close sidebar"
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-30 bg-black/60 backdrop-blur-[1px] md:hidden"
        />
      ) : null}

      <div className={`min-h-screen transition-[padding] duration-300 ease-out ${sidebarOpen ? 'md:pl-[260px]' : ''}`}>
        <header className="sticky top-0 z-20 border-b border-[#2F2F2F] bg-[#0D0D0D]/95 backdrop-blur">
          {busy ? (
            <div className="absolute inset-x-0 top-0 h-0.5 overflow-hidden">
              <div className="research-progress h-full w-1/3 rounded-full bg-[#ECECEC]" />
            </div>
          ) : null}
          <div className="flex h-14 items-center gap-3 px-3 sm:px-5">
            <button
              type="button"
              onClick={() => setSidebarOpen((open) => !open)}
              aria-label={sidebarOpen ? 'Collapse sidebar' : 'Open sidebar'}
              aria-expanded={sidebarOpen}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-[#9B9B9B] transition hover:bg-[#212121] hover:text-[#ECECEC]"
            >
              <Icon name="panel" className="h-[18px] w-[18px]" />
            </button>
            <div className="min-w-0">
              <h1 className="truncate text-[14px] font-medium leading-tight text-[#ECECEC]">{activeView.label}</h1>
              <p className="truncate text-[11.5px] leading-tight text-[#9B9B9B]">{activeView.description}</p>
            </div>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="ml-auto hidden max-w-[240px] items-center gap-2 rounded-full border border-[#2F2F2F] px-3 py-1.5 text-[11.5px] text-[#9B9B9B] transition hover:bg-[#212121] hover:text-[#ECECEC] sm:flex"
            >
              <span className={`h-1.5 w-1.5 rounded-full ${settings.provider === 'gemini' && settings.apiKey ? 'bg-[#38BDF8]' : 'bg-[#ECECEC]'}`} />
              <span className="truncate">{llmLabel(settings)}</span>
            </button>
          </div>
        </header>

        {view === 'research' ? (
          <CentipedeCrawler
            key={stageKey}
            markdown={stageMarkdown}
            streaming={Boolean(research?.streaming)}
            mode={mode}
            query={research?.query || ''}
            source={stageSource}
            sessionId={research ? String(research.id) : null}
            completed={Boolean(research?.completed)}
            onTelemetry={ingestTelemetry}
            telemetryExportRef={telemetryExportRef}
          />
        ) : (
          <main className="mx-auto w-full max-w-[1120px] px-3 pb-44 pt-6 sm:px-5">
            {view === 'julius' ? (
              <JuliusNapkin visuals={visuals} busy={visualsBusy} error={visualsError} research={research} />
            ) : (
              <PodcastStudio podcast={podcast} busy={podcastBusy} error={podcastError} research={research} />
            )}
          </main>
        )}
      </div>

      <div
        className={`pointer-events-none fixed inset-x-0 bottom-0 z-20 bg-gradient-to-t from-[#0D0D0D] via-[#0D0D0D]/95 to-transparent px-3 pb-4 pt-8 transition-[left] duration-300 sm:px-6 ${
          sidebarOpen ? 'md:left-[260px]' : ''
        }`}
      >
        <div className="pointer-events-auto mx-auto w-full max-w-[820px]">
          <div className="mb-2 flex flex-wrap items-center justify-center gap-2">
            <div
              role="tablist"
              aria-label="Crawler mode"
              className="inline-flex rounded-full border border-[#2F2F2F] bg-[#171717] p-1"
            >
              {[
                { id: 'auto', label: 'Auto-Iterate (LLM Reader)' },
                { id: 'cursor', label: 'Follow Cursor' },
              ].map((option) => {
                const active = mode === option.id
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setMode(option.id)}
                    className={`rounded-full px-3.5 py-1.5 text-[12px] transition-colors ${
                      active
                        ? 'bg-[#ECECEC] font-medium text-[#0D0D0D]'
                        : 'text-[#9B9B9B] hover:text-[#ECECEC]'
                    }`}
                  >
                    {option.label}
                  </button>
                )
              })}
            </div>
            <button
              type="button"
              onClick={() => setMemoryOpen(true)}
              className="rounded-full border border-[#2F2F2F] bg-[#171717] px-3.5 py-1.5 text-[12px] text-[#9B9B9B] transition hover:bg-[#2A2A2A] hover:text-[#ECECEC]"
              aria-haspopup="dialog"
            >
              Memory: {memoryEntities} {memoryEntities === 1 ? 'entity' : 'entities'} · {memoryGrips} grips
            </button>
          </div>

          <form
            onSubmit={handleSubmit}
            className="flex items-center gap-2 rounded-full border border-[#2F2F2F] bg-[#212121] py-2 pl-5 pr-2 shadow-[0_18px_50px_-18px_rgba(0,0,0,0.9)]"
          >
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onPaste={(event) => {
                const pasted = event.clipboardData?.getData('text') || ''
                const unwrapped = unwrapMarkdownLinks(pasted)
                if (unwrapped !== pasted) {
                  event.preventDefault()
                  setDraft(unwrapped)
                }
              }}
              placeholder="Ask a research question or paste a URL…"
              aria-label="Ask a research question or paste a URL"
              disabled={busy}
              className="min-w-0 flex-1 bg-transparent py-1 text-[14px] text-[#ECECEC] outline-none placeholder:text-[#9B9B9B] disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={!draft.trim() || busy}
              aria-label="Send"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#ECECEC] text-[#0D0D0D] transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-35"
            >
              {busy ? (
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[#0D0D0D]/30 border-t-[#0D0D0D]" />
              ) : (
                <Icon name="arrowUp" className="h-[18px] w-[18px]" />
              )}
            </button>
          </form>
          <p className="mt-2 min-h-[16px] text-center text-[11.5px] leading-4 text-[#9B9B9B]">
            {notice ||
              (mode === 'cursor'
                ? 'Autonomous extraction is paused. Move the pointer and the crawler will follow.'
                : 'Local-first research. Ask a question to stream an essay or paste a URL to read it.')}
          </p>
        </div>
      </div>

      <SettingsModal
        open={settingsOpen}
        settings={settings}
        onClose={() => setSettingsOpen(false)}
        onSave={(next) => setSettings(next)}
      />
      <MemoryModal open={memoryOpen} memory={memory} onClose={() => setMemoryOpen(false)} />
    </div>
  )
}
