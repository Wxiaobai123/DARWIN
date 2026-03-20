/**
 * DARWIN Strategy Archive
 * Manages the lifecycle and performance records of all strategies.
 */

import { randomUUID } from 'crypto'
import db from '../db.js'
import type { StrategySpec } from './validator.js'
import type { MarketState } from '../market/state-recognizer.js'

export type StrategyStatus = 'shadow' | 'live' | 'demoted' | 'eliminated' | 'paused'

export interface StrategyRecord {
  id:               string
  name:             string
  author:           string
  status:           StrategyStatus
  shadow_started_at: string | null
  live_started_at:  string | null
  demotion_count:   number
  created_at:       string
  spec:             StrategySpec
}

export interface PerformanceRecord {
  strategy_id:    string
  market_state:   MarketState
  trades:         number
  winning_trades: number
  total_return:   number
  max_drawdown:   number
  last_updated:   string
}

// ── Score calculation ─────────────────────────────────────────────────────────

export function scoreStrategy(stratId: string, currentState: MarketState): number {
  const rec = getStrategy(stratId)
  if (!rec) return 0

  const perfs = getPerformance(stratId)
  if (perfs.length === 0) return 0.1  // New strategy gets minimal score

  const totalTrades    = perfs.reduce((s, p) => s + p.trades, 0)
  const totalWinning   = perfs.reduce((s, p) => s + p.winning_trades, 0)
  const winRate        = totalTrades > 0 ? totalWinning / totalTrades : 0

  const returns        = perfs.map(p => p.total_return)
  const avgReturn      = returns.reduce((a, b) => a + b, 0) / returns.length
  const std            = Math.sqrt(returns.map(r => (r - avgReturn) ** 2)
                           .reduce((a, b) => a + b, 0) / returns.length) || 0.001
  const sharpe         = avgReturn / std  // simplified Sharpe

  const stateMatch     = rec.spec.conditions.market_states.includes(currentState) ? 1.0 : 0.3

  // Stability: days the strategy has been running with trades
  const daysSinceStart = rec.shadow_started_at
    ? (Date.now() - new Date(rec.shadow_started_at).getTime()) / 86400000
    : 1
  const stability = Math.min(1, totalTrades / (daysSinceStart * 2 + 1))

  const rawScore = winRate * 0.4 + Math.min(1, Math.max(0, sharpe)) * 0.3
                 + stateMatch * 0.2 + stability * 0.1

  // New strategy penalty (< 30 days live)
  if (rec.status === 'live' && rec.live_started_at) {
    const liveDays = (Date.now() - new Date(rec.live_started_at).getTime()) / 86400000
    if (liveDays < 30) return rawScore * 0.5
  }

  return rawScore
}

// ── Promotion check ───────────────────────────────────────────────────────────

export interface PromotionCheck {
  eligible: boolean
  reasons:  string[]
}

export function checkPromotion(stratId: string): PromotionCheck {
  const rec = getStrategy(stratId)
  if (!rec) return { eligible: false, reasons: ['Strategy not found'] }
  if (rec.status !== 'shadow') return { eligible: false, reasons: ['Not in shadow status'] }

  const spec    = rec.spec
  const perfs   = getPerformance(stratId)
  const reasons: string[] = []

  // Days in shadow
  const shadowDays = rec.shadow_started_at
    ? (Date.now() - new Date(rec.shadow_started_at).getTime()) / 86400000
    : 0
  if (shadowDays < spec.promotion.min_shadow_days)
    reasons.push(`Need ${spec.promotion.min_shadow_days} shadow days, have ${shadowDays.toFixed(1)}`)

  // Total trades
  const totalTrades = perfs.reduce((s, p) => s + p.trades, 0)
  if (totalTrades < spec.promotion.min_trades)
    reasons.push(`Need ${spec.promotion.min_trades} trades, have ${totalTrades}`)

  // Win rate
  const totalWinning = perfs.reduce((s, p) => s + p.winning_trades, 0)
  const winRate = totalTrades > 0 ? totalWinning / totalTrades : 0
  if (winRate < spec.promotion.min_win_rate)
    reasons.push(`Win rate ${(winRate * 100).toFixed(1)}% < required ${(spec.promotion.min_win_rate * 100).toFixed(1)}%`)

  // Max drawdown
  const maxDD = perfs.reduce((m, p) => Math.max(m, p.max_drawdown), 0)
  if (maxDD > spec.promotion.max_realized_drawdown)
    reasons.push(`Max drawdown ${(maxDD * 100).toFixed(1)}% > limit ${(spec.promotion.max_realized_drawdown * 100).toFixed(1)}%`)

  // Market state coverage
  for (const state of spec.conditions.market_states) {
    const statPerf = perfs.find(p => p.market_state === state)
    if (!statPerf || statPerf.trades < spec.promotion.min_days_per_state) {
      reasons.push(`Insufficient ${state} market data (need ${spec.promotion.min_days_per_state} days)`)
    }
  }

  return { eligible: reasons.length === 0, reasons }
}

// ── Demotion check ────────────────────────────────────────────────────────────

export function checkDemotion(stratId: string): { shouldDemote: boolean; reason: string } {
  const rec = getStrategy(stratId)
  if (!rec || rec.status !== 'live')
    return { shouldDemote: false, reason: 'Not live' }

  const perfs       = getPerformance(stratId)
  const maxDD       = perfs.reduce((m, p) => Math.max(m, p.max_drawdown), 0)
  const ddTrigger   = rec.spec.demotion.live_drawdown_trigger_pct / 100
  const lossDaysTrigger = rec.spec.demotion.consecutive_loss_days

  if (maxDD > ddTrigger)
    return { shouldDemote: true, reason: `Drawdown ${(maxDD * 100).toFixed(1)}% > trigger ${(ddTrigger * 100).toFixed(1)}%` }

  // Check consecutive loss days using daily performance data
  const dailyPerfs = getDailyPerformance(stratId, lossDaysTrigger)
  if (dailyPerfs.length >= lossDaysTrigger && dailyPerfs.every(p => p.total_return < 0))
    return { shouldDemote: true, reason: `连续${lossDaysTrigger}天亏损` }

  // Check pause_after_loss_days (auto-pause without full demotion)
  const pauseDays = rec.spec.risk.pause_after_loss_days
  if (pauseDays != null && pauseDays > 0) {
    const pausePerfs = getDailyPerformance(stratId, pauseDays)
    if (pausePerfs.length >= pauseDays && pausePerfs.every(p => p.total_return < 0))
      return { shouldDemote: true, reason: `${pauseDays} loss periods → auto-pause (risk.pause_after_loss_days)` }
  }

  return { shouldDemote: false, reason: '' }
}

// ── CRUD operations ───────────────────────────────────────────────────────────

export function registerStrategy(spec: StrategySpec): string {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO strategies (id, name, author, spec, status, shadow_started_at)
    VALUES (?, ?, ?, ?, 'shadow', datetime('now'))
  `).run(id, spec.metadata.name, spec.metadata.author, JSON.stringify(spec))
  return id
}

export function getStrategy(id: string): StrategyRecord | null {
  const row = db.prepare('SELECT * FROM strategies WHERE id = ?').get(id) as
    Record<string, unknown> | undefined
  if (!row) return null
  return { ...row, spec: JSON.parse(row.spec as string) } as StrategyRecord
}

export function getAllStrategies(status?: StrategyStatus): StrategyRecord[] {
  const rows = status
    ? db.prepare('SELECT * FROM strategies WHERE status = ? ORDER BY created_at DESC').all(status)
    : db.prepare('SELECT * FROM strategies ORDER BY created_at DESC').all()
  return (rows as Array<Record<string, unknown>>).map(r => ({
    ...r, spec: JSON.parse(r.spec as string)
  })) as StrategyRecord[]
}

export function setStrategyStatus(id: string, status: StrategyStatus): void {
  const now = new Date().toISOString()
  const extra = status === 'live'
    ? ', live_started_at = ?'
    : status === 'demoted'
      ? ', demotion_count = demotion_count + 1'
      : ''
  const params: string[] = status === 'live' ? [status, now, id] : [status, id]
  db.prepare(`UPDATE strategies SET status = ?${extra} WHERE id = ?`).run(...params)
}

export function getPerformance(stratId: string): PerformanceRecord[] {
  return db.prepare(
    'SELECT * FROM strategy_performance WHERE strategy_id = ? ORDER BY last_updated DESC'
  ).all(stratId) as unknown as PerformanceRecord[]
}

export function upsertPerformance(p: Omit<PerformanceRecord, 'last_updated'>): void {
  const existing = db.prepare(
    'SELECT id FROM strategy_performance WHERE strategy_id = ? AND market_state = ?'
  ).get(p.strategy_id, p.market_state)

  if (existing) {
    db.prepare(`
      UPDATE strategy_performance
      SET trades = ?, winning_trades = ?, total_return = ?, max_drawdown = ?,
          last_updated = datetime('now')
      WHERE strategy_id = ? AND market_state = ?
    `).run(p.trades, p.winning_trades, p.total_return, p.max_drawdown,
           p.strategy_id, p.market_state)
  } else {
    db.prepare(`
      INSERT INTO strategy_performance
        (strategy_id, market_state, trades, winning_trades, total_return, max_drawdown)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(p.strategy_id, p.market_state, p.trades, p.winning_trades,
           p.total_return, p.max_drawdown)
  }

  // Also write daily record for time-series analysis
  const today = new Date().toISOString().slice(0, 10)
  try {
    db.prepare(`
      INSERT INTO strategy_performance_daily
        (strategy_id, recorded_date, trades, winning_trades, total_return, max_drawdown, market_state)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(strategy_id, recorded_date) DO UPDATE SET
        trades = ?, winning_trades = ?, total_return = ?, max_drawdown = ?,
        market_state = ?, last_updated = datetime('now')
    `).run(
      p.strategy_id, today, p.trades, p.winning_trades, p.total_return, p.max_drawdown, p.market_state,
      p.trades, p.winning_trades, p.total_return, p.max_drawdown, p.market_state,
    )
  } catch {}
}

export interface DailyPerformanceRecord {
  strategy_id:    string
  recorded_date:  string
  trades:         number
  winning_trades: number
  total_return:   number
  max_drawdown:   number
  market_state:   string | null
}

export function getDailyPerformance(stratId: string, limit = 30): DailyPerformanceRecord[] {
  return db.prepare(
    'SELECT * FROM strategy_performance_daily WHERE strategy_id = ? ORDER BY recorded_date DESC LIMIT ?'
  ).all(stratId, limit) as unknown as DailyPerformanceRecord[]
}

// ── Leaderboard ───────────────────────────────────────────────────────────────

export function getLeaderboard(currentState: MarketState): Array<{
  rank:     number
  id:       string
  name:     string
  author:   string
  status:   StrategyStatus
  score:    number
  win_rate: number
  trades:   number
}> {
  const strategies = getAllStrategies()
  const scored = strategies
    .filter(s => s.status !== 'eliminated')
    .map(s => {
      const perfs   = getPerformance(s.id)
      const total   = perfs.reduce((x, p) => x + p.trades, 0)
      const winning = perfs.reduce((x, p) => x + p.winning_trades, 0)
      return {
        id:       s.id,
        name:     s.name,
        author:   s.author,
        status:   s.status,
        score:    scoreStrategy(s.id, currentState),
        win_rate: total > 0 ? winning / total : 0,
        trades:   total,
      }
    })
    .sort((a, b) => b.score - a.score)

  return scored.map((s, i) => ({ rank: i + 1, ...s }))
}
