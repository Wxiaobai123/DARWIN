/**
 * DARWIN Technical Indicator Engine
 *
 * Pure calculation functions — no side effects, no DB, no API calls.
 * Takes raw candle data and returns indicator values.
 *
 * Used by:
 *   - Strategy entry/exit signal evaluation
 *   - Market state enrichment
 *   - Backtest engine
 *
 * Indicators:
 *   RSI        — Relative Strength Index (momentum oscillator)
 *   EMA        — Exponential Moving Average (trend filter)
 *   SMA        — Simple Moving Average
 *   Bollinger  — Bollinger Bands (volatility channel)
 *   ATR        — Average True Range (volatility measure)
 *   MACD       — Moving Average Convergence Divergence
 *   VWAP       — Volume Weighted Average Price (intraday)
 */

import type { Candle } from '../atk/client.js'

// ── RSI (Relative Strength Index) ────────────────────────────────────────────
//
// RSI = 100 - 100 / (1 + RS)
// RS = average gain / average loss over `period` candles
// Default period: 14

export function rsi(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 50  // neutral default

  const changes = candles.slice(1).map((c, i) => c.close - candles[i].close)
  const recent  = changes.slice(-period)

  let avgGain = 0
  let avgLoss = 0
  for (const change of recent) {
    if (change > 0) avgGain += change
    else            avgLoss += Math.abs(change)
  }
  avgGain /= period
  avgLoss /= period

  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

/**
 * RSI series — returns RSI for each candle position (for charting/backtesting)
 */
export function rsiSeries(candles: Candle[], period = 14): number[] {
  const result: number[] = []
  for (let i = period; i <= candles.length; i++) {
    result.push(rsi(candles.slice(0, i), period))
  }
  return result
}

// ── EMA (Exponential Moving Average) ────────────────────────────────────────

export function ema(candles: Candle[], period: number): number {
  if (candles.length === 0) return 0
  if (candles.length < period) return sma(candles, candles.length)

  const k = 2 / (period + 1)
  let emaVal = sma(candles.slice(0, period), period)

  for (let i = period; i < candles.length; i++) {
    emaVal = candles[i].close * k + emaVal * (1 - k)
  }
  return emaVal
}

/**
 * EMA series — returns EMA value at each point
 */
export function emaSeries(candles: Candle[], period: number): number[] {
  if (candles.length < period) return []

  const k = 2 / (period + 1)
  const result: number[] = []

  let emaVal = sma(candles.slice(0, period), period)
  result.push(emaVal)

  for (let i = period; i < candles.length; i++) {
    emaVal = candles[i].close * k + emaVal * (1 - k)
    result.push(emaVal)
  }
  return result
}

// ── SMA (Simple Moving Average) ──────────────────────────────────────────────

export function sma(candles: Candle[], period: number): number {
  if (candles.length === 0) return 0
  const slice = candles.slice(-period)
  return slice.reduce((sum, c) => sum + c.close, 0) / slice.length
}

// ── Bollinger Bands ──────────────────────────────────────────────────────────
//
// Middle = SMA(period)
// Upper  = Middle + k × StdDev
// Lower  = Middle - k × StdDev
// Default: period=20, k=2

export interface BollingerBands {
  upper:  number
  middle: number
  lower:  number
  width:  number   // (upper - lower) / middle — band width %
}

export function bollinger(candles: Candle[], period = 20, k = 2): BollingerBands {
  const slice  = candles.slice(-period)
  const middle = slice.reduce((sum, c) => sum + c.close, 0) / slice.length
  const variance = slice.reduce((sum, c) => sum + (c.close - middle) ** 2, 0) / slice.length
  const stdDev = Math.sqrt(variance)

  const upper = middle + k * stdDev
  const lower = middle - k * stdDev
  const width = middle > 0 ? (upper - lower) / middle : 0

  return { upper, middle, lower, width }
}

// ── ATR (Average True Range) ─────────────────────────────────────────────────

export function atr(candles: Candle[], period = 14): number {
  if (candles.length < 2) return 0

  const trs: number[] = []
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    )
    trs.push(tr)
  }

  const recent = trs.slice(-period)
  return recent.reduce((a, b) => a + b, 0) / recent.length
}

/**
 * ATR ratio: recent ATR / baseline ATR — measures volatility expansion/contraction
 */
export function atrRatio(candles: Candle[], shortPeriod = 3, longPeriod = 30): number {
  if (candles.length < longPeriod + 1) return 1

  const trs: number[] = []
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    )
    trs.push(tr / candles[i].close)  // normalised by price
  }

  const recentATR   = mean(trs.slice(-shortPeriod))
  const baselineATR = mean(trs.slice(-longPeriod))

  return baselineATR > 0 ? recentATR / baselineATR : 1
}

// ── MACD (Moving Average Convergence Divergence) ─────────────────────────────

export interface MACDResult {
  macd:      number   // MACD line (fast EMA - slow EMA)
  signal:    number   // Signal line (EMA of MACD)
  histogram: number   // MACD - signal
}

export function macd(candles: Candle[], fast = 12, slow = 26, signal = 9): MACDResult {
  const fastEMA = ema(candles, fast)
  const slowEMA = ema(candles, slow)
  const macdLine = fastEMA - slowEMA

  // Simplified signal: use the current MACD value
  // Full implementation would compute EMA of MACD series
  const macdSeries: number[] = []
  const fastSeries = emaSeries(candles, fast)
  const slowSeries = emaSeries(candles, slow)

  const offset = Math.max(0, fastSeries.length - slowSeries.length)
  for (let i = 0; i < slowSeries.length; i++) {
    macdSeries.push(fastSeries[i + offset] - slowSeries[i])
  }

  // Signal line = EMA of MACD series
  let signalLine = 0
  if (macdSeries.length >= signal) {
    const k = 2 / (signal + 1)
    signalLine = mean(macdSeries.slice(0, signal))
    for (let i = signal; i < macdSeries.length; i++) {
      signalLine = macdSeries[i] * k + signalLine * (1 - k)
    }
  }

  return {
    macd:      macdLine,
    signal:    signalLine,
    histogram: macdLine - signalLine,
  }
}

// ── VWAP (Volume Weighted Average Price) ─────────────────────────────────────

export function vwap(candles: Candle[]): number {
  let cumVolPrice = 0
  let cumVol = 0

  for (const c of candles) {
    const typicalPrice = (c.high + c.low + c.close) / 3
    cumVolPrice += typicalPrice * c.vol
    cumVol += c.vol
  }

  return cumVol > 0 ? cumVolPrice / cumVol : 0
}

// ── Signal evaluation (used by strategy runner) ──────────────────────────────

export type EntrySignal =
  | 'immediate'
  | 'rsi_oversold'
  | 'rsi_overbought'
  | 'price_near_ma20'
  | 'price_near_ma50'
  | 'funding_rate_spike'
  | 'volume_breakout'
  | 'macd_cross_up'
  | 'macd_cross_down'
  | 'bollinger_squeeze'

/**
 * Evaluate whether an entry signal is currently triggered.
 */
export function evaluateEntrySignal(
  signal:      string,
  candles:     Candle[],
  fundingRate: number = 0,
): { triggered: boolean; detail: string } {
  const currentPrice = candles.length > 0 ? candles[candles.length - 1].close : 0

  switch (signal) {
    case 'immediate':
      return { triggered: true, detail: 'Immediate entry' }

    case 'rsi_oversold': {
      const rsiVal = rsi(candles)
      return {
        triggered: rsiVal < 30,
        detail: `RSI=${rsiVal.toFixed(1)} (< 30 = oversold)`,
      }
    }

    case 'rsi_overbought': {
      const rsiVal = rsi(candles)
      return {
        triggered: rsiVal > 70,
        detail: `RSI=${rsiVal.toFixed(1)} (> 70 = overbought)`,
      }
    }

    case 'price_near_ma20': {
      const ma = sma(candles, 20)
      const dist = ma > 0 ? Math.abs(currentPrice - ma) / ma : 1
      return {
        triggered: dist < 0.02,
        detail: `Price $${currentPrice.toFixed(0)} vs MA20 $${ma.toFixed(0)} (${(dist * 100).toFixed(1)}% away)`,
      }
    }

    case 'price_near_ma50': {
      const ma = sma(candles, 50)
      const dist = ma > 0 ? Math.abs(currentPrice - ma) / ma : 1
      return {
        triggered: dist < 0.03,
        detail: `Price $${currentPrice.toFixed(0)} vs MA50 $${ma.toFixed(0)} (${(dist * 100).toFixed(1)}% away)`,
      }
    }

    case 'funding_rate_spike': {
      const absFR = Math.abs(fundingRate)
      return {
        triggered: absFR > 0.0005,
        detail: `Funding ${(fundingRate * 100).toFixed(4)}% (threshold 0.05%)`,
      }
    }

    case 'volume_breakout': {
      if (candles.length < 21) return { triggered: false, detail: 'Not enough data' }
      const avgVol = mean(candles.slice(-21, -1).map(c => c.vol))
      const currVol = candles[candles.length - 1].vol
      const ratio = avgVol > 0 ? currVol / avgVol : 1
      return {
        triggered: ratio > 2.0,
        detail: `Volume ${ratio.toFixed(1)}× average (threshold 2.0×)`,
      }
    }

    case 'macd_cross_up': {
      const m = macd(candles)
      return {
        triggered: m.histogram > 0 && m.macd > 0,
        detail: `MACD=${m.macd.toFixed(2)} Signal=${m.signal.toFixed(2)} Hist=${m.histogram.toFixed(2)}`,
      }
    }

    case 'macd_cross_down': {
      const m = macd(candles)
      return {
        triggered: m.histogram < 0 && m.macd < 0,
        detail: `MACD=${m.macd.toFixed(2)} Signal=${m.signal.toFixed(2)} Hist=${m.histogram.toFixed(2)}`,
      }
    }

    case 'bollinger_squeeze': {
      const bb = bollinger(candles)
      return {
        triggered: bb.width < 0.04,
        detail: `BB width=${(bb.width * 100).toFixed(1)}% (threshold 4%)`,
      }
    }

    case 'time_interval':
      // Time-based signals are always valid (checked externally by schedule)
      return { triggered: true, detail: 'Time interval signal — always valid' }

    default:
      return { triggered: false, detail: `Unknown signal "${signal}" — blocked (fail-closed)` }
  }
}

// ── Helper ──────────────────────────────────────────────────────────────────

function mean(arr: number[]): number {
  return arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length
}
