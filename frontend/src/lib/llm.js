/** Active model settings, persisted in localStorage and forwarded to FastAPI. */

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/'

export const GEMINI_MODELS = ['gemini-3.5-flash-lite', 'gemini-4-hydrogen']

const STORAGE_KEY = 'webpilot.llm.v1'

export const DEFAULT_LLM = {
  provider: 'local',
  apiKey: '',
  model: GEMINI_MODELS[0],
}

export function loadLlmSettings() {
  if (typeof window === 'undefined') return { ...DEFAULT_LLM }
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null')
    if (!stored) return { ...DEFAULT_LLM }
    return {
      provider: stored.provider === 'gemini' ? 'gemini' : 'local',
      apiKey: typeof stored.apiKey === 'string' ? stored.apiKey : '',
      model: GEMINI_MODELS.includes(stored.model) ? stored.model : GEMINI_MODELS[0],
    }
  } catch {
    return { ...DEFAULT_LLM }
  }
}

export function saveLlmSettings(settings) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    /* storage may be unavailable in private mode */
  }
}

export function llmLabel(settings) {
  if (settings?.provider === 'gemini') {
    return settings.apiKey ? `Google ${settings.model}` : 'Google Gemini (no key)'
  }
  return 'Local Qwen 2.5 Coder'
}

/** Forwarded headers. Local Qwen reads .env on the backend, so it sends none. */
export function llmHeaders(settings) {
  if (settings?.provider !== 'gemini' || !settings.apiKey) return {}
  return {
    'X-LLM-Base-Url': GEMINI_BASE_URL,
    'X-LLM-Api-Key': settings.apiKey,
    'X-LLM-Model': settings.model || GEMINI_MODELS[0],
  }
}
