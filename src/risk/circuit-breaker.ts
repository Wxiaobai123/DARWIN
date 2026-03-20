/**
 * DARWIN Risk Layer — Four-Tier Circuit Breaker
 *
 * Tier 1: Strategy-level  — single strategy exceeds its declared drawdown
 * Tier 2: Asset-level     — single asset total drawdown too high
 * Tier 3: Portfolio-level — total portfolio hits risk tier limit
 * Tier 4: Emergency       — extreme single-day loss or API disconnect
 */

import db from '../db.js'

export type RiskTier = 'conservative' | 'balanced' | 'aggressive'

const RISK_LIMITS: Record<RiskTier, { maxDrawdown: number; activePool: number }> = {
  conservative: { maxDrawdown: 0.05,  activePool: 0.50 },
  balanced:     { maxDrawdown: 0.15,  activePool: 0.70 },
  aggressive:   { maxDrawdown: 0.30,  activePool: 0.85 },
}

export interface CircuitBreakerState {
  activeTiers:        number[]
  affectedAssets:     string[]
  affectedStrategies: string[]
  systemHalted:       boolean
}

// In-memory state (also persisted to DB for audit)
let state: CircuitBreakerState = {
  activeTiers:        [],
  affectedAssets:     [],
  affectedStrategies: [],
  systemHalted:       false,
}

export function getState(): CircuitBreakerState {
  return { ...state }
}

export function isSystemHalted(): boolean {
  return state.systemHalted
}

/** Check if a specific asset is blocked by Tier 2+ breakers */
export function isAssetBlocked(asset: string): boolean {
  if (state.systemHalted) return true
  if (state.activeTiers.includes(3) || state.activeTiers.includes(4)) return true
  if (state.affectedAssets.includes('ALL')) return true
  return state.affectedAssets.includes(asset)
}

/** Check if a specific strategy is blocked by Tier 1+ breakers */
export function isStrategyBlocked(strategyId: string): boolean {
  if (state.systemHalted) return true
  if (state.activeTiers.includes(3) || state.activeTiers.includes(4)) return true
  if (state.affectedStrategies.includes('ALL')) return true
  return state.affectedStrategies.includes(strategyId)
}

/** Persist current state to DB (called after every state change) */
function persistState(): void {
  try {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS circuit_breaker_state (
        id             INTEGER PRIMARY KEY CHECK (id = 1),
        tiers_active   TEXT,
        system_halted  INTEGER,
        affected_assets     TEXT,
        affected_strategies TEXT,
        last_updated   TEXT
      )
    `).run()
    db.prepare(`
      INSERT OR REPLACE INTO circuit_breaker_state (id, tiers_active, system_halted, affected_assets, affected_strategies, last_updated)
      VALUES (1, ?, ?, ?, ?, datetime('now'))
    `).run(
      JSON.stringify(state.activeTiers),
      state.systemHalted ? 1 : 0,
      JSON.stringify(state.affectedAssets),
      JSON.stringify(state.affectedStrategies),
    )
  } catch {}
}

/** Restore state from DB on startup — crash recovery */
export function restoreStateFromDB(): void {
  try {
    const row = db.prepare(`
      SELECT tiers_active, system_halted, affected_assets, affected_strategies
      FROM circuit_breaker_state WHERE id = 1
    `).get() as { tiers_active: string; system_halted: number; affected_assets: string; affected_strategies: string } | undefined
    if (!row) return
    state.activeTiers        = row.tiers_active ? JSON.parse(row.tiers_active) : []
    state.systemHalted       = (row.system_halted ?? 0) === 1
    state.affectedAssets     = row.affected_assets ? JSON.parse(row.affected_assets) : []
    state.affectedStrategies = row.affected_strategies ? JSON.parse(row.affected_strategies) : []
    if (state.activeTiers.length > 0 || state.systemHalted) {
      console.log(`  [Risk] Restored circuit breaker: tiers=[${state.activeTiers.join(',')}] halted=${state.systemHalted}`)
    }
  } catch {}
}

// ── Tier triggers ─────────────────────────────────────────────────────────────

export function triggerTier1(strategyId: string, strategyName: string, drawdownPct: number): void {
  console.warn(`[CIRCUIT BREAKER T1] Strategy "${strategyName}" drawdown ${(drawdownPct * 100).toFixed(1)}%`)

  if (!state.affectedStrategies.includes(strategyId))
    state.affectedStrategies.push(strategyId)
  if (!state.activeTiers.includes(1))
    state.activeTiers.push(1)

  logEvent(1, `Strategy "${strategyName}" drawdown ${(drawdownPct * 100).toFixed(1)}%`,
    { strategies: [strategyId] })
  persistState()
}

export function triggerTier2(asset: string, drawdownPct: number, riskTier: RiskTier): void {
  const limit = RISK_LIMITS[riskTier].maxDrawdown * 0.5
  console.warn(`[CIRCUIT BREAKER T2] Asset ${asset} drawdown ${(drawdownPct * 100).toFixed(1)}% > limit ${(limit * 100).toFixed(1)}%`)

  if (!state.affectedAssets.includes(asset))
    state.affectedAssets.push(asset)
  if (!state.activeTiers.includes(2))
    state.activeTiers.push(2)

  logEvent(2, `Asset ${asset} drawdown ${(drawdownPct * 100).toFixed(1)}%`, { assets: [asset] })
  persistState()
}

export function triggerTier3(portfolioDrawdown: number, riskTier: RiskTier): void {
  const limit = RISK_LIMITS[riskTier].maxDrawdown
  console.error(`[CIRCUIT BREAKER T3] Portfolio drawdown ${(portfolioDrawdown * 100).toFixed(1)}% >= limit ${(limit * 100).toFixed(1)}%`)
  console.error(`[CIRCUIT BREAKER T3] ALL strategies paused. USER APPROVAL REQUIRED to resume.`)

  state.activeTiers = [3]
  state.affectedAssets = ['ALL']
  state.affectedStrategies = ['ALL']

  logEvent(3, `Portfolio drawdown ${(portfolioDrawdown * 100).toFixed(1)}%`, { scope: 'portfolio' })
  persistState()
}

export function triggerTier4(reason: string): void {
  console.error(`[CIRCUIT BREAKER T4 EMERGENCY] ${reason}`)
  console.error(`[CIRCUIT BREAKER T4] SYSTEM HALTED. Manual restart required.`)

  state.activeTiers = [4]
  state.systemHalted = true
  state.affectedAssets = ['ALL']
  state.affectedStrategies = ['ALL']

  logEvent(4, reason, { scope: 'system' })
  persistState()
}

// ── Demo helpers (force-trigger for scenario demos) ──────────────────────────

export function triggerTier2ForDemo(asset = 'BTC-USDT'): void {
  triggerTier2(asset, 0.12, 'balanced')
}

export function triggerTier3ForDemo(): void {
  triggerTier3(0.16, 'balanced')
}

// ── Risk checks (called by Risk Agent heartbeat) ──────────────────────────────

export interface PortfolioSnapshot {
  totalEquity:         number
  peakEquity:          number
  dailyPnl:            number
  assetDrawdowns:      Record<string, number>
  strategyDrawdowns:   Record<string, { name: string; drawdown: number; maxDeclared: number }>
}

export function runRiskChecks(snapshot: PortfolioSnapshot, riskTier: RiskTier): void {
  if (state.systemHalted) {
    console.log('[RISK] System halted — skipping checks until manual restart')
    return
  }

  const limits = RISK_LIMITS[riskTier]

  // Tier 4: emergency — single-day loss > 2× risk limit
  const dailyDrawdown = snapshot.totalEquity > 0
    ? Math.abs(Math.min(0, snapshot.dailyPnl)) / snapshot.totalEquity
    : 0
  if (dailyDrawdown > limits.maxDrawdown * 2) {
    triggerTier4(`Single-day drawdown ${(dailyDrawdown * 100).toFixed(1)}% > emergency threshold ${(limits.maxDrawdown * 200).toFixed(0)}%`)
    return
  }

  // Tier 3: portfolio
  const portfolioDrawdown = snapshot.peakEquity > 0
    ? (snapshot.peakEquity - snapshot.totalEquity) / snapshot.peakEquity
    : 0
  if (portfolioDrawdown >= limits.maxDrawdown) {
    triggerTier3(portfolioDrawdown, riskTier)
    return
  }

  // Tier 2: per-asset
  for (const [asset, drawdown] of Object.entries(snapshot.assetDrawdowns)) {
    const tier2Limit = limits.maxDrawdown * 0.5
    if (drawdown > tier2Limit && !state.affectedAssets.includes(asset)) {
      triggerTier2(asset, drawdown, riskTier)
    }
  }

  // Tier 1: per-strategy
  for (const [stratId, info] of Object.entries(snapshot.strategyDrawdowns)) {
    if (info.drawdown > info.maxDeclared && !state.affectedStrategies.includes(stratId)) {
      triggerTier1(stratId, info.name, info.drawdown)
    }
  }
}

// ── Reset (requires user approval for tier 3+) ───────────────────────────────

export function resetTier1(strategyId: string): void {
  state.affectedStrategies = state.affectedStrategies.filter(s => s !== strategyId)
  if (state.affectedStrategies.length === 0)
    state.activeTiers = state.activeTiers.filter(t => t !== 1)

  resolveEvent(1, strategyId, 'auto')
  persistState()
}

export function resetTier2(asset: string, approvedBy = 'user'): void {
  state.affectedAssets = state.affectedAssets.filter(a => a !== asset)
  if (state.affectedAssets.length === 0)
    state.activeTiers = state.activeTiers.filter(t => t !== 2)

  resolveEvent(2, asset, approvedBy)
  persistState()
}

export function resetTier3(approvedBy: string): void {
  state.activeTiers = state.activeTiers.filter(t => t !== 3)
  state.affectedAssets = []
  state.affectedStrategies = []
  resolveEvent(3, 'portfolio', approvedBy)
  persistState()
  console.log(`[RISK] Tier 3 circuit breaker reset by: ${approvedBy}`)
}

export function resetTier4(approvedBy: string): void {
  state = {
    activeTiers: [], affectedAssets: [],
    affectedStrategies: [], systemHalted: false,
  }
  resolveEvent(4, 'system', approvedBy)
  persistState()
  console.log(`[RISK] Emergency reset by: ${approvedBy}. System resuming.`)
}

// ── DB helpers ────────────────────────────────────────────────────────────────

function logEvent(tier: number, reason: string, affected: Record<string, unknown>): void {
  try {
    db.prepare(`
      INSERT INTO circuit_breaker_events (tier, trigger_reason, affected)
      VALUES (?, ?, ?)
    `).run(tier, reason, JSON.stringify(affected))
  } catch {
    // DB errors should not block risk actions
  }
}

function resolveEvent(tier: number, affectedKey: string, resolvedBy: string): void {
  try {
    db.prepare(`
      UPDATE circuit_breaker_events
      SET resolved_at = datetime('now'), resolved_by = ?
      WHERE tier = ? AND resolved_at IS NULL
      AND (json_extract(affected, '$.strategies[0]') = ?
         OR json_extract(affected, '$.assets[0]')  = ?
         OR json_extract(affected, '$.scope')       = ?)
    `).run(resolvedBy, tier, affectedKey, affectedKey, affectedKey)
  } catch {
    // Ignore
  }
}

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const _C  = { reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m', green:'\x1b[32m', yellow:'\x1b[33m', red:'\x1b[31m', cyan:'\x1b[36m' }
const _b  = (s: string) => `${_C.bold}${s}${_C.reset}`
const _gn = (s: string) => `${_C.green}${s}${_C.reset}`
const _yw = (s: string) => `${_C.yellow}${s}${_C.reset}`
const _rd = (s: string) => `${_C.red}${s}${_C.reset}`
const _dm = (s: string) => `${_C.dim}${s}${_C.reset}`
const _cy = (s: string) => `${_C.cyan}${s}${_C.reset}`

// ── Status display ────────────────────────────────────────────────────────────

export function printStatus(riskTier: RiskTier): void {
  const limits = RISK_LIMITS[riskTier]
  const tierLabel = riskTier === 'conservative' ? _gn(riskTier.toUpperCase())
                  : riskTier === 'balanced'     ? _yw(riskTier.toUpperCase())
                  : _rd(riskTier.toUpperCase())

  if (state.systemHalted) {
    console.log(`  🛡  ${_b('Risk')}  ${_rd('⛔ SYSTEM HALTED')}  ${_dm('— manual restart required')}`)
  } else if (state.activeTiers.length === 0) {
    console.log(`  🛡  ${_b('Risk')}  ${tierLabel}  ${_dm('MaxDD ')}${_cy((limits.maxDrawdown * 100).toFixed(0) + '%')}  ${_gn('✓ All clear')}`)
  } else {
    const tierStr = state.activeTiers.map(t => `T${t}`).join('+')
    console.log(`  🛡  ${_b('Risk')}  ${tierLabel}  ${_yw('⚠  Breakers: ' + tierStr)}`)
    if (state.affectedStrategies.length)
      console.log(`       ${_dm('Paused:')} ${state.affectedStrategies.join(', ')}`)
    if (state.affectedAssets.length)
      console.log(`       ${_dm('Blocked:')} ${state.affectedAssets.join(', ')}`)
  }
}
