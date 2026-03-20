/**
 * ATK Swap (Perpetual) Trading layer — authenticated
 *
 * Wraps the ATK CLI `swap` module:
 *   swap place      — open a perpetual swap position
 *   swap close      — close a position
 *   swap leverage   — set leverage
 *   swap positions  — get open positions
 *   swap algo trail — place a trailing stop
 *   swap algo place — TP/SL/OCO conditional orders
 */

import { runATK } from './runner.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SwapOrderConfig {
  instId:    string
  side:      'buy' | 'sell'
  ordType:   'market' | 'limit' | 'post_only'
  sz:        string        // size in contracts
  px?:       string        // price (limit only)
  tdMode?:   'cross' | 'isolated'
  posSide?:  'net' | 'long' | 'short'
  reduceOnly?: boolean
}

export interface SwapTrailingStopConfig {
  instId:        string
  side:          'buy' | 'sell'
  sz:            string
  callbackRatio: string     // e.g. "0.03" for 3% trailing
  activePx?:     string     // activation price
  posSide?:      'net' | 'long' | 'short'
  tdMode?:       'cross' | 'isolated'
  reduceOnly?:   boolean
}

export interface SwapAlgoConfig {
  instId:      string
  side:        'buy' | 'sell'
  sz:          string
  ordType?:    'conditional' | 'oco'
  tpTriggerPx?: string
  tpOrdPx?:    string
  slTriggerPx?: string
  slOrdPx?:    string
  posSide?:    'net' | 'long' | 'short'
  tdMode?:     'cross' | 'isolated'
  reduceOnly?: boolean
}

export interface SwapPosition {
  instId:   string
  posSide:  string
  pos:      string        // position size
  avgPx:    string        // average entry price
  upl:      string        // unrealised P&L
  uplRatio: string
  lever:    string
  mgnMode:  string
  liqPx?:   string        // liquidation price
  markPx?:  string        // mark price
  last?:    string        // last traded price
}

export interface SwapLeverageSetting {
  instId:   string
  lever:    string
  mgnMode:  string
  posSide:  string
}

// ── Swap client ──────────────────────────────────────────────────────────────

export const swapClient = {

  /** Place a perpetual swap order */
  place(cfg: SwapOrderConfig): string {
    const args = [
      'swap', 'place',
      '--instId',  cfg.instId,
      '--side',    cfg.side,
      '--ordType', cfg.ordType,
      '--sz',      cfg.sz,
    ]
    if (cfg.px)        args.push('--px', cfg.px)
    if (cfg.tdMode)    args.push('--tdMode', cfg.tdMode)
    if (cfg.posSide)   args.push('--posSide', cfg.posSide)
    if (cfg.reduceOnly) args.push('--reduceOnly')

    const result = runATK(args, true) as Array<{ ordId: string; sCode: string; sMsg: string }>
    if (!result?.[0]) throw new Error('No response from swap place')
    if (result[0].sCode !== '0') throw new Error(`Swap order error: ${result[0].sMsg}`)
    return result[0].ordId
  },

  /** Close a swap position */
  close(instId: string, mgnMode: 'cross' | 'isolated' = 'cross', posSide?: string): void {
    const args = ['swap', 'close', '--instId', instId, '--mgnMode', mgnMode]
    if (posSide) args.push('--posSide', posSide)
    runATK(args, true)
  },

  /** Cancel a pending swap order */
  cancel(instId: string, ordId: string): void {
    runATK(['swap', 'cancel', instId, '--ordId', ordId], true)
  },

  /** Set leverage for a swap instrument */
  setLeverage(
    instId: string,
    lever: number,
    mgnMode: 'cross' | 'isolated' = 'cross',
    posSide?: 'net' | 'long' | 'short',
  ): void {
    const args = [
      'swap', 'leverage',
      '--instId', instId,
      '--lever', String(lever),
      '--mgnMode', mgnMode,
    ]
    if (posSide) args.push('--posSide', posSide)
    runATK(args, true)
  },

  /** Get current leverage setting(s) for a swap instrument */
  getLeverage(instId: string, mgnMode: 'cross' | 'isolated' = 'cross'): SwapLeverageSetting[] {
    const result = runATK([
      'swap', 'get-leverage',
      '--instId', instId,
      '--mgnMode', mgnMode,
    ], true) as Array<Record<string, string>> | null

    return (result ?? []).map(r => ({
      instId:  r.instId,
      lever:   r.lever ?? '1',
      mgnMode: r.mgnMode ?? mgnMode,
      posSide: r.posSide ?? '',
    }))
  },

  /** Whether the current leverage already matches the target */
  leverageMatches(
    instId: string,
    lever: number,
    mgnMode: 'cross' | 'isolated' = 'cross',
    posSide?: 'net' | 'long' | 'short',
  ): boolean {
    const target = String(lever)
    const settings = this.getLeverage(instId, mgnMode)
    if (settings.length === 0) return false
    if (posSide) {
      return settings.some(s => s.posSide === posSide && s.lever === target)
    }
    return settings.every(s => s.lever === target)
  },

  /** Get current swap positions */
  positions(instId?: string): SwapPosition[] {
    const args = ['swap', 'positions']
    if (instId) args.push(instId)
    const result = runATK(args, true) as Array<Record<string, string>> | null
    if (!result) return []
    return result.map(r => ({
      instId:   r.instId,
      posSide:  r.posSide,
      pos:      r.pos ?? '0',
      avgPx:    r.avgPx ?? '0',
      upl:      r.upl ?? '0',
      uplRatio: r.uplRatio ?? '0',
      lever:    r.lever ?? '1',
      mgnMode:  r.mgnMode ?? 'cross',
      liqPx:    r.liqPx,
      markPx:   r.markPx,
      last:     r.last,
    }))
  },

  /** Place a trailing stop algo order */
  trailingStop(cfg: SwapTrailingStopConfig): string {
    const args = [
      'swap', 'algo', 'trail',
      '--instId',        cfg.instId,
      '--side',          cfg.side,
      '--sz',            cfg.sz,
      '--callbackRatio', cfg.callbackRatio,
    ]
    if (cfg.activePx)   args.push('--activePx', cfg.activePx)
    if (cfg.posSide)    args.push('--posSide', cfg.posSide)
    if (cfg.tdMode)     args.push('--tdMode', cfg.tdMode)
    if (cfg.reduceOnly) args.push('--reduceOnly')

    const result = runATK(args, true) as Array<{ algoId: string; sCode: string; sMsg: string }>
    if (!result?.[0]) throw new Error('No response from swap trailing stop')
    if (result[0].sCode !== '0') throw new Error(`Trailing stop error: ${result[0].sMsg}`)
    return result[0].algoId
  },

  /** Place a TP/SL or OCO algo order on swap */
  algoPlace(cfg: SwapAlgoConfig): string {
    const args = [
      'swap', 'algo', 'place',
      '--instId', cfg.instId,
      '--side',   cfg.side,
      '--sz',     cfg.sz,
    ]
    if (cfg.ordType)     args.push('--ordType', cfg.ordType)
    if (cfg.tpTriggerPx) args.push('--tpTriggerPx', cfg.tpTriggerPx)
    if (cfg.tpOrdPx)     args.push('--tpOrdPx', cfg.tpOrdPx)
    if (cfg.slTriggerPx) args.push('--slTriggerPx', cfg.slTriggerPx)
    if (cfg.slOrdPx)     args.push('--slOrdPx', cfg.slOrdPx)
    if (cfg.posSide)     args.push('--posSide', cfg.posSide)
    if (cfg.tdMode)      args.push('--tdMode', cfg.tdMode)
    if (cfg.reduceOnly)  args.push('--reduceOnly')

    const result = runATK(args, true) as Array<{ algoId: string; sCode: string; sMsg: string }>
    if (!result?.[0]) throw new Error('No response from swap algo place')
    if (result[0].sCode !== '0') throw new Error(`Swap algo error: ${result[0].sMsg}`)
    return result[0].algoId
  },

  /** Cancel a swap algo order */
  algoCancel(instId: string, algoId: string): void {
    runATK(['swap', 'algo', 'cancel', '--instId', instId, '--algoId', algoId], true)
  },

  /** Cancel all pending swap algo orders for an instrument. Returns cancel count. */
  clearAlgoOrders(instId?: string): number {
    const orders = this.algoOrders(instId)
    let cancelled = 0
    for (const o of orders) {
      try {
        this.algoCancel(o.instId, o.algoId)
        cancelled++
      } catch {
        // Ignore individual cancel errors so we can try the rest.
      }
    }
    return cancelled
  },

  /** Get swap order history */
  orders(instId?: string, history = false): Array<Record<string, string>> {
    const args = ['swap', 'orders']
    if (instId) args.push('--instId', instId)
    if (history) args.push('--history')
    return (runATK(args, true) as Array<Record<string, string>> | null) ?? []
  },

  /** List pending swap algo orders (trailing stops, TP/SL) */
  algoOrders(instId?: string): Array<{ algoId: string; instId: string }> {
    const args = ['swap', 'algo', 'orders']
    if (instId) args.push('--instId', instId)
    const result = runATK(args, true) as Array<Record<string, string>> | null
    return (result ?? []).map(r => ({ algoId: r.algoId, instId: r.instId }))
  },
}
