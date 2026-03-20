/**
 * DARWIN TWAP & Iceberg Execution (大单拆分)
 *
 * Splits large orders into smaller slices to minimize market impact.
 *
 * TWAP — Time-Weighted Average Price:
 *   Divides an order into N equal slices, placed at regular time intervals.
 *   Goal: achieve a fill price close to the time-weighted average.
 *
 * Iceberg — Hidden Volume:
 *   Places only a visible slice; when filled, places the next.
 *   Goal: hide true order size from the order book.
 *
 * Both are composed from spot or swap market/limit orders.
 * Not native OKX bots — managed by DARWIN's heartbeat.
 *
 * Used by strategies with tool = "okx_twap" or "okx_iceberg"
 */

import db from '../db.js'
import { spotClient } from '../atk/spot.js'
import { swapClient } from '../atk/swap.js'
import { atk } from '../atk/client.js'
import { fromSwapId } from '../config.js'
import { toSwapId } from '../config.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TWAPConfig {
  instId:         string         // e.g. "BTC-USDT" or "BTC-USDT-SWAP"
  side:           'buy' | 'sell'
  totalAmountUsdt: number        // total USDT to fill
  slices:         number         // number of sub-orders (e.g. 10)
  intervalMinutes: number        // minutes between slices (e.g. 5)
  useSwap?:       boolean        // true = swap orders, false = spot (default)
  lever?:         number         // leverage for swap mode
  maxSlippage?:   number         // max price deviation % from TWAP (e.g. 0.5)
}

export interface IcebergConfig {
  instId:         string
  side:           'buy' | 'sell'
  totalAmountUsdt: number
  visibleAmountUsdt: number      // visible slice size
  priceOffset?:   number         // % offset from mid-price for limit orders (e.g. 0.1)
  useSwap?:       boolean
  lever?:         number
}

interface TWAPState {
  strategyId:     string
  instId:         string
  side:           string
  totalAmount:    number
  filledAmount:   number
  slicesDone:     number
  totalSlices:    number
  avgFillPrice:   number
  lastSliceAt:    string | null
  startedAt:      string
  mode:           'twap' | 'iceberg'
}

// ── Ensure DB table ──────────────────────────────────────────────────────────

function ensureTable(): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS twap_orders (
      strategy_id   TEXT PRIMARY KEY,
      inst_id       TEXT NOT NULL,
      side          TEXT NOT NULL,
      mode          TEXT NOT NULL DEFAULT 'twap',
      total_amount  REAL NOT NULL,
      filled_amount REAL DEFAULT 0,
      filled_qty    REAL DEFAULT 0,
      slices_done   INTEGER DEFAULT 0,
      total_slices  INTEGER NOT NULL,
      last_slice_at TEXT,
      started_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run()
}

// ── TWAP ─────────────────────────────────────────────────────────────────────

/**
 * Initialize a TWAP order.
 * Returns a bot ID prefixed with "twap_".
 */
export function initTWAP(strategyId: string, cfg: TWAPConfig): string {
  ensureTable()

  db.prepare(`
    INSERT OR REPLACE INTO twap_orders
    (strategy_id, inst_id, side, mode, total_amount, filled_amount, filled_qty, slices_done, total_slices, last_slice_at)
    VALUES (?, ?, ?, 'twap', ?, 0, 0, 0, ?, NULL)
  `).run(strategyId, cfg.instId, cfg.side, cfg.totalAmountUsdt, cfg.slices)

  console.log(`  [TWAP] Initialized: ${cfg.side} $${cfg.totalAmountUsdt} of ${cfg.instId} in ${cfg.slices} slices every ${cfg.intervalMinutes}min`)
  return `twap_${strategyId}`
}

/**
 * Execute one TWAP tick.
 * Called every risk heartbeat (5 min). Checks if next slice is due.
 * Returns true if a slice was executed.
 */
export function tickTWAP(strategyId: string, cfg: TWAPConfig): boolean {
  ensureTable()

  const row = db.prepare(
    'SELECT * FROM twap_orders WHERE strategy_id = ?'
  ).get(strategyId) as {
    filled_amount: number; filled_qty: number; slices_done: number
    total_slices: number; last_slice_at: string | null
  } | undefined

  if (!row) return false

  // All slices done
  if (row.slices_done >= row.total_slices) return false

  // Check interval
  if (row.last_slice_at) {
    const lastSlice = new Date(row.last_slice_at).getTime()
    const elapsedMin = (Date.now() - lastSlice) / 60_000
    if (elapsedMin < cfg.intervalMinutes) return false
  }

  // Calculate slice size
  const remaining = cfg.totalAmountUsdt - row.filled_amount
  const slicesLeft = cfg.slices - row.slices_done
  const sliceUsdt = Math.min(remaining, cfg.totalAmountUsdt / cfg.slices)

  if (sliceUsdt <= 0) return false

  // Optional slippage check
  if (cfg.maxSlippage != null && row.filled_qty > 0) {
    try {
      const spotId = cfg.instId.endsWith('-SWAP') ? fromSwapId(cfg.instId) : cfg.instId
      const ticker = atk.ticker(spotId)
      const avgPrice = row.filled_amount / row.filled_qty
      const deviation = Math.abs((ticker.last - avgPrice) / avgPrice) * 100
      if (deviation > cfg.maxSlippage) {
        console.log(`  [TWAP] Slice skipped: price deviation ${deviation.toFixed(2)}% > max ${cfg.maxSlippage}%`)
        return false
      }
    } catch {}
  }

  // Execute slice
  try {
    const spotInstId = cfg.instId.endsWith('-SWAP') ? fromSwapId(cfg.instId) : cfg.instId
    const ticker = atk.ticker(spotInstId)
    const sz = String(Math.floor(sliceUsdt / ticker.last * 10000) / 10000)

    if (cfg.useSwap) {
      const swapId = cfg.instId.includes('-SWAP') ? cfg.instId : toSwapId(cfg.instId)
      if (cfg.lever) swapClient.setLeverage(swapId, cfg.lever)
      swapClient.place({
        instId:  swapId,
        side:    cfg.side,
        ordType: 'market',
        sz,
        tdMode:  'cross',
      })
    } else {
      spotClient.place({
        instId:  spotInstId,
        side:    cfg.side,
        ordType: 'market',
        sz,
      })
    }

    // Update state
    const newFilled = row.filled_amount + sliceUsdt
    const newQty = row.filled_qty + parseFloat(sz)
    db.prepare(`
      UPDATE twap_orders
      SET slices_done = slices_done + 1,
          filled_amount = ?,
          filled_qty = ?,
          last_slice_at = datetime('now')
      WHERE strategy_id = ?
    `).run(newFilled, newQty, strategyId)

    const pctDone = ((row.slices_done + 1) / row.total_slices * 100).toFixed(0)
    console.log(`  [TWAP] Slice ${row.slices_done + 1}/${row.total_slices} (${pctDone}%): ${cfg.side} ${sz} ${cfg.instId} @ $${ticker.last.toFixed(2)}`)
    return true
  } catch (err) {
    console.warn(`  [TWAP] Slice failed: ${err}`)
    return false
  }
}

// ── Iceberg ──────────────────────────────────────────────────────────────────

/**
 * Initialize an iceberg order.
 * Returns a bot ID prefixed with "twap_" (shares the same tracking table).
 */
export function initIceberg(strategyId: string, cfg: IcebergConfig): string {
  ensureTable()

  const totalSlices = Math.ceil(cfg.totalAmountUsdt / cfg.visibleAmountUsdt)

  db.prepare(`
    INSERT OR REPLACE INTO twap_orders
    (strategy_id, inst_id, side, mode, total_amount, filled_amount, filled_qty, slices_done, total_slices, last_slice_at)
    VALUES (?, ?, ?, 'iceberg', ?, 0, 0, 0, ?, NULL)
  `).run(strategyId, cfg.instId, cfg.side, cfg.totalAmountUsdt, totalSlices)

  console.log(`  [Iceberg] Initialized: ${cfg.side} $${cfg.totalAmountUsdt} of ${cfg.instId} in $${cfg.visibleAmountUsdt} slices (${totalSlices} total)`)
  return `twap_${strategyId}`
}

/**
 * Execute one iceberg tick.
 * Unlike TWAP, iceberg executes as fast as possible (no time interval).
 * Each tick places one visible slice.
 */
export function tickIceberg(strategyId: string, cfg: IcebergConfig): boolean {
  ensureTable()

  const row = db.prepare(
    'SELECT * FROM twap_orders WHERE strategy_id = ?'
  ).get(strategyId) as {
    filled_amount: number; filled_qty: number; slices_done: number; total_slices: number
  } | undefined

  if (!row) return false
  if (row.slices_done >= row.total_slices) return false

  const remaining = cfg.totalAmountUsdt - row.filled_amount
  const sliceUsdt = Math.min(remaining, cfg.visibleAmountUsdt)
  if (sliceUsdt <= 0) return false

  try {
    const spotInstId = cfg.instId.endsWith('-SWAP') ? fromSwapId(cfg.instId) : cfg.instId
    const ticker = atk.ticker(spotInstId)
    const sz = String(Math.floor(sliceUsdt / ticker.last * 10000) / 10000)

    if (cfg.useSwap) {
      const swapId = cfg.instId.includes('-SWAP') ? cfg.instId : toSwapId(cfg.instId)
      if (cfg.lever) swapClient.setLeverage(swapId, cfg.lever)

      // Iceberg uses limit order slightly off-market for subtlety
      const offset = (cfg.priceOffset ?? 0.1) / 100
      const limitPx = cfg.side === 'buy'
        ? String(Math.round(ticker.last * (1 - offset)))
        : String(Math.round(ticker.last * (1 + offset)))

      swapClient.place({
        instId:  swapId,
        side:    cfg.side,
        ordType: 'limit',
        sz,
        px:      limitPx,
        tdMode:  'cross',
      })
    } else {
      // Spot iceberg — use limit order slightly off market
      const offset = (cfg.priceOffset ?? 0.1) / 100
      const limitPx = cfg.side === 'buy'
        ? String(Math.round(ticker.last * (1 - offset)))
        : String(Math.round(ticker.last * (1 + offset)))

      spotClient.place({
        instId:  spotInstId,
        side:    cfg.side,
        ordType: 'limit',
        sz,
        px:      limitPx,
      })
    }

    const newFilled = row.filled_amount + sliceUsdt
    const newQty = row.filled_qty + parseFloat(sz)
    db.prepare(`
      UPDATE twap_orders
      SET slices_done = slices_done + 1,
          filled_amount = ?,
          filled_qty = ?,
          last_slice_at = datetime('now')
      WHERE strategy_id = ?
    `).run(newFilled, newQty, strategyId)

    const pctDone = ((row.slices_done + 1) / row.total_slices * 100).toFixed(0)
    console.log(`  [Iceberg] Slice ${row.slices_done + 1}/${row.total_slices} (${pctDone}%): ${cfg.side} ${sz} ${cfg.instId}`)
    return true
  } catch (err) {
    console.warn(`  [Iceberg] Slice failed: ${err}`)
    return false
  }
}

// ── Query state ──────────────────────────────────────────────────────────────

export function getTWAPState(strategyId: string): TWAPState | null {
  ensureTable()

  const row = db.prepare(
    'SELECT * FROM twap_orders WHERE strategy_id = ?'
  ).get(strategyId) as {
    strategy_id: string; inst_id: string; side: string; mode: string
    total_amount: number; filled_amount: number; filled_qty: number
    slices_done: number; total_slices: number; last_slice_at: string | null
    started_at: string
  } | undefined

  if (!row) return null

  return {
    strategyId:   row.strategy_id,
    instId:       row.inst_id,
    side:         row.side,
    totalAmount:  row.total_amount,
    filledAmount: row.filled_amount,
    slicesDone:   row.slices_done,
    totalSlices:  row.total_slices,
    avgFillPrice: row.filled_qty > 0 ? row.filled_amount / row.filled_qty : 0,
    lastSliceAt:  row.last_slice_at,
    startedAt:    row.started_at,
    mode:         row.mode as 'twap' | 'iceberg',
  }
}

/**
 * Check if a TWAP/iceberg order is fully filled.
 */
export function isTWAPComplete(strategyId: string): boolean {
  const state = getTWAPState(strategyId)
  if (!state) return true
  return state.slicesDone >= state.totalSlices
}
