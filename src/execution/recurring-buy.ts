/**
 * DARWIN Recurring Buy (定投策略)
 *
 * Automated dollar-cost averaging strategy.
 * Not a native OKX bot — composed from spot market buys on a schedule.
 *
 * Features:
 *   - Fixed USDT amount per buy
 *   - Configurable interval (hours)
 *   - Smart entry: can skip buys when RSI is overbought
 *   - Tracks accumulated position for performance reporting
 *
 * Used by strategies with tool = "okx_recurring_buy"
 */

import db from '../db.js'
import { spotClient } from '../atk/spot.js'
import { atk } from '../atk/client.js'
import { rsi } from '../market/indicators.js'

/**
 * Round down to instrument lot size precision.
 * E.g. lotSz=0.001 → 3 decimals, lotSz=0.00001 → 5 decimals.
 */
function roundToLot(qty: number, lotSz: number): number {
  if (lotSz <= 0) return qty
  const decimals = Math.max(0, -Math.floor(Math.log10(lotSz)))
  const factor = Math.pow(10, decimals)
  return Math.floor(qty * factor) / factor
}

// ── Failure throttle: skip buys for 1 hour after 3 consecutive failures ──────
const failureCount = new Map<string, { count: number; lastFailAt: number }>()
const MAX_CONSECUTIVE_FAILS = 3
const FAIL_COOLDOWN_MS = 3_600_000 // 1 hour

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RecurringBuyConfig {
  instId:        string
  amountUsdt:    number          // USDT per buy
  intervalHours: number          // hours between buys
  skipRsiAbove?: number          // skip buy if RSI > this (e.g. 70)
  maxBuys?:      number          // max total buys (0 = unlimited)
}

export interface RecurringBuyState {
  strategyId:   string
  instId:       string
  totalBuys:    number
  totalSpent:   number
  totalQty:     number
  avgPrice:     number
  lastBuyAt:    string | null
  nextBuyAt:    string | null
}

// ── Ensure DB table ──────────────────────────────────────────────────────────

function ensureTable(): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS recurring_buys (
      strategy_id  TEXT PRIMARY KEY,
      inst_id      TEXT NOT NULL,
      total_buys   INTEGER DEFAULT 0,
      total_spent  REAL DEFAULT 0,
      total_qty    REAL DEFAULT 0,
      last_buy_at  TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run()
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initialize a recurring buy for a strategy.
 * Returns a sentinel ID (no real OKX bot is created).
 */
export function initRecurringBuy(strategyId: string, cfg: RecurringBuyConfig): string {
  ensureTable()

  db.prepare(`
    INSERT OR REPLACE INTO recurring_buys (strategy_id, inst_id, total_buys, total_spent, total_qty, last_buy_at)
    VALUES (?, ?, 0, 0, 0, NULL)
  `).run(strategyId, cfg.instId)

  return `recur_${strategyId}`
}

/**
 * Execute a recurring buy tick.
 * Called from the risk heartbeat. Checks if it's time to buy.
 * Returns true if a buy was executed.
 */
export function tickRecurringBuy(strategyId: string, cfg: RecurringBuyConfig): boolean {
  ensureTable()

  const row = db.prepare(
    'SELECT * FROM recurring_buys WHERE strategy_id = ?'
  ).get(strategyId) as {
    total_buys: number; total_spent: number; total_qty: number; last_buy_at: string | null
  } | undefined

  if (!row) return false

  // Check failure throttle — skip if too many recent consecutive failures
  const fstate = failureCount.get(strategyId)
  if (fstate && fstate.count >= MAX_CONSECUTIVE_FAILS) {
    if (Date.now() - fstate.lastFailAt < FAIL_COOLDOWN_MS) return false
    // Cooldown expired — reset and retry
    failureCount.delete(strategyId)
  }

  // Check if max buys reached
  if (cfg.maxBuys != null && cfg.maxBuys > 0 && row.total_buys >= cfg.maxBuys) return false

  // Check interval
  if (row.last_buy_at) {
    const lastBuy = new Date(row.last_buy_at).getTime()
    const elapsed = (Date.now() - lastBuy) / (3_600_000)
    if (elapsed < cfg.intervalHours) return false
  }

  // Smart entry: skip if RSI is overbought
  if (cfg.skipRsiAbove != null) {
    try {
      const candles = atk.candles(cfg.instId, '1H', 30)
      const currentRsi = rsi(candles)
      if (currentRsi > cfg.skipRsiAbove) {
        console.log(`  [RecurBuy] Skipping "${cfg.instId}": RSI=${currentRsi.toFixed(1)} > ${cfg.skipRsiAbove}`)
        return false
      }
    } catch {
      // API unavailable — proceed with buy
    }
  }

  // Execute spot buy — compute size using instrument lot precision
  try {
    const ticker = atk.ticker(cfg.instId)

    // Get instrument info for proper lot size rounding
    let lotSz = 0.0001 // safe default
    let minSz = 0.0001
    try {
      const info = atk.instrument(cfg.instId, 'SPOT')
      lotSz = info.lotSz
      minSz = info.minSz
    } catch {}

    let qty = roundToLot(cfg.amountUsdt / ticker.last, lotSz)
    // Ensure meets minimum size
    if (qty < minSz) qty = minSz
    const sz = String(qty)

    spotClient.place({
      instId:  cfg.instId,
      side:    'buy',
      ordType: 'market',
      sz,
      tdMode:  'cash',
    })

    // Update state
    const newSpent = row.total_spent + cfg.amountUsdt
    const newQty   = row.total_qty + qty
    db.prepare(`
      UPDATE recurring_buys
      SET total_buys = total_buys + 1,
          total_spent = ?,
          total_qty = ?,
          last_buy_at = datetime('now')
      WHERE strategy_id = ?
    `).run(newSpent, newQty, strategyId)

    const avgPx = newQty > 0 ? newSpent / newQty : ticker.last
    console.log(`  [RecurBuy] Bought ${sz} ${cfg.instId} @ $${ticker.last.toFixed(2)}  Total: ${row.total_buys + 1} buys, avg $${avgPx.toFixed(2)}`)
    failureCount.delete(strategyId) // reset on success
    return true
  } catch (err) {
    // Track consecutive failures — throttle after MAX_CONSECUTIVE_FAILS
    const prev = failureCount.get(strategyId) ?? { count: 0, lastFailAt: 0 }
    prev.count++
    prev.lastFailAt = Date.now()
    failureCount.set(strategyId, prev)
    if (prev.count <= MAX_CONSECUTIVE_FAILS) {
      console.warn(`  [RecurBuy] Buy failed for ${cfg.instId} (${prev.count}/${MAX_CONSECUTIVE_FAILS}): ${err}`)
    }
    if (prev.count === MAX_CONSECUTIVE_FAILS) {
      console.warn(`  [RecurBuy] ${cfg.instId}: ${MAX_CONSECUTIVE_FAILS} consecutive failures — cooling down for 1h`)
    }
    return false
  }
}

/**
 * Get current recurring buy state for a strategy.
 */
export function getRecurringBuyState(strategyId: string): RecurringBuyState | null {
  ensureTable()

  const row = db.prepare(
    'SELECT * FROM recurring_buys WHERE strategy_id = ?'
  ).get(strategyId) as {
    strategy_id: string; inst_id: string; total_buys: number
    total_spent: number; total_qty: number; last_buy_at: string | null
  } | undefined

  if (!row) return null

  return {
    strategyId: row.strategy_id,
    instId:     row.inst_id,
    totalBuys:  row.total_buys,
    totalSpent: row.total_spent,
    totalQty:   row.total_qty,
    avgPrice:   row.total_qty > 0 ? row.total_spent / row.total_qty : 0,
    lastBuyAt:  row.last_buy_at,
    nextBuyAt:  null, // computed externally
  }
}

/**
 * Stop and clean up a recurring buy.
 */
export function stopRecurringBuy(strategyId: string): void {
  ensureTable()
  // Keep the record for history, just stop ticking
}
