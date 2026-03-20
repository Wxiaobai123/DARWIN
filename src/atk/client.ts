/**
 * ATK Client — market data (no authentication needed)
 */

import { runATK } from './runner.js'

export interface Ticker {
  instId: string; last: number; high24h: number; low24h: number; vol24h: number; ts: number
}

export interface Candle {
  ts: number; open: number; high: number; low: number; close: number; vol: number
}

export interface FundingRate {
  instId: string; fundingRate: number; nextFundingRate: number; fundingTime: number
}

export interface OpenInterest {
  instId: string; oi: number; oiCcy: number; ts: number
}

export interface InstrumentInfo {
  instId: string; ctVal: number; lotSz: number; minSz: number; tickSz: number
}

export const atk = {
  ticker(instId: string): Ticker {
    const raw = runATK(['market', 'ticker', instId])
    const r = (Array.isArray(raw) ? raw[0] : raw) as Record<string, string>
    return {
      instId: r.instId,
      last:    parseFloat(r.last),
      high24h: parseFloat(r.high24h),
      low24h:  parseFloat(r.low24h),
      vol24h:  parseFloat(r.volCcy24h ?? r.vol24h),
      ts:      parseInt(r.ts),
    }
  },

  candles(instId: string, bar = '1D', limit = 30): Candle[] {
    const raw = runATK(['market', 'candles', instId, '--bar', bar, '--limit', String(limit)])
    const rows = raw as Array<[string, string, string, string, string, string]>
    return rows.map(r => ({
      ts:    parseInt(r[0]),
      open:  parseFloat(r[1]),
      high:  parseFloat(r[2]),
      low:   parseFloat(r[3]),
      close: parseFloat(r[4]),
      vol:   parseFloat(r[5]),
    }))
  },

  fundingRate(instId: string): FundingRate {
    const raw = runATK(['market', 'funding-rate', instId])
    const r = (Array.isArray(raw) ? raw[0] : raw) as Record<string, string>
    return {
      instId:          r.instId,
      fundingRate:     parseFloat(r.fundingRate),
      nextFundingRate: parseFloat(r.nextFundingRate || '0'),
      fundingTime:     parseInt(r.fundingTime),
    }
  },

  openInterest(instId: string): OpenInterest {
    const raw = runATK(['market', 'open-interest', '--instType', 'SWAP', '--instId', instId])
    const rows = raw as Array<Record<string, string>>
    const r = rows[0]
    return {
      instId: r.instId,
      oi:     parseFloat(r.oi),
      oiCcy:  parseFloat(r.oiCcy),
      ts:     parseInt(r.ts),
    }
  },

  /** Get instrument info (ctVal, lotSz, minSz) — cached per session */
  instrument(instId: string, instType: 'SWAP' | 'SPOT' = 'SWAP'): InstrumentInfo {
    const cacheKey = `${instType}:${instId}`
    if (instrumentCache.has(cacheKey)) return instrumentCache.get(cacheKey)!
    const raw = runATK(['market', 'instruments', '--instType', instType, '--instId', instId])
    const rows = raw as Array<Record<string, string>>
    const r = rows[0]
    const info: InstrumentInfo = {
      instId: r.instId,
      ctVal:  parseFloat(r.ctVal || '1'),
      lotSz:  parseFloat(r.lotSz || '0.01'),
      minSz:  parseFloat(r.minSz || '0.01'),
      tickSz: parseFloat(r.tickSz || '0.1'),
    }
    instrumentCache.set(cacheKey, info)
    return info
  },
}

const instrumentCache = new Map<string, InstrumentInfo>()
