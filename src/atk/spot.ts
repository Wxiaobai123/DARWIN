/**
 * ATK Spot Trading layer — authenticated spot order management
 *
 * Wraps the ATK CLI `spot` module:
 *   spot place     — market/limit buy/sell
 *   spot cancel    — cancel pending order
 *   spot amend     — modify pending order
 *   spot fills     — trade history
 *   spot algo place — TP/SL/OCO conditional orders
 */

import { runATK } from './runner.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SpotOrderConfig {
  instId:    string
  side:      'buy' | 'sell'
  ordType:   'market' | 'limit' | 'post_only'
  sz:        string        // size in base currency (e.g. "0.01" BTC)
  px?:       string        // price (required for limit/post_only)
  tdMode?:   'cash' | 'cross' | 'isolated'
}

export interface SpotAlgoConfig {
  instId:      string
  side:        'buy' | 'sell'
  sz:          string
  ordType?:    'conditional' | 'oco'
  tpTriggerPx?: string     // take-profit trigger price
  tpOrdPx?:    string      // take-profit order price (-1 = market)
  slTriggerPx?: string     // stop-loss trigger price
  slOrdPx?:    string      // stop-loss order price (-1 = market)
  tdMode?:     'cash' | 'cross' | 'isolated'
}

export interface SpotOrder {
  ordId:   string
  instId:  string
  side:    string
  ordType: string
  sz:      string
  px:      string
  state:   string
  fillSz:  string
  fillPx:  string
  avgPx:   string
}

// ── Spot client ──────────────────────────────────────────────────────────────

export const spotClient = {

  /** Place a spot order (buy or sell) */
  place(cfg: SpotOrderConfig): string {
    const args = [
      'spot', 'place',
      '--instId',  cfg.instId,
      '--side',    cfg.side,
      '--ordType', cfg.ordType,
      '--sz',      cfg.sz,
    ]
    if (cfg.px)     args.push('--px', cfg.px)
    if (cfg.tdMode) args.push('--tdMode', cfg.tdMode)

    const result = runATK(args, true) as Array<{ ordId: string; sCode: string; sMsg: string }>
    if (!result?.[0]) throw new Error('No response from spot place')
    if (result[0].sCode !== '0') throw new Error(`Spot order error: ${result[0].sMsg}`)
    return result[0].ordId
  },

  /** Cancel a pending spot order */
  cancel(instId: string, ordId: string): void {
    runATK(['spot', 'cancel', instId, '--ordId', ordId], true)
  },

  /** Amend a pending spot order */
  amend(instId: string, ordId: string, newSz?: string, newPx?: string): void {
    const args = ['spot', 'amend', '--instId', instId, '--ordId', ordId]
    if (newSz) args.push('--newSz', newSz)
    if (newPx) args.push('--newPx', newPx)
    runATK(args, true)
  },

  /** Get open or historical spot orders */
  orders(instId?: string, history = false): SpotOrder[] {
    const args = ['spot', 'orders']
    if (instId) args.push('--instId', instId)
    if (history) args.push('--history')
    const result = runATK(args, true) as Array<Record<string, string>> | null
    if (!result) return []
    return result.map(r => ({
      ordId:   r.ordId,
      instId:  r.instId,
      side:    r.side,
      ordType: r.ordType,
      sz:      r.sz,
      px:      r.px ?? '0',
      state:   r.state,
      fillSz:  r.fillSz ?? '0',
      fillPx:  r.fillPx ?? '0',
      avgPx:   r.avgPx ?? '0',
    }))
  },

  /** Get trade fill history */
  fills(instId?: string, ordId?: string): Array<{ ordId: string; fillPx: string; fillSz: string; side: string; fee: string }> {
    const args = ['spot', 'fills']
    if (instId) args.push('--instId', instId)
    if (ordId) args.push('--ordId', ordId)
    const result = runATK(args, true) as Array<Record<string, string>> | null
    return (result ?? []).map(r => ({
      ordId:  r.ordId ?? '',
      fillPx: r.fillPx ?? '0',
      fillSz: r.fillSz ?? '0',
      side:   r.side,
      fee:    r.fee ?? '0',
    }))
  },

  /** Place a spot algo order (TP/SL or OCO) */
  algoPlace(cfg: SpotAlgoConfig): string {
    const args = [
      'spot', 'algo', 'place',
      '--instId', cfg.instId,
      '--side',   cfg.side,
      '--sz',     cfg.sz,
    ]
    if (cfg.ordType)     args.push('--ordType', cfg.ordType)
    if (cfg.tpTriggerPx) args.push('--tpTriggerPx', cfg.tpTriggerPx)
    if (cfg.tpOrdPx)     args.push('--tpOrdPx', cfg.tpOrdPx)
    if (cfg.slTriggerPx) args.push('--slTriggerPx', cfg.slTriggerPx)
    if (cfg.slOrdPx)     args.push('--slOrdPx', cfg.slOrdPx)
    if (cfg.tdMode)      args.push('--tdMode', cfg.tdMode)

    const result = runATK(args, true) as Array<{ algoId: string; sCode: string; sMsg: string }>
    if (!result?.[0]) throw new Error('No response from spot algo place')
    if (result[0].sCode !== '0') throw new Error(`Spot algo error: ${result[0].sMsg}`)
    return result[0].algoId
  },

  /** Cancel a spot algo order */
  algoCancel(instId: string, algoId: string): void {
    runATK(['spot', 'algo', 'cancel', '--instId', instId, '--algoId', algoId], true)
  },
}
