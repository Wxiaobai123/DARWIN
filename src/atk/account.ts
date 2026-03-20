/**
 * ATK Account layer — authenticated endpoints
 */

import { runATK, runATKAsync } from './runner.js'

export interface Balance {
  currency:  string
  equity:    number
  available: number
  frozen:    number
}

export interface Position {
  instId:   string
  side:     string
  size:     number
  avgPx:    number
  upl:      number
  margin:   number
}

export interface DetailedPosition {
  instId:      string
  posSide:     string
  pos:         number
  avgPx:       number
  markPx:      number
  liqPx:       string
  lever:       number
  mgnMode:     string
  upl:         number
  uplRatio:    number
  notionalUsd: number
  margin:      number
  fee:         number
  fundingFee:  number
  realizedPnl: number
  cTime:       string
}

interface OKXAccountRow {
  totalEq: string
  details: Array<{
    ccy: string; eq: string; eqUsd: string; availBal: string; frozenBal: string
  }>
}

export const account = {

  balance(): Balance[] {
    const rows = runATK(['account', 'balance'], true) as OKXAccountRow[] | null
    if (!rows || !rows[0]?.details) return []
    return rows[0].details.map(d => ({
      currency:  d.ccy,
      equity:    parseFloat(d.eq       ?? '0'),
      available: parseFloat(d.availBal ?? '0'),
      frozen:    parseFloat(d.frozenBal ?? '0'),
    }))
  },

  totalEquityUSDT(): number {
    try {
      const rows = runATK(['account', 'balance'], true) as OKXAccountRow[] | null
      if (!rows || !rows[0]) return 0
      return parseFloat(rows[0].totalEq ?? '0')
    } catch {
      return 0
    }
  },

  positions(): Position[] {
    try {
      const rows = runATK(['swap', 'positions'], true) as Array<Record<string, string>> | null
      if (!rows) return []
      return rows.map(r => ({
        instId: r.instId,
        side:   r.posSide ?? 'net',
        size:   parseFloat(r.pos    ?? '0'),
        avgPx:  parseFloat(r.avgPx  ?? '0'),
        upl:    parseFloat(r.upl    ?? '0'),
        margin: parseFloat(r.margin ?? '0'),
      }))
    } catch {
      return []
    }
  },

  detailedPositions(): DetailedPosition[] {
    try {
      const rows = runATK(['swap', 'positions'], true) as Array<Record<string, string>> | null
      if (!rows) return []
      return parseDetailedPositions(rows)
    } catch {
      return []
    }
  },

  async detailedPositionsAsync(): Promise<DetailedPosition[]> {
    try {
      const rows = await runATKAsync(['swap', 'positions'], true) as Array<Record<string, string>> | null
      if (!rows) return []
      return parseDetailedPositions(rows)
    } catch {
      return []
    }
  },

  async totalEquityUSDTAsync(): Promise<number> {
    try {
      const rows = await runATKAsync(['account', 'balance'], true) as OKXAccountRow[] | null
      if (!rows || !rows[0]) return 0
      return parseFloat(rows[0].totalEq ?? '0')
    } catch {
      return 0
    }
  },
}

function parseDetailedPositions(rows: Array<Record<string, string>>): DetailedPosition[] {
  return rows.map(r => ({
    instId:      r.instId,
    posSide:     r.posSide ?? 'net',
    pos:         parseFloat(r.pos ?? '0'),
    avgPx:       parseFloat(r.avgPx ?? '0'),
    markPx:      parseFloat(r.markPx ?? '0'),
    liqPx:       r.liqPx ?? '',
    lever:       parseInt(r.lever ?? '1'),
    mgnMode:     r.mgnMode ?? 'cross',
    upl:         parseFloat(r.upl ?? '0'),
    uplRatio:    parseFloat(r.uplRatio ?? '0'),
    notionalUsd: parseFloat(r.notionalUsd ?? '0'),
    margin:      parseFloat(r.imr ?? '0'),
    fee:         parseFloat(r.fee ?? '0'),
    fundingFee:  parseFloat(r.fundingFee ?? '0'),
    realizedPnl: parseFloat(r.realizedPnl ?? '0'),
    cTime:       r.cTime ?? '',
  }))
}
