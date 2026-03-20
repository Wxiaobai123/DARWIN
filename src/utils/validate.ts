/**
 * DARWIN Structured Output Validator
 *
 * Inspired by ai-hedge-fund's Pydantic validation pattern.
 * Provides type-safe parsing with graceful fallback for all agent outputs.
 *
 * Usage:
 *   const result = validate(rawData, MarketStateSchema, defaultMarketState)
 *   // → always returns a valid value, never throws
 */

// ── Generic validator ─────────────────────────────────────────────────────────

export type Validator<T> = (data: unknown) => T | null

/**
 * Parse and validate `data` using `validator`.
 * Returns `fallback` if validation fails.
 * Never throws — safe to use in heartbeat handlers.
 */
export function validate<T>(
  data:      unknown,
  validator: Validator<T>,
  fallback:  T,
): T {
  try {
    const result = validator(data)
    return result ?? fallback
  } catch {
    return fallback
  }
}

/**
 * Parse JSON string safely, validate the result.
 * Returns fallback if JSON parse or validation fails.
 */
export function parseAndValidate<T>(
  jsonString: string,
  validator:  Validator<T>,
  fallback:   T,
): T {
  try {
    const parsed = JSON.parse(jsonString) as unknown
    return validate(parsed, validator, fallback)
  } catch {
    return fallback
  }
}

// ── Domain validators ─────────────────────────────────────────────────────────

/** Market state output from recognizeState() */
export interface ValidatedMarketState {
  state:      'oscillation' | 'trend' | 'extreme'
  confidence: number
  atrRatio:   number
  funding:    number
  volume:     number
}

export function validateMarketState(data: unknown): ValidatedMarketState | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>

  const state = d.state as string
  if (!['oscillation', 'trend', 'extreme'].includes(state)) return null

  return {
    state:      state as 'oscillation' | 'trend' | 'extreme',
    confidence: typeof d.confidence === 'number' ? Math.max(0, Math.min(1, d.confidence)) : 0.5,
    atrRatio:   typeof (d.indicators as Record<string, unknown>)?.atrRatio === 'number'
                  ? (d.indicators as Record<string, number>).atrRatio : 1.0,
    funding:    typeof (d.indicators as Record<string, unknown>)?.fundingRate === 'number'
                  ? (d.indicators as Record<string, number>).fundingRate : 0,
    volume:     typeof (d.indicators as Record<string, unknown>)?.volumeRatio === 'number'
                  ? (d.indicators as Record<string, number>).volumeRatio : 1.0,
  }
}

export const defaultMarketState: ValidatedMarketState = {
  state: 'oscillation', confidence: 0.5,
  atrRatio: 1.0, funding: 0, volume: 1.0,
}

/** Risk check output */
export interface ValidatedRiskStatus {
  equity:      number
  peakEquity:  number
  dailyPnl:    number
  activeTiers: number[]
  halted:      boolean
}

export function validateRiskStatus(data: unknown): ValidatedRiskStatus | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>

  return {
    equity:      typeof d.equity === 'number'     ? d.equity     : 0,
    peakEquity:  typeof d.peakEquity === 'number' ? d.peakEquity : 0,
    dailyPnl:    typeof d.dailyPnl === 'number'   ? d.dailyPnl   : 0,
    activeTiers: Array.isArray(d.activeTiers)     ? d.activeTiers.filter((t): t is number => typeof t === 'number') : [],
    halted:      typeof d.halted === 'boolean'    ? d.halted      : false,
  }
}

export const defaultRiskStatus: ValidatedRiskStatus = {
  equity: 0, peakEquity: 0, dailyPnl: 0,
  activeTiers: [], halted: false,
}

/** CTO decision output */
export interface ValidatedCTODecision {
  currentState: 'oscillation' | 'trend' | 'extreme'
  stateChanged: boolean
  actionsCount: number
  rationale:    string
}

export function validateCTODecision(data: unknown): ValidatedCTODecision | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>

  const state = d.currentState as string
  if (!['oscillation', 'trend', 'extreme'].includes(state)) return null

  return {
    currentState: state as 'oscillation' | 'trend' | 'extreme',
    stateChanged: typeof d.stateChanged === 'boolean' ? d.stateChanged : false,
    actionsCount: typeof d.actionsCount === 'number'  ? d.actionsCount : 0,
    rationale:    typeof d.rationale    === 'string'  ? d.rationale    : 'No rationale available',
  }
}

export const defaultCTODecision: ValidatedCTODecision = {
  currentState: 'oscillation',
  stateChanged: false,
  actionsCount: 0,
  rationale:    'No decision available (fallback)',
}

/** Strategy promotion event */
export interface ValidatedPromotion {
  strategyId: string
  name:       string
  action:     'promoted' | 'demoted' | 'eliminated' | 'shadow'
}

export function validatePromotion(data: unknown): ValidatedPromotion | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>

  if (typeof d.strategyId !== 'string') return null
  if (typeof d.name !== 'string')       return null

  const action = d.action as string
  if (!['promoted', 'demoted', 'eliminated', 'shadow'].includes(action)) return null

  return {
    strategyId: d.strategyId,
    name:       d.name,
    action:     action as ValidatedPromotion['action'],
  }
}

/** LLM output from Claude */
export interface ValidatedLLMOutput {
  rationale:   string
  priority:    string[]
  riskComment: string
}

export function validateLLMOutput(data: unknown): ValidatedLLMOutput | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>

  if (typeof d.rationale !== 'string')   return null
  if (!Array.isArray(d.priority))        return null
  if (typeof d.riskComment !== 'string') return null

  return {
    rationale:   d.rationale.slice(0, 400),
    priority:    d.priority.slice(0, 5).map(String),
    riskComment: d.riskComment.slice(0, 200),
  }
}

export const defaultLLMOutput: ValidatedLLMOutput = {
  rationale:   'LLM unavailable — rule-based decision applied',
  priority:    [],
  riskComment: '',
}
