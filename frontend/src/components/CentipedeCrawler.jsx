import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { downloadCSV } from '../lib/api.js'
import {
  MAX_EDGES,
  MAX_ENTITIES,
  MAX_MEMORY_WORDS,
  MAX_SECTIONS,
  MEMORY_FLUSH_MS,
} from '../lib/insectMemory.js'

/**
 * DOM crawler for the research stage.
 *
 * The legs and gait follow web-crawlers/js/crawler.js: 8 legs + 2 palps,
 * two-bone analytic IK with a fixed knee side, tetrapod gait, and
 * urgent/over-extension retraction. The body is an exact four-segment
 * articulated oval: head, two thorax segments, and a larger abdomen.
 *
 * Three deliberate changes keep it usable inside a research stage:
 *  - word boxes are measured once and cached; the animation frame loop never
 *    calls getBoundingClientRect();
 *  - transient word and filler mutations use transform/opacity only;
 *  - bounded session telemetry rolls up from the rAF closure and flushes at
 *    1.5s intervals and on completion.
 */

const STARTER = `# WebPilot research

Ask a question and this page becomes a streaming research essay. Paste a URL and WebPilot reads that page instead. The spider above is the original open-source DOM crawler, walking real words as they arrive.

Auto-iterate keeps the spider moving through the incoming text, marking key phrases in slate blue and filing entities into the notes drawer. Follow cursor parks the autonomous reader and lets the same legs walk toward your pointer at a relaxed pace, stepping from word to word as it goes.

Everything runs locally. The FastAPI engine talks to your own model endpoint, and the generator routes turn the finished research into a bar, line and breakdown chart set, a concept map, and a two-host audio overview.`

const STOPWORDS = new Set(
  `the and for with from that this what which into about your their have has are was were will can how why who when all any best top find show list map most more than then over under using use should could would of in on to a an is it be by or as at we you our where next page pages here these those also its but not they them been being does did doing each few other some such only own same very just now one two may much many well make made like still even`.split(
    ' ',
  ),
)

const TERMINAL = /[.!?]["')\]]?$/
const SIGNAL = /^[A-Z0-9]/

const BODY_SEGMENTS = 4
const MAX_LEG_LENGTH = 82
const MAX_WORD_SNAP_RADIUS = 84
const MAX_STEP_THRESHOLD = 52
const GLITCH_MS = 650

function stripInline(text) {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_`~]+/g, '')
    .trim()
}

function isFiller(token) {
  return STOPWORDS.has(token.toLowerCase().replace(/[^a-z']/g, ''))
}

/** Markdown → blocks of word ids, plus narrative sentences and key phrases. */
function parseReading(markdown, streaming) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n')
  const blocks = []
  const words = []
  let nextId = 0
  let inCode = false

  const addWords = (text, narrative) => {
    const ids = []
    for (const token of text.split(/\s+/)) {
      if (!token) continue
      const id = nextId++
      words.push({ id, text: token, filler: isFiller(token), narrative, sentence: null })
      ids.push(id)
    }
    return ids
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (/^```/.test(trimmed)) {
      inCode = !inCode
      continue
    }
    if (inCode || !trimmed) continue

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      const level = Math.min(heading[1].length, 3)
      blocks.push({ type: `h${level}`, wordIds: addWords(stripInline(heading[2]), false) })
      continue
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(trimmed)) {
      blocks.push({ type: 'hr', wordIds: [] })
      continue
    }
    const list = trimmed.match(/^[-*+]\s+(.*)$/) || trimmed.match(/^\d+[.)]\s+(.*)$/)
    if (list) {
      blocks.push({ type: 'li', wordIds: addWords(stripInline(list[1]), true) })
      continue
    }
    if (/^>\s?/.test(trimmed)) {
      blocks.push({ type: 'quote', wordIds: addWords(stripInline(trimmed.replace(/^>\s?/, '')), true) })
      continue
    }
    blocks.push({ type: 'p', wordIds: addWords(stripInline(trimmed), true) })
  }

  const sentences = []
  const finalize = (start, end) => {
    if (end < start || end - start < 2) return
    const slice = words.slice(start, end + 1)
    const text = slice.map((word) => word.text).join(' ')
    if (!text) return
    const id = sentences.length
    let keyStart = start
    let keyEnd = Math.min(end, start + 3)
    let best = null
    for (let index = start; index <= end; index += 1) {
      if (!SIGNAL.test(words[index].text.replace(/^["'(\[]+/, ''))) continue
      if (words[index].filler) continue
      let last = index
      while (last + 1 <= end && last - index < 4 && SIGNAL.test(words[last + 1].text.replace(/^["'(\[]+/, ''))) {
        last += 1
      }
      if (last > index && (!best || last - index > best[1] - best[0])) best = [index, last]
    }
    if (best) {
      keyStart = best[0]
      keyEnd = best[1]
    } else {
      const content = []
      for (let index = start; index <= end && content.length < 4; index += 1) {
        if (!words[index].filler) content.push(index)
      }
      if (content.length >= 2) {
        keyStart = content[0]
        keyEnd = content[Math.min(3, content.length - 1)]
      }
    }
    for (let index = start; index <= end; index += 1) words[index].sentence = id
    sentences.push({ id, start, end, text, keyStart, keyEnd })
  }

  let runStart = null
  for (let index = 0; index < words.length; index += 1) {
    if (!words[index].narrative) {
      if (runStart !== null) {
        finalize(runStart, index - 1)
        runStart = null
      }
      continue
    }
    if (runStart === null) runStart = index
    if (TERMINAL.test(words[index].text)) {
      finalize(runStart, index)
      runStart = null
    }
  }
  // While tokens are still arriving the trailing run is incomplete; leave it
  // unsentenced so a half-sentence never files a truncated row.
  if (runStart !== null && !streaming) finalize(runStart, words.length - 1)

  return { blocks, words, sentences }
}

function WordRun({ ids, words }) {
  return ids.map((id, index) => (
    <Fragment key={id}>
      {index > 0 ? ' ' : null}
      <span className="rw" data-wid={id}>
        {words[id].text}
      </span>
    </Fragment>
  ))
}

function ReadingBody({ model }) {
  return model.blocks.map((block, index) => {
    const content = <WordRun ids={block.wordIds} words={model.words} />
    if (block.type === 'hr') return <hr key={index} className="reader-rule" />
    if (block.type === 'h1') return <h1 key={index}>{content}</h1>
    if (block.type === 'h2') return <h2 key={index}>{content}</h2>
    if (block.type === 'h3') return <h3 key={index}>{content}</h3>
    if (block.type === 'li') {
      return (
        <div key={index} className="reader-li" role="listitem">
          <span className="reader-bullet" aria-hidden="true">
            &bull;
          </span>
          <span>{content}</span>
        </div>
      )
    }
    if (block.type === 'quote') return <blockquote key={index}>{content}</blockquote>
    return <p key={index}>{content}</p>
  })
}

export default function CentipedeCrawler({ markdown, streaming, mode, query, source, sessionId, completed, onTelemetry, telemetryExportRef }) {
  const contentRef = useRef(null)
  const canvasRef = useRef(null)
  const cacheRef = useRef({
    words: [],
    sentences: [],
    blocks: [],
    wordBlock: [],
    blockWordCount: [],
    sectionInfo: [],
    wordSection: [],
    boxes: new Map(),
    els: new Map(),
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    width: 0,
  })
  const model = useMemo(() => parseReading(markdown || STARTER, streaming), [markdown, streaming])
  const modelRef = useRef(model)
  modelRef.current = model

  const modeRef = useRef(mode)
  modeRef.current = mode
  const metaRef = useRef({ query, source, sessionId, completed })
  metaRef.current = { query, source, sessionId, completed }
  const telemetryHandlerRef = useRef(onTelemetry)
  telemetryHandlerRef.current = onTelemetry

  const telemetryStateRef = useRef(null)
  const [rows, setRows] = useState([])
  const [drawerOpen, setDrawerOpen] = useState(
    () => typeof window === 'undefined' || window.matchMedia('(min-width: 1024px)').matches,
  )
  const [readCount, setReadCount] = useState(0)
  const rowKeysRef = useRef(new Set())
  const rowHandlerRef = useRef(() => {})
  rowHandlerRef.current = (row) => {
    if (!row || rowKeysRef.current.has(row.key)) return
    rowKeysRef.current.add(row.key)
    setRows((previous) => [...previous.slice(-199), row])
  }
  const readHandlerRef = useRef(() => {})
  readHandlerRef.current = (count) => setReadCount(count)

  const measureRef = useRef(() => {})

  useLayoutEffect(() => {
    const measure = () => {
      const el = contentRef.current
      if (!el) return
      const cache = cacheRef.current
      const activeModel = modelRef.current
      cache.words = activeModel.words
      cache.sentences = activeModel.sentences
      cache.blocks = activeModel.blocks
      cache.wordBlock = new Array(activeModel.words.length).fill(0)
      cache.blockWordCount = activeModel.blocks.map((block) => block.wordIds.length)
      activeModel.blocks.forEach((block, blockIndex) => {
        for (const id of block.wordIds) cache.wordBlock[id] = blockIndex
      })

      const sections = []
      let section = null
      const ensureSection = (title) => {
        section = { index: sections.length, title, wordIds: [] }
        sections.push(section)
        return section
      }
      activeModel.blocks.forEach((block) => {
        if (block.type.startsWith('h')) {
          const title = block.wordIds.map((id) => activeModel.words[id]?.text || '').join(' ').trim()
          ensureSection(title || `Section ${sections.length + 1}`)
        } else if (!section) {
          ensureSection('Opening')
        }
        section.wordIds.push(...block.wordIds)
      })
      if (!sections.length) ensureSection('Opening')
      cache.sectionInfo = sections.map((item) => ({ ...item, wordCount: item.wordIds.length }))
      cache.wordSection = new Array(activeModel.words.length).fill(0)
      for (const item of cache.sectionInfo) {
        for (const id of item.wordIds) cache.wordSection[id] = item.index
      }

      const rect = el.getBoundingClientRect()
      const left = rect.left + window.scrollX
      const top = rect.top + window.scrollY
      if (Math.abs(rect.width - cache.width) > 0.5 || Math.abs(left - cache.left) > 0.5) {
        cache.boxes.clear()
      }
      cache.left = left
      cache.top = top
      cache.right = left + rect.width
      cache.bottom = top + rect.height
      cache.width = rect.width

      const spans = el.querySelectorAll('[data-wid]')
      cache.els = new Map()
      spans.forEach((span) => {
        const id = Number(span.dataset.wid)
        cache.els.set(id, span)
        const cached = cache.boxes.get(id)
        if (cached && cached.text === span.textContent) return
        if (cached) cache.boxes.delete(id)
        const box = span.getBoundingClientRect()
        if (!box.width && !box.height) return
        cache.boxes.set(id, {
          x: box.left + window.scrollX,
          y: box.top + window.scrollY,
          w: box.width,
          h: box.height,
          text: span.textContent,
        })
      })
    }
    measureRef.current = measure
    measure()
  }, [model, drawerOpen])

  useEffect(() => {
    const el = contentRef.current
    if (!el) return undefined
    // Measure synchronously in the observer callback (after layout, outside any
    // animation frame) so the rAF loop never reads geometry.
    const observer = new ResizeObserver(() => measureRef.current())
    observer.observe(el)
    const onResize = () => {
      cacheRef.current.boxes.clear()
      measureRef.current()
    }
    window.addEventListener('resize', onResize)
    if (document.fonts?.ready) document.fonts.ready.then(onResize).catch(() => {})
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', onResize)
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined
    const cache = cacheRef.current

    const R = Math.random
    const pick = (list) => list[(R() * list.length) | 0]
    const clamp = (value, min, max) => (value < min ? min : value > max ? max : value)
    const V = (x = 0, y = 0) => ({ x, y })
    const add = (a, b) => V(a.x + b.x, a.y + b.y)
    const sub = (a, b) => V(a.x - b.x, a.y - b.y)
    const mul = (a, scalar) => V(a.x * scalar, a.y * scalar)
    const length = (a) => Math.hypot(a.x, a.y)
    const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
    const lerp = (a, b, t) => V(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
    const mix = (a, b, t) => a + (b - a) * t
    const rotate = (v, angle) => {
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      return V(v.x * cos - v.y * sin, v.x * sin + v.y * cos)
    }
    const capLength = (v, max) => {
      const l = length(v)
      return l > max ? mul(v, max / l) : v
    }
    const angleLerp = (a, b, t) => {
      let delta = b - a
      while (delta > Math.PI) delta -= 2 * Math.PI
      while (delta < -Math.PI) delta += 2 * Math.PI
      return a + delta * t
    }
    const damp = (k, dt) => 1 - Math.exp(-k * dt)
    const range = ([a, b]) => a + R() * (b - a)

    // Monochrome palette with a single slate-blue accent, matching the UI.
    const C = {
      femur: '#ECECEC',
      tibia: '#8F8F8F',
      joint: '#38BDF8',
      body: '#E4E4E4',
      bodyFill: 'rgba(33,33,33,.9)',
    }
    const THREAD_COLORS = ['#475569', '#64748B', '#94A3B8']

    const SCALE = window.innerWidth < 640 ? 1.02 : 1.32
    const BODY_S = SCALE * 0.95
    const BODY_DEF = [
      { gap: 0, rx: 8.8, ry: 7.1 },
      { gap: 13.2, rx: 9.8, ry: 7.7 },
      { gap: 27.2, rx: 10.6, ry: 8.3 },
      { gap: 43.4, rx: 13.4, ry: 10.8 },
    ]
    const LW = 1.35 * Math.sqrt(SCALE)
    const DR = Math.pow(SCALE, 0.6)
    const T = {
      cruise: 210,
      lure: 880,
      cursor: 165,
      burstFloor: 0.6,
      stopChance: 0.04,
      stopTime: [0.25, 0.6],
      arrive: 48,
      stepFrac: 0.68,
      urgentFrac: 0.5,
      overFrac: 0.92,
      placeFrac: 0.85,
      lead: 0.28,
      leadMax: 0.3,
      threadEvery: [0.5, 1.1],
      threadMax: 4,
      threadRange: 230,
    }

    const LEG_DEF = [
      [0.55, 118, 7],
      [1.15, 106, 3],
      [1.95, 106, -1],
      [2.55, 126, -5],
      [0.22, 38, 10],
    ]
    const rawLegs = []
    for (const side of [1, -1]) {
      LEG_DEF.forEach(([angle, reach, hip], index) => {
        rawLegs.push({
          side,
          idx: index,
          ang: angle * side,
          rawReach: reach * SCALE,
          hip: hip * SCALE,
          palp: index === 4,
          foot: null,
          next: null,
          from: null,
          t: 0,
          dur: 0.15,
          stepping: false,
          bend: (index === 3 || index === 4 ? 1 : -1) * side,
          tint: null,
          tintUntil: 0,
          knee: V(),
          tip: V(),
        })
      })
    }
    const NATURAL_LEG_SPAN = 72
    const rawLongest = Math.max(...rawLegs.map((leg) => leg.rawReach * 1.2))
    const LEG_SCALE = rawLongest ? NATURAL_LEG_SPAN / rawLongest : 1
    const legs = rawLegs.map((leg) => ({
      ...leg,
      reach: leg.rawReach * LEG_SCALE,
      L1: leg.rawReach * 0.56 * LEG_SCALE,
      L2: leg.rawReach * 0.64 * LEG_SCALE,
    }))
    const LEG_MAX = Math.max(...legs.map((leg) => leg.L1 + leg.L2))

    const S = {
      p: V(0, 0),
      v: V(),
      heading: Math.PI / 2,
      stopUntil: 0,
      brake: false,
      target: V(),
      tUntil: 0,
      phase: R() * 10,
      spine: Array.from({ length: BODY_SEGMENTS }, () => V()),
      abd: V(),
      spin: V(),
    }

    let W = 0
    let H = 0
    let DPR = 1
    let now = 0
    let bodyReady = false
    let readIndex = 0
    let lastReadCount = -1
    let camY = 0
    let cameraHold = 0
    const mouse = { x: 0, y: 0, has: false }
    const marked = new Set()
    const emitted = new Set()
    const activeFills = new Map()
    const threads = []
    const flashes = []
    const queue = { add: [], remove: [], fill: [] }
    const activeGlitches = new Map()
    const glitchUntil = new Map()
    const touchedWords = new Set()
    const telemetry =
      telemetryStateRef.current ||
      (telemetryStateRef.current = {
        startedAt: Date.now(),
        dwellMs: 0,
        gripCount: 0,
        grips: new Set(),
        sectionDwell: new Map(),
        sectionGrips: new Map(),
        sectionEntities: new Map(),
        traversalEdges: new Map(),
        lastSection: null,
        lastFlush: 0,
        completedFlush: false,
      })

    let docBottom = 0
    let frameNumber = 0
    let gripActive = false

    function resizeCanvas() {
      DPR = Math.min(2, window.devicePixelRatio || 1)
      W = window.innerWidth
      H = window.innerHeight
      canvas.width = Math.round(W * DPR)
      canvas.height = Math.round(H * DPR)
      canvas.style.width = `${W}px`
      canvas.style.height = `${H}px`
    }

    function refreshBounds() {
      docBottom = cache.bottom
    }

    function safeBox() {
      const margin = Math.min(LEG_MAX * 0.7, W * 0.3)
      let left = cache.left + 36
      let right = cache.right - 36
      if (right < left) left = right = (left + right) / 2
      return {
        l: Math.max(left, window.scrollX + margin * 0.35),
        r: Math.min(right, window.scrollX + W - margin * 0.35),
        t: cache.top + 24,
        b: Math.max(cache.top + 160, cache.bottom - 24),
      }
    }

    function anchorPos(anchor) {
      if (anchor.id != null) {
        const box = cache.boxes.get(anchor.id)
        if (box) {
          anchor.x = box.x + anchor.u * box.w
          anchor.y = box.y + anchor.v * box.h
        }
      }
      return V(anchor.x, anchor.y)
    }

    /** Word box containing a point. No DOM reads. */
    function wordAtPoint(point) {
      for (const word of cache.words) {
        const box = cache.boxes.get(word.id)
        if (!box) continue
        if (point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h) {
          return word.id
        }
      }
      return null
    }

    /** Nearest cached word to a point. No DOM reads. */
    function findAnchor(point, radius = 18) {
      let best = null
      let bestDistance = Infinity
      for (const word of cache.words) {
        const box = cache.boxes.get(word.id)
        if (!box) continue
        const nearestX = clamp(point.x, box.x, box.x + box.w)
        const nearestY = clamp(point.y, box.y, box.y + box.h)
        const d = Math.hypot(nearestX - point.x, nearestY - point.y)
        if (d < bestDistance && d <= radius * 2.4) {
          bestDistance = d
          const u = clamp((point.x - box.x) / Math.max(1, box.w), 0.12, 0.88)
          const v = clamp((point.y - box.y) / Math.max(1, box.h), 0.3, 0.7)
          best = { id: word.id, u, v, x: box.x + u * box.w, y: box.y + v * box.h }
        }
      }
      return best || { id: null, u: 0.5, v: 0.5, x: point.x, y: point.y }
    }

    /**
     * Foot-target selector. A foot may only take a cached word that is within
     * MAX_WORD_SNAP_RADIUS of its natural rest position and within physical leg
     * reach. With no such word it plants on blank canvas at the rest position.
     */
    function findFoothold(leg) {
      const hip = hipPos(leg)
      const rest = restPos(leg)
      const target = stepTarget(leg)
      const maxLength = Math.min(MAX_LEG_LENGTH, leg.L1 + leg.L2)
      let best = null
      let bestScore = Infinity

      for (const word of cache.words) {
        const box = cache.boxes.get(word.id)
        if (!box) continue
        const restX = clamp(rest.x, box.x, box.x + box.w)
        const restY = clamp(rest.y, box.y, box.y + box.h)
        if (Math.hypot(restX - rest.x, restY - rest.y) > MAX_WORD_SNAP_RADIUS) continue

        const targetX = clamp(target.x, box.x, box.x + box.w)
        const targetY = clamp(target.y, box.y, box.y + box.h)
        const score = Math.hypot(targetX - target.x, targetY - target.y)
        if (score >= bestScore) continue

        const u = clamp((target.x - box.x) / Math.max(1, box.w), 0.12, 0.88)
        const v = clamp((target.y - box.y) / Math.max(1, box.h), 0.3, 0.7)
        const x = box.x + u * box.w
        const y = box.y + v * box.h
        if (Math.hypot(x - hip.x, y - hip.y) > maxLength - 0.01) continue

        best = { id: word.id, u, v, x, y }
        bestScore = score
      }

      return best || { id: null, u: 0.5, v: 0.5, x: rest.x, y: rest.y }
    }

    const forward = () => V(Math.cos(S.heading), Math.sin(S.heading))
    const hipPos = (leg) => add(S.p, rotate(V(leg.hip, leg.side * 3 * SCALE), S.heading))
    const restPos = (leg) => {
      const k = leg.palp ? 0.96 : 0.9
      return add(hipPos(leg), rotate(V(Math.cos(leg.ang) * leg.reach * k, Math.sin(leg.ang) * leg.reach * k), S.heading))
    }
    const stepTarget = (leg) => {
      const hip = hipPos(leg)
      const point = add(restPos(leg), capLength(mul(S.v, T.lead), leg.reach * T.leadMax))
      return add(hip, capLength(sub(point, hip), (leg.L1 + leg.L2) * T.placeFrac))
    }

    function pickWander() {
      const box = safeBox()
      const centre = (box.l + box.r) / 2
      const half = Math.max(20, (box.r - box.l) / 2)
      const gaussian = (R() + R() + R() - 1.5) / 1.5
      const x = clamp(mix(centre + gaussian * half * 0.75, S.p.x, 0.45), box.l, box.r)
      const y = clamp(
        S.p.y + range([120, 340]),
        box.t,
        Math.max(box.t + 140, box.b),
      )
      S.target = V(x, y)
      S.tUntil = now + 2 + R() * 2.5
      S.brake = false
    }

    function resetSpine() {
      const back = mul(forward(), -1)
      for (let index = 0; index < BODY_SEGMENTS; index += 1) {
        S.spine[index] = add(S.p, mul(back, BODY_DEF[index].gap * BODY_S))
      }
      S.abd = S.spine[BODY_SEGMENTS - 1]
      S.spin = add(S.abd, mul(back, 7 * BODY_S))
    }

    function initBody() {
      const firstWord = cache.words.find((word) => cache.boxes.has(word.id))
      if (!firstWord) return
      const box = cache.boxes.get(firstWord.id)
      S.p = V(box.x + box.w / 2, Math.max(cache.top + 40, box.y - 34 * SCALE))
      S.target = V(box.x + box.w / 2, box.y + box.h / 2)
      S.tUntil = now + 3
      resetSpine()
      for (const leg of legs) leg.foot = findFoothold(leg)
      bodyReady = true
      camY = Math.max(0, S.p.y - H * 0.46)
    }

    function steppingCount() {
      let count = 0
      for (const leg of legs) if (leg.stepping) count += 1
      return count
    }

    function neighbourStepping(leg) {
      for (const other of legs) {
        if (other.stepping && other.side === leg.side && Math.abs(other.idx - leg.idx) === 1 && !other.palp && !leg.palp) {
          return true
        }
      }
      return false
    }

    function startStep(leg, quick) {
      const hip = hipPos(leg)
      const full = leg.L1 + leg.L2
      let from = leg.foot ? anchorPos(leg.foot) : restPos(leg)
      const delta = sub(from, hip)
      const deltaLength = length(delta)
      if (deltaLength > full) from = add(hip, mul(delta, full / deltaLength))
      leg.from = from
      leg.next = findFoothold(leg)
      leg.t = 0
      leg.dur = quick ? 0.07 + R() * 0.04 : (leg.palp ? 0.08 : 0.1) + R() * 0.07
      leg.stepping = true
    }

    function markClass(word, cls) {
      if (!word) return
      const key = `${cls}:${word.id}`
      if (marked.has(key)) return
      marked.add(key)
      queue.add.push([word.id, cls])
    }

    function mutateFiller(word) {
      if (!word?.filler) return
      if (activeFills.has(word.id)) return
      activeFills.set(word.id, now + 0.9)
      queue.add.push([word.id, 'mut-fill'])
    }

    function glitchWord(word) {
      if (!word || word.id == null) return
      if (now < (glitchUntil.get(word.id) || 0)) return
      const until = now + GLITCH_MS / 1000 + 0.05
      glitchUntil.set(word.id, until)
      activeGlitches.set(word.id, until)
      queue.add.push([word.id, 'word-glitch-vanish'])
    }

    function sectionIndexAt(wordIndex) {
      return cache.wordSection[clamp(wordIndex, 0, Math.max(0, cache.words.length - 1))] ?? 0
    }

    function highlightSentence(sentence) {
      for (let index = sentence.keyStart; index <= sentence.keyEnd; index += 1) {
        markClass(cache.words[index], 'key')
      }
    }

    function emitSentence(sentence) {
      const key = `row:${sentence.id}`
      if (emitted.has(key)) return
      emitted.add(key)
      const entity =
        cache.words
          .slice(sentence.keyStart, sentence.keyEnd + 1)
          .map((word) => word.text)
          .join(' ')
          .replace(/^[^\w]+|[^\w)]+$/g, '') || sentence.text.split(/\s+/).slice(0, 4).join(' ')
      const locked = entity.slice(0, 90)
      const sectionIndex = sectionIndexAt(sentence.start)
      const bucket = telemetry.sectionEntities.get(sectionIndex) || new Map()
      bucket.set(locked, (bucket.get(locked) || 0) + 1)
      telemetry.sectionEntities.set(sectionIndex, bucket)
      rowHandlerRef.current({
        key,
        entity: locked,
        detail: sentence.text,
        source: metaRef.current.source || metaRef.current.query || 'research',
      })
    }

    function advanceRead() {
      const words = cache.words
      let guard = 0
      while (readIndex < words.length && guard < 24) {
        guard += 1
        const word = words[readIndex]
        const box = cache.boxes.get(word.id)
        if (!box) break
        const cx = box.x + box.w / 2
        const cy = box.y + box.h / 2
        const near = Math.hypot(cx - S.p.x, cy - S.p.y) < 82
        const passed = cy < S.p.y + 30
        if (!near && !passed) break
        markClass(word, 'read')
        if (word.sentence != null) {
          const sentence = cache.sentences[word.sentence]
          if (sentence) {
            if (readIndex === sentence.start) highlightSentence(sentence)
            if (readIndex === sentence.end) emitSentence(sentence)
          }
        }
        readIndex += 1
      }
      // The trailing sentence is only sentenced after the stream ends; make
      // sure it is still highlighted and filed once the reader has passed it.
      if (readIndex >= cache.words.length) {
        for (const sentence of cache.sentences) {
          if (sentence.end < readIndex && !emitted.has(`row:${sentence.id}`)) {
            highlightSentence(sentence)
            emitSentence(sentence)
          }
        }
      }

      if (readIndex !== lastReadCount) {
        lastReadCount = readIndex
        readHandlerRef.current(readIndex)
      }
    }

    function plant(leg) {
      leg.stepping = false
      leg.foot = leg.next
      leg.next = null
      flashes.push({ anchor: leg.foot, t: now })
      const word = cache.words[leg.foot.id]
      if (leg.foot.id != null && word) {
        touchedWords.add(word.id)
        if (gripActive) {
          if (!telemetry.grips.has(word.id)) {
            telemetry.grips.add(word.id)
            telemetry.gripCount += 1
            const sectionIndex = sectionIndexAt(word.id)
            telemetry.sectionGrips.set(sectionIndex, (telemetry.sectionGrips.get(sectionIndex) || 0) + 1)
          }
        }
        if (word.filler) mutateFiller(word)
        else if (R() < 0.12) leg.tint = '#D4D4D4'
        if (leg.tint) leg.tintUntil = now + 0.8
      }
      if (!leg.palp && R() < 0.12) {
        const nearby = findAnchor(add(S.p, V((R() * 2 - 1) * 130, (R() * 2 - 1) * 80)), 30)
        if (nearby.id != null) mutateFiller(cache.words[nearby.id])
      }
    }

    function shootThread() {
      if (threads.length >= T.threadMax) return
      const anchor = findAnchor(
        add(S.p, V((R() * 2 - 1) * T.threadRange, (R() * 2 - 1) * T.threadRange * 0.7)),
        26,
      )
      if (anchor.id == null) return
      threads.push({
        anchor,
        born: now,
        until: now + 0.5 + R() * 0.7,
        color: pick(THREAD_COLORS),
        from: R() < 0.5 ? 'spin' : 'body',
      })
    }

    function emitCursorPoint(point) {
      const box = safeBox()
      return V(
        clamp(point.x, box.l, box.r),
        clamp(point.y, Math.max(box.t, window.scrollY + 80), Math.min(box.b, window.scrollY + H - 120)),
      )
    }

    function updateSpine(dt) {
      const back = mul(forward(), -1)
      S.spine[0] = lerp(S.spine[0], S.p, damp(18, dt))
      for (let index = 1; index < BODY_SEGMENTS; index += 1) {
        const gap = (BODY_DEF[index].gap - BODY_DEF[index - 1].gap) * BODY_S
        const desired = add(S.spine[index - 1], mul(back, gap))
        S.spine[index] = lerp(S.spine[index], desired, damp(12 - index * 0.8, dt))
      }

      S.abd = S.spine[BODY_SEGMENTS - 1]
      const before = S.spine[BODY_SEGMENTS - 2]
      const tail = sub(S.abd, before)
      const tailLength = length(tail) || 1
      S.spin = add(S.abd, mul(tail, (7 * BODY_S) / tailLength))
    }

    function buildMemorySnapshot() {
      const meta = metaRef.current
      if (!meta.sessionId) return null
      const sections = cache.sectionInfo.slice(-MAX_SECTIONS).map((item) => {
        const entities = [...(telemetry.sectionEntities.get(item.index) || new Map()).entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, MAX_ENTITIES)
          .map(([label]) => label)
        return {
          section: item.title,
          dwellMs: Math.round(telemetry.sectionDwell.get(item.index) || 0),
          avgSegments: BODY_SEGMENTS,
          gripCount: telemetry.sectionGrips.get(item.index) || 0,
          lockedEntities: entities,
          words: Math.min(MAX_MEMORY_WORDS, item.wordCount),
        }
      })
      const traversalEdges = [...telemetry.traversalEdges.entries()]
        .map(([key, weight]) => {
          const [from, to] = key.split('\u0000')
          return { from, to, weight }
        })
        .filter((edge) => edge.from && edge.to && edge.from !== edge.to)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, MAX_EDGES)
      return {
        id: String(meta.sessionId),
        query: meta.query || '',
        source: meta.source || '',
        startedAt: telemetry.startedAt,
        updatedAt: Date.now(),
        wordCount: Math.min(MAX_MEMORY_WORDS, cache.words.length),
        dwellMs: Math.round(telemetry.dwellMs),
        avgSegments: BODY_SEGMENTS,
        gripCount: telemetry.gripCount,
        sections,
        traversalEdges,
      }
    }

    function flushTelemetry(complete = false) {
      const snapshot = buildMemorySnapshot()
      if (snapshot) telemetryHandlerRef.current?.(snapshot, { complete })
      telemetry.lastFlush = now
      if (complete) telemetry.completedFlush = true
    }

    let nextThread = 0

    function update(dt) {
      refreshBounds()
      const currentMode = modeRef.current
      const auto = currentMode !== 'cursor'

      if (!bodyReady) {
        initBody()
        if (!bodyReady) {
          S.p = V((cache.left + cache.right) / 2 || W / 2, window.scrollY + H * 0.45)
          resetSpine()
        }
      }

      if (auto) {
        S.brake = false
        advanceRead()
        const words = cache.words
        if (words.length) {
          const index = Math.min(readIndex + 3, words.length - 1)
          const box = cache.boxes.get(words[index].id)
          if (box) S.target = V(box.x + box.w / 2, box.y + box.h / 2)
          else if (now > S.tUntil) pickWander()
        } else if (now > S.tUntil) {
          pickWander()
        }
      } else {
        if (mouse.has) {
          S.target = emitCursorPoint(V(mouse.x, mouse.y))
          S.brake = true
        } else {
          S.target = V(S.p.x, S.p.y)
        }
      }

      // Original spider rhythm, relaxed to a constant glide while following the cursor.
      S.phase += dt
      const pulse = Math.pow(
        Math.max(0, Math.sin(S.phase * 3.1) * 0.6 + Math.sin(S.phase * 1.27) * 0.5 + 0.35),
        0.7,
      )
      const burst = auto ? T.burstFloor + (1 - T.burstFloor) * Math.min(1, pulse) : 1
      const to = sub(S.target, S.p)
      const d = length(to)
      const maxSpeed = auto ? T.cruise * burst : T.cursor
      const brake = !auto || S.brake
      const want = d > 2 ? mul(to, (brake ? Math.min(maxSpeed, d * 2.2) : maxSpeed) / d) : V()
      S.v = lerp(S.v, want, damp(auto ? 5 : 3.4, dt))
      S.p = add(S.p, mul(S.v, dt))

      const speed = length(S.v)
      if (speed > 3) S.heading = angleLerp(S.heading, Math.atan2(S.v.y, S.v.x), damp(4 + speed * 0.02, dt))
      S.heading += (R() - 0.5) * 0.02

      gripActive = auto || (mouse.has && speed > 4)
      if (bodyReady && gripActive) {
        const sectionIndex = sectionIndexAt(readIndex)
        telemetry.dwellMs += dt * 1000
        telemetry.sectionDwell.set(sectionIndex, (telemetry.sectionDwell.get(sectionIndex) || 0) + dt * 1000)
        if (telemetry.lastSection != null && telemetry.lastSection !== sectionIndex) {
          const from = cache.sectionInfo[telemetry.lastSection]?.title
          const to = cache.sectionInfo[sectionIndex]?.title
          if (from && to) {
            const key = `${from}\u0000${to}`
            telemetry.traversalEdges.set(key, (telemetry.traversalEdges.get(key) || 0) + 1)
          }
        }
        telemetry.lastSection = sectionIndex
      }

      updateSpine(dt)

      const maxStepping = speed > 70 ? 6 : 4
      for (const leg of legs) {
        if (leg.stepping) {
          leg.t += dt / leg.dur
          if (leg.t >= 1) plant(leg)
          continue
        }
        const foot = leg.foot ? anchorPos(leg.foot) : restPos(leg)
        const off = distance(foot, restPos(leg))
        const over = distance(foot, hipPos(leg)) > (leg.L1 + leg.L2) * T.overFrac
        const urgent = off > leg.reach * T.urgentFrac
        const threshold = Math.min(MAX_STEP_THRESHOLD, leg.reach * (leg.palp ? 0.25 : T.stepFrac))
        if (over || urgent) startStep(leg, true)
        else if (off > threshold && steppingCount() < maxStepping && !neighbourStepping(leg)) startStep(leg, false)
        else if (speed < 4 && R() < dt * 0.3) startStep(leg, false)
      }

      if (now > nextThread) {
        shootThread()
        nextThread = now + range(T.threadEvery)
      }
      for (let index = threads.length - 1; index >= 0; index -= 1) {
        if (now > threads[index].until) threads.splice(index, 1)
      }

      if (auto && R() < dt * 1.6) {
        const anchor = findAnchor(
          add(S.p, V((R() * 2 - 1) * LEG_MAX * 0.8, (R() * 2 - 1) * LEG_MAX * 0.6)),
          14,
        )
        if (anchor.id != null) mutateFiller(cache.words[anchor.id])
      }

      for (const [id, until] of activeFills) {
        if (now > until) {
          activeFills.delete(id)
          queue.remove.push([id, 'mut-fill'])
        }
      }
      for (const [id, until] of activeGlitches) {
        if (now > until) {
          activeGlitches.delete(id)
          glitchUntil.delete(id)
          queue.remove.push([id, 'word-glitch-vanish'])
        }
      }
      for (let index = flashes.length - 1; index >= 0; index -= 1) {
        if (now - flashes[index].t > 0.3) flashes.splice(index, 1)
      }

      if (frameNumber % 3 === 0) {
        const headWord = wordAtPoint(add(S.spine[0], mul(forward(), 7 * BODY_S)))
        if (headWord != null) touchedWords.add(headWord)
        for (const id of touchedWords) glitchWord(cache.words[id])
        touchedWords.clear()
      }

      if (now - telemetry.lastFlush >= MEMORY_FLUSH_MS / 1000) flushTelemetry(false)
      if (metaRef.current.completed && !telemetry.completedFlush) flushTelemetry(true)

      // Camera: only the autonomous reader scrolls the page, and only forward.
      if (auto) {
        if (now > cameraHold && bodyReady) {
          const desired = clamp(
            S.p.y + Math.max(0, S.v.y) * 0.28 - H * 0.44,
            0,
            Math.max(0, docBottom + 220 - H),
          )
          camY += (desired - camY) * damp(3.1, dt)
          if (Math.abs(camY - window.scrollY) > 1) window.scrollTo(0, Math.round(camY))
        }
      } else {
        camY = window.scrollY
      }
    }

    function line(a, b, color, width = LW) {
      ctx.strokeStyle = color
      ctx.lineWidth = width
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    }

    function dot(point, color, radius = 2.4) {
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(point.x, point.y, radius * DR, 0, Math.PI * 2)
      ctx.fill()
    }

    function clampFoot(hip, foot, leg) {
      const delta = sub(foot, hip)
      const d = length(delta)
      const max = Math.min(MAX_LEG_LENGTH, leg.L1 + leg.L2)
      return d > max ? add(hip, mul(delta, max / d)) : foot
    }

    function ik(hip, foot, leg) {
      const d = distance(hip, foot)
      const base = Math.atan2(foot.y - hip.y, foot.x - hip.x)
      if (d >= leg.L1 + leg.L2 - 0.01) return add(hip, mul(V(Math.cos(base), Math.sin(base)), leg.L1))
      const cosine = clamp((leg.L1 * leg.L1 + d * d - leg.L2 * leg.L2) / (2 * leg.L1 * d), -1, 1)
      const angle = base + leg.bend * Math.acos(cosine)
      return add(hip, V(Math.cos(angle) * leg.L1, Math.sin(angle) * leg.L1))
    }

    function reticle(point) {
      const r = 5.2 * DR
      const arm = 1.8 * DR
      ctx.strokeStyle = '#475569'
      ctx.lineWidth = 0.9
      ctx.beginPath()
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          ctx.moveTo(point.x + sx * r, point.y + sy * (r - arm))
          ctx.lineTo(point.x + sx * r, point.y + sy * r)
          ctx.lineTo(point.x + sx * (r - arm), point.y + sy * r)
        }
      }
      ctx.stroke()
    }

    function draw() {
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
      ctx.clearRect(0, 0, W, H)
      const origin = V(-window.scrollX, -window.scrollY)
      const P = (point) => add(point, origin)

      for (const thread of threads) {
        const start = thread.from === 'spin' ? S.spin : S.p
        const end = anchorPos(thread.anchor)
        const reveal = Math.min(
          clamp((now - thread.born) / 0.12, 0, 1),
          clamp((thread.until - now) / 0.15, 0, 1),
        )
        const tip = lerp(start, end, reveal)
        ctx.globalAlpha = 0.55
        line(P(start), P(tip), thread.color, 1)
        dot(P(tip), thread.color, 1.3)
        ctx.globalAlpha = 1
      }

      for (const leg of legs) {
        const hip = hipPos(leg)
        let foot
        if (leg.stepping) {
          const ease = leg.t * leg.t * (3 - 2 * leg.t)
          const target = leg.next?.id == null ? restPos(leg) : anchorPos(leg.next)
          foot = lerp(leg.from, target, ease)
          foot = lerp(foot, hip, Math.sin(Math.PI * leg.t) * 0.18)
        } else {
          foot = leg.foot?.id != null ? anchorPos(leg.foot) : restPos(leg)
        }
        foot = clampFoot(hip, foot, leg)
        const knee = ik(hip, foot, leg)
        leg.knee = knee
        leg.tip = foot
        const width = leg.palp ? LW * 0.72 : LW
        line(P(hip), P(knee), C.femur, width)
        line(P(knee), P(foot), C.tibia, width)
        dot(P(knee), C.joint, leg.palp ? 1.7 : 2.5)
        dot(P(foot), C.joint, leg.palp ? 1.5 : 2.2)
        if (!leg.stepping && leg.foot?.id != null) reticle(P(foot))
      }

      for (const flash of flashes) {
        const t = (now - flash.t) / 0.3
        const point = P(anchorPos(flash.anchor))
        ctx.strokeStyle = `rgba(56,189,248,${(1 - t) * 0.5})`
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.arc(point.x, point.y, (3 + t * 9) * DR, 0, Math.PI * 2)
        ctx.stroke()
      }

      // Exact four-segment articulated oval: head, two thorax ovals, abdomen.
      for (let index = 1; index < BODY_SEGMENTS; index += 1) {
        line(P(S.spine[index - 1]), P(S.spine[index]), 'rgba(143,143,143,.45)', 1)
      }
      for (const leg of legs) {
        if (!leg.palp && leg.idx % 2 === 0) {
          line(P(S.spine[1]), P(hipPos(leg)), 'rgba(143,143,143,.28)', 1)
        }
      }

      for (let index = 0; index < BODY_SEGMENTS; index += 1) {
        const a = S.spine[Math.max(0, index - 1)]
        const b = S.spine[Math.min(BODY_SEGMENTS - 1, index + 1)]
        const angle = index === 0 ? Math.atan2(S.spine[0].y - b.y, S.spine[0].x - b.x) : Math.atan2(a.y - b.y, a.x - b.x)
        const centre = P(S.spine[index])
        const rx = BODY_DEF[index].rx * BODY_S
        const ry = BODY_DEF[index].ry * BODY_S
        ctx.beginPath()
        ctx.ellipse(centre.x, centre.y, rx, ry, angle, 0, Math.PI * 2)
        ctx.fillStyle = C.bodyFill
        ctx.fill()
        ctx.strokeStyle = index === 0 ? C.body : C.tibia
        ctx.lineWidth = 1
        ctx.stroke()
        ctx.beginPath()
        ctx.ellipse(centre.x, centre.y, rx * 0.62, ry * 0.4, angle, 0, Math.PI * 2)
        ctx.strokeStyle = 'rgba(236,236,236,.13)'
        ctx.stroke()
      }
      const abdomen = P(S.spine[BODY_SEGMENTS - 1])
      dot(abdomen, C.joint, 2.9)

      const back = sub(S.spin, S.abd)
      const backLength = length(back) || 1
      const backUnit = mul(back, 1 / backLength)
      const sideUnit = V(-backUnit.y, backUnit.x)
      const spinneretBase = add(S.abd, mul(backUnit, 4 * BODY_S))
      for (const side of [-1, 1]) {
        const tip = add(spinneretBase, add(mul(backUnit, 6 * BODY_S), mul(sideUnit, side * 2.6 * BODY_S)))
        line(P(spinneretBase), P(tip), C.tibia, 0.85)
        dot(P(tip), C.joint, 1.1)
      }

      const head = add(S.spine[0], mul(forward(), 11 * BODY_S))
      line(P(S.spine[0]), P(head), C.body)
      dot(P(head), C.joint, 1.8)
      for (let index = 1; index < BODY_SEGMENTS; index += 1) dot(P(S.spine[index]), C.joint, 1.15)
      dot(P(S.spin), C.joint, 1.4)
    }

    function commit() {
      for (const [id, cls] of queue.remove) {
        const el = cache.els.get(id)
        if (el) el.classList.remove(cls)
      }
      for (const [id, cls] of queue.add) {
        const el = cache.els.get(id)
        if (el) el.classList.add(cls)
      }
      queue.add.length = 0
      queue.remove.length = 0
      queue.fill.length = 0
    }

    let last = performance.now()
    let frameId = 0
    function frame(time) {
      frameId = requestAnimationFrame(frame)
      const dt = Math.min(0.05, (time - last) / 1000)
      last = time
      now += dt
      frameNumber += 1
      update(dt)
      draw()
      commit()
    }

    function onMouseMove(event) {
      mouse.x = event.clientX + window.scrollX
      mouse.y = event.clientY + window.scrollY
      mouse.has = true
    }
    function onWheel() {
      cameraHold = now + 3
    }

    if (telemetryExportRef) telemetryExportRef.current = buildMemorySnapshot
    resizeCanvas()
    refreshBounds()
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('wheel', onWheel, { passive: true })
    window.addEventListener('resize', resizeCanvas)
    frameId = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(frameId)
      flushTelemetry(true)
      telemetryStateRef.current = null
      if (telemetryExportRef) telemetryExportRef.current = () => null
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('resize', resizeCanvas)
    }
  }, [])

  const wordCount = model.words.length
  const csvRows = rows.map((row) => ({ Entity: row.entity, Detail: row.detail, Source: row.source }))

  return (
    <div className="relative">
      <canvas ref={canvasRef} className="pointer-events-none fixed inset-0 z-[12]" aria-hidden="true" />

      <div className={`transition-[padding] duration-300 ${drawerOpen ? 'lg:pr-[352px]' : ''}`}>
        <article className="mx-auto w-full max-w-[720px] px-5 pb-52 pt-8 sm:px-8">
          <div className="mb-8 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-[#9B9B9B]">
            <span className="truncate">{source || 'Research stage'}</span>
            <span className="text-[#2F2F2F]">/</span>
            <span>
              {Math.min(readCount, wordCount).toLocaleString()} of {wordCount.toLocaleString()} words read
            </span>
            {streaming ? (
              <span className="flex items-center gap-2 text-[#38BDF8]">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#38BDF8]" />
                Writing
              </span>
            ) : null}
          </div>

          <div ref={contentRef} className="reader-content">
            <ReadingBody model={model} />
            {streaming ? <span className="reader-caret" aria-hidden="true" /> : null}
          </div>
        </article>
      </div>

      <button
        type="button"
        onClick={() => setDrawerOpen((open) => !open)}
        className={`fixed right-5 top-[76px] z-30 hidden items-center gap-2 rounded-full border border-[#2F2F2F] bg-[#171717] px-3.5 py-1.5 text-[12px] text-[#9B9B9B] transition hover:bg-[#2A2A2A] hover:text-[#ECECEC] lg:flex ${
          drawerOpen ? 'opacity-0' : 'opacity-100'
        }`}
        aria-label="Open extracted notes"
      >
        Notes
        <span className="rounded-full bg-[#212121] px-2 py-0.5 text-[11px] text-[#ECECEC]">{rows.length}</span>
      </button>

      <aside
        aria-label="Extracted entities"
        className={`fixed bottom-32 right-0 top-[64px] z-30 flex w-full flex-col border-l border-[#2F2F2F] bg-[#171717] transition-transform duration-300 ease-out sm:w-[352px] ${
          drawerOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between gap-3 border-b border-[#2F2F2F] px-4 py-3">
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-[#ECECEC]">Extracted notes</p>
            <p className="truncate text-[11.5px] text-[#9B9B9B]">
              {rows.length ? `${rows.length} entities found` : 'Nothing extracted yet'}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => downloadCSV(csvRows, 'webpilot-notes.csv')}
              disabled={!rows.length}
              className="rounded-full px-2.5 py-1.5 text-[11.5px] text-[#9B9B9B] transition hover:bg-[#2A2A2A] hover:text-[#ECECEC] disabled:opacity-40"
            >
              Export CSV
            </button>
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              aria-label="Collapse notes"
              className="grid h-7 w-7 place-items-center rounded-full text-[#9B9B9B] transition hover:bg-[#2A2A2A] hover:text-[#ECECEC]"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-4 w-4">
                <path d="m9 6 6 6-6 6" />
              </svg>
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {rows.length ? (
            rows.map((row) => (
              <div key={row.key} className="note-row border-b border-[#2F2F2F] px-4 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-[13px] font-medium text-[#ECECEC]">{row.entity}</span>
                  <span className="max-w-[120px] shrink-0 truncate text-[11px] text-[#9B9B9B]" title={row.source}>
                    {row.source}
                  </span>
                </div>
                <p className="mt-1 line-clamp-3 text-[12.5px] leading-5 text-[#9B9B9B]">{row.detail}</p>
              </div>
            ))
          ) : (
            <p className="px-4 py-6 text-[12.5px] leading-6 text-[#9B9B9B]">
              As the spider reads, each finished sentence files an entity here with its detail and source.
            </p>
          )}
        </div>
      </aside>
    </div>
  )
}
