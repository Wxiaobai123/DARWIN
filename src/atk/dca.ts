/**
 * ATK DCA (Martingale) Bot layer — authenticated
 *
 * Wraps the ATK CLI `bot dca` module:
 *   bot dca create      — create a DCA/Martingale bot
 *   bot dca stop        — stop a running bot
 *   bot dca orders      — list active/historical bots
 *   bot dca details     — get bot details
 *   bot dca sub-orders  — get cycle/order details
 */

import { runATK } from './runner.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DCABotConfig {
  instId:         string
  lever:          number           // leverage (e.g. 5)
  direction:      'long' | 'short'
  initOrdAmt:     number           // initial order amount USDT
  maxSafetyOrds:  number           // max safety orders (0 = no averaging)
  tpPct:          number           // take-profit percentage (e.g. 2.5)

  // Required when maxSafetyOrds > 0
  safetyOrdAmt?:  number           // safety order amount USDT
  pxSteps?:       number           // price deviation % between safety orders
  pxStepsMult?:   number           // multiplier for price steps (e.g. 1.5)
  volMult?:       number           // volume multiplier per safety order (e.g. 2)

  // Optional
  slPct?:         number           // stop-loss percentage
  slMode?:        'limit' | 'market'
  triggerStrategy?: 'instant' | 'price' | 'rsi'
  triggerPx?:     number           // trigger price (for price trigger)
}

export interface DCABotStatus {
  algoId:       string
  instId:       string
  state:        string
  direction:    string
  lever:        string
  pnl:          string
  pnlRatio:     string
  curCycleCnt:  string
}

// ── DCA Bot client ───────────────────────────────────────────────────────────

export const dcaClient = {

  /** Create a new DCA/Martingale bot */
  create(cfg: DCABotConfig): string {
    const args = [
      'bot', 'dca', 'create',
      '--instId',       cfg.instId,
      '--lever',        String(cfg.lever),
      '--direction',    cfg.direction,
      '--initOrdAmt',   String(cfg.initOrdAmt),
      '--maxSafetyOrds', String(cfg.maxSafetyOrds),
      '--tpPct',        String(cfg.tpPct),
    ]

    // Safety order params (required when maxSafetyOrds > 0)
    if (cfg.maxSafetyOrds > 0) {
      if (cfg.safetyOrdAmt != null) args.push('--safetyOrdAmt', String(cfg.safetyOrdAmt))
      if (cfg.pxSteps != null)      args.push('--pxSteps', String(cfg.pxSteps))
      if (cfg.pxStepsMult != null)  args.push('--pxStepsMult', String(cfg.pxStepsMult))
      if (cfg.volMult != null)      args.push('--volMult', String(cfg.volMult))
    }

    // Optional risk params
    if (cfg.slPct != null)           args.push('--slPct', String(cfg.slPct))
    if (cfg.slMode)                  args.push('--slMode', cfg.slMode)
    if (cfg.triggerStrategy)         args.push('--triggerStrategy', cfg.triggerStrategy)
    if (cfg.triggerPx != null)       args.push('--triggerPx', String(cfg.triggerPx))

    const result = runATK(args, true) as Array<{ algoId: string; sCode: string; sMsg: string }>
    if (!result?.[0]) throw new Error('No response from DCA create')
    if (result[0].sCode !== '0') throw new Error(`DCA bot error: ${result[0].sMsg}`)
    return result[0].algoId
  },

  /** Stop a running DCA bot */
  stop(algoId: string): void {
    runATK(['bot', 'dca', 'stop', '--algoId', algoId], true)
  },

  /** List active or historical DCA bots */
  list(history = false): DCABotStatus[] {
    const args = ['bot', 'dca', 'orders']
    if (history) args.push('--history')
    const result = runATK(args, true) as Array<Record<string, string>> | null
    if (!result) return []
    return result.map(r => ({
      algoId:      r.algoId,
      instId:      r.instId,
      state:       r.state,
      direction:   r.direction,
      lever:       r.lever ?? '1',
      pnl:         r.pnl ?? '0',
      pnlRatio:    r.pnlRatio ?? '0',
      curCycleCnt: r.curCycleCnt ?? '0',
    }))
  },

  /** Get details of a specific DCA bot */
  details(algoId: string): DCABotStatus | null {
    try {
      const result = runATK([
        'bot', 'dca', 'details', '--algoId', algoId,
      ], true) as Array<Record<string, string>> | null
      if (!result?.[0]) return null
      const r = result[0]
      return {
        algoId:      r.algoId,
        instId:      r.instId,
        state:       r.state,
        direction:   r.direction,
        lever:       r.lever ?? '1',
        pnl:         r.pnl ?? '0',
        pnlRatio:    r.pnlRatio ?? '0',
        curCycleCnt: r.curCycleCnt ?? '0',
      }
    } catch {
      return null
    }
  },

  /** Get sub-orders (cycles) for a DCA bot */
  subOrders(algoId: string, cycleId?: string): Array<Record<string, string>> {
    const args = ['bot', 'dca', 'sub-orders', '--algoId', algoId]
    if (cycleId) args.push('--cycleId', cycleId)
    return (runATK(args, true) as Array<Record<string, string>> | null) ?? []
  },
}
