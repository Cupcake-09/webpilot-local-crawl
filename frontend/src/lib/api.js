/**
 * Thin client for the WebPilot Local FastAPI engine.
 * Override the base URL with VITE_API_BASE if the backend lives elsewhere.
 */
import { llmHeaders } from './llm.js'

export const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8000'

async function readError(res) {
  const text = await res.text().catch(() => '')
  try {
    const json = JSON.parse(text)
    return json.detail || json.error || json.message || text || `HTTP ${res.status}`
  } catch {
    return text || `HTTP ${res.status}`
  }
}

function jsonHeaders(settings) {
  return { 'Content-Type': 'application/json', ...llmHeaders(settings) }
}

/** POST /api/run-agent → { status, summary, markdown, rows } */
export async function runAgent({ goal, targetUrl, mode, settings }) {
  const res = await fetch(`${API_BASE}/api/run-agent`, {
    method: 'POST',
    headers: jsonHeaders(settings),
    body: JSON.stringify({ goal, target_url: targetUrl, mode }),
  })

  if (!res.ok) throw new Error(await readError(res))

  const data = await res.json()
  return {
    status: data.status ?? 'success',
    summary: data.summary ?? '',
    markdown: data.markdown ?? '',
    rows: Array.isArray(data.rows) ? data.rows : [],
  }
}

/** POST /api/centipede-brain → verbatim highlights and { entity, detail, source } rows. */
export async function runCentipedeBrain({ goal, sentences, links, settings }) {
  const res = await fetch(`${API_BASE}/api/centipede-brain`, {
    method: 'POST',
    headers: jsonHeaders(settings),
    body: JSON.stringify({ goal, sentences, links }),
  })

  if (!res.ok) throw new Error(await readError(res))

  const data = await res.json()
  const items = Array.isArray(data.structured_items) ? data.structured_items : []
  return {
    highlights: Array.isArray(data.highlights) ? data.highlights.filter(Boolean) : [],
    structuredItems: items.map((item) => ({
      entity: item?.entity ?? '',
      detail: item?.detail ?? '',
      source: item?.source ?? '',
    })),
  }
}

/** POST /api/stream-research → Server-Sent Events with { token } payloads. */
export async function streamResearch({ query, settings, signal, onChunk }) {
  const res = await fetch(`${API_BASE}/api/stream-research`, {
    method: 'POST',
    headers: jsonHeaders(settings),
    body: JSON.stringify({ query }),
    signal,
  })

  if (!res.ok) throw new Error(await readError(res))
  if (!res.body) throw new Error('This browser cannot read the research stream')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finished = false

  const handle = (block) => {
    const line = block
      .split('\n')
      .map((part) => part.trim())
      .find((part) => part.startsWith('data:'))
    if (!line) return
    const payload = line.slice(5).trim()
    if (!payload) return
    if (payload === '[DONE]') {
      finished = true
      return
    }
    try {
      const json = JSON.parse(payload)
      if (json.token) onChunk(json.token)
      if (json.error) throw new Error(json.error)
    } catch (error) {
      if (error instanceof SyntaxError) return
      throw error
    }
  }

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
    let split = buffer.indexOf('\n\n')
    while (split !== -1) {
      handle(buffer.slice(0, split))
      buffer = buffer.slice(split + 2)
      split = buffer.indexOf('\n\n')
    }
  }
  if (buffer.trim()) handle(buffer)
  return { finished }
}

/** POST /api/generate-visuals → bar / line / breakdown / concept diagram data. */
export async function generateVisuals({ query, markdown, source, rows = [], memory = null, settings }) {
  const res = await fetch(`${API_BASE}/api/generate-visuals`, {
    method: 'POST',
    headers: jsonHeaders(settings),
    body: JSON.stringify({ query, markdown, source, rows, memory }),
  })

  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

/** POST /api/generate-podcast → takeaways + Host A / Host B dialogue. */
export async function generatePodcast({ query, markdown, rows = [], memory = null, settings }) {
  const res = await fetch(`${API_BASE}/api/generate-podcast`, {
    method: 'POST',
    headers: jsonHeaders(settings),
    body: JSON.stringify({ query, markdown, rows, memory }),
  })

  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

/** POST /api/podcast-audio → mp3 blob when ElevenLabs is configured, else JSON fallback. */
export async function requestPodcastAudio(lines) {
  const res = await fetch(`${API_BASE}/api/podcast-audio`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lines }),
  })

  if (!res.ok) throw new Error(await readError(res))

  const type = res.headers.get('content-type') || ''
  if (type.includes('application/json')) {
    const data = await res.json()
    return { fallback: true, script: data.script || '' }
  }

  const blob = await res.blob()
  if (!blob.size) throw new Error('ElevenLabs returned an empty audio stream')
  return { fallback: false, url: URL.createObjectURL(blob) }
}

/** Client-side CSV export for the notes drawer and chart cards. */
export function buildCSV(rows) {
  if (!rows?.length) return ''
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))]
  const escape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`
  return [
    columns.map(escape).join(','),
    ...rows.map((row) => columns.map((key) => escape(row[key])).join(',')),
  ].join('\r\n')
}

export function downloadCSV(rows, filename = 'webpilot-export.csv') {
  const csv = buildCSV(rows)
  if (!csv) return false
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1500)
  return true
}
