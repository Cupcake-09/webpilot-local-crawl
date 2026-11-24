/**
 * Quantitative extraction for the Julius & Napkin analytics.
 *
 * Everything here is pure: markdown in, chart-ready rows out. Numbers are read
 * from the whole generated essay (not only the words the spider happened to
 * grip), grouped by the section they appear in, and kept with a short context
 * snippet so a chart bar can explain itself. When the essay contains no
 * numbers at all, derived section metrics (signal-to-noise, entity density,
 * grips per 100 words) stand in so the comparison is never blank.
 */

const MAX_SECTIONS = 10
const MAX_POINTS_PER_SECTION = 6
const MAX_POINTS = 40

const UNIT_ALIASES = new Map(
  Object.entries({
    '%': ['%', 'percent'],
    percent: ['%', 'percent'],
    pct: ['%', 'percent'],
    bps: ['bps', 'percent'],
    ms: ['ms', 'time'],
    msec: ['ms', 'time'],
    millisecond: ['ms', 'time'],
    milliseconds: ['ms', 'time'],
    'µs': ['µs', 'time'],
    'μs': ['µs', 'time'],
    ns: ['ns', 'time'],
    s: ['s', 'time'],
    sec: ['s', 'time'],
    secs: ['s', 'time'],
    second: ['s', 'time'],
    seconds: ['s', 'time'],
    min: ['min', 'time'],
    mins: ['min', 'time'],
    minute: ['min', 'time'],
    minutes: ['min', 'time'],
    h: ['h', 'time'],
    hr: ['h', 'time'],
    hrs: ['h', 'time'],
    hour: ['h', 'time'],
    hours: ['h', 'time'],
    day: ['day', 'time'],
    days: ['day', 'time'],
    week: ['week', 'time'],
    weeks: ['week', 'time'],
    month: ['month', 'time'],
    months: ['month', 'time'],
    year: ['year', 'year'],
    years: ['year', 'year'],
    yr: ['year', 'year'],
    yrs: ['year', 'year'],
    x: ['×', 'ratio'],
    '×': ['×', 'ratio'],
    times: ['×', 'ratio'],
    fold: ['×', 'ratio'],
    pt: ['pts', 'ratio'],
    pts: ['pts', 'ratio'],
    point: ['pts', 'ratio'],
    points: ['pts', 'ratio'],
    ghz: ['GHz', 'frequency'],
    mhz: ['MHz', 'frequency'],
    khz: ['kHz', 'frequency'],
    hz: ['Hz', 'frequency'],
    'tb/s': ['TB/s', 'throughput'],
    'gb/s': ['GB/s', 'throughput'],
    'mb/s': ['MB/s', 'throughput'],
    mbps: ['Mbps', 'throughput'],
    gbps: ['Gbps', 'throughput'],
    twh: ['TWh', 'energy'],
    gwh: ['GWh', 'energy'],
    mwh: ['MWh', 'energy'],
    kwh: ['kWh', 'energy'],
    wh: ['Wh', 'energy'],
    'wh/kg': ['Wh/kg', 'energy'],
    'w/kg': ['W/kg', 'energy'],
    kw: ['kW', 'power'],
    mw: ['MW', 'power'],
    gw: ['GW', 'power'],
    nm: ['nm', 'size'],
    mm: ['mm', 'size'],
    cm: ['cm', 'size'],
    km: ['km', 'size'],
    gb: ['GB', 'size'],
    tb: ['TB', 'size'],
    mb: ['MB', 'size'],
    kb: ['KB', 'size'],
    pb: ['PB', 'size'],
    mt: ['Mt', 'mass'],
    gt: ['Gt', 'mass'],
    kt: ['kt', 'mass'],
    kg: ['kg', 'mass'],
    g: ['g', 'mass'],
    ton: ['t', 'mass'],
    tons: ['t', 'mass'],
    tonne: ['t', 'mass'],
    tonnes: ['t', 'mass'],
    usd: ['$', 'currency'],
    eur: ['€', 'currency'],
    gbp: ['£', 'currency'],
  }),
)

const SCALE_SUFFIXES = new Map([
  ['k', 1e3],
  ['thousand', 1e3],
  ['m', 1e6],
  ['mn', 1e6],
  ['million', 1e6],
  ['b', 1e9],
  ['bn', 1e9],
  ['billion', 1e9],
  ['trillion', 1e12],
])

// Digits, optional currency prefix, optional comparison sign, optional unit or
// noun. Long digit groups are matched first so "1,200" never becomes "1".
// The match starts on the number (or its currency sign) so the boundary check
// can see the real preceding character.
const NUMBER_SCAN =
  /([$€£])?([~<>≈+\-−]?)(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s?([A-Za-z%µμ][A-Za-z0-9%/µμ]*))?/g

const cleanText = (value, limit = 160) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)

const cleanProse = (value) =>
  String(value ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[\d+\]/g, ' ')
    .replace(/[#*_>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const round1 = (value) => Math.round(value * 10) / 10
const headingText = (value) =>
  cleanText(String(value ?? '').replace(/^#{1,6}\s*/, '').replace(/^\d+[.)]\s*/, ''), 90)

/** Split the essay into sections by markdown heading, else by paragraphs. */
export function splitResearchSections(markdown) {
  const source = String(markdown ?? '')
  if (!source.trim()) return []
  const lines = source.split(/\r?\n/)
  const blocks = []
  let current = { heading: 'Opening', lines: [] }
  let sawHeading = false

  for (const line of lines) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/)
    if (heading) {
      if (current.lines.join('').trim()) blocks.push(current)
      current = { heading: headingText(heading[1]) || 'Section', lines: [] }
      sawHeading = true
      continue
    }
    current.lines.push(line)
  }
  if (current.lines.join('').trim()) blocks.push(current)

  if (sawHeading) {
    return blocks
      .map((block) => ({ heading: block.heading, text: cleanProse(block.lines.join(' ')) }))
      .filter((block) => block.text)
  }

  // No headings: treat blank-line paragraphs as sections, titled by their
  // opening words so chart categories stay meaningful.
  return source
    .split(/\n{2,}/)
    .map((paragraph) => cleanProse(paragraph))
    .filter(Boolean)
    .map((paragraph) => {
      const words = paragraph.split(' ').slice(0, 7).join(' ')
      return { heading: `${words}${paragraph.split(' ').length > 7 ? '…' : ''}`, text: paragraph }
    })
}

function readUnit(token) {
  const raw = String(token ?? '').trim()
  if (!raw) return null
  const trimmed = raw.replace(/[.,;:)\]"'”’]+$/g, '').toLowerCase()
  if (!trimmed) return null
  const alias = UNIT_ALIASES.get(trimmed)
  if (alias) return { unit: alias[0], family: alias[1], countNoun: '' }
  const scale = SCALE_SUFFIXES.get(trimmed)
  if (scale) return { unit: '', family: 'scale', scale, countNoun: '' }
  // Unknown but plural word after a bare count ("12 models") is a count.
  if (/^[a-z][a-z-]{2,}s$/.test(trimmed)) {
    return { unit: 'count', family: 'count', countNoun: trimmed }
  }
  return null
}

function readContext(text, index, length) {
  const start = Math.max(0, index - 58)
  const end = Math.min(text.length, index + length + 46)
  const raw = cleanProse(text.slice(start, end))
  return `${start > 0 ? '…' : ''}${raw}${end < text.length ? '…' : ''}`.slice(0, 150)
}

/** Pull one section's numbers out with their units, values and context. */
function extractSectionPoints(section) {
  const text = section.text
  const points = []
  const seen = new Set()
  NUMBER_SCAN.lastIndex = 0
  let match = NUMBER_SCAN.exec(text)
  while (match) {
    const index = match.index
    const before = index === 0 ? ' ' : text[index - 1]
    const after = text[index + match[0].length] ?? ' '
    const currency = match[1]
    const digits = match[3]
    const suffix = match[4]
    const numeric = Number(digits.replace(/,/g, ''))

    const trustworthyBoundary = !/[\w$€£.,/]/.test(before) && !/[\w]/.test(after)
    const unitInfo = readUnit(suffix)
    const scale = unitInfo?.scale ?? 1
    let value = numeric * scale
    let unit = unitInfo?.unit ?? ''
    let family = unitInfo?.family ?? ''
    let label = cleanText(match[0], 46)

    if (currency) {
      unit = currency
      family = 'currency'
    }
    if (!unitInfo && !currency) {
      // Bare numbers: keep years and comma-grouped/large counts, drop the rest
      // so versions ("GPT-4"), list markers and identifiers never leak in.
      const isYear = /^\d{4}$/.test(digits) && numeric >= 1900 && numeric <= 2099
      if (isYear) {
        unit = 'year'
        family = 'year'
      } else if (/,/.test(digits) || numeric >= 1000) {
        unit = 'count'
        family = 'count'
      } else {
        match = NUMBER_SCAN.exec(text)
        continue
      }
    }
    if (unitInfo?.countNoun) {
      label = cleanText(`${digits} ${unitInfo.countNoun}`, 46)
    }
    if (!Number.isFinite(value) || value <= 0 || value > 1e15) {
      match = NUMBER_SCAN.exec(text)
      continue
    }
    if (unit === '' && family === 'scale') {
      unit = 'count'
      family = 'count'
    }
    if (!trustworthyBoundary) {
      match = NUMBER_SCAN.exec(text)
      continue
    }
    const key = `${label.toLowerCase()}|${value}|${unit}`
    if (!seen.has(key)) {
      seen.add(key)
      points.push({
        label,
        value,
        unit,
        family,
        sectionHeading: section.heading,
        context: readContext(text, index, match[0].length),
      })
    }
    if (points.length >= MAX_POINTS_PER_SECTION) break
    match = NUMBER_SCAN.exec(text)
  }
  return points
}

/** Full-text metric extraction, grouped by section. */
export function extractTextMetrics(markdown) {
  const sections = splitResearchSections(markdown)
    .slice(0, MAX_SECTIONS)
    .map((section) => ({ heading: section.heading, points: extractSectionPoints(section) }))
    .filter((section) => section.points.length)

  const rows = []
  for (const section of sections) {
    for (const point of section.points) {
      if (rows.length >= MAX_POINTS) break
      rows.push(point)
    }
  }

  return {
    rows,
    total: rows.length,
    sections: sections.length,
    hasNumbers: rows.length > 0,
    fallback: false,
  }
}

/** Derived section metrics used when the essay contains no numbers at all. */
export function buildFallbackMetrics(sections = []) {
  const rows = []
  for (const section of sections) {
    const words = Number(section?.words) || Number(section?.gripCount) || 0
    if (!words) continue
    const heading = section.heading || 'General Context'
    const grips = Number(section.gripCount) || 0
    const concepts = Array.isArray(section.concepts) ? section.concepts.length : 0
    const snr = Number.isFinite(section.signalShare)
      ? section.signalShare
      : Math.min(100, round1((Number(section.avgScore) || 0) * 12.5))
    rows.push({
      label: 'Signal-to-Noise Ratio',
      value: round1(snr),
      unit: '%',
      family: 'percent',
      sectionHeading: heading,
      context: `${grips} grips · avg salience ${round1(Number(section.avgScore) || 0)}/10`,
    })
    rows.push({
      label: 'Entity Density',
      value: round1((concepts / words) * 100),
      unit: 'concepts/100w',
      family: 'count',
      sectionHeading: heading,
      context: `${concepts} concepts across ${words} words`,
    })
    rows.push({
      label: 'Grips per 100 Words',
      value: round1((grips / words) * 100),
      unit: 'grips/100w',
      family: 'count',
      sectionHeading: heading,
      context: `${grips} grips across ${words} words`,
    })
  }
  const usable = rows.filter((row) => row.value > 0)
  return {
    rows: usable,
    total: usable.length,
    sections: new Set(usable.map((row) => row.sectionHeading)).size,
    hasNumbers: false,
    fallback: true,
  }
}

/** Adapt crawler-era numeric points (from spider memory) to the same rows. */
export function rowsFromNumericPoints(points = []) {
  return points.map((point) => {
    const unit = cleanText(point.unit, 12) || 'count'
    const family = UNIT_ALIASES.get(unit.toLowerCase())?.[1] ?? 'count'
    return {
      label: cleanText(point.raw, 46) || `${point.value}`,
      value: Number(point.value) || 0,
      unit,
      family,
      sectionHeading: point.sectionHeading || 'General Context',
      context: point.entity ? `paired with “${point.entity}”` : '',
    }
  })
}

export const SIGNAL_RATINGS = ['High Signal', 'Balanced', 'Filler-Heavy']

/** Bucket a section's semantic density into a plain-language rating. */
export function signalRating(section) {
  const score = Number(section?.avgScore) || 0
  const grips = Number(section?.gripCount) || 0
  if (!grips && !score) return 'Filler-Heavy'
  if (score >= 5.4) return 'High Signal'
  if (score >= 3.1) return 'Balanced'
  return 'Filler-Heavy'
}
