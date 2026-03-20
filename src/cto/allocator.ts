/**
 * DARWIN Capital Allocator  (v2 — volatility + correlation adjusted)
 *
 * Weighted-scoring allocation engine with volatility and correlation adjustments.
 * Given total available capital and a set of strategies,
 * returns the USDT amount each strategy should deploy.
 *
 * v2 improvements (inspired by ai-hedge-fund risk manager):
 *
 *   1. Volatility multiplier — strategies on high-ATR assets receive a
 *      reduced position cap proportional to current realised volatility.
 *      Source: latest ATR ratio stored by Market Analyst heartbeat.
 *
 *   2. Correlation discount — multiple strategies on the same asset are
 *      co-correlated by construction.  2nd+ strategies on the same asset
 *      receive a decreasing multiplier to prevent over-concentration.
 *
 * Hard constraints:
 *   - Single strategy cap: conservative 20%, balanced 30%, aggressive 40%
 *   - New/unproven strategies: max 10% regardless of tier
 *   - Extreme state: max 5% total deployed (preserve capital)
 *   - Sum of all allocations ≤ activePool% of totalEquity
 */

import { getAllStrategies, getPerformance } from '../strategy/archive.js'
import type { MarketState } from '../market/state-recognizer.js'
import type { RiskTier } from '../risk/circuit-breaker.js'
import db from '../db.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Allocation {
  strategyId:       string
  name:             string
  status:           string
  score:            number
  allocUSDT:        number
  allocPct:         number
  reason:           string
  volatilityMult:   number   // 1.0 = no adjustment
  correlationMult:  number   // 1.0 = no adjustment
}

export interface AllocationPlan {
  totalEquity:   number
  deployedUSDT:  number
  deployedPct:   number
  reserveUSDT:   number
  allocations:   Allocation[]
  marketState:   MarketState
  riskTier:      RiskTier
  volatilityMap: Record<string, number>   // asset → ATR ratio
}

// ── Risk tier constraints ─────────────────────────────────────────────────────

export const ALLOC_LIMITS: Record<RiskTier, {
  activePoolPct:   number   // max fraction of equity to deploy total
  maxSinglePct:    number   // max fraction of deployed pool per strategy
  newStratMaxPct:  number   // cap for strategies with < 10 trades
}> = {
  conservative: { activePoolPct: 0.30, maxSinglePct: 0.20, newStratMaxPct: 0.08 },
  balanced:     { activePoolPct: 0.50, maxSinglePct: 0.30, newStratMaxPct: 0.10 },
  aggressive:   { activePoolPct: 0.70, maxSinglePct: 0.40, newStratMaxPct: 0.15 },
}

// ── Volatility adjustment (inspired by ai-hedge-fund) ─────────────────────────
//
// ATR ratio bands → position cap multiplier
//   < 0.8  → 1.20  (below-average vol: can allocate a bit more)
//   < 1.2  → 1.00  (normal range: no adjustment)
//   < 2.0  → 0.80  (elevated: reduce by 20%)
//   < 3.0  → 0.60  (high: reduce by 40%)
//   ≥ 3.0  → 0.40  (extreme: severely cap — mirrors extreme state 5% rule)

function volatilityMultiplier(atrRatio: number): number {
  if (atrRatio < 0.8) return 1.20
  if (atrRatio < 1.2) return 1.00
  if (atrRatio < 2.0) return 0.80
  if (atrRatio < 3.0) return 0.60
  return 0.40
}

// ── Correlation discount (same-asset strategies) ───────────────────────────────
//
// Strategies on the same underlying asset are co-correlated by construction.
// The Nth strategy on the same asset receives a discount:
//   1st  → 1.00 (no discount)
//   2nd  → 0.70
//   3rd  → 0.50
//   4th+ → 0.35

function correlationMultiplier(rankOnAsset: number): number {
  if (rankOnAsset <= 1) return 1.00
  if (rankOnAsset === 2) return 0.70
  if (rankOnAsset === 3) return 0.50
  return 0.35
}

// ── Read latest ATR ratios from DB (written by Market Analyst) ─────────────────

function getLatestVolatilityMap(assets: string[]): Record<string, number> {
  const map: Record<string, number> = {}
  for (const asset of assets) {
    try {
      const row = db.prepare(`
        SELECT indicators FROM market_states
        WHERE asset = ?
        ORDER BY recorded_at DESC
        LIMIT 1
      `).get(asset) as { indicators: string } | undefined

      if (row?.indicators) {
        const ind = JSON.parse(row.indicators) as { atrRatio?: number }
        if (typeof ind.atrRatio === 'number') {
          map[asset] = ind.atrRatio
        }
      }
    } catch {
      // Non-fatal
    }
    if (!(asset in map)) map[asset] = 1.0  // default: no adjustment
  }
  return map
}

// ── Equity scaling ──────────────────────────────────────────────────────────
//
// Strategy YAML caps (max_position_usdt, order amounts) are authored for a
// $10 000 reference portfolio.  For larger/smaller portfolios we scale
// proportionally so a $50K account deploys 5× more per strategy.

const REFERENCE_EQUITY = 10_000

export function equityScale(totalEquity: number): number {
  return Math.max(totalEquity / REFERENCE_EQUITY, 0.5)   // floor 0.5 for tiny accounts
}

// ── Allocation engine ─────────────────────────────────────────────────────────

export function calculateAllocations(
  totalEquity:  number,
  marketState:  MarketState,
  riskTier:     RiskTier,
): AllocationPlan {

  const limits = ALLOC_LIMITS[riskTier]
  const eqScale = equityScale(totalEquity)

  // In extreme state, deploy max 5% of equity regardless of tier
  const activePoolPct = marketState === 'extreme'
    ? 0.05
    : limits.activePoolPct

  const deployableUSDT = totalEquity * activePoolPct

  // Pre-fetch all strategies and all unique assets for ATR lookup
  const allLive = getAllStrategies('live')
  const allAssets = [...new Set(allLive.flatMap(s => s.spec.conditions.assets))]
  const volatilityMap = getLatestVolatilityMap(allAssets)

  // Get strategies that match the current market state
  // Also filter by ATR ratio conditions (wired from strategy YAML)
  const strategies = allLive.filter(s => {
    if (!s.spec.conditions.market_states.includes(marketState)) return false

    // Check ATR ratio bounds per strategy
    const primaryAsset = s.spec.conditions.assets[0]
    if (primaryAsset) {
      const atr = volatilityMap[primaryAsset] ?? 1.0
      if (s.spec.conditions.min_atr_ratio != null && atr < s.spec.conditions.min_atr_ratio) return false
      if (s.spec.conditions.max_atr_ratio != null && atr > s.spec.conditions.max_atr_ratio) return false
    }

    return true
  })

  if (strategies.length === 0) {
    return {
      totalEquity,
      deployedUSDT:  0,
      deployedPct:   0,
      reserveUSDT:   totalEquity,
      allocations:   [],
      marketState,
      riskTier,
      volatilityMap,
    }
  }

  // Score each strategy (same formula as v1)
  const scored = strategies.map(s => {
    const perfs    = getPerformance(s.id)
    const trades   = perfs.reduce((n, p) => n + p.trades, 0)
    const winRate  = trades > 0
      ? perfs.reduce((n, p) => n + p.winning_trades, 0) / trades
      : 0
    const returns  = perfs.map(p => p.total_return)
    const avgRet   = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0
    const stateMatch = s.spec.conditions.market_states.includes(marketState) ? 1.0 : 0.3

    const variance = returns.length > 1
      ? returns.reduce((sum, r) => sum + (r - avgRet) ** 2, 0) / returns.length
      : 0.01
    const sharpe = variance > 0 ? Math.min(avgRet / Math.sqrt(variance), 3) : 0

    const score = winRate * 0.4 + Math.max(0, sharpe / 3) * 0.3 + stateMatch * 0.2 + 0.1
    const isNew = trades < 10

    // Primary asset for this strategy (first in the assets list)
    const primaryAsset = s.spec.conditions.assets[0] ?? 'UNKNOWN'

    return { s, score, trades, isNew, primaryAsset }
  })

  // Sort by score descending (to assign correlation ranks correctly)
  scored.sort((a, b) => b.score - a.score)

  // Track how many strategies we've assigned per asset (for correlation discount)
  const assetCount: Record<string, number> = {}

  // Normalise scores to weights
  const totalScore = scored.reduce((sum, x) => sum + Math.max(x.score, 0.01), 0)

  const allocations: Allocation[] = []
  let totalAllocated = 0

  for (const { s, score, trades, isNew, primaryAsset } of scored) {
    const weight = Math.max(score, 0.01) / totalScore

    // ── Compute adjustments ───────────────────────────────────────────────────

    // Volatility: use the ATR ratio of the strategy's primary asset
    const atrRatio   = volatilityMap[primaryAsset] ?? 1.0
    const volMult    = volatilityMultiplier(atrRatio)

    // Correlation: rank of this strategy among strategies on the same asset
    assetCount[primaryAsset] = (assetCount[primaryAsset] ?? 0) + 1
    const corrMult = correlationMultiplier(assetCount[primaryAsset])

    // ── Apply caps with adjustments ───────────────────────────────────────────

    let allocUSDT  = deployableUSDT * weight

    // Base single-strategy cap — adjusted by volatility and correlation
    const singleCap = deployableUSDT * limits.maxSinglePct * volMult * corrMult
    const newCap    = deployableUSDT * limits.newStratMaxPct
    const cap       = isNew ? Math.min(singleCap, newCap) : singleCap

    if (allocUSDT > cap) allocUSDT = cap

    // Per-strategy max_position_usdt cap (from strategy YAML risk section)
    // Scale by equity factor — YAML caps are for $10K reference portfolio
    const maxPosBase = s.spec.risk.max_position_usdt
    if (maxPosBase != null && maxPosBase > 0) {
      const maxPosScaled = maxPosBase * eqScale
      if (allocUSDT > maxPosScaled) allocUSDT = maxPosScaled
    }

    // Round to nearest $10 for cleaner orders
    allocUSDT = Math.floor(allocUSDT / 10) * 10

    // ── Build reason string ───────────────────────────────────────────────────

    const adjustments: string[] = []
    if (volMult !== 1.0) {
      const dir = volMult > 1 ? '↑' : '↓'
      adjustments.push(`vol${dir}${(volMult * 100).toFixed(0)}% ATR=${atrRatio.toFixed(2)}x`)
    }
    if (corrMult !== 1.0) {
      adjustments.push(`corr${(corrMult * 100).toFixed(0)}% #${assetCount[primaryAsset]} on ${primaryAsset}`)
    }

    const reason = isNew
      ? `New (${trades} trades) — capped at ${(limits.newStratMaxPct * 100).toFixed(0)}%`
      : `Score ${score.toFixed(2)} → ${(weight * 100).toFixed(1)}% weight` +
        (adjustments.length ? '  [' + adjustments.join(', ') + ']' : '')

    totalAllocated += allocUSDT
    allocations.push({
      strategyId:      s.id,
      name:            s.name,
      status:          s.status,
      score,
      allocUSDT,
      allocPct:        totalEquity > 0 ? allocUSDT / totalEquity : 0,
      reason,
      volatilityMult:  volMult,
      correlationMult: corrMult,
    })
  }

  return {
    totalEquity,
    deployedUSDT:  totalAllocated,
    deployedPct:   totalEquity > 0 ? totalAllocated / totalEquity : 0,
    reserveUSDT:   totalEquity - totalAllocated,
    allocations:   allocations.sort((a, b) => b.allocUSDT - a.allocUSDT),
    marketState,
    riskTier,
    volatilityMap,
  }
}

// ── Display ───────────────────────────────────────────────────────────────────

const _C  = { reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m', cyan:'\x1b[36m', green:'\x1b[32m', yellow:'\x1b[33m', red:'\x1b[31m' }
const _b  = (s: string) => `${_C.bold}${s}${_C.reset}`
const _cy = (s: string) => `${_C.cyan}${s}${_C.reset}`
const _gn = (s: string) => `${_C.green}${s}${_C.reset}`
const _yw = (s: string) => `${_C.yellow}${s}${_C.reset}`
const _rd = (s: string) => `${_C.red}${s}${_C.reset}`
const _dm = (s: string) => `${_C.dim}${s}${_C.reset}`

export function printAllocationPlan(plan: AllocationPlan): void {
  const deployedPct = (plan.deployedPct * 100).toFixed(1)
  const reservePct  = plan.totalEquity > 0
    ? ((plan.reserveUSDT / plan.totalEquity) * 100).toFixed(1)
    : '100.0'

  console.log()
  console.log(`  💰 ${_b('Capital Allocation')}  ` +
    `Total ${_cy('$' + plan.totalEquity.toFixed(0))}  ` +
    `Deployed ${_yw('$' + plan.deployedUSDT.toFixed(0) + ' (' + deployedPct + '%)')}  ` +
    `Reserve ${_gn('$' + plan.reserveUSDT.toFixed(0) + ' (' + reservePct + '%)')}`)

  // Show volatility context
  const volEntries = Object.entries(plan.volatilityMap)
  if (volEntries.length > 0) {
    const volLine = volEntries.map(([asset, atr]) => {
      const tag = asset.replace('-USDT', '')
      const col = atr < 1.2 ? _gn : atr < 2.0 ? _yw : _rd
      return `${tag} ATR ${col(atr.toFixed(2) + 'x')}`
    }).join('  │  ')
    console.log(`  ${_dm('Volatility')}  ${volLine}`)
  }

  if (plan.allocations.length === 0) {
    console.log(_dm('     No live strategies to allocate to.'))
    return
  }

  console.log(`  ${'─'.repeat(70)}`)
  console.log(_dm(`  ${'Strategy'.padEnd(28)} ${'Alloc'.padStart(10)} ${'%Eq'.padStart(6)} Score  Vol×  Corr×`))
  console.log(`  ${'─'.repeat(70)}`)

  for (const a of plan.allocations) {
    const allocStr = '$' + a.allocUSDT.toFixed(0)
    const pctStr   = (a.allocPct * 100).toFixed(1) + '%'
    const score    = a.score >= 0.7 ? _gn(a.score.toFixed(2))
                   : a.score >= 0.4 ? _yw(a.score.toFixed(2))
                   : a.score.toFixed(2)
    const volStr   = a.volatilityMult === 1.0
      ? _dm('1.00')
      : a.volatilityMult > 1 ? _gn(a.volatilityMult.toFixed(2)) : _yw(a.volatilityMult.toFixed(2))
    const corrStr  = a.correlationMult === 1.0
      ? _dm('1.00')
      : _rd(a.correlationMult.toFixed(2))

    console.log(
      `  ${a.name.slice(0, 27).padEnd(28)} ` +
      `${_cy(allocStr.padStart(10))} ` +
      `${pctStr.padStart(6)} ` +
      `${score}  ${volStr}  ${corrStr}`
    )
    console.log(`  ${''.padEnd(28)} ${_dm(a.reason)}`)
  }
  console.log(`  ${'─'.repeat(70)}`)
}
