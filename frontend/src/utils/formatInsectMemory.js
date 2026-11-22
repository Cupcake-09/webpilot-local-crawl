/**
 * Turn the crawler's raw grip log into a small, ordered semantic payload.
 *
 * The spider records one grip per word it actually attached to
 * ({ word, score, sectionHeading, clusterId, timestamp }). This module groups
 * those grips back into reading sections, isolates the quantitative tokens it
 * walked over, and renders a compact markdown digest for prompt contexts.
 * Everything is derived: no DOM, no essay text, no side effects.
 */

export const MAX_FORMAT_SECTIONS = 12
export const MAX_SECTION_CONCEPTS = 12
export const MAX_SECTION_METRICS = 8
export const MAX_TOP_CONCEPTS = 15
export const MAX_NUMERIC_POINTS = 16
export const CONTEXT_CHAR_BUDGET = 2600
export const MIN_CONCEPT_SCORE = 3.5

// Extracted numbers with an optional technical unit. Order matters: longer
// unit tokens (PFLOPs, TB/s) must be tried before their shorter suffixes.
const UNIT = 'PFLOPs|EFLOPs|FLOPs|TWh|GWh|MWh|kWh|TB\\/s|GB\\/s|Wh\\/kg|W\\/kg|GW|MW|kW|Wh|Mt|Gt|kt|%|ms|nm|B|M|K|x'
const NUMBER_UNIT = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*((?:${UNIT})(?:\\/[A-Za-z]+)?)?`, 'i')
// True only when a token is *itself* a quantitative value ("42%", "$120/kWh"),
// so identifiers such as "COVID-19" are not mistaken for metrics.
const METRIC_TOKEN = new RegExp(`^[~<>≈$€£+-]?\\s*\\d+(?:[.,]\\d+)*\\s*(?:(?:${UNIT})(?:\\/[A-Za-z]+)?)?$`, 'i')
// Values written with a slash unit ("$120/kWh") are a separate shape from
// the plain number+unit tokens above.
const SLASH_UNIT = /^[~<>≈$€£+-]?\s*(\d+(?:\.\d+)?)\s*\/\s*([A-Za-z]+)$/i
const PROMPT_STARTS = [
  'compare ',
  'contrast ',
  'research brief',
  'research question',
  'brief:',
  'summarize',
  'summarise',
  'explain ',
  'analyze ',
  'analyse ',
  'evaluate ',
  'identify ',
  'write ',
  'create ',
  'generate ',
  'what ',
  'how ',
  'why ',
]
const DEFAULT_HEADING = 'General Context'
const text = (value, limit = 120) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit)
const scoreOf = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0
}
const keyOf = (value) => text(value).toLowerCase()

/** Strip markdown/numbering decoration so a heading reads as document text. */
export function sanitizeHeading(value) {
  return text(value, 120)
    .replace(/^#{1,6}\s*/, '')
    .replace(/^\d+[.)]\s*/, '')
    .replace(/^[-*•]\s*/, '')
    .replace(/\s*[:|]+\s*$/, '')
    .trim()
}

/**
 * True for raw prompt echoes ("Compare lithium sourcing across...",
 * "Research brief: ...") that the crawler gripped from the question line.
 * Those are not document sections and must not become chart categories.
 */
export function isPromptEcho(value, query = '') {
  const clean = sanitizeHeading(value)
  if (!clean) return false
  const lower = clean.toLowerCase()
  const queryKey = keyOf(query)
  if (queryKey && keyOf(clean) === queryKey) return true
  const words = lower.split(/\s+/).filter(Boolean)
  if (words.length >= 4 && PROMPT_STARTS.some((prefix) => lower.startsWith(prefix))) return true
  if (words.length >= 5 && lower.endsWith('?')) return true
  if (words.length >= 14) return true
  return false
}

function numberish(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function uniqueWords(values) {
  const seen = new Set()
  const words = []
  for (const value of values) {
    const word = text(value, 80)
    const key = keyOf(word)
    if (!word || seen.has(key)) continue
    seen.add(key)
    words.push(word)
  }
  return words
}

function looksLikeMetric(value) {
  const clean = text(value, 40)
  return METRIC_TOKEN.test(clean) || SLASH_UNIT.test(clean)
}

function excerpt(values, limit) {
  const joined = values.join(', ')
  return joined.length > limit ? `${joined.slice(0, limit - 1).trimEnd()}…` : joined
}

function addConcept(bucket, word, score, order) {
  const clean = text(word, 80)
  const key = keyOf(clean)
  if (!clean || !key) return
  const prior = bucket.get(key)
  if (prior) {
    prior.score = Math.max(prior.score, score)
    return
  }
  bucket.set(key, { word: clean, score, order })
}

function sectionFrom(source) {
  return {
    heading: source.heading,
    concepts: source.concepts,
    metrics: source.metrics,
    avgScore: source.avgScore,
    topScore: source.topScore,
    gripCount: source.gripCount,
    dwellMs: source.dwellMs,
    words: source.words,
    wordShare: source.wordShare ?? 0,
    numericSeries: source.numericSeries ?? [],
    summarySnippet: source.summarySnippet,
  }
}

/** Nearest non-metric word in crawl order, so numbers pair with their subject. */
function nearestEntity(metric, entries, fallback) {
  const index = entries.findIndex((entry) => keyOf(entry.word) === keyOf(metric))
  if (index >= 0) {
    for (let distance = 1; distance < entries.length; distance += 1) {
      const before = entries[index - distance]
      if (before && !looksLikeMetric(before.word)) return text(before.word, 80)
      const after = entries[index + distance]
      if (after && !looksLikeMetric(after.word)) return text(after.word, 80)
    }
  }
  return fallback
}

/** Pair each extracted number with the nearest entity in the section. */
function extractNumericPoints(concepts, metrics, heading, avgScore, entries = []) {
  const entities = concepts.filter((concept) => !looksLikeMetric(concept))
  const fallback = entities[0] || heading
  const points = []
  for (const metric of metrics) {
    const slash = metric.match(SLASH_UNIT)
    const plain = slash ? null : metric.match(NUMBER_UNIT)
    const match = slash || plain
    if (!match) continue
    const value = Number(match[1])
    if (!Number.isFinite(value)) continue
    points.push({
      raw: metric,
      value,
      unit: slash ? slash[2] : (match[2] || '').replace(/^\s+/, ''),
      entity: nearestEntity(metric, entries, fallback),
      sectionHeading: heading,
      avgScore,
    })
  }
  return points
}

function buildSection(heading, entries, fallbackEntities, extra = {}) {
  const query = extra.query ?? ''
  const bucket = new Map()
  let order = 0
  const keep = (word) => !isPromptEcho(word, query)
  for (const entry of entries) {
    if (!keep(entry.word)) continue
    addConcept(bucket, entry.word, entry.score, order)
    order += 1
  }
  for (const entity of fallbackEntities) {
    if (!keep(entity)) continue
    addConcept(bucket, entity, 0, order)
    order += 1
  }

  const ranked = [...bucket.values()].sort((a, b) => b.score - a.score || a.order - b.order)
  // Entities and quantitative metrics are separate series so charts and
  // diagrams never treat "500 Wh/kg" as an entity name.
  const concepts = uniqueWords(
    ranked.filter((item) => !looksLikeMetric(item.word)).map((item) => item.word),
  ).slice(0, MAX_SECTION_CONCEPTS)
  const metrics = uniqueWords(ranked.filter((item) => looksLikeMetric(item.word)).map((item) => item.word)).slice(
    0,
    MAX_SECTION_METRICS,
  )
  const scores = entries.map((entry) => entry.score).filter((score) => score > 0)
  const avgScore = scores.length
    ? Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 10) / 10
    : 0
  const topScore = scores.length ? Math.round(Math.max(...scores) * 10) / 10 : 0

  const summaryParts = []
  if (concepts.length) summaryParts.push(`Concepts: ${excerpt(concepts.slice(0, 5), 110)}`)
  if (metrics.length) summaryParts.push(`Metrics: ${excerpt(metrics.slice(0, 4), 80)}`)

  return sectionFrom({
    heading,
    concepts,
    metrics,
    avgScore,
    topScore,
    gripCount: entries.length,
    dwellMs: Math.max(0, Math.round(numberish(extra.dwellMs))),
    words: Math.max(0, Math.round(numberish(extra.words))),
    numericSeries: extractNumericPoints(concepts, metrics, heading, avgScore, entries),
    summarySnippet: text(summaryParts.join(' · ') || 'No grips recorded in this section.', 200),
  })
}

/** Ordered section groups plus crawler-wide concept, metric and numeric rollups. */
export function formatInsectMemory(session) {
  const query = text(session?.query, 200)
  const grips = (Array.isArray(session?.grips) ? session.grips : []).filter(
    (grip) => grip && text(grip.word) && !isPromptEcho(grip.word, query),
  )
  const storedSections = Array.isArray(session?.sections) ? session.sections : []
  const storedConcepts = uniqueWords(
    Array.isArray(session?.topConcepts)
      ? session.topConcepts.map((item) => (typeof item === 'string' ? item : item?.word))
      : [],
  ).filter((word) => !isPromptEcho(word, query))

  const entitiesByHeading = new Map()
  for (const section of storedSections) {
    const heading = sanitizeHeading(section?.section ?? section?.heading) || DEFAULT_HEADING
    if (isPromptEcho(heading, query)) continue
    const key = keyOf(heading)
    if (!entitiesByHeading.has(key)) entitiesByHeading.set(key, { heading, entities: [], words: 0, dwellMs: 0 })
    const bucket = entitiesByHeading.get(key)
    const entities = uniqueWords(section?.lockedEntities ?? section?.concepts ?? []).filter(
      (word) => !isPromptEcho(word, query),
    )
    bucket.entities.push(...entities)
    bucket.words = Math.max(bucket.words, numberish(section?.words ?? section?.wordCount))
    bucket.dwellMs = Math.max(bucket.dwellMs, numberish(section?.dwellMs))
  }

  const ordered = []
  const byHeading = new Map()
  const sortedGrips = [...grips]
    .filter((grip) => !isPromptEcho(grip.sectionHeading, query))
    .sort((a, b) => numberish(a.timestamp) - numberish(b.timestamp))
  for (const grip of sortedGrips) {
    const heading = sanitizeHeading(grip.sectionHeading) || DEFAULT_HEADING
    if (isPromptEcho(heading, query)) continue
    const key = keyOf(heading)
    let group = byHeading.get(key)
    if (!group) {
      group = { heading, entries: [] }
      byHeading.set(key, group)
      ordered.push(group)
    }
    group.entries.push({ word: grip.word, score: scoreOf(grip.score) })
  }

  // Sections the spider filed without leaving a word-level grip still describe
  // where it dwelled, so keep them in document order after the grip groups.
  for (const bucket of entitiesByHeading.values()) {
    const key = keyOf(bucket.heading)
    if (byHeading.has(key)) continue
    byHeading.set(key, { heading: bucket.heading, entries: [] })
    ordered.push(byHeading.get(key))
  }

  const sections = ordered
    .slice(0, MAX_FORMAT_SECTIONS)
    .map((group) => {
      const bucket = entitiesByHeading.get(keyOf(group.heading))
      return buildSection(group.heading, group.entries, bucket?.entities ?? [], {
        query,
        words: bucket?.words ?? 0,
        dwellMs: bucket?.dwellMs ?? 0,
      })
    })
    .filter((section) => section.concepts.length || section.metrics.length || section.gripCount > 0)

  // Word share drives the volume axis. Sections the crawler only gripped (no
  // word count) fall back to their grip count so the chart stays meaningful.
  const volumeOf = (section) => (section.words > 0 ? section.words : section.gripCount)
  const totalVolume = sections.reduce((sum, section) => sum + volumeOf(section), 0)
  for (const section of sections) {
    section.wordShare = totalVolume ? Math.round((volumeOf(section) / totalVolume) * 1000) / 10 : 0
  }

  // Roll concepts up from the per-word grips so each entry keeps its real
  // salience instead of inheriting a whole-section average.
  const conceptBucket = new Map()
  let order = 0
  for (const grip of sortedGrips) {
    addConcept(conceptBucket, grip.word, scoreOf(grip.score), order)
    order += 1
  }
  for (const word of storedConcepts) {
    addConcept(conceptBucket, word, MIN_CONCEPT_SCORE, order)
    order += 1
  }
  for (const bucket of entitiesByHeading.values()) {
    for (const entity of bucket.entities) {
      addConcept(conceptBucket, entity, 0, order)
      order += 1
    }
  }

  const headingByConcept = new Map()
  for (const bucket of entitiesByHeading.values()) {
    for (const entity of bucket.entities) {
      if (!headingByConcept.has(keyOf(entity))) headingByConcept.set(keyOf(entity), bucket.heading)
    }
  }
  for (const section of sections) {
    for (const concept of section.concepts) {
      if (!headingByConcept.has(keyOf(concept))) headingByConcept.set(keyOf(concept), section.heading)
    }
  }

  const snippetFor = (word, heading) => {
    const hits = []
    sortedGrips.forEach((grip, index) => {
      if (keyOf(grip.word) !== keyOf(word)) return
      if (heading && keyOf(sanitizeHeading(grip.sectionHeading)) !== keyOf(heading)) return
      const around = sortedGrips.slice(Math.max(0, index - 2), index + 3).map((item) => text(item.word, 24))
      hits.push(around.join(' '))
    })
    return uniqueWords(hits).slice(0, 2)
  }

  const allRanked = [...conceptBucket.values()]
    .filter((item) => !looksLikeMetric(item.word))
    .sort((a, b) => b.score - a.score || a.order - b.order)
  const signalCount = allRanked.filter((item) => item.score >= MIN_CONCEPT_SCORE).length
  const signalToNoise = allRanked.length ? Math.round((signalCount / allRanked.length) * 100) : 0
  const topConcepts = allRanked.slice(0, MAX_TOP_CONCEPTS).map((item) => {
    const section = sections.find((candidate) => candidate.concepts.some((word) => keyOf(word) === keyOf(item.word)))
    const sectionHeading = section?.heading || headingByConcept.get(keyOf(item.word)) || DEFAULT_HEADING
    return {
      word: item.word,
      score: item.score,
      sectionHeading,
      snippets: snippetFor(item.word, sectionHeading),
    }
  })

  const numericSeries = []
  const seenNumeric = new Set()
  for (const section of sections) {
    for (const point of section.numericSeries) {
      const key = `${keyOf(point.raw)}|${keyOf(section.heading)}`
      if (seenNumeric.has(key)) continue
      seenNumeric.add(key)
      numericSeries.push(point)
    }
  }
  // A bare "500" next to "500 Wh/kg" in the same section is the same datum;
  // keep the version that carries a unit so charts do not double-count it.
  const united = new Set(
    numericSeries.filter((point) => point.unit).map((point) => `${point.value}|${keyOf(point.sectionHeading)}`),
  )
  const bestNumeric = numericSeries.filter(
    (point) => point.unit || !united.has(`${point.value}|${keyOf(point.sectionHeading)}`),
  )
  bestNumeric.sort((a, b) => b.value - a.value)
  bestNumeric.splice(MAX_NUMERIC_POINTS)

  const metrics = uniqueWords(sections.flatMap((section) => section.metrics)).slice(0, 24)
  const gripCount = sortedGrips.length || sections.reduce((sum, section) => sum + section.gripCount, 0)
  const scores = sections.map((section) => section.avgScore).filter((value) => value > 0)
  const averageScore = scores.length
    ? Math.round((scores.reduce((sum, value) => sum + value, 0) / scores.length) * 10) / 10
    : 0
  const highestSection =
    [...sections]
      .filter((section) => section.avgScore > 0)
      .sort((a, b) => b.avgScore - a.avgScore || b.topScore - a.topScore)[0] ?? null

  const stats = {
    sections: sections.length,
    concepts: topConcepts.length,
    metrics: metrics.length,
    grips: gripCount,
    averageScore,
    signalToNoise,
    numericPoints: bestNumeric.length,
    totalWords: sections.reduce((sum, section) => sum + section.words, 0),
    topEntity: topConcepts[0]?.word ?? '',
    topEntityScore: topConcepts[0]?.score ?? 0,
    highestSection: highestSection
      ? {
          heading: highestSection.heading,
          avgScore: highestSection.avgScore,
          topScore: highestSection.topScore,
          gripCount: highestSection.gripCount,
        }
      : null,
  }

  return {
    query,
    source: text(session?.source, 160),
    sections,
    topConcepts,
    numericSeries: bestNumeric,
    metrics,
    stats,
    traversalEdges: Array.isArray(session?.traversalEdges) ? session.traversalEdges : [],
    formattedContext: buildDigest({
      query,
      sections,
      topConcepts,
      stats,
    }),
  }
}

function buildDigest({ query, sections, topConcepts, stats }) {
  if (!sections.length && !topConcepts.length) return ''
  const lines = ['## Spider-foraged memory']
  if (query) lines.push(`Query: ${query}`)
  lines.push(
    `Coverage: ${stats.sections} sections · ${stats.concepts} concepts · ${stats.metrics} metrics · ${stats.grips} grips`,
  )
  if (topConcepts.length) {
    lines.push(`Top concepts: ${topConcepts.map((item) => item.word).join(', ')}`)
  }
  for (const section of sections) {
    if (lines.join('\n').length >= CONTEXT_CHAR_BUDGET) break
    const gripLabel = `${section.gripCount} ${section.gripCount === 1 ? 'grip' : 'grips'}`
    lines.push('', `### ${section.heading} (avg score ${section.avgScore || 'n/a'} · ${gripLabel})`)
    if (section.concepts.length) lines.push(`Concepts: ${section.concepts.join(', ')}`)
    if (section.metrics.length) lines.push(`Metrics: ${section.metrics.join(', ')}`)
  }
  if (lines.join('\n').length > CONTEXT_CHAR_BUDGET) {
    return `${lines.join('\n').slice(0, CONTEXT_CHAR_BUDGET - 1).trimEnd()}…`
  }
  return lines.join('\n')
}

