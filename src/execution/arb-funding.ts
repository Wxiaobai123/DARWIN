/**
 * DARWIN Funding Rate Arbitrage (资金费率套利)
 *
 * Delta-neutral strategy: spot long + perpetual short
 * Collects funding rate payments while staying market-neutral.
 *
 * How it works:
 *   1. When funding rate is high (longs pay shorts):
 *      - Buy spot (go long on underlying)
 *      - Short perpetual swap (collect funding)
 *   2. The two positions cancel each other's directional exposure
 *   3. Profit = funding payments - trading fees
 *
 * Entry: Annualized funding rate > threshold (e.g. 15%)
 * Exit:  Funding rate normalizes below minimum (e.g. 5%) or max hold reached
 *
 * Uses: spotClient (buy spot) + swapClient (short perp)
 */

import db from '../db.js'
import { spotClient } from '../atk/spot.js'
import { swapClient } from '../atk/swap.js'
import { atk } from '../atk/client.js'
import { ensureSwapLeverage } from './ensure-swap-leverage.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FundingArbConfig {
  spotInstId:   string           // e.g. "BTC-USDT"
  swapInstId:   string           // e.g. "BTC-USDT-SWAP"
  amountUsdt:   number           // notional per leg
  lever:        number           // leverage for swap side (1-3x recommended)
  minAnnualPct: number           // minimum annualized funding to enter (e.g. 15)
  exitAnnualPct: number          // exit when funding drops below (e.g. 5)
}

export interface FundingArbState {
  strategyId:      string
  spotOrdId:       string | null
  swapOrdId:       string | null
  entryFunding:    number
  currentFunding:  number
  accumulatedPnl:  number
  openedAt:        string | null
}

// ── Ensure DB table ──────────────────────────────────────────────────────────

function ensureTable(): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS funding_arb (
      strategy_id     TEXT PRIMARY KEY,
      spot_ord_id     TEXT,
      swap_ord_id     TEXT,
      entry_funding   REAL DEFAULT 0,
      accumulated_pnl REAL DEFAULT 0,
      opened_at       TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run()
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Check if funding rate is attractive enough to open arb position.
 * Returns annualized funding rate percentage.
 */
export function checkFundingOpportunity(swapInstId: string): {
  annualizedPct: number; fundingRate: number; attractive: boolean
} {
  try {
    const fr = atk.fundingRate(swapInstId)
    // OKX funding settles every 8 hours = 3x/day = 1095x/year
    const annualized = Math.abs(fr.fundingRate) * 1095 * 100
    return {
      annualizedPct: annualized,
      fundingRate:   fr.fundingRate,
      attractive:    annualized > 15, // default threshold
    }
  } catch {
    return { annualizedPct: 0, fundingRate: 0, attractive: false }
  }
}

/**
 * Open a funding rate arbitrage position (spot long + swap short).
 * Returns a composite bot ID.
 */
export function openFundingArb(strategyId: string, cfg: FundingArbConfig): string {
  ensureTable()

  const ticker = atk.ticker(cfg.spotInstId)

  // 1. Set leverage on swap side with settlement-aware retries.
  const leverageSet = ensureSwapLeverage(cfg.swapInstId, cfg.lever, {
    mgnMode: 'cross',
    posSide: 'short',
    logPrefix: '  [FundingArb]',
  })
  if (!leverageSet) {
    console.warn(`  [FundingArb] Proceeding without confirmed leverage change on ${cfg.swapInstId}`)
  }

  // 2. Buy spot (long leg) — market buy uses USDT amount for sz
  const spotSz = String(cfg.amountUsdt)
  const spotOrdId = spotClient.place({
    instId:  cfg.spotInstId,
    side:    'buy',
    ordType: 'market',
    sz:      spotSz,
  })

  // 3. Short perpetual (short leg — collect funding)
  //    sz is in contracts; need ctVal for conversion
  const inst = atk.instrument(cfg.swapInstId, 'SWAP')
  const contracts = cfg.amountUsdt / (ticker.last * inst.ctVal)
  // Round to lotSz, then fix floating point (e.g. 2754*0.01 = 27.540000000000003)
  const lotDecimals = inst.lotSz < 1 ? (String(inst.lotSz).split('.')[1]?.length ?? 0) : 0
  const swapSz = String(Number((Math.max(inst.minSz, Math.floor(contracts / inst.lotSz) * inst.lotSz)).toFixed(lotDecimals)))
  const swapOrdId = swapClient.place({
    instId:  cfg.swapInstId,
    side:    'sell',
    ordType: 'market',
    sz:      swapSz,
    tdMode:  'cross',
    posSide: 'short',
  })

  // 4. Get current funding rate for tracking
  const fr = atk.fundingRate(cfg.swapInstId)

  // 5. Persist state
  db.prepare(`
    INSERT OR REPLACE INTO funding_arb
    (strategy_id, spot_ord_id, swap_ord_id, entry_funding, accumulated_pnl, opened_at)
    VALUES (?, ?, ?, ?, 0, datetime('now'))
  `).run(strategyId, spotOrdId, swapOrdId, fr.fundingRate)

  const annualized = Math.abs(fr.fundingRate) * 1095 * 100
  console.log(`  [FundingArb] Opened: ${cfg.spotInstId} spot long + ${cfg.swapInstId} swap short`)
  console.log(`    Spot: $${cfg.amountUsdt}  Swap: ${swapSz} contracts  Funding: ${(fr.fundingRate * 100).toFixed(4)}% (${annualized.toFixed(1)}% ann.)`)

  const botId = `arb_${strategyId}`
  return botId
}

/**
 * Close the funding arb position (sell spot + close swap short).
 */
export function closeFundingArb(strategyId: string, cfg: FundingArbConfig): void {
  ensureTable()

  const row = db.prepare(
    'SELECT spot_ord_id FROM funding_arb WHERE strategy_id = ?'
  ).get(strategyId) as { spot_ord_id: string | null } | undefined

  try {
    // Close swap short position (posSide required in long_short_mode)
    swapClient.close(cfg.swapInstId, 'cross', 'short')
  } catch (err) {
    console.warn(`  [FundingArb] Swap close failed: ${err}`)
  }

  try {
    // Sell only the spot quantity opened by this strategy.
    const fills = row?.spot_ord_id
      ? spotClient.fills(cfg.spotInstId, row.spot_ord_id).filter(f => f.side === 'buy')
      : []
    const totalSz = fills.reduce((sum, f) => sum + parseFloat(f.fillSz), 0)
    if (totalSz > 0) {
      // Market sell uses base currency (BTC) for sz
      spotClient.place({
        instId:  cfg.spotInstId,
        side:    'sell',
        ordType: 'market',
        sz:      String(Math.floor(totalSz * 100000000) / 100000000),
      })
    }
  } catch (err) {
    console.warn(`  [FundingArb] Spot sell failed: ${err}`)
  }

  try {
    db.prepare('DELETE FROM funding_arb WHERE strategy_id = ?').run(strategyId)
  } catch {}

  console.log(`  [FundingArb] Closed position for strategy ${strategyId}`)
}

/**
 * Check if arb should be closed (funding rate dropped below threshold).
 */
export function shouldCloseArb(strategyId: string, cfg: FundingArbConfig): {
  shouldClose: boolean; reason: string; currentAnnualized: number
} {
  const { annualizedPct, fundingRate } = checkFundingOpportunity(cfg.swapInstId)

  // Close if funding dropped below exit threshold
  if (annualizedPct < cfg.exitAnnualPct) {
    return {
      shouldClose: true,
      reason: `资金费率 ${annualizedPct.toFixed(1)}% 年化 < 退出阈值 ${cfg.exitAnnualPct}%`,
      currentAnnualized: annualizedPct,
    }
  }

  // Close if funding flipped (now negative = shorts pay longs)
  if (fundingRate < 0) {
    return {
      shouldClose: true,
      reason: `资金费率转负: ${(fundingRate * 100).toFixed(4)}%`,
      currentAnnualized: annualizedPct,
    }
  }

  return { shouldClose: false, reason: '', currentAnnualized: annualizedPct }
}

/**
 * Get current arb state.
 */
export function getFundingArbState(strategyId: string): FundingArbState | null {
  ensureTable()

  const row = db.prepare(
    'SELECT * FROM funding_arb WHERE strategy_id = ?'
  ).get(strategyId) as {
    strategy_id: string; spot_ord_id: string; swap_ord_id: string
    entry_funding: number; accumulated_pnl: number; opened_at: string
  } | undefined

  if (!row) return null

  return {
    strategyId:     row.strategy_id,
    spotOrdId:      row.spot_ord_id,
    swapOrdId:      row.swap_ord_id,
    entryFunding:   row.entry_funding,
    currentFunding: 0, // fetch live
    accumulatedPnl: row.accumulated_pnl,
    openedAt:       row.opened_at,
  }
}
