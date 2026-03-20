/**
 * DARWIN Backtest Engine  (v2 — realistic grid simulation)
 *
 * Replays historical OKX daily candles through DARWIN's market state
 * recognizer and simulates actual grid bot fills.
 *
 * v2 improvements over v1 formula-based approach:
 *
 *   1. Grid fill simulation — computes actual grid levels, counts crossings
 *      based on candle high/low, and calculates round-trip profit per fill.
 *
 *   2. Realistic costs — maker 0.02%, taker 0.05%, slippage 0.01% per trade,
 *      plus 8h funding rate drag on perpetual swap exposure.
 *
 *   3. Inventory risk — tracks net inventory drift in trending markets,
 *      applies unrealised P&L from accumulated position bias.
 *
 *   4. State-adaptive grid — grid parameters (width, density) change
 *      based on detected market state.
 *
 *   5. Stop-loss / take-profit simulation — checks per-day P&L against
 *      strategy risk parameters.
 *
 * Usage:
 *   pnpm run backtest [--days=90] [--tier=balanced] [--capital=20000]
 */

import { atk, type Candle } from '../atk/client.js'
import db from '../db.js'
import type { MarketState } from '../market/state-recognizer.js'
import type { RiskTier } from '../risk/circuit-breaker.js'
import { ALLOC_LIMITS } from '../cto/allocator.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BacktestConfig {
  assets:      string[]
  days:        number
  riskTier:    RiskTier
  initialUSDT: number
  // Grid config per asset (optional — uses sensible defaults)
  gridCount?:       number   // default 20
  rangeWidthPct?:   number   // default 5 (oscillation), 10 (trend)
  orderSizeUSDT?:   number   // default 10
  stopLossPct?:     number   // default 10
  takeProfitPct?:   number   // default 15
}

export interface DailySnapshot {
  date:         string
  equity:       number
  dailyReturn:  number
  drawdown:     number
  marketState:  Record<string, MarketState>
  deployed:     number
  reserve:      number
  fills:        number       // grid fills for the day
  gridProfit:   number       // USDT profit from grid fills
}

export interface BacktestResult {
  config:         BacktestConfig
  startDate:      string
  endDate:        string
  totalReturn:    number
  annualReturn:   number
  sharpeRatio:    number
  sortinoRatio:   number
  maxDrawdown:    number
  winDays:        number
  totalDays:      number
  winRate:        number
  finalEquity:    number
  totalFills:     number
  snapshots:      DailySnapshot[]
}

// ── Stats helpers ─────────────────────────────────────────────────────────────

function mean(arr: number[]): number {
  return arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length
}

function stdDev(arr: number[]): number {
  if (arr.length < 2) return 0
  const m = mean(arr)
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length)
}

function downstdDev(arr: number[]): number {
  const neg = arr.filter(r => r < 0)
  return neg.length < 2 ? 0 : stdDev(neg)
}

function calcSharpe(dailyReturns: number[], riskFreeDaily = 0.0001): number {
  const excess = dailyReturns.map(r => r - riskFreeDaily)
  const std    = stdDev(excess)
  return std === 0 ? 0 : (mean(excess) / std) * Math.sqrt(252)
}

function calcSortino(dailyReturns: number[], riskFreeDaily = 0.0001): number {
  const excess = dailyReturns.map(r => r - riskFreeDaily)
  const dstd   = downstdDev(excess)
  return dstd === 0 ? 0 : (mean(excess) / dstd) * Math.sqrt(252)
}

function calcMaxDrawdown(equityCurve: number[]): number {
  let peak = equityCurve[0] ?? 0
  let maxDD = 0
  for (const e of equityCurve) {
    if (e > peak) peak = e
    const dd = peak > 0 ? (peak - e) / peak : 0
    if (dd > maxDD) maxDD = dd
  }
  return maxDD
}

// ── ATR-based state classification (inline, no DB writes) ────────────────────

function calcATR(candles: Candle[]): number[] {
  return candles.slice(1).map((c, i) => {
    const prev = candles[i]
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close))
    return tr / c.close
  })
}

function classifyDay(
  recentCandles: Candle[],
  fundingRate:   number,
): { state: MarketState; atrRatio: number; volRatio: number } {
  if (recentCandles.length < 10) return { state: 'oscillation', atrRatio: 1, volRatio: 1 }

  const atrs       = calcATR(recentCandles)
  const recentATR  = mean(atrs.slice(-3))
  const baseATR    = mean(atrs)
  const atrRatio   = baseATR > 0 ? recentATR / baseATR : 1

  const vols       = recentCandles.map(c => c.vol)
  const avgVol     = mean(vols.slice(0, -1))
  const currentVol = vols[vols.length - 1]
  const volRatio   = avgVol > 0 ? currentVol / avgVol : 1

  const absFunding = Math.abs(fundingRate)

  let extremeCount = 0
  let trendCount   = 0

  if (atrRatio > 3.0)     extremeCount++
  if (absFunding > 0.001) extremeCount++
  if (volRatio  > 3.0)    extremeCount++

  if (atrRatio >= 1.0 && atrRatio < 3.0)  trendCount++
  if (absFunding >= 0.0003 && absFunding <= 0.001) trendCount++
  if (volRatio >= 1.5 && volRatio < 3.0)  trendCount++

  const state: MarketState = extremeCount >= 2 ? 'extreme'
                           : trendCount   >= 2 ? 'trend'
                           : 'oscillation'

  return { state, atrRatio, volRatio }
}

// ── Kelly allocation proxy ───────────────────────────────────────────────────

function mockAllocate(
  equity:        number,
  state:         MarketState,
  tier:          RiskTier,
  numStrategies: number,
): { deployed: number; reserve: number } {
  if (numStrategies === 0) return { deployed: 0, reserve: equity }

  // Use real allocation limits from the allocator
  const limits = ALLOC_LIMITS[tier]
  const poolPct = state === 'extreme' ? 0.05 : limits.activePoolPct

  const deployed = equity * poolPct
  return { deployed, reserve: equity - deployed }
}

// ── Grid fill simulation (v2 core) ──────────────────────────────────────────
//
// Instead of a formula, we simulate actual grid mechanics:
//
//  1. Place N grid lines evenly between gridMin and gridMax.
//  2. For a given day (candle), count how many grid lines fall within
//     the [low, high] range — these are "active" levels.
//  3. Estimate round trips based on market state:
//     - Oscillation: price bounces → ~1.5–2.0× round trips per active level pair
//     - Trend: price moves one direction → ~0.4–0.7× round trips
//     - Extreme: grid paused → 0 round trips
//  4. Each round trip: profit = gridSpacing / midPrice × orderSize − fees
//  5. Inventory risk: in trends, accumulated net position drifts with price

interface GridConfig {
  gridMin:      number
  gridMax:      number
  gridNum:      number
  orderUSDT:    number
}

interface GridDayResult {
  fills:          number    // total buy+sell fills
  grossProfit:    number    // USDT before fees
  fees:           number    // USDT
  inventoryPnl:   number    // unrealised drift (can be negative)
  netProfit:      number    // gross - fees + inventory
  dailyReturn:    number    // as fraction of deployed capital
}

function buildGrid(midPrice: number, state: MarketState, cfg: BacktestConfig): GridConfig {
  // State-adaptive grid width
  const widthPct = state === 'trend'   ? (cfg.rangeWidthPct ?? 10) / 100
                 : state === 'extreme' ? 0.02   // very narrow — mostly paused
                 : (cfg.rangeWidthPct ?? 5) / 100

  // State-adaptive grid density
  const gridNum = state === 'trend'   ? Math.max(8, (cfg.gridCount ?? 20) - 5)
                : state === 'extreme' ? 5
                : (cfg.gridCount ?? 20)

  return {
    gridMin:   midPrice * (1 - widthPct),
    gridMax:   midPrice * (1 + widthPct),
    gridNum,
    orderUSDT: cfg.orderSizeUSDT ?? 10,
  }
}

function simulateGridDay(
  candle:    Candle,
  prevClose: number,
  grid:      GridConfig,
  state:     MarketState,
): GridDayResult {
  const { gridMin, gridMax, gridNum, orderUSDT } = grid

  if (state === 'extreme') {
    // Grid paused in extreme — only holding cost
    const holdingCost = orderUSDT * gridNum * 0.0002  // ~0.02% daily holding
    const priceMove   = prevClose > 0 ? (candle.close - prevClose) / prevClose : 0
    const inventoryPnl = priceMove * orderUSDT * 0.5  // small residual position
    return {
      fills: 0, grossProfit: 0, fees: 0,
      inventoryPnl: inventoryPnl - holdingCost,
      netProfit: inventoryPnl - holdingCost,
      dailyReturn: -(holdingCost / (orderUSDT * gridNum || 1)),
    }
  }

  const gridSpacing = gridNum > 0 ? (gridMax - gridMin) / gridNum : 0
  if (gridSpacing <= 0) return { fills: 0, grossProfit: 0, fees: 0, inventoryPnl: 0, netProfit: 0, dailyReturn: 0 }

  // Generate grid levels
  const levels: number[] = []
  for (let i = 0; i <= gridNum; i++) {
    levels.push(gridMin + i * gridSpacing)
  }

  // Count active levels within today's price range
  const activeLevels = levels.filter(l => l >= candle.low && l <= candle.high)
  const numActive = activeLevels.length

  if (numActive < 2) {
    return { fills: 0, grossProfit: 0, fees: 0, inventoryPnl: 0, netProfit: 0, dailyReturn: 0 }
  }

  // Estimate round trips based on market behavior
  // In oscillation, price tends to bounce between levels multiple times
  // In trend, price sweeps through levels mostly in one direction
  const roundTripFactor = state === 'oscillation' ? 1.6 : 0.5
  const roundTrips = Math.max(1, Math.floor((numActive - 1) * roundTripFactor / 2))

  // Each round trip = 1 buy fill + 1 sell fill at adjacent levels
  const fills = roundTrips * 2
  const midPrice = (candle.high + candle.low) / 2

  // Profit per round trip: buy low, sell high = gridSpacing
  // But expressed in USDT terms relative to order size
  const profitPerRT = (gridSpacing / midPrice) * orderUSDT

  const grossProfit = roundTrips * profitPerRT

  // Fees: maker 0.02% + taker 0.05% = avg 0.035% per trade, 2 trades per RT
  // Plus slippage ~0.01% per trade
  const feePerTrade = orderUSDT * 0.00045   // 0.035% + 0.01%
  const fees = fills * feePerTrade

  // Inventory risk: in trending markets, net position drifts
  // If price moves up, we accumulate short inventory (sold higher, didn't rebuy)
  // If price moves down, we accumulate long inventory
  const priceMove = prevClose > 0 ? (candle.close - prevClose) / prevClose : 0
  const inventoryExposure = state === 'trend'
    ? orderUSDT * numActive * 0.4   // 40% of active levels contribute to drift
    : orderUSDT * numActive * 0.1   // minimal drift in oscillation

  // In trend, we're on the wrong side of the drift
  const inventoryPnl = -Math.abs(priceMove) * inventoryExposure * 0.5

  // Funding rate drag (perpetual swaps: ~0.01% per 8h, 3× per day)
  const fundingDrag = orderUSDT * numActive * 0.0003  // 0.03% daily

  const netProfit = grossProfit - fees + inventoryPnl - fundingDrag
  const totalDeployed = orderUSDT * gridNum

  return {
    fills,
    grossProfit,
    fees,
    inventoryPnl,
    netProfit,
    dailyReturn: totalDeployed > 0 ? netProfit / totalDeployed : 0,
  }
}

// ── Main engine ───────────────────────────────────────────────────────────────

export async function runBacktest(cfg: BacktestConfig): Promise<BacktestResult> {
  const { assets, days, riskTier, initialUSDT } = cfg

  console.log(`\n  📊 DARWIN Backtest Engine v2`)
  console.log(`  Assets: ${assets.join(', ')}  |  Days: ${days}  |  Tier: ${riskTier}  |  Capital: $${initialUSDT.toLocaleString()}`)
  console.log(`  Grid: ${cfg.gridCount ?? 20} levels  |  Order: $${cfg.orderSizeUSDT ?? 10}  |  Range: ±${cfg.rangeWidthPct ?? 5}%`)
  console.log(`  ${'─'.repeat(60)}`)

  // Fetch historical candles
  const candleMap: Record<string, Candle[]> = {}
  for (const asset of assets) {
    process.stdout.write(`  Fetching ${asset} candles... `)
    try {
      const raw = atk.candles(asset, '1D', days + 35)
      candleMap[asset] = [...raw].reverse()
      console.log(`${candleMap[asset].length} days`)
    } catch (e) {
      console.log(`ERROR: ${e}`)
      candleMap[asset] = []
    }
  }

  const numStrategies = assets.length * 2

  let equity           = initialUSDT
  let peakEquity       = initialUSDT
  const equityCurve:   number[] = [equity]
  const dailyReturns:  number[] = []
  const snapshots:     DailySnapshot[] = []
  let winDays          = 0
  let totalFills       = 0
  let consecutiveLoss  = 0
  let circuitBreakerActive = false

  const stopLossPct    = cfg.stopLossPct    ?? 10
  const takeProfitPct  = cfg.takeProfitPct  ?? 15

  // Filter out assets with no candle data and report failures
  const failedAssets = assets.filter(a => candleMap[a].length === 0)
  if (failedAssets.length > 0) {
    console.warn(`  ⚠ No candle data for: ${failedAssets.join(', ')} — excluding from backtest`)
  }
  const validAssets = assets.filter(a => candleMap[a].length > 0)
  if (validAssets.length === 0) throw new Error('No candle data available for any asset. Check ATK CLI and network connectivity.')

  const minLen = Math.min(...validAssets.map(a => candleMap[a].length))
  const simLen = Math.min(days, minLen - 31)

  if (simLen <= 0) throw new Error(`Not enough candle data for backtest (have ${minLen} days, need ${days + 31}). Try fewer days.`)

  const startIdx = (candleMap[assets[0]]?.length ?? 0) - simLen

  for (let i = 0; i < simLen; i++) {
    const dayIdx = startIdx + i
    const stateMap:    Record<string, MarketState> = {}
    let   dayNetProfit = 0
    let   dayFills     = 0
    let   dayDeployed  = 0

    for (const asset of assets) {
      const candles = candleMap[asset]
      if (!candles || dayIdx >= candles.length) continue

      const window    = candles.slice(Math.max(0, dayIdx - 30), dayIdx + 1)
      const todayC    = candles[dayIdx]
      const prevClose = candles[dayIdx - 1]?.close ?? todayC.open

      const { state, atrRatio } = classifyDay(window, 0)
      stateMap[asset] = state

      // Build state-adaptive grid centered on previous close
      const grid = buildGrid(prevClose, state, cfg)

      // Simulate grid fills for the day
      const result = simulateGridDay(todayC, prevClose, grid, state)

      // Scale by allocation weight (per-asset share of deployed capital)
      // Circuit breaker reduces deployment to 5% when active
      const allocState = circuitBreakerActive ? 'extreme' as MarketState : state
      const { deployed } = mockAllocate(equity, allocState, riskTier, numStrategies)
      const assetShare   = deployed / (assets.length || 1)
      const scaleFactor  = grid.orderUSDT * grid.gridNum > 0
        ? assetShare / (grid.orderUSDT * grid.gridNum)
        : 0

      dayNetProfit += result.netProfit * scaleFactor
      dayFills     += result.fills
      dayDeployed  += assetShare
    }

    totalFills += dayFills

    // Update equity
    const prevEquity = equity
    equity += dayNetProfit
    if (equity < 0) equity = 0

    const pnl = equity - prevEquity
    if (pnl > 0) { winDays++; consecutiveLoss = 0 }
    else consecutiveLoss++

    if (equity > peakEquity) peakEquity = equity

    equityCurve.push(equity)
    const portfolioReturn = prevEquity > 0 ? pnl / prevEquity : 0
    dailyReturns.push(portfolioReturn)

    // Circuit breaker simulation: drawdown from peak exceeds threshold
    const drawdownFromPeak = peakEquity > 0 ? (peakEquity - equity) / peakEquity * 100 : 0
    if (drawdownFromPeak >= stopLossPct) {
      circuitBreakerActive = true  // reduces deployment in subsequent days
    }
    // Take-profit check: reset circuit breaker if equity recovers
    const gainFromStart = initialUSDT > 0 ? (equity - initialUSDT) / initialUSDT * 100 : 0
    if (gainFromStart >= takeProfitPct && circuitBreakerActive) {
      circuitBreakerActive = false
    }

    const todayTs = candleMap[assets[0]]?.[dayIdx]?.ts ?? Date.now()
    const dateStr = new Date(todayTs).toISOString().slice(0, 10)
    const drawdown = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0

    const primaryState = stateMap[assets[0]] ?? 'oscillation'
    const { deployed, reserve } = mockAllocate(equity, primaryState, riskTier, numStrategies)

    snapshots.push({
      date:        dateStr,
      equity:      Math.round(equity * 100) / 100,
      dailyReturn: portfolioReturn,
      drawdown,
      marketState: stateMap,
      deployed:    Math.round(deployed * 100) / 100,
      reserve:     Math.round(reserve * 100) / 100,
      fills:       dayFills,
      gridProfit:  Math.round(dayNetProfit * 100) / 100,
    })
  }

  // ── Compute final metrics ─────────────────────────────────────────────────
  const totalReturn  = initialUSDT > 0 ? (equity - initialUSDT) / initialUSDT : 0
  const annualReturn = simLen > 0 ? (1 + totalReturn) ** (252 / simLen) - 1 : 0

  const result: BacktestResult = {
    config:       cfg,
    startDate:    snapshots[0]?.date  ?? '',
    endDate:      snapshots[snapshots.length - 1]?.date ?? '',
    totalReturn,
    annualReturn,
    sharpeRatio:  Math.round(calcSharpe(dailyReturns)   * 100) / 100,
    sortinoRatio: Math.round(calcSortino(dailyReturns)  * 100) / 100,
    maxDrawdown:  Math.round(calcMaxDrawdown(equityCurve) * 10000) / 10000,
    winDays,
    totalDays:    simLen,
    winRate:      simLen > 0 ? winDays / simLen : 0,
    finalEquity:  Math.round(equity * 100) / 100,
    totalFills,
    snapshots,
  }

  saveBacktestResult(result)
  return result
}

// ── Persist results ───────────────────────────────────────────────────────────

function saveBacktestResult(result: BacktestResult): void {
  try {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS backtest_results (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        run_at         TEXT    NOT NULL DEFAULT (datetime('now')),
        assets         TEXT    NOT NULL,
        days           INTEGER NOT NULL,
        risk_tier      TEXT    NOT NULL,
        initial_usdt   REAL    NOT NULL,
        total_return   REAL,
        annual_return  REAL,
        sharpe_ratio   REAL,
        sortino_ratio  REAL,
        max_drawdown   REAL,
        win_rate       REAL,
        final_equity   REAL,
        total_fills    INTEGER,
        snapshots      TEXT
      )
    `).run()

    db.prepare(`
      INSERT INTO backtest_results
        (assets, days, risk_tier, initial_usdt, total_return, annual_return,
         sharpe_ratio, sortino_ratio, max_drawdown, win_rate, final_equity, total_fills, snapshots)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      result.config.assets.join(','),
      result.config.days,
      result.config.riskTier,
      result.config.initialUSDT,
      result.totalReturn,
      result.annualReturn,
      result.sharpeRatio,
      result.sortinoRatio,
      result.maxDrawdown,
      result.winRate,
      result.finalEquity,
      result.totalFills,
      JSON.stringify(result.snapshots),
    )
  } catch {
    // Non-fatal
  }
}

// ── Display ───────────────────────────────────────────────────────────────────

const C = {
  reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m',
  cyan:'\x1b[36m', green:'\x1b[32m', yellow:'\x1b[33m', red:'\x1b[31m',
}
const b  = (s: string) => `${C.bold}${s}${C.reset}`
const cy = (s: string) => `${C.cyan}${s}${C.reset}`
const gn = (s: string) => `${C.green}${s}${C.reset}`
const yw = (s: string) => `${C.yellow}${s}${C.reset}`
const rd = (s: string) => `${C.red}${s}${C.reset}`
const dm = (s: string) => `${C.dim}${s}${C.reset}`

export function printBacktestResult(r: BacktestResult): void {
  const retColor = r.totalReturn >= 0 ? gn : rd
  const ddColor  = r.maxDrawdown <= 0.05 ? gn : r.maxDrawdown <= 0.15 ? yw : rd

  console.log()
  console.log(cy('  ╔' + '═'.repeat(58) + '╗'))
  console.log(cy('  ║ ') + b('📊  DARWIN Backtest Results  v2'.padEnd(57)) + cy('║'))
  console.log(cy('  ╚' + '═'.repeat(58) + '╝'))
  console.log()

  console.log(`  ${dm('Period')}       ${r.startDate}  →  ${r.endDate}  (${r.totalDays} days)`)
  console.log(`  ${dm('Assets')}       ${r.config.assets.join(', ')}`)
  console.log(`  ${dm('Risk tier')}    ${r.config.riskTier.toUpperCase()}`)
  console.log(`  ${dm('Capital')}      $${r.config.initialUSDT.toLocaleString()}  →  $${r.finalEquity.toLocaleString()}`)
  console.log()
  console.log(`  ${'─'.repeat(50)}`)

  const fmt = (label: string, val: string) =>
    `  ${label.padEnd(22)} ${val}`

  const retPct = (r.totalReturn  * 100).toFixed(2) + '%'
  const annPct = (r.annualReturn * 100).toFixed(2) + '%'
  const ddPct  = (r.maxDrawdown  * 100).toFixed(2) + '%'

  console.log(fmt('Total Return',   retColor((r.totalReturn  >= 0 ? '+' : '') + retPct)))
  console.log(fmt('Annual Return',  retColor((r.annualReturn >= 0 ? '+' : '') + annPct)))
  console.log(fmt('Sharpe Ratio',   r.sharpeRatio  >= 1.5 ? gn(r.sharpeRatio.toFixed(2))
                                   : r.sharpeRatio >= 0.5 ? yw(r.sharpeRatio.toFixed(2))
                                   : rd(r.sharpeRatio.toFixed(2))))
  console.log(fmt('Sortino Ratio',  r.sortinoRatio >= 1.5 ? gn(r.sortinoRatio.toFixed(2))
                                   : r.sortinoRatio >= 0.5 ? yw(r.sortinoRatio.toFixed(2))
                                   : rd(r.sortinoRatio.toFixed(2))))
  console.log(fmt('Max Drawdown',   ddColor(ddPct)))
  console.log(fmt('Win Days',       `${r.winDays}/${r.totalDays}  (${wrColor(r.winRate)})`))
  console.log(fmt('Total Fills',    cy(r.totalFills.toLocaleString())))
  console.log(fmt('Avg Fills/Day',  cy((r.totalFills / (r.totalDays || 1)).toFixed(1))))
  console.log()

  // State distribution
  const stateCounts: Record<string, number> = {}
  for (const s of r.snapshots) {
    for (const state of Object.values(s.marketState)) {
      stateCounts[state] = (stateCounts[state] ?? 0) + 1
    }
  }
  const total = r.snapshots.length || 1
  console.log(`  ${dm('Market regime distribution:')}`)
  for (const [state, count] of Object.entries(stateCounts)) {
    const pct = (count / total * 100).toFixed(0) + '%'
    const col = state === 'oscillation' ? yw : state === 'trend' ? gn : rd
    const bar = col('█'.repeat(Math.round(count / total * 20)))
    console.log(`    ${state.padEnd(14)} ${bar} ${pct}  (${count} days)`)
  }

  // Fill distribution by state
  const fillsByState: Record<string, number> = {}
  for (const s of r.snapshots) {
    const primaryState = Object.values(s.marketState)[0] ?? 'oscillation'
    fillsByState[primaryState] = (fillsByState[primaryState] ?? 0) + s.fills
  }
  console.log()
  console.log(`  ${dm('Grid fills by regime:')}`)
  for (const [state, fills] of Object.entries(fillsByState)) {
    const col = state === 'oscillation' ? yw : state === 'trend' ? gn : rd
    console.log(`    ${state.padEnd(14)} ${col(fills.toLocaleString())} fills`)
  }
  console.log()
}

function wrColor(wr: number): string {
  const pct = (wr * 100).toFixed(1) + '%'
  return wr >= 0.6 ? gn(pct) : wr >= 0.45 ? yw(pct) : rd(pct)
}

// ── CLI entry point ───────────────────────────────────────────────────────────

const isMain = process.argv[1]?.includes('engine')
if (isMain) {
  const args    = process.argv.slice(2)
  const getArg  = (prefix: string, fallback: string) =>
    args.find(a => a.startsWith(prefix))?.split('=')[1] ?? fallback

  const config: BacktestConfig = {
    assets:         ['BTC-USDT', 'ETH-USDT'],
    days:           parseInt(getArg('--days=', '90')),
    riskTier:       getArg('--tier=', 'balanced') as RiskTier,
    initialUSDT:    parseFloat(getArg('--capital=', '20000')),
    gridCount:      parseInt(getArg('--grids=', '20')),
    orderSizeUSDT:  parseFloat(getArg('--order=', '10')),
    rangeWidthPct:  parseFloat(getArg('--range=', '5')),
    stopLossPct:    parseFloat(getArg('--sl=', '10')),
    takeProfitPct:  parseFloat(getArg('--tp=', '15')),
  }

  try {
    const result = await runBacktest(config)
    printBacktestResult(result)
  } catch (e) {
    console.error(`  Backtest error: ${e}`)
    process.exit(1)
  }
}
