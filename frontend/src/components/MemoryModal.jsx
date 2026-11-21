import { useEffect, useMemo, useState } from 'react'
import {
  MAX_EDGES,
  MAX_ENTITIES,
  MAX_SECTIONS,
  activeSession,
  contextBudget,
  entityCount,
  exportActiveSession,
  gripTotal,
} from '../lib/insectMemory.js'

function formatDuration(ms) {
  const value = Number(ms) || 0
  if (value < 1000) return `${Math.round(value)}ms`
  if (value < 60000) return `${(value / 1000).toFixed(1)}s`
  const minutes = Math.floor(value / 60000)
  const seconds = Math.round((value % 60000) / 1000)
  return `${minutes}m ${seconds}s`
}

function BudgetBar({ label, value, max, pct }) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-[11.5px] text-[#9B9B9B]">{label}</span>
        <span className="font-mono text-[11px] text-[#ECECEC]">
          {value.toLocaleString()} / {max.toLocaleString()}
          <span className="ml-2 text-[#6F6F6F]">{pct}%</span>
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-[#171717] ring-1 ring-inset ring-[#2F2F2F]">
        <div
          className="h-full rounded-full bg-[#38BDF8] transition-[width] duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

function Stat({ label, value }) {
  return (
    <div className="rounded-xl border border-[#2F2F2F] bg-[#171717] px-3 py-2.5">
      <p className="text-[10.5px] uppercase tracking-[0.08em] text-[#6F6F6F]">{label}</p>
      <p className="mt-0.5 font-mono text-[13px] text-[#ECECEC]">{value}</p>
    </div>
  )
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-3.5 w-3.5" aria-hidden="true">
      <rect x="8" y="8" width="11" height="11" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </svg>
  )
}

export default function MemoryModal({ open, memory, onClose }) {
  const [copyState, setCopyState] = useState('idle')

  const session = useMemo(() => activeSession(memory), [memory])
  const budget = useMemo(() => contextBudget(session), [session])
  const entities = useMemo(() => entityCount(session), [session])
  const grips = useMemo(() => gripTotal(session), [session])
  const payload = useMemo(() => exportActiveSession(memory), [memory])
  const json = useMemo(() => JSON.stringify(payload, null, 2), [payload])

  useEffect(() => {
    if (open) setCopyState('idle')
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape') onClose()
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  if (!open) return null

  const copyJson = async () => {
    try {
      await navigator.clipboard.writeText(json)
      setCopyState('copied')
    } catch {
      try {
        const textarea = document.createElement('textarea')
        textarea.value = json
        textarea.setAttribute('readonly', '')
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        const copied = document.execCommand('copy')
        document.body.removeChild(textarea)
        setCopyState(copied ? 'copied' : 'failed')
      } catch {
        setCopyState('failed')
      }
    }
  }

  const stats = [
    ['Sections', `${session?.sections?.length ?? 0} / ${MAX_SECTIONS}`],
    ['Entities', entities.toLocaleString()],
    ['Grips', grips.toLocaleString()],
    ['Dwell', formatDuration(session?.dwellMs)],
    ['Avg segments', session ? Math.round(session.avgSegments) : '—'],
    ['Edges', `${session?.traversalEdges?.length ?? 0} / ${MAX_EDGES}`],
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/65 px-3 pb-3 pt-10 backdrop-blur-sm sm:items-center sm:p-6">
      <button type="button" aria-label="Close attention memory" className="absolute inset-0 cursor-default" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Attention memory"
        className="relative flex max-h-[90vh] w-full max-w-[760px] flex-col overflow-hidden rounded-2xl border border-[#2F2F2F] bg-[#212121] shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-[#2F2F2F] px-5 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[16px] font-semibold text-[#ECECEC]">Attention memory</h2>
              <span className="rounded-full border border-[#2F2F2F] bg-[#171717] px-2 py-0.5 font-mono text-[10.5px] text-[#9B9B9B]">
                live context
              </span>
            </div>
            <p className="mt-1 truncate text-[12.5px] leading-5 text-[#9B9B9B]">
              {session ? session.query || session.source || `Session ${session.id}` : 'No reading session yet.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[#9B9B9B] transition hover:bg-[#2A2A2A] hover:text-[#ECECEC]"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-4 w-4">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <section aria-label="Context budget" className="space-y-3 rounded-xl border border-[#2F2F2F] bg-[#1A1A1A] p-3.5">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-[12px] font-medium text-[#ECECEC]">Context budget</h3>
              <span className="text-[10.5px] text-[#6F6F6F]">
                {MAX_SECTIONS} sections · {MAX_ENTITIES} entities/section · top {MAX_EDGES} edges
              </span>
            </div>
            <BudgetBar label="Words" value={budget.words} max={budget.maxWords} pct={budget.wordPct} />
            <BudgetBar label="Approx. tokens" value={budget.tokens} max={budget.maxTokens} pct={budget.tokenPct} />
          </section>

          <section aria-label="Session summary" className="mt-4">
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <h3 className="text-[12px] font-medium text-[#ECECEC]">Session summary</h3>
              {session ? (
                <span className="truncate font-mono text-[10.5px] text-[#6F6F6F]">
                  {session.source || 'Research essay'} · {new Date(session.updatedAt).toLocaleTimeString()}
                </span>
              ) : null}
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {stats.map(([label, value]) => (
                <Stat key={label} label={label} value={value} />
              ))}
            </div>
          </section>

          {session?.sections?.length ? (
            <section aria-label="Retained sections" className="mt-4">
              <h3 className="mb-2 text-[12px] font-medium text-[#ECECEC]">Sections retained</h3>
              <div className="divide-y divide-[#2F2F2F] overflow-hidden rounded-xl border border-[#2F2F2F] bg-[#171717]">
                {session.sections.map((section, index) => (
                  <div key={`${section.section}-${index}`} className="flex items-center gap-3 px-3 py-2.5">
                    <span className="w-5 shrink-0 font-mono text-[10.5px] text-[#6F6F6F]">{index + 1}</span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-[#ECECEC]">{section.section}</span>
                    <span className="shrink-0 font-mono text-[10.5px] text-[#9B9B9B]">
                      {section.words.toLocaleString()} words · {section.gripCount} grips · {formatDuration(section.dwellMs)}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <section aria-label="Live JSON context window" className="mt-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-[12px] font-medium text-[#ECECEC]">Live JSON context window</h3>
                <p className="mt-0.5 text-[10.5px] text-[#6F6F6F]">Exactly what the visual generators receive.</p>
              </div>
              <button
                type="button"
                onClick={copyJson}
                disabled={!payload}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[#2F2F2F] bg-[#171717] px-3 py-1.5 text-[11.5px] text-[#9B9B9B] transition hover:bg-[#2A2A2A] hover:text-[#ECECEC] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {copyState === 'copied' ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3.5 w-3.5" aria-hidden="true">
                    <path d="m5 12 4 4L19 6" />
                  </svg>
                ) : (
                  <CopyIcon />
                )}
                <span aria-live="polite">
                  {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy JSON'}
                </span>
              </button>
            </div>
            <pre className="max-h-[300px] overflow-auto rounded-xl border border-[#2F2F2F] bg-[#0D0D0D] p-3.5 font-mono text-[10.5px] leading-[1.65] text-[#BDBDBD]">
              <code>{json}</code>
            </pre>
          </section>
        </div>
      </div>
    </div>
  )
}
