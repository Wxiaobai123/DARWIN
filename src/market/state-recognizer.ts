/**
 * DARWIN Market State Recognizer
 *
 * Classifies each asset into one of three states:
 *   oscillation — low volatility, range-bound, balanced sentiment
 *   trend       — directional move, elevated volume, persistent funding
 *   extreme     — panic/euphoria, ATR spike, extreme funding/positioning
 *
 * State changes require 3 consecutive confirmations (45 min at 15-min heartbeat)
 * to prevent false switches on single anomalous readings.
 */

import { atk, Candle } from '../atk/client.js'
import { toSwapId } from '../config.js'
import db from '../db.js'

export type MarketState = 'oscillation' | 'trend' | 'extreme'

export interface StateIndicators {
  atrRatio:       number   // current ATR / 30d average ATR
  fundingRate:    number   // absolute value of funding rate
  volumeRatio:    number   // 24h vol / 30d average daily vol
  longShortRatio: number   // approximated from open interest trend
}

export interface StateReport {
  asset:       string
  state:       MarketState
  confidence:  number          // 0.0 – 1.0
  indicators:  StateIndicators
  recordedAt:  Date
}

// ── Confirmation buffer: tracks last N classifications per asset ──────────────

const confirmationBuffer = new Map<string, MarketState[]>()
const CONFIRMATIONS_NEEDED = 3

function getConfirmedState(asset: string, newState: MarketState): MarketState | null {
  const buf = confirmationBuffer.get(asset) ?? []
  buf.push(newState)
  if (buf.length > CONFIRMATIONS_NEEDED) buf.shift()
  confirmationBuffer.set(asset, buf)

  if (buf.length < CONFIRMATIONS_NEEDED) return null
  if (buf.every(s => s === buf[0])) return buf[0]
  return null
}

// ── ATR calculation ───────────────────────────────────────────────────────────

function calcATR(candles: Candle[]): number[] {
  const atrs: number[] = []
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low  - candles[i - 1].close)
    )
    atrs.push(tr / candles[i].close) // normalised as % of price
  }
  return atrs
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

// ── State classification ──────────────────────────────────────────────────────

function countExtremeSignals(ind: StateIndicators): number {
  let count = 0
  if (ind.atrRatio    > 3.0)  count++
  if (Math.abs(ind.fundingRate) > 0.001) count++   // 0.1%
  if (ind.volumeRatio > 3.0)  count++
  if (ind.longShortRatio > 3.0 || ind.longShortRatio < 0.33) count++
  return count
}

function countTrendSignals(ind: StateIndicators): number {
  let count = 0
  if (ind.atrRatio    >= 1.0 && ind.atrRatio < 3.0) count++
  if (Math.abs(ind.fundingRate) >= 0.0003 && Math.abs(ind.fundingRate) <= 0.001) count++
  if (ind.volumeRatio >= 1.5 && ind.volumeRatio < 3.0) count++
  if ((ind.longShortRatio > 1.5 && ind.longShortRatio <= 3.0) ||
      (ind.longShortRatio < 0.67 && ind.longShortRatio >= 0.33)) count++
  return count
}

function classifyRaw(indicators: StateIndicators): { state: MarketState; confidence: number } {
  const extremeCount = countExtremeSignals(indicators)
  const trendCount   = countTrendSignals(indicators)

  if (extremeCount >= 3) return { state: 'extreme',     confidence: extremeCount / 4 }
  if (extremeCount >= 2) return { state: 'extreme',     confidence: 0.65 }
  if (trendCount   >= 3) return { state: 'trend',       confidence: trendCount / 4 }
  if (trendCount   >= 2) return { state: 'trend',       confidence: 0.65 }
  return { state: 'oscillation', confidence: 0.5 + (4 - trendCount - extremeCount) * 0.1 }
}

// ── Main recognizer ───────────────────────────────────────────────────────────

export async function recognizeState(asset: string): Promise<StateReport> {
  // Derive swap instId from spot (BTC-USDT → BTC-USDT-SWAP, XAUT-USDT → XAU-USDT-SWAP)
  const swapId = toSwapId(asset)

  // 1. Fetch 30 daily candles for ATR baseline
  const candles = atk.candles(asset, '1D', 31)

  // Guard: need at least 5 candles for meaningful ATR calculation
  if (candles.length < 5) {
    console.warn(`  [Market] ${asset}: only ${candles.length} candles — insufficient data, defaulting to oscillation`)
    const defaultIndicators: StateIndicators = { atrRatio: 1.0, fundingRate: 0, volumeRatio: 1.0, longShortRatio: 1.0 }
    db.prepare('INSERT INTO market_states (asset, state, confidence, indicators) VALUES (?, ?, ?, ?)')
      .run(asset, 'oscillation', 0.3, JSON.stringify(defaultIndicators))
    return { asset, state: 'oscillation', confidence: 0.3, indicators: defaultIndicators, recordedAt: new Date() }
  }

  const atrs = calcATR(candles)

  const recentATR = avg(atrs.slice(-3))   // last 3 days
  const baselineATR = avg(atrs)           // 30-day average
  const atrRatio = baselineATR > 0 ? recentATR / baselineATR : 1

  // 2. Volume ratio (24h vs 30d avg daily vol)
  const volumes = candles.map(c => c.vol)
  const avgVol = avg(volumes.slice(0, -1))
  const currentVol = volumes[volumes.length - 1]
  const volumeRatio = avgVol > 0 ? currentVol / avgVol : 1

  // 3. Funding rate (swap only)
  let fundingRate = 0
  try {
    const fr = atk.fundingRate(swapId)
    fundingRate = fr.fundingRate
  } catch {
    // Some assets may not have perpetual swaps — skip
  }

  // 4. Long/short ratio approximation via open interest delta
  let longShortRatio = 1.0
  try {
    const oi = atk.openInterest(swapId)
    // Simple proxy: if OI is growing while price rises → more longs
    const priceChange = (candles[candles.length - 1].close - candles[candles.length - 2].close)
      / candles[candles.length - 2].close
    const oiNormalised = oi.oi > 0 ? 1 : 0
    longShortRatio = priceChange > 0 && oiNormalised > 0 ? 1.4
                   : priceChange < 0 && oiNormalised > 0 ? 0.7
                   : 1.0
  } catch {
    // Fallback to neutral
  }

  const indicators: StateIndicators = { atrRatio, fundingRate, volumeRatio, longShortRatio }
  const { state: rawState, confidence } = classifyRaw(indicators)

  // Apply confirmation buffer — state only changes after 3 consecutive same results
  const confirmedState = getConfirmedState(asset, rawState)
  const finalState = confirmedState ?? getLastKnownState(asset) ?? rawState

  const report: StateReport = {
    asset,
    state:      finalState,
    confidence: confirmedState ? confidence : confidence * 0.7,
    indicators,
    recordedAt: new Date(),
  }

  // Persist to DB
  db.prepare(`
    INSERT INTO market_states (asset, state, confidence, indicators)
    VALUES (?, ?, ?, ?)
  `).run(asset, report.state, report.confidence, JSON.stringify(indicators))

  return report
}

function getLastKnownState(asset: string): MarketState | null {
  const row = db.prepare(`
    SELECT state FROM market_states
    WHERE asset = ?
    ORDER BY recorded_at DESC LIMIT 1
  `).get(asset) as { state: MarketState } | undefined
  return row?.state ?? null
}

// ── CLI entry point (only runs when executed directly) ───────────────────────

const isMain = process.argv[1]?.endsWith('state-recognizer.ts') ||
               process.argv[1]?.endsWith('state-recognizer.js')

if (isMain) {
  const assets = ['BTC-USDT', 'ETH-USDT']

  console.log('\n╔══════════════════════════════════════════════════╗')
  console.log('║        DARWIN Market State Recognizer            ║')
  console.log(`║        ${new Date().toLocaleString().padEnd(42)}║`)
  console.log('╚══════════════════════════════════════════════════╝\n')

  for (const asset of assets) {
    process.stdout.write(`  Analyzing ${asset}... `)
    try {
      const report = await recognizeState(asset)
      const stateEmoji = report.state === 'oscillation' ? '〰️ '
                       : report.state === 'trend'       ? '📈'
                       : '⚠️ '
      const bar = '█'.repeat(Math.round(report.confidence * 10)).padEnd(10)
      console.log(`${stateEmoji}  ${report.state.toUpperCase().padEnd(12)} [${bar}] ${Math.round(report.confidence * 100)}%`)
      console.log(`              ATR ratio: ${report.indicators.atrRatio.toFixed(2)}x  `
        + `Funding: ${(report.indicators.fundingRate * 100).toFixed(4)}%  `
        + `Volume: ${report.indicators.volumeRatio.toFixed(2)}x`)
    } catch (err) {
      console.log(`  ERROR: ${err}`)
    }
    console.log()
  }
}
