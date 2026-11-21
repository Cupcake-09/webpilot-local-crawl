import { useEffect, useRef, useState } from 'react'
import { requestPodcastAudio } from '../lib/api.js'

function tokens(text) {
  return [...String(text).matchAll(/\S+/g)].map((match) => ({ text: match[0], start: match.index, end: match.index + match[0].length }))
}

function formatTime(value) {
  if (!Number.isFinite(value) || value < 0) return '0:00'
  const minutes = Math.floor(value / 60)
  const seconds = Math.floor(value % 60)
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export default function PodcastStudio({ podcast, busy, error, research }) {
  const lines = podcast?.dialogue || []
  const takeaways = podcast?.takeaways || []

  const [playing, setPlaying] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [audioUrl, setAudioUrl] = useState(null)
  const [source, setSource] = useState('')
  const [activeLine, setActiveLine] = useState(-1)
  const [activeWord, setActiveWord] = useState(null)
  const [playerError, setPlayerError] = useState('')
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)

  const audioRef = useRef(null)
  const voicesRef = useRef([])
  const speechRunRef = useRef({ cancelled: false })

  useEffect(() => {
    setPlaying(false)
    setPreparing(false)
    setActiveLine(-1)
    setActiveWord(null)
    setPlayerError('')
    setCurrentTime(0)
    setDuration(0)
    setAudioUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous)
      return null
    })
    if (typeof window !== 'undefined') window.speechSynthesis?.cancel()
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

  useEffect(() => {
    if (!audioUrl || !audioRef.current) return
    audioRef.current.play().catch(() => {
      setPlaying(false)
      setPlayerError('The audio could not start. Press play again.')
    })
  }, [audioUrl])

  useEffect(
    () => () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl)
    },
    [audioUrl],
  )

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
    setSource('speech')
    setAudioUrl(null)
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

  const stopAll = () => {
    speechRunRef.current.cancelled = true
    window.speechSynthesis?.cancel()
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
    }
    setPlaying(false)
    setActiveLine(-1)
    setActiveWord(null)
    setCurrentTime(0)
  }

  const handlePlay = async () => {
    if (playing) {
      stopAll()
      return
    }
    if (audioUrl) {
      setPlayerError('')
      audioRef.current?.play().catch(() => setPlayerError('The audio could not start.'))
      return
    }
    setPreparing(true)
    setPlayerError('')
    try {
      const result = await requestPodcastAudio(
        lines.map((line) => ({ speaker: line.speaker, text: line.text })),
      )
      if (result.fallback) {
        startSpeech(0)
      } else {
        setSource('eleven')
        setAudioUrl(result.url)
      }
    } catch (requestError) {
      setPlayerError(requestError?.message || 'ElevenLabs is unavailable, using browser voices.')
      startSpeech(0)
    } finally {
      setPreparing(false)
    }
  }

  const handleTimeUpdate = () => {
    const audio = audioRef.current
    if (!audio) return
    setCurrentTime(audio.currentTime)
    const total = lines.reduce((sum, line) => sum + line.text.length, 0)
    if (!total) return
    const target = (audio.currentTime / Math.max(0.1, audio.duration || duration || 1)) * total
    let running = 0
    for (let index = 0; index < lines.length; index += 1) {
      running += lines[index].text.length
      if (target <= running) {
        setActiveLine(index)
        return
      }
    }
    setActiveLine(lines.length - 1)
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
            : 'Finish a question or a URL read. WebPilot will pool the takeaways and produce a Host A / Host B audio overview automatically.'}
        </p>
      </div>
    )
  }

  const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0
  const playerMeta =
    source === 'eleven'
      ? 'ElevenLabs voices'
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

          <div className="mt-5 rounded-xl border border-[#2F2F2F] bg-[#171717] p-4">
            <p className="text-[12.5px] text-[#9B9B9B]">{playerMeta}</p>
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
                    style={{ width: `${source === 'speech' ? (activeLine >= 0 ? ((activeLine + 1) / Math.max(1, lines.length)) * 100 : 0) : progress}%` }}
                  />
                </div>
                <div className="mt-1.5 flex justify-between text-[11px] text-[#9B9B9B]">
                  <span>{source === 'speech' ? `Line ${Math.max(0, activeLine + 1)} of ${lines.length}` : formatTime(currentTime)}</span>
                  <span>{source === 'speech' ? 'Browser voices' : formatTime(duration)}</span>
                </div>
              </div>
            </div>
            {playerError ? <p className="mt-3 text-[11.5px] leading-5 text-[#ECECEC]">{playerError}</p> : null}
            <audio
              ref={audioRef}
              src={audioUrl || undefined}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => {
                setPlaying(false)
                setActiveLine(-1)
                setCurrentTime(0)
                if (audioRef.current) audioRef.current.currentTime = 0
              }}
              onTimeUpdate={handleTimeUpdate}
              onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
              className="hidden"
            />
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
