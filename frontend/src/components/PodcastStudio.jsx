import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchPodcastVoices, requestPodcastTurn, requestVoicePreview } from '../lib/api.js'

function tokens(text) {
  return [...String(text).matchAll(/\S+/g)].map((match) => ({ text: match[0], start: match.index, end: match.index + match[0].length }))
}

function formatTime(value) {
  if (!Number.isFinite(value) || value < 0) return '0:00'
  const minutes = Math.floor(value / 60)
  const seconds = Math.floor(value % 60)
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export default function PodcastStudio({ podcast, busy, error, research, spiderMemory }) {
  const lines = podcast?.dialogue || []
  const takeaways = podcast?.takeaways || []
  const crawled = spiderMemory?.stats
  const crawledLabel =
    crawled && (crawled.concepts || crawled.sections)
      ? `Grounded in ${crawled.concepts} spider-foraged ${crawled.concepts === 1 ? 'concept' : 'concepts'} across ${crawled.sections} ${crawled.sections === 1 ? 'section' : 'sections'}`
      : ''

  const [playing, setPlaying] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [source, setSource] = useState('')
  const [activeLine, setActiveLine] = useState(-1)
  const [activeWord, setActiveWord] = useState(null)
  const [playerError, setPlayerError] = useState('')
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [turnIndex, setTurnIndex] = useState(-1)
  const [elapsed, setElapsed] = useState(0)
  const [queueNote, setQueueNote] = useState('')

  const [voices, setVoices] = useState([])
  const [voicesLoading, setVoicesLoading] = useState(true)
  const [voiceError, setVoiceError] = useState('')
  const [hostAVoice, setHostAVoice] = useState('')
  const [hostBVoice, setHostBVoice] = useState('')
  const [previewBusy, setPreviewBusy] = useState('')

  const audioRef = useRef(null)
  const previewAudioRef = useRef(null)
  const previewUrlRef = useRef(null)
  const voicesRef = useRef([])
  const speechRunRef = useRef({ cancelled: false })
  const linesRef = useRef([])
  const pairRef = useRef({ a: '', b: '' })
  const startedRef = useRef(false)
  const indexRef = useRef(-1)
  const sessionRef = useRef({ cancelled: false, controllers: new Set(), urls: new Map(), pending: new Map() })

  useEffect(() => {
    let active = true
    fetchPodcastVoices()
      .then((data) => {
        if (!active) return
        const ids = data.voices.map((voice) => voice.voiceId)
        setVoices(data.voices)
        setHostAVoice(ids.includes(data.defaults.hostA) ? data.defaults.hostA : ids[0] || '')
        setHostBVoice(ids.includes(data.defaults.hostB) ? data.defaults.hostB : ids[1] || ids[0] || '')
      })
      .catch((error) => {
        if (active) setVoiceError(error?.message || 'Podcast voices could not be loaded.')
      })
      .finally(() => {
        if (active) setVoicesLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(
    () => () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
      speechRunRef.current.cancelled = true
      window.speechSynthesis?.cancel()
      cancelSession()
    },
    [],
  )

  const voiceGroups = useMemo(() => {
    const groups = []
    for (const voice of voices) {
      let group = groups.find((entry) => entry.label === voice.group)
      if (!group) {
        group = { label: voice.group, voices: [] }
        groups.push(group)
      }
      group.voices.push(voice)
    }
    return groups
  }, [voices])

  const offlineCount = voices.filter((voice) => voice.engine === 'kokoro').length
  const onlineCount = voices.filter((voice) => voice.engine === 'edge').length
  const voiceSummary = voicesLoading
    ? 'Loading voices…'
    : [offlineCount ? `${offlineCount} offline` : '', onlineCount ? `${onlineCount} online` : '']
        .filter(Boolean)
        .join(' · ')
  const voiceNote =
    voiceError ||
    (!voicesLoading && !voices.length ? 'No podcast voices are available on this machine.' : '')

  useEffect(() => {
    stopAll()
  }, [podcast])

  useEffect(() => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return undefined
    const load = () => {
      voicesRef.current = window.speechSynthesis.getVoices()
    }
    load()
    window.speechSynthesis.addEventListener('voiceschanged', load)
    return () => {
      window.speechSynthesis.removeEventListener('voiceschanged', load)
      window.speechSynthesis.cancel()
    }
  }, [])

  const voiceLabel = (voiceId) =>
    voices.find((voice) => voice.voiceId === voiceId)?.label || voiceId || 'the default voice'

  // Keep the queue reading live state, so a voice switch applies to the next turn.
  useEffect(() => {
    pairRef.current = { a: hostAVoice, b: hostBVoice }
  }, [hostAVoice, hostBVoice])

  useEffect(() => {
    linesRef.current = podcast?.dialogue || []
  }, [podcast])

  const revokeTurns = (session) => {
    session.urls.forEach((url) => URL.revokeObjectURL(url))
    session.urls.clear()
    session.pending.clear()
  }

  const cancelSession = () => {
    const previous = sessionRef.current
    previous.cancelled = true
    previous.controllers.forEach((controller) => controller.abort())
    previous.controllers.clear()
    revokeTurns(previous)
    const next = { cancelled: false, controllers: new Set(), urls: new Map(), pending: new Map() }
    sessionRef.current = next
    return next
  }

  const fetchTurn = (index, session) => {
    const cached = session.urls.get(index)
    if (cached) return Promise.resolve(cached)
    const pending = session.pending.get(index)
    if (pending) return pending
    const line = linesRef.current[index]
    if (!line) return Promise.reject(new Error('That turn is no longer part of the script'))
    const pair = pairRef.current
    const voiceId = String(line.speaker || '').toLowerCase().endsWith('b') ? pair.b : pair.a
    const controller = new AbortController()
    session.controllers.add(controller)
    const request = requestPodcastTurn({ text: line.text, voiceId, signal: controller.signal })
      .then(({ url }) => {
        if (session.cancelled || sessionRef.current !== session) {
          URL.revokeObjectURL(url)
          throw new DOMException('Turn cancelled', 'AbortError')
        }
        session.urls.set(index, url)
        return url
      })
      .finally(() => {
        session.controllers.delete(controller)
        session.pending.delete(index)
      })
    session.pending.set(index, request)
    return request
  }

  const finishQueue = (session) => {
    if (session !== sessionRef.current) return
    startedRef.current = false
    indexRef.current = -1
    revokeTurns(session)
    setPlaying(false)
    setPreparing(false)
    setSource('')
    setTurnIndex(-1)
    setActiveLine(-1)
    setActiveWord(null)
    setCurrentTime(0)
    setDuration(0)
    setElapsed(0)
    setQueueNote('')
  }

  const playIndex = async (index, session) => {
    if (session.cancelled || sessionRef.current !== session) return
    const total = linesRef.current.length
    if (index >= total) {
      finishQueue(session)
      return
    }
    indexRef.current = index
    startedRef.current = true
    setSource('tts')
    setTurnIndex(index)
    setActiveLine(index)
    setActiveWord(null)
    setCurrentTime(0)
    setDuration(0)
    if (index === 0) {
      setPreparing(true)
      setElapsed(0)
    }
    let url
    try {
      url = await fetchTurn(index, session)
    } catch (error) {
      if (error?.name === 'AbortError' || session.cancelled || sessionRef.current !== session) return
      const message = error?.message
        ? `${error.message} Using browser voices instead.`
        : 'The neural voices are unavailable, using browser voices.'
      startSpeech(index)
      setPlayerError(message)
      return
    }
    if (session.cancelled || sessionRef.current !== session) return
    const audio = audioRef.current
    if (!audio) return
    audio.src = url
    audio.currentTime = 0
    setPreparing(false)
    try {
      await audio.play()
    } catch (error) {
      if (error?.name === 'AbortError') return
      setPlaying(false)
      setPlayerError('The audio could not start. Press play again.')
    }
    // Prefetch the next turn with the live voice pair while this one plays.
    if (index + 1 < total) fetchTurn(index + 1, session).catch(() => {})
  }

  const handleTurnEnded = () => {
    const finished = Number(audioRef.current?.duration)
    if (Number.isFinite(finished) && finished > 0) setElapsed((previous) => previous + finished)
    setActiveWord(null)
    playIndex(indexRef.current + 1, sessionRef.current)
  }

  const stopAll = () => {
    speechRunRef.current.cancelled = true
    window.speechSynthesis?.cancel()
    const audio = audioRef.current
    if (audio) {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    }
    startedRef.current = false
    indexRef.current = -1
    cancelSession()
    setPlaying(false)
    setPreparing(false)
    setSource('')
    setTurnIndex(-1)
    setActiveLine(-1)
    setActiveWord(null)
    setCurrentTime(0)
    setDuration(0)
    setElapsed(0)
    setQueueNote('')
  }

  // A voice switch drops every queued or prefetched turn; the next turn is
  // requested with the new pair, no script regeneration and no page reload.
  useEffect(() => {
    const session = sessionRef.current
    const busy = startedRef.current || session.urls.size > 0 || session.controllers.size > 0
    if (!busy) return
    const keepIndex = playing ? indexRef.current : -1
    session.controllers.forEach((controller) => controller.abort())
    session.controllers.clear()
    session.pending.clear()
    for (const [index, url] of [...session.urls]) {
      if (index === keepIndex) continue
      URL.revokeObjectURL(url)
      session.urls.delete(index)
    }
    if (keepIndex === -1) {
      const audio = audioRef.current
      if (audio) {
        audio.pause()
        audio.removeAttribute('src')
        audio.load()
      }
      setPreparing(false)
      setCurrentTime(0)
      setDuration(0)
    }
    setPlayerError('')
    setQueueNote(
      `Voices switched - upcoming turns use ${voiceLabel(hostAVoice)} and ${voiceLabel(hostBVoice)}.`,
    )
  }, [hostAVoice, hostBVoice])

  // Prime turn 0 while the studio is idle so the first Play click starts at once.
  useEffect(() => {
    if (!podcast || !hostAVoice || !linesRef.current.length) return undefined
    const timer = setTimeout(() => {
      if (startedRef.current) return
      fetchTurn(0, sessionRef.current).catch(() => {})
    }, 120)
    return () => clearTimeout(timer)
  }, [podcast, hostAVoice, hostBVoice])


  const pickVoices = () => {
    const english = voicesRef.current.filter((voice) => /^en/i.test(voice.lang))
    const pool = english.length ? english : voicesRef.current
    const hostA =
      pool.find((voice) => /female|samantha|zira|aria|jenny|uk english female/i.test(voice.name)) || pool[0]
    const hostB = pool.find((voice) => voice !== hostA) || pool[1] || hostA
    return { hostA, hostB }
  }

  const startSpeech = (startIndex = 0) => {
    const synth = window.speechSynthesis
    if (!synth) {
      setPlayerError('Speech synthesis is unavailable in this browser.')
      return
    }
    synth.cancel()
    speechRunRef.current.cancelled = false
    const voices = pickVoices()
    startedRef.current = false
    indexRef.current = -1
    cancelSession()
    setTurnIndex(-1)
    setQueueNote('')
    setSource('speech')
    setPlaying(true)
    setPlayerError('')
    let index = startIndex

    const speakNext = () => {
      if (speechRunRef.current.cancelled || index >= lines.length) {
        setPlaying(false)
        setActiveLine(-1)
        setActiveWord(null)
        return
      }
      const line = lines[index]
      const utterance = new SpeechSynthesisUtterance(line.text)
      const voice = line.speaker === 'Host A' ? voices.hostA : voices.hostB
      if (voice) utterance.voice = voice
      utterance.rate = 1.02
      utterance.pitch = line.speaker === 'Host A' ? 1.02 : 0.92
      utterance.onstart = () => {
        setActiveLine(index)
        setActiveWord({ line: index, charIndex: 0 })
      }
      utterance.onboundary = (event) => {
        if (typeof event.charIndex === 'number') setActiveWord({ line: index, charIndex: event.charIndex })
      }
      utterance.onend = () => {
        index += 1
        speakNext()
      }
      utterance.onerror = () => {
        index += 1
        speakNext()
      }
      synth.speak(utterance)
    }

    speakNext()
  }

  const handlePreview = async (voiceId) => {
    if (!voiceId || previewBusy) return
    previewAudioRef.current?.pause()
    audioRef.current?.pause()
    setPreviewBusy(voiceId)
    setVoiceError('')
    try {
      const { url } = await requestVoicePreview(voiceId)
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = url
      const player = previewAudioRef.current
      if (!player) return
      player.src = url
      player.currentTime = 0
      await player.play().catch(() => setVoiceError('The preview could not start. Press the speaker again.'))
    } catch (requestError) {
      setVoiceError(requestError?.message || 'Voice preview is unavailable.')
    } finally {
      setPreviewBusy('')
    }
  }

  const swapVoices = () => {
    setHostAVoice(hostBVoice)
    setHostBVoice(hostAVoice)
  }

  const previewButton = (voiceId, hostLabel) => (
    <button
      type="button"
      onClick={() => handlePreview(voiceId)}
      disabled={!voiceId || Boolean(previewBusy)}
      title={`Preview ${hostLabel} voice`}
      aria-label={`Preview ${hostLabel} voice`}
      className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-[#2F2F2F] bg-[#0F0F0F] text-[#9B9B9B] transition hover:border-[#38BDF8]/50 hover:text-[#ECECEC] disabled:opacity-40"
    >
      {previewBusy === voiceId ? (
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[#ECECEC]/25 border-t-[#ECECEC]" />
      ) : (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          className="h-4 w-4"
        >
          <path d="M4 10v4h3l4 3.2V6.8L7 10H4Z" fill="currentColor" stroke="none" />
          <path d="M15.5 9.6a3.6 3.6 0 0 1 0 4.8M17.9 7.2a6.8 6.8 0 0 1 0 9.6" />
        </svg>
      )}
    </button>
  )

  const handlePlay = async () => {
    previewAudioRef.current?.pause()
    if (playing) {
      audioRef.current?.pause()
      setPlaying(false)
      return
    }
    if (startedRef.current && indexRef.current >= 0 && audioRef.current?.src) {
      setPlayerError('')
      try {
        await audioRef.current.play()
      } catch {
        setPlayerError('The audio could not start.')
      }
      return
    }
    setPlayerError('')
    setQueueNote('')
    const start = startedRef.current && indexRef.current >= 0 ? indexRef.current : 0
    const session = startedRef.current ? cancelSession() : sessionRef.current
    if (start === 0) setElapsed(0)
    playIndex(start, session)
  }

  const handleTimeUpdate = () => {
    const audio = audioRef.current
    if (!audio) return
    setCurrentTime(audio.currentTime)
    if (indexRef.current >= 0) setActiveLine(indexRef.current)
  }

  if (busy) {
    return (
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="h-[320px] animate-pulse rounded-2xl border border-[#2F2F2F] bg-[#212121]" />
        <div className="h-[420px] animate-pulse rounded-2xl border border-[#2F2F2F] bg-[#212121]" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-[#2F2F2F] bg-[#212121] p-6">
        <h2 className="text-[14px] font-medium text-[#ECECEC]">The podcast could not be generated</h2>
        <p className="mt-1.5 text-[12.5px] leading-6 text-[#9B9B9B]">{error}</p>
      </div>
    )
  }

  if (!podcast) {
    return (
      <div className="rounded-2xl border border-[#2F2F2F] bg-[#212121] p-6">
        <h2 className="text-[14px] font-medium text-[#ECECEC]">Waiting for research</h2>
        <p className="mt-1.5 max-w-[540px] text-[12.5px] leading-6 text-[#9B9B9B]">
          {research
            ? 'Takeaways and the two-host dialogue are generated as soon as the current research finishes.'
            : 'Finish a question or a URL read. Rivet will pool the takeaways and produce a Host A / Host B audio overview automatically.'}
        </p>
      </div>
    )
  }

  const turnFraction = duration > 0 ? Math.min(1, currentTime / duration) : 0
  const progress =
    source === 'speech'
      ? activeLine >= 0
        ? ((activeLine + 1) / Math.max(1, lines.length)) * 100
        : 0
      : lines.length
        ? ((Math.max(0, turnIndex) + turnFraction) / lines.length) * 100
        : 0
  const progressiveMeta =
    source === 'speech'
      ? `Line ${Math.max(0, activeLine + 1)} of ${lines.length}`
      : turnIndex >= 0
        ? `Turn ${turnIndex + 1} of ${lines.length}`
        : `${lines.length} turns ready`
  const playerMeta =
    source === 'tts'
      ? 'Streaming neural voices'
      : source === 'speech'
        ? 'Dual-voice speech synthesis'
        : 'Two hosts · generated overview'

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <div className="flex flex-col gap-4">
        <section className="rounded-2xl border border-[#2F2F2F] bg-[#212121] p-5">
          <h1 className="text-[15px] font-medium text-[#ECECEC]">NotebookLM &amp; Podcast</h1>
          <p className="mt-1 text-[12.5px] leading-6 text-[#9B9B9B]">
            Pooled takeaways and a two-host conversation, generated from the last research run.
          </p>
          {crawledLabel ? (
            <p className="mt-3 inline-flex max-w-full items-center gap-2 rounded-full border border-[#2F2F2F] bg-[#171717] px-3 py-1 text-[11px] text-[#9B9B9B]">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#38BDF8]" />
              <span className="truncate">{crawledLabel}</span>
            </p>
          ) : null}

          <div className="mt-5 rounded-xl border border-[#2F2F2F] bg-[#171717] p-4">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-[12px] text-[#9B9B9B]">Host voices</p>
              {voiceSummary ? <span className="truncate text-[11px] text-[#6E6E6E]">{voiceSummary}</span> : null}
            </div>
            <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-2">
              <div className="min-w-0">
                <p className="text-[11px] text-[#9B9B9B]">Host A</p>
                <div className="mt-1 flex items-center gap-1.5">
                  <select
                    value={hostAVoice}
                    onChange={(event) => setHostAVoice(event.target.value)}
                    disabled={voicesLoading || !voices.length}
                    aria-label="Host A voice"
                    className="min-w-0 flex-1 rounded-lg border border-[#2F2F2F] bg-[#0F0F0F] px-2 py-1.5 text-[12px] text-[#ECECEC] outline-none focus:border-[#38BDF8]/60 disabled:opacity-50"
                  >
                    {voiceGroups.map((group) => (
                      <optgroup key={group.label} label={group.label}>
                        {group.voices.map((voice) => (
                          <option key={voice.voiceId} value={voice.voiceId}>
                            {voice.label} · {voice.language}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  {previewButton(hostAVoice, 'Host A')}
                </div>
              </div>
              <button
                type="button"
                onClick={swapVoices}
                disabled={!hostAVoice || !hostBVoice}
                title="Swap voices"
                aria-label="Swap voices"
                className="mb-0.5 grid h-8 w-8 place-items-center rounded-lg border border-[#2F2F2F] bg-[#0F0F0F] text-[13px] text-[#9B9B9B] transition hover:border-[#38BDF8]/50 hover:text-[#ECECEC] disabled:opacity-40"
              >
                ⇄
              </button>
              <div className="min-w-0">
                <p className="text-[11px] text-[#9B9B9B]">Host B</p>
                <div className="mt-1 flex items-center gap-1.5">
                  <select
                    value={hostBVoice}
                    onChange={(event) => setHostBVoice(event.target.value)}
                    disabled={voicesLoading || !voices.length}
                    aria-label="Host B voice"
                    className="min-w-0 flex-1 rounded-lg border border-[#2F2F2F] bg-[#0F0F0F] px-2 py-1.5 text-[12px] text-[#ECECEC] outline-none focus:border-[#38BDF8]/60 disabled:opacity-50"
                  >
                    {voiceGroups.map((group) => (
                      <optgroup key={group.label} label={group.label}>
                        {group.voices.map((voice) => (
                          <option key={voice.voiceId} value={voice.voiceId}>
                            {voice.label} · {voice.language}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  {previewButton(hostBVoice, 'Host B')}
                </div>
              </div>
            </div>
            {voiceNote ? <p className="mt-2 text-[11px] leading-5 text-[#ECECEC]">{voiceNote}</p> : null}
          </div>

          <div className="mt-4 rounded-xl border border-[#2F2F2F] bg-[#171717] p-4">
            <p className="text-[12.5px] text-[#9B9B9B]">{playerMeta}</p>
            {queueNote ? <p className="mt-1 text-[11px] leading-5 text-[#38BDF8]">{queueNote}</p> : null}
            <div className="mt-3 flex items-center gap-3">
              <button
                type="button"
                onClick={handlePlay}
                disabled={preparing || !lines.length}
                className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#ECECEC] text-[#0D0D0D] transition hover:bg-white disabled:opacity-40"
                aria-label={playing ? 'Pause podcast' : 'Play podcast'}
              >
                {preparing ? (
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#0D0D0D]/30 border-t-[#0D0D0D]" />
                ) : playing ? (
                  <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
                    <rect x="6" y="5" width="4" height="14" rx="1" />
                    <rect x="14" y="5" width="4" height="14" rx="1" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
                    <path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14Z" />
                  </svg>
                )}
              </button>
              <div className="min-w-0 flex-1">
                <div className="h-1.5 overflow-hidden rounded-full bg-[#2F2F2F]">
                  <div
                    className="h-full rounded-full bg-[#ECECEC] transition-[width] duration-200"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <div className="mt-1.5 flex justify-between text-[11px] text-[#9B9B9B]">
                  <span>{progressiveMeta}</span>
                  <span>{source === 'speech' ? 'Browser voices' : formatTime(elapsed + currentTime)}</span>
                </div>
              </div>
            </div>
            {playerError ? <p className="mt-3 text-[11.5px] leading-5 text-[#ECECEC]">{playerError}</p> : null}
            <audio
              ref={audioRef}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={handleTurnEnded}
              onTimeUpdate={handleTimeUpdate}
              onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
              className="hidden"
            />
            <audio ref={previewAudioRef} className="hidden" />
          </div>
        </section>

        <section className="rounded-2xl border border-[#2F2F2F] bg-[#212121] p-5">
          <h2 className="text-[14px] font-medium text-[#ECECEC]">Takeaways</h2>
          <ul className="mt-3 space-y-2.5">
            {takeaways.map((point, index) => (
              <li key={`${point}-${index}`} className="flex gap-2.5 text-[12.5px] leading-6 text-[#9B9B9B]">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#38BDF8]" />
                <span>{point}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="rounded-2xl border border-[#2F2F2F] bg-[#212121] p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[14px] font-medium text-[#ECECEC]">Transcript</h2>
          <span className="text-[11.5px] text-[#9B9B9B]">{lines.length} turns</span>
        </div>
        <div className="mt-4 max-h-[560px] space-y-2 overflow-y-auto pr-1">
          {lines.map((line, index) => {
            const words = tokens(line.text)
            const active = index === activeLine
            return (
              <div
                key={`${line.speaker}-${index}`}
                className={`rounded-xl border px-4 py-3 transition-colors ${
                  active ? 'border-[#38BDF8]/40 bg-[#2A2A2A]' : 'border-transparent'
                }`}
              >
                <p className="text-[11.5px] text-[#9B9B9B]">{line.speaker}</p>
                <p className="mt-1 text-[13.5px] leading-6 text-[#ECECEC]">
                  {words.map((word, wordIndex) => {
                    const highlighted =
                      active && activeWord && activeWord.line === index && activeWord.charIndex >= word.start && activeWord.charIndex < word.end
                    return (
                      <span key={`${word.start}-${wordIndex}`}>
                        {wordIndex > 0 ? ' ' : ''}
                        <span className={highlighted ? 'text-[#38BDF8]' : ''}>{word.text}</span>
                      </span>
                    )
                  })}
                </p>
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}
