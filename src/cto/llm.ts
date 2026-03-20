/**
 * DARWIN LLM Engine  (v3 — universal multi-provider)
 *
 * Design principles (deterministic-first):
 *   • Rule constraints ALWAYS enforced first by planTransition()
 *   • LLM only enriches rationale / priority / riskComment
 *   • No LLM failure can affect capital allocation or circuit breakers
 *   • Multiple providers tried in priority order; first success wins
 *   • Graceful fallback to null on all failures → caller uses rule-based output
 *   • No LLM configured? System runs 100% rule-based — no degradation
 *
 * Supported providers (15+ — configure via .env):
 *   ──── Tier 1: Dedicated adapters ───────────────────────
 *   ANTHROPIC_API_KEY    → Claude 3.5 Haiku
 *   ──── Tier 2: OpenAI-compatible (largest coverage) ─────
 *   OPENAI_API_KEY       → GPT-4o-mini
 *   DEEPSEEK_API_KEY     → deepseek-chat
 *   GROQ_API_KEY         → llama-3.1-70b (ultra-fast inference)
 *   MISTRAL_API_KEY      → mistral-small-latest
 *   XAI_API_KEY          → grok-2
 *   MOONSHOT_API_KEY     → moonshot-v1-8k (Kimi)
 *   ZHIPU_API_KEY        → glm-4-flash (ChatGLM)
 *   BAICHUAN_API_KEY     → Baichuan4
 *   YI_API_KEY           → yi-lightning
 *   QWEN_API_KEY         → qwen-turbo (Alibaba DashScope)
 *   OPENROUTER_API_KEY   → auto (meta-router, any model)
 *   TOGETHER_API_KEY     → meta-llama/Llama-3.1-70B-Instruct-Turbo
 *   SILICONFLOW_API_KEY  → deepseek-ai/DeepSeek-V3
 *   ──── Tier 3: Local inference (no API key needed) ──────
 *   OLLAMA_BASE_URL      → qwen2.5 / llama3 / mistral / etc.
 *   ──── Custom OpenAI-compatible endpoint ────────────────
 *   CUSTOM_LLM_BASE_URL + CUSTOM_LLM_KEY + CUSTOM_LLM_MODEL
 *
 * Priority order: env LLM_PROVIDER_ORDER or default alphabetical availability
 */

import db from '../db.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CTOLLMInput {
  marketState:   string
  prevState:     string | null
  stateChanged:  boolean
  strategies: Array<{
    name:       string
    status:     string
    score:      number
    asset:      string
    states:     string[]
    trades:     number
    winRate:    number
  }>
  allocation: {
    deployedPct: number
    reservePct:  number
    topStrategy: string | null
  }
  circuitBreaker: {
    activeTiers: number[]
    halted:      boolean
  }
  atrRatios: Record<string, number>
}

export interface CTOLLMOutput {
  rationale:    string
  priority:     string[]
  riskComment:  string
  llmUsed:      true
  provider:     string    // e.g. "deepseek", "groq[rescue]", "rule-based"
}

// ── Failure tracking ──────────────────────────────────────────────────────────

type FailureReason =
  | 'no_api_key'       // provider not configured
  | 'network_error'    // fetch threw (DNS, connection refused, etc.)
  | 'timeout'          // AbortSignal.timeout fired
  | 'http_error'       // non-2xx response (includes rate limit 429, server 500)
  | 'empty_response'   // 200 but no content in response body
  | 'parse_failed'     // got text but couldn't extract valid JSON after all repair stages
  | 'validation_failed'// JSON parsed but missing required fields

interface FailureRecord {
  provider: string
  reason:   FailureReason
  detail?:  string       // e.g. "HTTP 429", "timeout after 15s"
  at:       string       // ISO timestamp
}

// Rolling failure log — last 50 failures, queryable for diagnostics
const failureLog: FailureRecord[] = []
const MAX_FAILURE_LOG = 50

function logFailure(provider: string, reason: FailureReason, detail?: string) {
  const record: FailureRecord = { provider, reason, detail, at: new Date().toISOString() }
  failureLog.push(record)
  if (failureLog.length > MAX_FAILURE_LOG) failureLog.shift()

  // Persist to DB for audit (non-fatal)
  try {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS llm_failures (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        reason   TEXT NOT NULL,
        detail   TEXT,
        at       TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `).run()
    db.prepare('INSERT INTO llm_failures (provider, reason, detail, at) VALUES (?, ?, ?, ?)').run(
      record.provider, record.reason, record.detail ?? null, record.at,
    )
  } catch {}
}

/** Get recent failures (for diagnostics / status endpoint) */
export function getRecentFailures(): FailureRecord[] {
  return [...failureLog]
}

// ── Provider definitions ───────────────────────────────────────────────────────

interface Provider {
  name:        string
  isAvailable: () => boolean
  call:        (prompt: string) => Promise<string | null>
}

// ── Anthropic adapter (unique API format) ─────────────────────────────────────

const anthropicProvider: Provider = {
  name: 'anthropic',
  isAvailable: () => !!process.env.ANTHROPIC_API_KEY,
  call: async (prompt) => {
    const apiKey = process.env.ANTHROPIC_API_KEY!
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-3-5-haiku-20241022',
        max_tokens: 512,
        messages:   [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      logFailure('anthropic', 'http_error', `HTTP ${res.status}`)
      return null
    }
    const data = await res.json() as { content?: Array<{ text?: string }> }
    const text = data.content?.[0]?.text ?? null
    if (!text) logFailure('anthropic', 'empty_response')
    return text
  },
}

// ── Google Gemini adapter (unique API format) ─────────────────────────────────

const geminiProvider: Provider = {
  name: 'gemini',
  isAvailable: () => !!process.env.GEMINI_API_KEY,
  call: async (prompt) => {
    const apiKey = process.env.GEMINI_API_KEY!
    const model  = process.env.GEMINI_MODEL ?? 'gemini-2.0-flash'
    const url    = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 512 },
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      logFailure('gemini', 'http_error', `HTTP ${res.status}`)
      return null
    }
    const data = await res.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? null
    if (!text) logFailure('gemini', 'empty_response')
    return text
  },
}

// ── OpenAI-compatible factory (covers 12+ providers) ──────────────────────────

function openAICompat(opts: {
  name:    string
  envKey:  string
  baseURL: string
  model:   string | (() => string)
}): Provider {
  return {
    name: opts.name,
    isAvailable: () => {
      if (opts.name === 'ollama')  return !!process.env.OLLAMA_BASE_URL
      if (opts.name === 'custom')  return !!process.env.CUSTOM_LLM_BASE_URL
      return !!process.env[opts.envKey]
    },
    call: async (prompt) => {
      const apiKey = opts.name === 'ollama'
        ? 'ollama'
        : opts.name === 'custom'
          ? (process.env.CUSTOM_LLM_KEY ?? 'none')
          : (process.env[opts.envKey] ?? '')

      const baseURL = opts.name === 'ollama'
        ? (process.env.OLLAMA_BASE_URL ?? opts.baseURL)
        : opts.name === 'custom'
          ? (process.env.CUSTOM_LLM_BASE_URL ?? opts.baseURL)
          : opts.baseURL

      const model = typeof opts.model === 'function' ? opts.model() : opts.model

      const res = await fetch(`${baseURL}/chat/completions`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: 512,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(15_000),
      })

      if (!res.ok) {
        logFailure(opts.name, 'http_error', `HTTP ${res.status}`)
        return null
      }
      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
      const text = data.choices?.[0]?.message?.content ?? null
      if (!text) logFailure(opts.name, 'empty_response')
      return text
    },
  }
}

// ── All providers ─────────────────────────────────────────────────────────────
//
//  Provider           API Key Env Var         Base URL                                     Model
//  ─────────────────  ──────────────────────  ───────────────────────────────────────────   ────────────────────

const providers: Provider[] = [
  // Tier 1: unique API formats
  anthropicProvider,
  geminiProvider,

  // Tier 2: OpenAI-compatible cloud providers
  openAICompat({ name: 'openai',      envKey: 'OPENAI_API_KEY',      baseURL: 'https://api.openai.com/v1',                           model: 'gpt-4o-mini' }),
  openAICompat({ name: 'deepseek',    envKey: 'DEEPSEEK_API_KEY',    baseURL: 'https://api.deepseek.com/v1',                         model: 'deepseek-chat' }),
  openAICompat({ name: 'groq',        envKey: 'GROQ_API_KEY',        baseURL: 'https://api.groq.com/openai/v1',                      model: 'llama-3.1-70b-versatile' }),
  openAICompat({ name: 'mistral',     envKey: 'MISTRAL_API_KEY',     baseURL: 'https://api.mistral.ai/v1',                           model: 'mistral-small-latest' }),
  openAICompat({ name: 'xai',         envKey: 'XAI_API_KEY',         baseURL: 'https://api.x.ai/v1',                                 model: 'grok-2' }),
  openAICompat({ name: 'moonshot',    envKey: 'MOONSHOT_API_KEY',    baseURL: 'https://api.moonshot.cn/v1',                           model: 'moonshot-v1-8k' }),
  openAICompat({ name: 'zhipu',       envKey: 'ZHIPU_API_KEY',       baseURL: 'https://open.bigmodel.cn/api/paas/v4',                model: 'glm-4-flash' }),
  openAICompat({ name: 'baichuan',    envKey: 'BAICHUAN_API_KEY',    baseURL: 'https://api.baichuan-ai.com/v1',                      model: 'Baichuan4' }),
  openAICompat({ name: 'yi',          envKey: 'YI_API_KEY',          baseURL: 'https://api.lingyiwanwu.com/v1',                      model: 'yi-lightning' }),
  openAICompat({ name: 'qwen',        envKey: 'QWEN_API_KEY',        baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',   model: 'qwen-turbo' }),
  openAICompat({ name: 'openrouter',  envKey: 'OPENROUTER_API_KEY',  baseURL: 'https://openrouter.ai/api/v1',                        model: () => process.env.OPENROUTER_MODEL ?? 'auto' }),
  openAICompat({ name: 'together',    envKey: 'TOGETHER_API_KEY',    baseURL: 'https://api.together.xyz/v1',                         model: 'meta-llama/Llama-3.1-70B-Instruct-Turbo' }),
  openAICompat({ name: 'siliconflow', envKey: 'SILICONFLOW_API_KEY', baseURL: 'https://api.siliconflow.cn/v1',                       model: 'deepseek-ai/DeepSeek-V3' }),

  // Tier 3: local inference
  openAICompat({ name: 'ollama',      envKey: 'OLLAMA_MODEL',        baseURL: 'http://localhost:11434/v1',                            model: () => process.env.OLLAMA_MODEL ?? 'qwen2.5' }),

  // Tier 4: user-defined custom endpoint
  openAICompat({ name: 'custom',      envKey: 'CUSTOM_LLM_KEY',      baseURL: 'http://localhost:8000/v1',                             model: () => process.env.CUSTOM_LLM_MODEL ?? 'default' }),
]

// ── Provider registry ─────────────────────────────────────────────────────────

const ALL_PROVIDERS: Record<string, Provider> = Object.fromEntries(
  providers.map(p => [p.name, p])
)

const DEFAULT_ORDER = [
  'anthropic', 'openai', 'deepseek', 'gemini', 'groq', 'mistral',
  'xai', 'moonshot', 'zhipu', 'qwen', 'baichuan', 'yi',
  'openrouter', 'together', 'siliconflow', 'ollama', 'custom',
]

function getProviderChain(): Provider[] {
  const orderEnv = process.env.LLM_PROVIDER_ORDER
  const order    = orderEnv ? orderEnv.split(',').map(s => s.trim()) : DEFAULT_ORDER
  return order
    .map(name => ALL_PROVIDERS[name])
    .filter((p): p is Provider => !!p && p.isAvailable())
}

// ── Retry wrapper with failure tracking ───────────────────────────────────────

async function callWithRetry(provider: Provider, prompt: string, retries = 3): Promise<string | null> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await provider.call(prompt)
      if (result) return result
      // call() already logged the specific failure (http_error or empty_response)
    } catch (err: unknown) {
      const isTimeout = err instanceof DOMException && err.name === 'AbortError'
      logFailure(
        provider.name,
        isTimeout ? 'timeout' : 'network_error',
        isTimeout ? 'timeout after 15s' : String(err).slice(0, 100),
      )
    }
    if (attempt < retries) {
      await new Promise(r => setTimeout(r, attempt * 2000))
    }
  }
  return null
}

// ── Parse structured output ───────────────────────────────────────────────────
//
// Multi-stage repair pipeline (inspired by BettaFish):
//   Stage 1: strip <thinking>...</thinking> reasoning traces
//   Stage 2: strip ```json ``` markdown fences
//   Stage 3: extract first complete {...} block
//   Stage 4: JSON.parse
//   Stage 5: bracket balancing — close unclosed braces and arrays

function validateParsed(parsed: Partial<CTOLLMOutput>): Omit<CTOLLMOutput, 'provider'> | null {
  if (typeof parsed.rationale !== 'string')   return null
  if (!Array.isArray(parsed.priority))         return null
  if (typeof parsed.riskComment !== 'string')  return null

  return {
    rationale:   parsed.rationale.slice(0, 300),
    priority:    parsed.priority.slice(0, 3).map(String),
    riskComment: parsed.riskComment.slice(0, 150),
    llmUsed:     true,
  }
}

function parseStructured(text: string, providerName: string): Omit<CTOLLMOutput, 'provider'> | null {
  // Stage 1: strip reasoning traces
  let cleaned = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim()

  // Stage 2: strip markdown code fences
  cleaned = cleaned.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim()

  // Stage 3: extract the outermost {...} block
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    logFailure(providerName, 'parse_failed', 'no JSON block found in response')
    return null
  }

  let candidate = jsonMatch[0]

  // Stage 4: standard parse
  try {
    const parsed = JSON.parse(candidate) as Partial<CTOLLMOutput>
    const result = validateParsed(parsed)
    if (result) return result
    logFailure(providerName, 'validation_failed', 'JSON parsed but missing required fields')
    return null
  } catch {}

  // Stage 5: bracket balancing
  const opens   = (candidate.match(/\{/g)  ?? []).length
  const closes  = (candidate.match(/\}/g)  ?? []).length
  const aOpens  = (candidate.match(/\[/g)  ?? []).length
  const aCloses = (candidate.match(/\]/g)  ?? []).length

  if (aOpens > aCloses) candidate += ']'.repeat(aOpens - aCloses)
  if (opens  > closes)  candidate += '}'.repeat(opens  - closes)

  try {
    const parsed = JSON.parse(candidate) as Partial<CTOLLMOutput>
    const result = validateParsed(parsed)
    if (result) return result
    logFailure(providerName, 'validation_failed', 'repaired JSON still missing fields')
  } catch {
    logFailure(providerName, 'parse_failed', 'bracket repair failed')
  }

  return null
}

// ── Rescue prompt (BettaFish cross-engine rescue pattern) ─────────────────────

function buildRepairPrompt(_originalPrompt: string, brokenOutput: string): string {
  return `The following JSON is malformed. Fix it and return ONLY valid JSON with no preamble.

Required JSON format:
{"rationale":"<string>","priority":["<string>","<string>","<string>"],"riskComment":"<string>"}

Broken output to fix:
${brokenOutput.slice(0, 800)}

Return ONLY the corrected JSON. No explanation, no markdown fences.`
}

// ── Agent context injection (BettaFish ForumHost pattern) ─────────────────────

export interface AgentContext {
  riskSummary?:   string
  auditorNote?:   string
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildPrompt(input: CTOLLMInput, ctx?: AgentContext): string {
  const stratList = input.strategies.length > 0
    ? input.strategies.slice(0, 6).map(s =>
        `  - ${s.name} [${s.status}] score=${s.score.toFixed(2)} wr=${(s.winRate * 100).toFixed(0)}% asset=${s.asset}`
      ).join('\n')
    : '  (none active)'

  const atrInfo = Object.entries(input.atrRatios)
    .map(([a, v]) => `${a.replace('-USDT', '')}:${v.toFixed(2)}x`).join(' | ')

  const agentCtxLines: string[] = []
  if (ctx?.riskSummary) agentCtxLines.push(`- Risk Agent: ${ctx.riskSummary}`)
  if (ctx?.auditorNote) agentCtxLines.push(`- Auditor:    ${ctx.auditorNote}`)
  const agentCtxSection = agentCtxLines.length > 0
    ? `\nLatest agent context:\n${agentCtxLines.join('\n')}\n`
    : ''

  return `You are the Chief Trading Officer (CTO) of DARWIN, an AI-driven crypto grid-bot trading system.

Current market context:
- Market regime: ${input.marketState.toUpperCase()}${input.stateChanged ? ` (just changed from ${input.prevState?.toUpperCase()})` : ' (stable)'}
- Volatility (ATR ratios, 1.0=normal): ${atrInfo || 'unknown'}
- Circuit breakers: ${input.circuitBreaker.halted ? 'SYSTEM HALTED' : input.circuitBreaker.activeTiers.length > 0 ? `Tiers [${input.circuitBreaker.activeTiers.join(',')}] active` : 'all clear'}
- Capital deployed: ${(input.allocation.deployedPct * 100).toFixed(1)}%  reserve: ${(input.allocation.reservePct * 100).toFixed(1)}%
${agentCtxSection}
Available strategies (sorted by score):
${stratList}

Your job: in 1-2 sentences, state your key insight about the current regime and which strategies to prioritise. Be specific and actionable.

Respond ONLY with valid JSON (no markdown, no preamble):
{"rationale":"<1-2 sentence insight>","priority":["<strategy1>","<strategy2>","<strategy3>"],"riskComment":"<1 sentence risk note>"}`
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Enrich the CTO decision with LLM insights.
 *
 * Tries each configured provider in priority order; first success wins.
 * Returns null if no provider is configured or all fail.
 * Callers MUST always implement a rule-based fallback.
 *
 * Failure detection (5 layers):
 *   1. network_error  — DNS / connection refused / socket hang up
 *   2. timeout        — no response within 15 seconds
 *   3. http_error     — 429 rate limit, 500 server error, 401 auth, etc.
 *   4. parse_failed   — got text but couldn't extract valid JSON after 5 repair stages
 *   5. validation_failed — JSON parsed but rationale/priority/riskComment missing
 *
 * All failures are logged to `llm_failures` DB table + in-memory ring buffer.
 * Query with getRecentFailures() or SELECT * FROM llm_failures.
 */
export async function enrichCTODecision(
  input: CTOLLMInput,
  ctx?: AgentContext,
): Promise<CTOLLMOutput | null> {
  const chain = getProviderChain()
  if (chain.length === 0) return null   // no LLM configured → pure rule-based, no degradation

  const prompt = buildPrompt(input, ctx)

  let lastBrokenRaw: string | null = null

  for (let i = 0; i < chain.length; i++) {
    const provider = chain[i]!

    // Cross-engine rescue: if previous provider returned broken output,
    // send it to this provider for repair (BettaFish pattern)
    if (lastBrokenRaw && i > 0) {
      const repairPrompt = buildRepairPrompt(prompt, lastBrokenRaw)
      const rescued      = await callWithRetry(provider, repairPrompt, 2)
      if (rescued) {
        const rescueParsed = parseStructured(rescued, `${provider.name}[rescue]`)
        if (rescueParsed) {
          return { ...rescueParsed, provider: `${provider.name}[rescue]` }
        }
      }
    }

    // Standard attempt
    const raw = await callWithRetry(provider, prompt)
    if (!raw) continue

    const parsed = parseStructured(raw, provider.name)
    if (parsed) return { ...parsed, provider: provider.name }

    lastBrokenRaw = raw
  }

  return null   // all providers exhausted → caller uses rule-based
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/** List providers that have API keys configured (for startup logging) */
export function listConfiguredProviders(): string[] {
  return getProviderChain().map(p => p.name)
}

/** List ALL supported providers (for help/docs) */
export function listAllSupportedProviders(): Array<{ name: string; envKey: string; available: boolean }> {
  const envKeys: Record<string, string> = {
    anthropic:   'ANTHROPIC_API_KEY',
    gemini:      'GEMINI_API_KEY',
    openai:      'OPENAI_API_KEY',
    deepseek:    'DEEPSEEK_API_KEY',
    groq:        'GROQ_API_KEY',
    mistral:     'MISTRAL_API_KEY',
    xai:         'XAI_API_KEY',
    moonshot:    'MOONSHOT_API_KEY',
    zhipu:       'ZHIPU_API_KEY',
    baichuan:    'BAICHUAN_API_KEY',
    yi:          'YI_API_KEY',
    qwen:        'QWEN_API_KEY',
    openrouter:  'OPENROUTER_API_KEY',
    together:    'TOGETHER_API_KEY',
    siliconflow: 'SILICONFLOW_API_KEY',
    ollama:      'OLLAMA_BASE_URL',
    custom:      'CUSTOM_LLM_BASE_URL',
  }
  return providers.map(p => ({
    name:      p.name,
    envKey:    envKeys[p.name] ?? 'unknown',
    available: p.isAvailable(),
  }))
}
