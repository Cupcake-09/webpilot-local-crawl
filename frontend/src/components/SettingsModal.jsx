import { useEffect, useState } from 'react'
import { GEMINI_BASE_URL, GEMINI_MODELS, saveLlmSettings } from '../lib/llm.js'

export default function SettingsModal({ open, settings, onClose, onSave }) {
  const [draft, setDraft] = useState(settings)

  useEffect(() => {
    if (open) setDraft(settings)
  }, [open, settings])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const save = () => {
    saveLlmSettings(draft)
    onSave(draft)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 px-3 pb-3 pt-10 backdrop-blur-sm sm:items-center sm:p-6">
      <button type="button" aria-label="Close settings" className="absolute inset-0 cursor-default" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Model and API settings"
        className="relative w-full max-w-[480px] rounded-2xl border border-[#2F2F2F] bg-[#212121] p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-[16px] font-semibold text-[#ECECEC]">Model &amp; API settings</h2>
            <p className="mt-1 text-[12.5px] leading-5 text-[#9B9B9B]">
              Choose the model the research engine should call.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-8 w-8 place-items-center rounded-full text-[#9B9B9B] transition hover:bg-[#2A2A2A] hover:text-[#ECECEC]"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-4 w-4">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </div>

        <div className="mt-5 rounded-full border border-[#2F2F2F] bg-[#171717] p-1">
          <div className="grid grid-cols-2 gap-1">
            {[
              { id: 'local', label: 'Local Qwen 2.5 Coder' },
              { id: 'gemini', label: 'Google Gemini' },
            ].map((option) => {
              const active = draft.provider === option.id
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setDraft((current) => ({ ...current, provider: option.id }))}
                  className={`rounded-full px-3 py-2 text-[12.5px] transition ${
                    active ? 'bg-[#ECECEC] font-medium text-[#0D0D0D]' : 'text-[#9B9B9B] hover:text-[#ECECEC]'
                  }`}
                >
                  {option.label}
                </button>
              )
            })}
          </div>
        </div>

        {draft.provider === 'local' ? (
          <div className="mt-5 space-y-3 text-[12.5px] leading-5 text-[#9B9B9B]">
            <p>
              Uses the OpenAI-compatible endpoint from <span className="text-[#ECECEC]">backend/.env</span>:
              <span className="text-[#ECECEC]"> OPENAI_BASE_URL</span> and <span className="text-[#ECECEC]">LLM_MODEL</span>.
            </p>
            <div className="rounded-xl border border-[#2F2F2F] bg-[#171717] px-3 py-2.5">
              <p className="text-[12px] text-[#9B9B9B]">No key leaves this machine.</p>
            </div>
          </div>
        ) : (
          <div className="mt-5 space-y-3">
            <label className="block">
              <span className="mb-1.5 block text-[12px] text-[#9B9B9B]">AI Studio API key</span>
              <input
                type="password"
                value={draft.apiKey}
                onChange={(event) => setDraft((current) => ({ ...current, apiKey: event.target.value }))}
                placeholder="Paste your Google AI Studio key"
                autoComplete="off"
                className="w-full rounded-xl border border-[#2F2F2F] bg-[#171717] px-3 py-2.5 text-[13px] text-[#ECECEC] outline-none placeholder:text-[#6F6F6F] focus:border-[#4A4A4A]"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12px] text-[#9B9B9B]">Model</span>
              <select
                value={draft.model}
                onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))}
                className="w-full rounded-xl border border-[#2F2F2F] bg-[#171717] px-3 py-2.5 text-[13px] text-[#ECECEC] outline-none focus:border-[#4A4A4A]"
              >
                {GEMINI_MODELS.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-[11.5px] leading-5 text-[#9B9B9B]">
              Sent to FastAPI as <span className="text-[#ECECEC]">{GEMINI_BASE_URL}</span> via the X-LLM headers. The
              key is stored only in this browser.
            </p>
          </div>
        )}

        <div className="mt-6 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-3.5 py-2 text-[12.5px] text-[#9B9B9B] transition hover:bg-[#2A2A2A] hover:text-[#ECECEC]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            className="rounded-full bg-[#ECECEC] px-4 py-2 text-[12.5px] font-medium text-[#0D0D0D] transition hover:bg-white"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
