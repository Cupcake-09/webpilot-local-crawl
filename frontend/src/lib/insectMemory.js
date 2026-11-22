/**
 * Bounded attention memory for the reading stage.
 *
 * The crawler emits cumulative session snapshots. This module normalises those
 * snapshots, keeps only the newest 12 section summaries and the 25 strongest
 * traversal edges, and persists a small FIFO window in localStorage. It never
 * stores the source text itself, only section labels, counts, dwell time and
 * the entities that were gripped.
 */

export const MAX_MEMORY_WORDS = 4000
export const MAX_MEMORY_TOKENS = 5000
export const MAX_SECTIONS = 12
export const MAX_ENTITIES = 25
export const MAX_EDGES = 25
export const MAX_SESSIONS = 8
export const MAX_GRIPS = 120
export const MAX_TOP_CONCEPTS = 20
export const MEMORY_FLUSH_MS = 1500
export const MEMORY_STORAGE_KEY = 'webpilot.insect-memory.v1'
export const TOKENS_PER_WORD = MAX_MEMORY_TOKENS / MAX_MEMORY_WORDS

const text = (value, limit = 160) => String(value ?? '').trim().slice(0, limit)
const count = (value) => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0
}
const stamp = (value) => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

function tokenEstimate(words) {
  return Math.min(MAX_MEMORY_TOKENS, Math.ceil(count(words) * TOKENS_PER_WORD))
}

function emptyMemory() {
  return { version: 1, activeId: null, sessions: [] }
}

function normaliseEntityList(value) {
  const seen = new Set()
  const entities = []
  for (const item of Array.isArray(value) ? value : []) {
    const label = text(item, 80)
    const key = label.toLowerCase()
    if (!label || seen.has(key)) continue
    seen.add(key)
    entities.push(label)
    if (entities.length >= MAX_ENTITIES) break
  }
  return entities
}

function normaliseGrip(raw) {
  if (!raw || typeof raw !== 'object') return null
  const word = text(raw.word ?? raw.entity, 80)
  if (!word) return null
  const rawScore = Number(raw.score)
  return {
    word,
    score: Number.isFinite(rawScore) ? Math.round(rawScore * 100) / 100 : 0,
    sectionHeading: text(raw.sectionHeading ?? raw.section, 80) || 'General Context',
    clusterId: text(raw.clusterId, 80),
    timestamp: stamp(raw.timestamp),
  }
}

/** Newest-bounded, deduplicated grip log; higher salience wins a repeat. */
function mergeGrips(previous, incoming) {
  const byKey = new Map()
  for (const raw of [...(Array.isArray(previous) ? previous : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    const grip = normaliseGrip(raw)
    if (!grip) continue
    const key = `${grip.word.toLowerCase()}\u0000${grip.sectionHeading.toLowerCase()}`
    const prior = byKey.get(key)
    byKey.set(
      key,
      prior
        ? {
            ...prior,
            score: Math.max(prior.score, grip.score),
            timestamp: Math.max(prior.timestamp, grip.timestamp),
            clusterId: grip.clusterId || prior.clusterId,
          }
        : grip,
    )
  }
  return [...byKey.values()]
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-MAX_GRIPS)
}

function normaliseConceptList(value) {
  const seen = new Set()
  const concepts = []
  for (const item of Array.isArray(value) ? value : []) {
    const label = text(typeof item === 'string' ? item : item?.word, 80)
    const key = label.toLowerCase()
    if (!label || seen.has(key)) continue
    seen.add(key)
    concepts.push(label)
    if (concepts.length >= MAX_TOP_CONCEPTS) break
  }
  return concepts
}

function normaliseSection(raw) {
  if (!raw || typeof raw !== 'object') return null
  const section = text(raw.section ?? raw.title ?? raw.name, 80)
  if (!section) return null
  return {
    section,
    dwellMs: count(raw.dwellMs),
    avgSegments: Math.max(1, count(raw.avgSegments) || 8),
    gripCount: count(raw.gripCount),
    lockedEntities: normaliseEntityList(raw.lockedEntities ?? raw.entities),
    words: Math.min(MAX_MEMORY_WORDS, count(raw.words ?? raw.wordCount)),
  }
}

function normaliseEdge(raw) {
  if (!raw || typeof raw !== 'object') return null
  const from = text(raw.from ?? raw.source, 80)
  const to = text(raw.to ?? raw.target, 80)
  if (!from || !to || from === to) return null
  return { from, to, weight: Math.max(1, count(raw.weight) || 1) }
}

function trimSectionsToBudget(sections) {
  const kept = sections.slice(-MAX_SECTIONS)
  let total = kept.reduce((sum, section) => sum + section.words, 0)
  while (kept.length > 1 && total > MAX_MEMORY_WORDS) {
    total -= kept[0].words
    kept.shift()
  }
  return kept
}

function mergeSections(previousSections, incomingSections) {
  const byName = new Map()
  for (const section of Array.isArray(previousSections) ? previousSections : []) {
    const normalised = normaliseSection(section)
    if (normalised) byName.set(normalised.section.toLowerCase(), normalised)
  }
  for (const raw of Array.isArray(incomingSections) ? incomingSections : []) {
    const incoming = normaliseSection(raw)
    if (!incoming) continue
    const key = incoming.section.toLowerCase()
    const prior = byName.get(key)
    byName.set(
      key,
      prior
        ? {
            section: incoming.section || prior.section,
            dwellMs: Math.max(prior.dwellMs, incoming.dwellMs),
            avgSegments: incoming.avgSegments || prior.avgSegments,
            gripCount: Math.max(prior.gripCount, incoming.gripCount),
            lockedEntities: normaliseEntityList([...prior.lockedEntities, ...incoming.lockedEntities]),
            words: Math.max(prior.words, incoming.words),
          }
        : incoming,
    )
  }
  return trimSectionsToBudget([...byName.values()])
}

function mergeEdges(previousEdges, incomingEdges) {
  const byPair = new Map()
  for (const raw of [...(Array.isArray(previousEdges) ? previousEdges : []), ...(Array.isArray(incomingEdges) ? incomingEdges : [])]) {
    const edge = normaliseEdge(raw)
    if (!edge) continue
    const key = `${edge.from.toLowerCase()}\u0000${edge.to.toLowerCase()}`
    const prior = byPair.get(key)
    byPair.set(key, prior ? { ...prior, weight: Math.max(prior.weight, edge.weight) } : edge)
  }
  return [...byPair.values()].sort((a, b) => b.weight - a.weight).slice(0, MAX_EDGES)
}

function normaliseSession(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = text(raw.id ?? raw.sessionId, 80)
  if (!id) return null
  const sections = mergeSections([], raw.sections)
  const wordCount = Math.min(MAX_MEMORY_WORDS, count(raw.wordCount) || sections.reduce((sum, item) => sum + item.words, 0))
  return {
    id,
    query: text(raw.query, 500),
    source: text(raw.source, 160),
    startedAt: stamp(raw.startedAt) || Date.now(),
    updatedAt: stamp(raw.updatedAt) || Date.now(),
    wordCount,
    tokenCount: Math.min(MAX_MEMORY_TOKENS, count(raw.tokenCount) || tokenEstimate(wordCount)),
    dwellMs: count(raw.dwellMs) || sections.reduce((sum, item) => sum + item.dwellMs, 0),
    avgSegments: Math.max(1, count(raw.avgSegments) || 8),
    gripCount: count(raw.gripCount) || sections.reduce((sum, item) => sum + item.gripCount, 0),
    sections,
    traversalEdges: mergeEdges([], raw.traversalEdges),
    grips: mergeGrips([], raw.grips),
    topConcepts: normaliseConceptList(raw.topConcepts),
  }
}

function normaliseMemory(raw) {
  if (!raw || typeof raw !== 'object') return emptyMemory()
  const sessions = []
  const seen = new Set()
  for (const candidate of Array.isArray(raw.sessions) ? raw.sessions : []) {
    const session = normaliseSession(candidate)
    if (!session || seen.has(session.id)) continue
    seen.add(session.id)
    sessions.push(session)
    if (sessions.length >= MAX_SESSIONS) break
  }
  const activeId = text(raw.activeId, 80)
  return {
    version: 1,
    activeId: sessions.some((session) => session.id === activeId) ? activeId : sessions[0]?.id ?? null,
    sessions,
  }
}

function activeSessionFrom(memory) {
  const state = normaliseMemory(memory)
  return state.sessions.find((session) => session.id === state.activeId) ?? state.sessions[0] ?? null
}

function mergeSession(previous, snapshot) {
  const incoming = normaliseSession(snapshot)
  if (!incoming) return previous
  if (!previous) return incoming
  const sections = mergeSections(previous.sections, incoming.sections)
  const wordCount = Math.min(MAX_MEMORY_WORDS, Math.max(previous.wordCount, incoming.wordCount))
  return {
    ...previous,
    query: incoming.query || previous.query,
    source: incoming.source || previous.source,
    startedAt: previous.startedAt || incoming.startedAt,
    updatedAt: Math.max(previous.updatedAt, incoming.updatedAt),
    wordCount,
    tokenCount: Math.min(
      MAX_MEMORY_TOKENS,
      Math.max(previous.tokenCount, incoming.tokenCount, tokenEstimate(wordCount)),
    ),
    dwellMs: Math.max(previous.dwellMs, incoming.dwellMs),
    avgSegments: incoming.avgSegments || previous.avgSegments,
    gripCount: Math.max(previous.gripCount, incoming.gripCount),
    sections,
    traversalEdges: mergeEdges(previous.traversalEdges, incoming.traversalEdges),
    grips: mergeGrips(previous.grips, incoming.grips),
    topConcepts: normaliseConceptList([...(previous.topConcepts ?? []), ...(incoming.topConcepts ?? [])]),
  }
}

function putSession(state, session) {
  return {
    version: 1,
    activeId: session.id,
    sessions: [session, ...state.sessions.filter((item) => item.id !== session.id)].slice(0, MAX_SESSIONS),
  }
}

/** Read persisted memory. Corrupt or unavailable storage falls back to empty. */
export function loadInsectMemory() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return emptyMemory()
    const raw = window.localStorage.getItem(MEMORY_STORAGE_KEY)
    return raw ? normaliseMemory(JSON.parse(raw)) : emptyMemory()
  } catch {
    return emptyMemory()
  }
}

/** Persist memory. Quota/security failures are intentionally non-fatal. */
export function saveInsectMemory(memory) {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false
    window.localStorage.setItem(MEMORY_STORAGE_KEY, JSON.stringify(normaliseMemory(memory)))
    return true
  } catch {
    return false
  }
}

/** Start a new active reading session, keeping a bounded newest-first history. */
export function beginMemorySession(memory, meta = {}) {
  const state = normaliseMemory(memory)
  const id = text(meta.id, 80)
  if (!id) return state
  const now = Date.now()
  const previous = state.sessions.find((session) => session.id === id)
  const session = {
    ...(previous ?? {}),
    id,
    query: text(meta.query, 500),
    source: text(meta.source, 160),
    startedAt: previous?.startedAt || now,
    updatedAt: now,
    wordCount: previous?.wordCount ?? 0,
    tokenCount: previous?.tokenCount ?? 0,
    dwellMs: previous?.dwellMs ?? 0,
    avgSegments: previous?.avgSegments ?? 8,
    gripCount: previous?.gripCount ?? 0,
    sections: previous?.sections ?? [],
    traversalEdges: previous?.traversalEdges ?? [],
    grips: previous?.grips ?? [],
    topConcepts: previous?.topConcepts ?? [],
  }
  return putSession(state, session)
}

/** Merge one cumulative crawler snapshot into its session. */
export function mergeMemorySession(memory, snapshot) {
  const state = normaliseMemory(memory)
  const incoming = normaliseSession(snapshot)
  if (!incoming) return state
  const previous = state.sessions.find((session) => session.id === incoming.id)
  const merged = mergeSession(previous, incoming)
  return putSession(state, merged)
}

export function activeSession(memory) {
  return activeSessionFrom(memory)
}

export function entityCount(session) {
  if (!session) return 0
  const seen = new Set()
  for (const section of session.sections ?? []) {
    for (const entity of section.lockedEntities ?? []) seen.add(String(entity).toLowerCase())
  }
  return seen.size
}

export function gripTotal(session) {
  if (!session) return 0
  return count(session.gripCount) || (session.sections ?? []).reduce((sum, section) => sum + count(section.gripCount), 0)
}

export function contextBudget(session) {
  const words = Math.min(MAX_MEMORY_WORDS, count(session?.wordCount))
  const tokens = Math.min(MAX_MEMORY_TOKENS, count(session?.tokenCount) || tokenEstimate(words))
  return {
    words,
    tokens,
    maxWords: MAX_MEMORY_WORDS,
    maxTokens: MAX_MEMORY_TOKENS,
    wordPct: Math.min(100, Math.round((words / MAX_MEMORY_WORDS) * 100)),
    tokenPct: Math.min(100, Math.round((tokens / MAX_MEMORY_TOKENS) * 100)),
  }
}

/** Return the active session as a small, JSON-safe payload. */
export function exportActiveSession(memory) {
  const session = activeSessionFrom(memory)
  if (!session) return null
  const budget = contextBudget(session)
  return {
    id: session.id,
    query: session.query,
    source: session.source,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    wordCount: budget.words,
    tokenCount: budget.tokens,
    dwellMs: count(session.dwellMs),
    avgSegments: session.avgSegments,
    gripCount: gripTotal(session),
    entityCount: entityCount(session),
    sections: session.sections,
    traversalEdges: session.traversalEdges,
    grips: session.grips ?? [],
    topConcepts: session.topConcepts ?? [],
  }
}

/** Payload handed to the visual generators; null when nothing has been read. */
export function memoryForVisuals(memory) {
  return exportActiveSession(memory)
}

/** Record dwell for a section on the active session (or an explicit session id). */
export function recordSectionDwell(memory, sectionTitle, dwellMs = 0, sessionId = null) {
  const state = normaliseMemory(memory)
  const targetId = text(sessionId, 80) || state.activeId
  const session = state.sessions.find((item) => item.id === targetId)
  const amount = count(dwellMs)
  if (!session || !amount) return state
  const title = text(sectionTitle, 80) || 'Opening'
  const sections = mergeSections(session.sections, [
    { section: title, dwellMs: count(session.sections.find((item) => item.section === title)?.dwellMs) + amount },
  ])
  const next = {
    ...session,
    updatedAt: Date.now(),
    dwellMs: session.dwellMs + amount,
    sections,
  }
  return putSession(state, next)
}

/** Record a grip, and optionally the entity that was gripped. */
export function recordGrip(memory, sectionTitle, entity = '', sessionId = null) {
  const state = normaliseMemory(memory)
  const targetId = text(sessionId, 80) || state.activeId
  const session = state.sessions.find((item) => item.id === targetId)
  if (!session) return state
  const title = text(sectionTitle, 80) || 'Opening'
  const prior = session.sections.find((item) => item.section === title)
  const sections = mergeSections(session.sections, [
    {
      section: title,
      gripCount: count(prior?.gripCount) + 1,
      lockedEntities: entity ? [entity] : [],
    },
  ])
  const next = {
    ...session,
    updatedAt: Date.now(),
    gripCount: session.gripCount + 1,
    sections,
  }
  return putSession(state, next)
}
