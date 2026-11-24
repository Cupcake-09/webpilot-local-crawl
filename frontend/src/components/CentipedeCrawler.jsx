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

const STARTER = `# Rivet research

Ask a question and this page becomes a streaming research essay. Paste a URL and Rivet reads that page instead. The spider above is the original open-source DOM crawler, walking real words as they arrive.

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
const CONTACT_RADIUS = 6
const MAX_STEP_THRESHOLD = 52
const MIN_FOOT_SEPARATION = 26
const OUTWARD_DOT_MIN = 0.25
const EMBER_COLORS = ['#FEF08A', '#FB923C', '#EF4444']
const ASH_COLORS = ['#78716C', '#57534E', '#292524']
const ACID_BUBBLE_COLORS = ['#ECFCCB', '#BEF264', '#84CC16']
const ACID_DRIP_COLORS = ['#65A30D', '#4D7C0F']
const NEON_COLORS = ['#00FFFF', '#FF1E9E', '#D946EF', '#39FF14', '#FFF01F', '#38F8FF']
const GLITCH_SPARK_COLORS = ['#00FFFF', '#FF1E9E', '#39FF14', '#FFF01F', '#D946EF']
const EMBER_CAP = 160

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

  const addWords = (text, narrative, strong = false) => {
    const ids = []
    for (const token of text.split(/\s+/)) {
      if (!token) continue
      const id = nextId++
      words.push({ id, text: token, filler: isFiller(token), narrative, strong, sentence: null })
      ids.push(id)
    }
    return ids
  }

  // Emphasis is stripped before tokenising, so recover the bold/strong flag
  // first: it is one of the semantic signals the steering brain reads.
  const BOLD_SPAN = /(\*\*[^*]+\*\*|__[^_]+__)/
  const addRichWords = (raw, narrative) => {
    const ids = []
    for (const part of raw.split(BOLD_SPAN)) {
      if (!part) continue
      const bold =
        (part.startsWith('**') && part.endsWith('**') && part.length > 4) ||
        (part.startsWith('__') && part.endsWith('__') && part.length > 4)
      const cleaned = stripInline(bold ? part.slice(2, -2) : part)
      if (cleaned) ids.push(...addWords(cleaned, narrative, bold))
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
      blocks.push({ type: 'li', wordIds: addRichWords(list[1], true) })
      continue
    }
    if (/^>\s?/.test(trimmed)) {
      blocks.push({ type: 'quote', wordIds: addRichWords(trimmed.replace(/^>\s?/, ''), true) })
      continue
    }
    blocks.push({ type: 'p', wordIds: addRichWords(trimmed, true) })
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

  // Silent semantic steering brain. Every field is mutated in place by the
  // movement loop, so changing targets never restarts or remounts the effect.
  // Nothing in here is ever drawn: the lock-on is purely internal.
  const navBrainRef = useRef({
    evaluatedAt: -1,
    target: null,
    targetId: null,
    clusterId: null,
    clusterWordIds: [],
    scores: new Map(),
    keywords: new Set(),
    headings: new Map(),
    gripLog: [],
    topConcepts: [],
    // Predator foraging memory: the lane it has just harvested, which lane it
    // is currently sweeping, and when it last paused to orient. Mutated in
    // place, never rendered, so the movement loop never restarts.
    recentX: [],
    sweep: { lane: 'center', until: 0 },
    lastScanAt: -99,
  })

  // Audio lives entirely in refs. Nothing here is read or written by the
  // requestAnimationFrame effect's closure setup, so toggling sound or firing
  // a synthesised hit can never restart, remount or block the movement loop.
  const audioCtxRef = useRef(null)
  const noiseBufRef = useRef(null)
  const masterBusRef = useRef(null)
  const soundEnabledRef = useRef(true)
  const lastBlankSoundRef = useRef(-1)
  const lastWordSoundRef = useRef(-1)
  const [soundEnabled, setSoundEnabled] = useState(true)
  soundEnabledRef.current = soundEnabled

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
    // Scrolling re-syncs the cached boxes with the reading container so contact
    // checks and flame rects stay 1:1 with the visible text. Coalesced per frame.
    let scrollFrame = 0
    const onScroll = () => {
      if (scrollFrame) return
      scrollFrame = window.requestAnimationFrame(() => {
        scrollFrame = 0
        measureRef.current()
      })
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onScroll, { passive: true })
    if (document.fonts?.ready) document.fonts.ready.then(onResize).catch(() => {})
    return () => {
      observer.disconnect()
      if (scrollFrame) window.cancelAnimationFrame(scrollFrame)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onScroll)
    }
  }, [])

  // Lazily builds the clean unity master bus once: gain -> output.
  // Swallows every failure so a blocked or unsupported AudioContext is silent.
  function ensureAudioBus() {
    try {
      if (typeof window === 'undefined') return null
      const AudioCtor = window.AudioContext || window.webkitAudioContext
      if (!AudioCtor) return null
      let ctx = audioCtxRef.current
      if (!ctx) {
        ctx = new AudioCtor()
        audioCtxRef.current = ctx

        const frames = Math.max(1, Math.floor(ctx.sampleRate * 0.02))
        const buffer = ctx.createBuffer(1, frames, ctx.sampleRate)
        const channel = buffer.getChannelData(0)
        for (let index = 0; index < frames; index += 1) channel[index] = Math.random() * 2 - 1
        noiseBufRef.current = buffer

        const master = ctx.createGain()
        master.gain.value = 0.85

        master.connect(ctx.destination)
        masterBusRef.current = master

        const resume = () => {
          try {
            const current = audioCtxRef.current
            if (current && current.state === 'suspended') current.resume()
          } catch {
            /* audio is optional */
          }
        }
        window.addEventListener('pointerdown', resume, { passive: true })
        window.addEventListener('keydown', resume)
      }
      if (ctx.state === 'suspended') {
        const resumed = ctx.resume()
        if (resumed && typeof resumed.catch === 'function') resumed.catch(() => {})
      }
      return ctx
    } catch {
      return null
    }
  }

  // Layer 1: soft liquid tactile foot tap for a leg planting on blank surface.
  function playBlankTap(panX) {
    try {
      if (!soundEnabledRef.current) return
      const ctx = ensureAudioBus()
      const bus = masterBusRef.current
      if (!ctx || !bus) return
      const start = ctx.currentTime
      if (start - lastBlankSoundRef.current < 0.022) return
      lastBlankSoundRef.current = start

      const panner = ctx.createStereoPanner()
      panner.pan.value = Math.max(-0.65, Math.min(0.65, Number.isFinite(panX) ? panX : 0))
      panner.connect(bus)

      const noise = ctx.createBufferSource()
      noise.buffer = noiseBufRef.current
      const filter = ctx.createBiquadFilter()
      filter.type = 'bandpass'
      filter.frequency.value = 2400
      filter.Q.value = 3.2
      const noiseGain = ctx.createGain()
      noiseGain.gain.setValueAtTime(0.0001, start)
      noiseGain.gain.linearRampToValueAtTime(0.085, start + 0.001)
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, start + 0.016)
      noise.connect(filter)
      filter.connect(noiseGain)
      noiseGain.connect(panner)
      noise.start(start)
      noise.stop(start + 0.018)
      noise.onended = () => {
        try {
          noise.disconnect()
          filter.disconnect()
          noiseGain.disconnect()
        } catch {
          /* node already released */
        }
      }

      const thump = ctx.createOscillator()
      thump.type = 'sine'
      const thumpGain = ctx.createGain()
      thump.frequency.setValueAtTime(340, start)
      thump.frequency.exponentialRampToValueAtTime(135, start + 0.018)
      thumpGain.gain.setValueAtTime(0.075, start)
      thumpGain.gain.exponentialRampToValueAtTime(0.0001, start + 0.018)
      thump.connect(thumpGain)
      thumpGain.connect(panner)
      thump.start(start)
      thump.stop(start + 0.018)
      thump.onended = () => {
        try {
          thump.disconnect()
          thumpGain.disconnect()
          panner.disconnect()
        } catch {
          /* node already released */
        }
      }
    } catch {
      /* audio must never touch the animation frame */
    }
  }

  // Layer 2: clean liquid bleep at a random, deliberately non-musical pitch.
  function playWordContactBleep(panX) {
    try {
      if (!soundEnabledRef.current) return
      const ctx = ensureAudioBus()
      const bus = masterBusRef.current
      if (!ctx || !bus) return
      const start = ctx.currentTime
      if (start - lastWordSoundRef.current < 0.026) return
      lastWordSoundRef.current = start

      const panner = ctx.createStereoPanner()
      panner.pan.value = Math.max(-1, Math.min(1, Number.isFinite(panX) ? panX : 0))
      panner.connect(bus)

      const freq = 290 + Math.random() * 1060

      const bleep = ctx.createOscillator()
      bleep.type = 'sine'
      const harmonic = ctx.createOscillator()
      harmonic.type = 'triangle'
      const harmonicGain = ctx.createGain()
      harmonicGain.gain.value = 0.15
      const bleepGain = ctx.createGain()

      bleep.frequency.setValueAtTime(freq * 0.72, start)
      bleep.frequency.exponentialRampToValueAtTime(freq * 1.15, start + 0.042)
      harmonic.frequency.setValueAtTime(freq * 0.72 * 1.5, start)
      harmonic.frequency.exponentialRampToValueAtTime(freq * 1.15 * 1.5, start + 0.042)

      bleepGain.gain.setValueAtTime(0.0001, start)
      bleepGain.gain.linearRampToValueAtTime(0.11, start + 0.003)
      bleepGain.gain.exponentialRampToValueAtTime(0.0001, start + 0.048)

      bleep.connect(bleepGain)
      harmonic.connect(harmonicGain)
      harmonicGain.connect(bleepGain)
      bleepGain.connect(panner)

      bleep.start(start)
      harmonic.start(start)
      bleep.stop(start + 0.05)
      harmonic.stop(start + 0.05)
      bleep.onended = () => {
        try {
          bleep.disconnect()
          harmonic.disconnect()
          harmonicGain.disconnect()
          bleepGain.disconnect()
          panner.disconnect()
        } catch {
          /* node already released */
        }
      }
    } catch {
      /* audio must never touch the animation frame */
    }
  }

  useEffect(
    () => () => {
      try {
        audioCtxRef.current?.close()
      } catch {
        /* nothing to release */
      }
      audioCtxRef.current = null
      noiseBufRef.current = null
      masterBusRef.current = null
    },
    [],
  )

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
      cruise: 310,
      lure: 880,
      cursor: 255,
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

    // Wide radial spider fan. Pair 1/2 originate from spine segment 1, pair
    // 3/4 from segment 2. The final entry is a short pedipalp on the head.
    const LEG_DEF = [
      { angle: 38, reach: 68, segment: 1, along: 3 },
      { angle: 72, reach: 74, segment: 1, along: -3 },
      { angle: 110, reach: 74, segment: 2, along: 3 },
      { angle: 145, reach: 70, segment: 2, along: -3 },
      { angle: 20, reach: 38, segment: 0, along: 0, palp: true },
    ]
    const legs = []
    for (const side of [1, -1]) {
      LEG_DEF.forEach((def, index) => {
        const boneLength = def.reach * (0.56 + 0.64)
        const boneScale = Math.min(1, MAX_LEG_LENGTH / boneLength)
        legs.push({
          side,
          idx: index,
          ang: (def.angle * Math.PI) / 180 * side,
          reach: def.reach,
          segment: def.segment,
          along: def.along,
          palp: Boolean(def.palp),
          foot: null,
          next: null,
          from: null,
          t: 0,
          dur: 0.15,
          stepping: false,
          // Mirror the knee across the body: right legs bend +, left legs -.
          bend: side,
          L1: def.reach * 0.56 * boneScale,
          L2: def.reach * 0.64 * boneScale,
          tint: null,
          tintUntil: 0,
          knee: V(),
          tip: V(),
        })
      })
    }
    const LEG_MAX = Math.max(...legs.map((leg) => leg.L1 + leg.L2))
    // Palps and front legs, cached once: these twitch during an orienting scan.
    const twitchLegs = legs.filter((leg) => leg.palp || leg.idx === 0)

    const S = {
      p: V(0, 0),
      v: V(),
      heading: Math.PI / 2,
      stopUntil: 0,
      brake: false,
      target: V(),
      tUntil: 0,
      phase: R() * 10,
      wander: R() * 10,
      scanUntil: 0,
      scanTwitchAt: 0,
      scanLook: V(),
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
    const embers = []
    const queue = { add: [], remove: [], fill: [] }
    const activeEffects = new Map()
    const claimedWordIndices = new Set()
    const touchedWordIds = new Set()
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

    /** Shortest distance from a point to a cached word box. No DOM reads. */
    function distanceToBox(point, box) {
      const dx = Math.max(box.x - point.x, 0, point.x - (box.x + box.w))
      const dy = Math.max(box.y - point.y, 0, point.y - (box.y + box.h))
      return Math.hypot(dx, dy)
    }

    /**
     * Word whose box is within CONTACT_RADIUS of a point. Cached boxes are in
     * page coordinates; the draw transform maps them to canvas pixels.
     */
    function wordNearPoint(point, radius = CONTACT_RADIUS) {
      let best = null
      let bestDistance = radius
      for (const word of cache.words) {
        const box = cache.boxes.get(word.id)
        if (!box) continue
        const distance = distanceToBox(point, box)
        if (distance === 0) return word.id
        if (distance <= bestDistance) {
          bestDistance = distance
          best = word.id
        }
      }
      return best
    }

    function reserveParticleSlots(count) {
      if (embers.length + count > EMBER_CAP) embers.splice(0, embers.length + count - EMBER_CAP)
    }

    function spawnPaperParticles(word) {
      const box = cache.boxes.get(word.id)
      if (!box) return
      const count = 8
      const perKind = count / 2
      reserveParticleSlots(count)
      for (let index = 0; index < count; index += 1) {
        const ash = index >= perKind
        const slot = ash ? index - perKind : index
        const spread = (slot + 0.5) / perKind
        const x = box.x + (0.08 + spread * 0.84) * box.w + (R() - 0.5) * box.w * 0.06
        if (ash) {
          // Ash flakes follow the burn front down the word, tearing off late.
          embers.push({
            kind: 'ash',
            x,
            y: box.y + (0.4 + spread * 0.5 + (R() - 0.5) * 0.1) * box.h,
            vx: (R() < 0.5 ? -1 : 1) * (6 + R() * 14),
            vy: 18 + R() * 24,
            size: R() < 0.5 ? 2.5 : 3,
            color: pick(ASH_COLORS),
            age: 0,
            ttl: 0.5 + R() * 0.2,
            delay: 0.06 + spread * 0.14 + R() * 0.02,
            phase: R() * Math.PI * 2,
          })
        } else {
          // Fire embers burst out of the top edge and flicker upward.
          embers.push({
            kind: 'paper-ember',
            x,
            y: box.y + (0.06 + spread * 0.38 + (R() - 0.5) * 0.08) * box.h,
            vx: 0,
            vy: -22 - R() * 26,
            size: R() < 0.5 ? 2.5 : 3,
            color: pick(EMBER_COLORS),
            age: 0,
            ttl: 0.3 + R() * 0.15,
            delay: spread * 0.08,
            phase: R() * Math.PI * 2,
            jitter: 0,
          })
        }
      }
    }

    // Six short-lived acid motes at the contact point: four sizzling bubbles
    // rising and two heavy droplets sagging downward.
    function spawnAcidParticles(point) {
      reserveParticleSlots(6)
      for (let index = 0; index < 6; index += 1) {
        const bubbly = index < 4
        const spread = bubbly ? (index + 0.5) / 4 : (index - 4 + 0.5) / 2
        if (bubbly) {
          embers.push({
            kind: 'acid-bubble',
            x: point.x + (R() - 0.5) * 10,
            y: point.y + (R() - 0.5) * 6,
            vx: (R() - 0.5) * 16,
            vy: -18 - R() * 24,
            size: R() < 0.5 ? 2 : 2.5,
            color: pick(ACID_BUBBLE_COLORS),
            age: 0,
            ttl: 0.3 + R() * 0.15,
            phase: R() * Math.PI * 2,
          })
        } else {
          embers.push({
            kind: 'acid-drip',
            x: point.x + (spread - 0.5) * 8 + (R() - 0.5) * 4,
            y: point.y + (R() - 0.5) * 4,
            vx: (R() - 0.5) * 6,
            vy: 28 + R() * 27,
            size: 2.5,
            color: pick(ACID_DRIP_COLORS),
            age: 0,
            ttl: 0.3 + R() * 0.15,
            phase: R() * Math.PI * 2,
          })
        }
      }
    }

    function spawnCyberShards(point) {
      const count = 5
      reserveParticleSlots(count)
      for (let index = 0; index < count; index += 1) {
        embers.push({
          kind: 'cyber',
          x: point.x + (R() - 0.5) * 8,
          y: point.y + (R() - 0.5) * 10,
          vx: (R() < 0.5 ? -1 : 1) * 110,
          width: 4 + R() * 6,
          height: 1.5,
          color: GLITCH_SPARK_COLORS[index],
          age: 0,
          ttl: 0.12 + R() * 0.06,
        })
      }
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
     * MAX_WORD_SNAP_RADIUS of its natural rest position, within physical leg
     * reach, on its own side of the spine and clear of the other feet. Words
     * are claimed per frame so two legs can never plant on the same word.
     */
    function findFoothold(leg) {
      const hip = hipPos(leg)
      const rest = restPos(leg)
      const target = stepTarget(leg)
      const maxLength = Math.min(MAX_LEG_LENGTH, leg.L1 + leg.L2)
      const outward = outwardNormal(leg)
      const spine = S.spine[leg.segment]
      let best = null
      let bestScore = Infinity

      for (const word of cache.words) {
        const box = cache.boxes.get(word.id)
        if (!box) continue
        // The id is the stable word index; never share it with another foot.
        if (claimedWordIndices.has(word.id)) continue

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

        // Reject a foot that crosses the spine or crowds an existing foot.
        const fromCenter = sub(V(x, y), spine)
        const centerLength = length(fromCenter) || 1
        if ((fromCenter.x * outward.x + fromCenter.y * outward.y) / centerLength <= OUTWARD_DOT_MIN) continue
        if (!footIsClear(leg, V(x, y))) continue

        best = { id: word.id, u, v, x, y }
        bestScore = score
      }

      const chosen = best || { id: null, u: 0.5, v: 0.5, x: rest.x, y: rest.y }
      if (chosen.id != null) claimedWordIndices.add(chosen.id)
      return chosen
    }

    function footIsClear(leg, point) {
      for (const other of legs) {
        if (other === leg) continue
        if (other.foot) {
          if (distance(point, anchorPos(other.foot)) < MIN_FOOT_SEPARATION) return false
        }
        if (other.stepping && other.next) {
          if (distance(point, anchorPos(other.next)) < MIN_FOOT_SEPARATION) return false
        }
      }
      return true
    }

    function refreshFootholdClaims() {
      claimedWordIndices.clear()
      for (const leg of legs) {
        if (leg.foot?.id != null) claimedWordIndices.add(leg.foot.id)
        if (leg.stepping && leg.next?.id != null) claimedWordIndices.add(leg.next.id)
      }
    }

    const forward = () => V(Math.cos(S.heading), Math.sin(S.heading))
    const spineTangent = (index) => {
      // Point tangents toward the head so +side is the screen-right normal.
      const a = S.spine[Math.min(BODY_SEGMENTS - 1, index + 1)]
      const b = S.spine[Math.max(0, index - 1)]
      const tangent = sub(b, a)
      const tangentLength = length(tangent) || 1
      return mul(tangent, 1 / tangentLength)
    }
    const outwardNormal = (leg) => {
      const tangent = spineTangent(leg.segment)
      return V(-tangent.y * leg.side, tangent.x * leg.side)
    }
    const hipPos = (leg) => {
      const tangent = spineTangent(leg.segment)
      const lateral = leg.palp ? 3 : 6
      const anchor = add(S.spine[leg.segment], mul(tangent, leg.along))
      return add(anchor, V(-tangent.y * lateral * leg.side, tangent.x * lateral * leg.side))
    }
    const restPos = (leg) => {
      // The reach values are the exact radial rest distances from the hip.
      return add(hipPos(leg), rotate(V(Math.cos(leg.ang) * leg.reach, Math.sin(leg.ang) * leg.reach), S.heading))
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
      claimedWordIndices.clear()
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

    function effectWord(word, contactPoint) {
      if (!word || word.id == null) return
      if (now < (word.effectUntil || 0)) return
      const el = cache.els.get(word.id)
      if (!el) return
      const duration = 3000 + Math.random() * 1000
      const durationMs = Math.round(duration)
      const roll = Math.random()
      const cls = roll < 0.5 ? 'rw-cyber-glitch' : roll < 0.75 ? 'rw-paper-burn' : 'rw-acid-decay'
      const glitchColor = cls === 'rw-cyber-glitch' ? pick(NEON_COLORS) : null
      el.style.setProperty('--effect-duration', `${durationMs}ms`)
      if (glitchColor) el.style.setProperty('--glitch-color', glitchColor)
      word.effectUntil = now + durationMs / 1000 + 0.06
      activeEffects.set(word.id, { until: now + durationMs / 1000 + 0.01, cls })
      if (cls === 'rw-paper-burn') {
        spawnPaperParticles(word)
      } else if (cls === 'rw-cyber-glitch') {
        spawnCyberShards(contactPoint)
      } else {
        spawnAcidParticles(contactPoint)
      }
      queue.add.push([word.id, cls])
    }

    function sectionIndexAt(wordIndex) {
      return cache.wordSection[clamp(wordIndex, 0, Math.max(0, cache.words.length - 1))] ?? 0
    }

    // --- Dynamic semantic steering ------------------------------------------
    // Candidates are scored and locked silently; the brain only ever writes
    // S.target, so no sightline, reticle or highlight is introduced.
    const NAV_EVAL_INTERVAL = 0.45
    const CLUSTER_RADIUS = 110
    const TRAVEL_DECAY = 0.012
    const HIGH_VALUE = 3.5
    const KEYWORD_MIN = 4
    // Foraging shape: stay out of one vertical lane, sweep the full text
    // width, wobble while travelling, and pause to orient on notable targets.
    const TUNNEL_RADIUS = 130
    const TUNNEL_PENALTY = 3.2
    const TUNNEL_MEMORY = 4
    const SWEEP_MIN = 2.4
    const SWEEP_MAX = 3.6
    const SWEEP_BONUS = 2.8
    const SWEEP_HUNT_BONUS = 5
    const WANDER_DEADZONE = 35
    const WANDER_FALLOFF = 90
    const WANDER_STRENGTH = 0.42
    const SCAN_MIN = 0.2
    const SCAN_MAX = 0.35
    const SCAN_COOLDOWN = 1.6

    function queryKeywords() {
      const raw = `${metaRef.current.query || ''}`.toLowerCase()
      const keywords = new Set()
      for (const token of raw.split(/[^a-z0-9]+/)) {
        if (token.length < KEYWORD_MIN || STOPWORDS.has(token)) continue
        keywords.add(token)
      }
      return keywords
    }

    function matchesKeywords(word) {
      const keywords = navBrainRef.current.keywords
      if (!keywords.size) return false
      const token = word.text.toLowerCase().replace(/[^a-z0-9-]/g, '')
      if (!token) return false
      for (const keyword of keywords) {
        if (token === keyword) return true
        // Loose stemming keeps "navigate" and "navigation" in the same cluster.
        if (keyword.length >= 5 && (token.startsWith(keyword) || keyword.startsWith(token))) return true
      }
      return false
    }

    /** Nearest preceding h1/h2/h3 text, cached per block. */
    function headingForWord(id) {
      const brain = navBrainRef.current
      const blockIndex = cache.wordBlock[id] ?? 0
      if (brain.headings.has(blockIndex)) return brain.headings.get(blockIndex)
      let heading = 'General Context'
      for (let index = blockIndex; index >= 0; index -= 1) {
        const block = cache.blocks[index]
        if (!block || !/^h[1-3]$/.test(block.type)) continue
        const title = block.wordIds
          .map((wordId) => cache.words[wordId]?.text || '')
          .join(' ')
          .trim()
        if (title) {
          heading = title.slice(0, 120)
          break
        }
      }
      brain.headings.set(blockIndex, heading)
      return heading
    }

    /** Intrinsic semantic value of one word, capped to the +4..+8 band. */
    function semanticValue(word, id) {
      if (!word) return -3
      const block = cache.blocks[cache.wordBlock[id] ?? -1]
      const type = block?.type || 'p'
      let value = 0
      if (type === 'h1') value += 6
      else if (type === 'h2' || type === 'h3') value += 5
      if (word.strong) value += 4
      const token = word.text.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')
      if (/^[A-Z][A-Za-z0-9-]{2,}$/.test(token)) value += 4
      if (/\d/.test(word.text)) value += 2
      if (!word.filler && matchesKeywords(word)) value += 6
      if (word.filler) value -= 3
      return Math.min(8, value)
    }

    /** Mean X of the last few harvested words: the lane the predator favours. */
    function recentLaneX() {
      const recent = navBrainRef.current.recentX
      if (!recent.length) return null
      let sum = 0
      for (const x of recent) sum += x
      return sum / recent.length
    }

    function rememberVisitedX(word) {
      const box = cache.boxes.get(word.id)
      if (!box) return
      const recent = navBrainRef.current.recentX
      recent.push(box.x + box.w / 2)
      if (recent.length > TUNNEL_MEMORY) recent.splice(0, recent.length - TUNNEL_MEMORY)
    }

    /**
     * Periodic horizontal sweep. A lane preference is re-rolled every few
     * seconds so the hunt alternates across right, centre and the occasional
     * left pass instead of settling into one column.
     */
    function sweepBias(candidate, box) {
      const sweep = navBrainRef.current.sweep
      const span = Math.max(1, box.r - box.l)
      const u = clamp((candidate.centre.x - box.l) / span, 0, 1)
      if (now >= sweep.until) {
        const roll = R()
        sweep.lane = roll < 0.48 ? 'right' : roll < 0.86 ? 'center' : 'left'
        sweep.until = now + range([SWEEP_MIN, SWEEP_MAX])
      }
      // A notable word inside the swept lane is worth travelling for: the
      // bonus is large enough to beat a few hundred px of travel decay, so a
      // right-side heading actually pulls the predator across the paragraph.
      const hunt = candidate.base >= HIGH_VALUE ? SWEEP_HUNT_BONUS : 0
      if (sweep.lane === 'right') {
        const lane = u > 0.6 ? SWEEP_BONUS : u > 0.42 ? SWEEP_BONUS * 0.4 : -SWEEP_BONUS * 0.25
        return lane + (u > 0.55 ? hunt : 0)
      }
      if (sweep.lane === 'left') {
        const lane = u < 0.38 ? SWEEP_BONUS : u < 0.55 ? SWEEP_BONUS * 0.4 : -SWEEP_BONUS * 0.25
        return lane + (u < 0.45 ? hunt : 0)
      }
      const lane = u > 0.32 && u < 0.68 ? SWEEP_BONUS * 0.85 : 0
      return lane + (u > 0.28 && u < 0.72 ? hunt : 0)
    }

    /** Strong, value-dense words (headings, figures, names, query terms). */
    function isNotable(word) {
      if (!word) return false
      if (word.strong || /\d/.test(word.text)) return true
      const token = word.text.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')
      if (/^[A-Z][A-Za-z0-9-]{2,}$/.test(token)) return true
      return matchesKeywords(word)
    }

    /** Value + cohesion - travel cost - tunnelling, plus the sweep pull. */
    function scoreWordCandidate(candidate, highValue, box) {
      let cohesion = 0
      for (const other of highValue) {
        if (other.id === candidate.id) continue
        if (distance(candidate.centre, other.centre) <= CLUSTER_RADIUS) cohesion += 1.5
      }
      const travel = distance(candidate.centre, S.p)
      let tunnel = 0
      const laneX = recentLaneX()
      if (laneX != null && navBrainRef.current.recentX.length >= 2) {
        const drift = Math.abs(candidate.centre.x - laneX)
        if (drift < TUNNEL_RADIUS) tunnel = -TUNNEL_PENALTY * (1 - drift / TUNNEL_RADIUS)
      }
      // A light downward pull keeps wide sweeps from stalling reading order,
      // without discouraging side-to-side hunting on the current row.
      const forward = candidate.centre.y > S.p.y + 20 ? 0.8 : 0
      return {
        score: candidate.base + cohesion - travel * TRAVEL_DECAY + tunnel + sweepBias(candidate, box) + forward,
      }
    }

    function evaluateBrain() {
      const brain = navBrainRef.current
      const previousTargetId = brain.targetId
      brain.evaluatedAt = now
      brain.keywords = queryKeywords()
      brain.headings.clear()

      const viewTop = window.scrollY - 240
      const viewBottom = window.scrollY + H + 320
      const candidates = []
      for (let id = Math.max(0, readIndex); id < cache.words.length; id += 1) {
        const box = cache.boxes.get(id)
        if (!box) continue
        if (box.y + box.h < viewTop || box.y > viewBottom) continue
        const word = cache.words[id]
        if (!word) continue
        candidates.push({
          id,
          box,
          centre: V(box.x + box.w / 2, box.y + box.h / 2),
          word,
          base: semanticValue(word, id),
        })
      }

      brain.scores.clear()
      if (!candidates.length) {
        brain.target = null
        brain.targetId = null
        brain.clusterWordIds = []
        return
      }

      const clampBox = safeBox()
      const highValue = candidates.filter((candidate) => candidate.base >= HIGH_VALUE)
      let best = null
      for (const candidate of candidates) {
        const result = scoreWordCandidate(candidate, highValue, clampBox)
        brain.scores.set(candidate.id, result.score)
        if (!best || result.score > best.score) best = { ...candidate, score: result.score }
      }
      if (!best) return

      const pool = highValue.length ? highValue : candidates
      let sumX = 0
      let sumY = 0
      let count = 0
      const clusterWordIds = []
      for (const candidate of pool) {
        if (distance(candidate.centre, best.centre) > CLUSTER_RADIUS) continue
        clusterWordIds.push(candidate.id)
        sumX += candidate.centre.x
        sumY += candidate.centre.y
        count += 1
      }
      if (!count) {
        sumX = best.centre.x
        sumY = best.centre.y
        count = 1
        clusterWordIds.push(best.id)
      }

      brain.target = V(
        clamp(sumX / count, clampBox.l, clampBox.r),
        clamp(sumY / count, clampBox.t, clampBox.b),
      )
      brain.targetId = best.id
      brain.clusterId = `cluster:${best.id}`
      brain.clusterWordIds = clusterWordIds
      brain.evaluatedAt = now

      // Acquiring a notable target (heading, figure, name, query term) pauses
      // the hunt for a beat: the head turns and the palps test the air before
      // the lunge. Rate-limited so dense prose cannot freeze the crawl.
      if (
        best.id !== previousTargetId &&
        (best.base >= HIGH_VALUE || isNotable(best.word)) &&
        now - brain.lastScanAt > SCAN_COOLDOWN
      ) {
        brain.lastScanAt = now
        S.scanUntil = now + SCAN_MIN + R() * (SCAN_MAX - SCAN_MIN)
        S.scanLook = V(brain.target.x, brain.target.y)
        S.scanTwitchAt = now
      }
    }

    function gripClusterId(wordId) {
      const brain = navBrainRef.current
      return brain.clusterWordIds.includes(wordId) ? brain.clusterId : `cluster:${wordId}`
    }

    function refreshTopConcepts() {
      const brain = navBrainRef.current
      const ranked = [...brain.gripLog].sort((a, b) => b.score - a.score)
      const seen = new Set()
      const top = []
      for (const entry of ranked) {
        if (entry.score < HIGH_VALUE) continue
        const key = entry.word.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        top.push(entry.word)
        if (top.length >= 10) break
      }
      brain.topConcepts = top
    }

    /** Structured grip memory; existing telemetry fields are untouched. */
    function recordGripDetail(word) {
      const brain = navBrainRef.current
      // Grips can land on words outside the last evaluation window, so fall
      // back to that word's intrinsic value minus its travel cost.
      const evaluated = brain.scores.get(word.id)
      const box = cache.boxes.get(word.id)
      const centre = box ? V(box.x + box.w / 2, box.y + box.h / 2) : S.p
      const score = evaluated ?? semanticValue(word, word.id) - distance(centre, S.p) * TRAVEL_DECAY
      rememberVisitedX(word)
      brain.gripLog.push({
        word: word.text,
        score: Math.round(score * 100) / 100,
        sectionHeading: headingForWord(word.id),
        clusterId: gripClusterId(word.id),
        timestamp: Date.now(),
      })
      if (brain.gripLog.length > 120) brain.gripLog.splice(0, brain.gripLog.length - 120)
      refreshTopConcepts()
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
      // Layer 1: no `.rw` word under the foot means a blank-surface tap.
      if (leg.foot.id == null || !word) {
        const plantPoint = anchorPos(leg.foot)
        playBlankTap(W > 0 ? (plantPoint.x - (window.scrollX + W / 2)) / (W / 2) : 0)
      }
      if (leg.foot.id != null && word) {
        if (gripActive) {
          if (!telemetry.grips.has(word.id)) {
            telemetry.grips.add(word.id)
            telemetry.gripCount += 1
            const sectionIndex = sectionIndexAt(word.id)
            telemetry.sectionGrips.set(sectionIndex, (telemetry.sectionGrips.get(sectionIndex) || 0) + 1)
            recordGripDetail(word)
          }
          // A gripped target is consumed: re-lock immediately instead of
          // waiting for the next 450ms tick.
          if (navBrainRef.current.targetId === word.id) navBrainRef.current.evaluatedAt = -1
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
      refreshTopConcepts()
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
        // Structured grip memory and the derived concept list ride alongside
        // the existing fields; nothing here replaces or renames them.
        grips: navBrainRef.current.gripLog.slice(-60),
        topConcepts: [...navBrainRef.current.topConcepts],
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
      refreshFootholdClaims()
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
        const brain = navBrainRef.current
        const consumed =
          brain.targetId == null ||
          brain.targetId < readIndex ||
          !cache.boxes.has(brain.targetId)
        if (!brain.target || consumed || now - brain.evaluatedAt >= NAV_EVAL_INTERVAL) evaluateBrain()
        if (brain.target) {
          S.target = V(brain.target.x, brain.target.y)
        } else {
          const words = cache.words
          if (words.length) {
            const index = Math.min(readIndex + 3, words.length - 1)
            const box = cache.boxes.get(words[index].id)
            if (box) S.target = V(box.x + box.w / 2, box.y + box.h / 2)
            else if (now > S.tUntil) pickWander()
          } else if (now > S.tUntil) {
            pickWander()
          }
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
      const scanning = auto && now < S.scanUntil
      const maxSpeed = auto ? T.cruise * burst * (scanning ? 0.22 : 1) : T.cursor
      const brake = !auto || S.brake
      let want = V()
      if (d > 2) {
        if (brake) {
          want = mul(to, Math.min(maxSpeed, d * 2.2) / d)
        } else {
          // Reynolds seek + arrive blend: cruise at the lock from a distance,
          // then ease onto the cluster centre as the spider closes in.
          const slowRadius = Math.max(T.arrive * 3, 180)
          const arriveSpeed = maxSpeed * clamp(d / slowRadius, 0.12, 1)
          const seekWeight = clamp((d - slowRadius / 2) / (slowRadius / 2), 0, 1)
          want = mul(to, mix(arriveSpeed, maxSpeed, seekWeight) / d)
        }
      }
      if (auto && !brake && d > WANDER_DEADZONE && !scanning) {
        // Organic S-curve locomotion: a smooth, time-varying perpendicular
        // force (incommensurate sines, never per-frame noise) bends the path.
        // It fades to exactly zero inside the landing radius, so the lunge
        // still converges on the word.
        S.wander += dt * (1.05 + pulse * 0.55)
        const wobble =
          Math.sin(S.wander * 2.05) * 0.62 +
          Math.sin(S.wander * 0.81 + 1.3) * 0.28 +
          Math.sin(S.wander * 4.3 + 0.6) * 0.1
        const falloff = clamp((d - WANDER_DEADZONE) / WANDER_FALLOFF, 0, 1)
        const eased = falloff * falloff * (3 - 2 * falloff)
        const push = wobble * eased * WANDER_STRENGTH * maxSpeed
        want = add(want, V((-to.y / d) * push, (to.x / d) * push))
        want = capLength(want, maxSpeed * 1.25)
      }
      S.v = lerp(S.v, want, damp(auto ? 6.5 : 10, dt))
      S.p = add(S.p, mul(S.v, dt))

      const speed = length(S.v)
      if (scanning) {
        // Square up on the target while the body creeps forward.
        const aim = S.scanLook.x || S.scanLook.y ? S.scanLook : S.target
        S.heading = angleLerp(S.heading, Math.atan2(aim.y - S.p.y, aim.x - S.p.x), damp(14, dt))
      } else if (speed > 3) {
        S.heading = angleLerp(S.heading, Math.atan2(S.v.y, S.v.x), damp(4 + speed * 0.02, dt))
      }
      S.heading += (R() - 0.5) * (scanning ? 0.01 : 0.02)

      // Orienting twitch: palps and front legs tap at the air while the head
      // turns, then the crawl surges forward as the scan window closes.
      if (scanning && now > S.scanTwitchAt) {
        S.scanTwitchAt = now + 0.05 + R() * 0.05
        const leg = twitchLegs[Math.floor(R() * twitchLegs.length)]
        if (leg && !leg.stepping) {
          startStep(leg, true)
          leg.dur = 0.05 + R() * 0.03
        }
      }

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
      const endedEffects = new Set()
      for (const [id, effect] of activeEffects) {
        if (now > effect.until) {
          activeEffects.delete(id)
          endedEffects.add(id)
          queue.remove.push([id, effect.cls])
        }
      }
      for (let index = embers.length - 1; index >= 0; index -= 1) {
        const ember = embers[index]
        if (ember.delay > 0) {
          ember.delay -= dt
          continue
        }
        ember.age += dt
        if (ember.age >= ember.ttl) {
          embers.splice(index, 1)
          continue
        }
        if (ember.kind === 'cyber') {
          ember.x += ember.vx * dt
        } else if (ember.kind === 'ash') {
          ember.x += (ember.vx + Math.sin(now * 7 + ember.phase) * 12) * dt
          ember.y += ember.vy * dt
        } else if (ember.kind === 'paper-ember') {
          // Stepped pixel jitter: snap sideways in whole pixels, never glide.
          ember.jitter += dt
          if (ember.jitter >= 0.05) {
            ember.jitter = 0
            ember.x += (R() < 0.5 ? -1 : 1) * Math.round(1 + R() * 1.5)
          }
          ember.y += ember.vy * dt
        } else if (ember.kind === 'acid-bubble') {
          ember.x += (ember.vx + Math.sin(now * 22 + ember.phase) * 7) * dt
          ember.y += ember.vy * dt
        } else if (ember.kind === 'acid-drip') {
          ember.x += ember.vx * dt
          ember.y += ember.vy * dt
          ember.vy += 26 * dt
        } else {
          ember.x += (ember.vx + Math.sin(now * 26 + ember.phase) * 16) * dt
          ember.y += ember.vy * dt
          ember.vy += 8 * dt
        }
      }
      for (let index = flashes.length - 1; index >= 0; index -= 1) {
        if (now - flashes[index].t > 0.3) flashes.splice(index, 1)
      }

      // Test every current contact point each frame: head, planted feet and
      // the interpolated tips of legs that are mid-step.
      const contacts = new Map()
      const headPoint = add(S.spine[0], mul(forward(), 7 * BODY_S))
      const headWord = wordNearPoint(headPoint)
      if (headWord != null) contacts.set(headWord, headPoint)
      for (const leg of legs) {
        const footPoint = currentFootPoint(leg)
        const wordId = wordNearPoint(footPoint)
        if (wordId != null && !contacts.has(wordId)) contacts.set(wordId, footPoint)
      }
      // Layer 2 fires on contact onset, not on every frame a foot rests on the
      // same word, so a planted leg bleeps once instead of buzzing.
      for (const [id, contactPoint] of contacts) {
        if (touchedWordIds.has(id)) continue
        touchedWordIds.add(id)
        playWordContactBleep(
          W > 0 ? (contactPoint.x - (window.scrollX + W / 2)) / (W / 2) : 0,
        )
      }
      for (const id of touchedWordIds) {
        if (!contacts.has(id)) touchedWordIds.delete(id)
      }
      for (const [id, contactPoint] of contacts) {
        if (!endedEffects.has(id)) effectWord(cache.words[id], contactPoint)
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

    function currentFootPoint(leg) {
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
      return clampFoot(hip, foot, leg)
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

      for (const ember of embers) {
        if (ember.delay > 0) continue
        const t = clamp(ember.age / ember.ttl, 0, 1)
        const point = P(ember)
        if (ember.kind === 'cyber') {
          ctx.globalAlpha = 1 - t
          ctx.fillStyle = ember.color
          ctx.shadowColor = ember.color
          ctx.shadowBlur = 4 * DR
          const width = ember.width * (1 - t * 0.2)
          ctx.fillRect(point.x - width / 2, point.y - ember.height / 2, width, ember.height)
          continue
        }
        // Paper fire and ash are hard square pixels on the integer grid.
        const pixelX = Math.round(point.x)
        const pixelY = Math.round(point.y)
        if (ember.kind === 'acid-bubble') {
          const size = ember.size
          ctx.globalAlpha = (1 - t) * 0.9
          ctx.fillStyle = ember.color
          ctx.shadowColor = '#BEF264'
          ctx.shadowBlur = 4 * DR
          ctx.fillRect(pixelX - size / 2, pixelY - size / 2, size, size)
          continue
        }
        if (ember.kind === 'acid-drip') {
          ctx.globalAlpha = (1 - t) * 0.85
          ctx.fillStyle = ember.color
          ctx.shadowBlur = 0
          ctx.shadowColor = 'transparent'
          ctx.fillRect(pixelX - 1, pixelY - 2, 2, 4)
          continue
        }
        if (ember.kind === 'ash') {
          const size = ember.size
          ctx.globalAlpha = (1 - t) * 0.7
          ctx.fillStyle = ember.color
          ctx.shadowBlur = 0
          ctx.shadowColor = 'transparent'
          ctx.fillRect(pixelX - size / 2, pixelY - size / 2, size, size)
          continue
        }
        const size = ember.size
        ctx.globalAlpha = 1 - t
        ctx.fillStyle = ember.color
        ctx.shadowBlur = 0
        ctx.shadowColor = 'transparent'
        ctx.fillRect(pixelX - size / 2, pixelY - size / 2, size, size)
      }
      ctx.globalAlpha = 1
      ctx.shadowBlur = 0
      ctx.shadowColor = 'transparent'

      // Exact four-segment articulated oval: head, two thorax ovals, abdomen.
      for (let index = 1; index < BODY_SEGMENTS; index += 1) {
        line(P(S.spine[index - 1]), P(S.spine[index]), 'rgba(143,143,143,.45)', 1)
      }
      for (const leg of legs) {
        if (!leg.palp && leg.idx % 2 === 0) {
          line(P(S.spine[leg.segment]), P(hipPos(leg)), 'rgba(143,143,143,.28)', 1)
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

      {/* Progressive acid erosion: turbulence warps and pits the glyph strokes
          in place, so the word never scales down or changes its layout box. */}
      <svg
        width="0"
        height="0"
        aria-hidden="true"
        style={{ position: 'absolute', pointerEvents: 'none' }}
      >
        <filter id="acid-erode-1" x="-10%" y="-10%" width="120%" height="120%">
          <feTurbulence type="fractalNoise" baseFrequency="0.18" numOctaves="3" seed="4" result="noise" />
          <feDisplacementMap
            in="SourceGraphic"
            in2="noise"
            scale="4"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
        <filter id="acid-erode-2" x="-12%" y="-12%" width="124%" height="124%">
          <feTurbulence type="fractalNoise" baseFrequency="0.22" numOctaves="3" seed="9" result="noise" />
          <feDisplacementMap
            in="SourceGraphic"
            in2="noise"
            scale="9"
            xChannelSelector="R"
            yChannelSelector="G"
            result="warped"
          />
          <feMorphology in="warped" operator="erode" radius="0.9" />
        </filter>
        <filter id="acid-erode-3" x="-15%" y="-15%" width="130%" height="130%">
          <feTurbulence type="fractalNoise" baseFrequency="0.28" numOctaves="3" seed="15" result="noise" />
          <feDisplacementMap
            in="SourceGraphic"
            in2="noise"
            scale="15"
            xChannelSelector="R"
            yChannelSelector="G"
            result="warped"
          />
          <feMorphology in="warped" operator="erode" radius="1.6" />
        </filter>
      </svg>

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
              onClick={() => downloadCSV(csvRows, 'rivet-notes.csv')}
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

      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          const next = !soundEnabledRef.current
          soundEnabledRef.current = next
          setSoundEnabled(next)
          if (next) ensureAudioBus()
        }}
        aria-pressed={soundEnabled}
        aria-label={soundEnabled ? 'Mute crawler sound' : 'Enable crawler sound'}
        title={soundEnabled ? 'Mute crawler sound' : 'Enable crawler sound'}
        className="fixed bottom-[112px] right-4 z-30 grid h-8 w-8 place-items-center rounded-full border border-[#2F2F2F] bg-[#171717] text-[#9B9B9B] transition hover:bg-[#2A2A2A] hover:text-[#ECECEC] sm:right-6"
      >
        {soundEnabled ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
            <path d="M4 9.5h3L12 6v12l-5-3.5H4z" />
            <path d="M16 9a4 4 0 0 1 0 6" />
            <path d="M18.5 6.5a7.5 7.5 0 0 1 0 11" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
            <path d="M4 9.5h3L12 6v12l-5-3.5H4z" />
            <path d="m16 9.5 5 5" />
            <path d="m21 9.5-5 5" />
          </svg>
        )}
      </button>
    </div>
  )
}
