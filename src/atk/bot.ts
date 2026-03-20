/**
 * ATK Bot layer — Grid bot management (authenticated)
 *
 * Supports both spot grid and contract grid:
 *
 *   Spot grid (algoOrdType = "grid"):
 *     - instId: BTC-USDT (spot pair)
 *     - quoteSz: total USDT to deploy
 *     - No leverage, no direction
 *
 *   Contract grid (algoOrdType = "contract_grid"):
 *     - instId: BTC-USDT-SWAP (perpetual swap)
 *     - direction: long | short | neutral
 *     - lever: leverage multiplier
 *     - sz: contract size
 *     - basePos: open base position at creation (default true)
 *
 *   Moon grid (algoOrdType = "moon_grid"):
 *     - Geometric grid optimized for trending markets
 */

import { runATK } from './runner.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export type GridType = 'grid' | 'contract_grid' | 'moon_grid'

export interface GridBotConfig {
  instId:        string
  algoOrdType?:  GridType        // default: 'grid' (spot)
  maxPx:         number
  minPx:         number
  gridNum:       number

  // Spot grid params
  quoteSz?:      number           // total USDT to deploy (spot grid)
  baseSz?:       number           // base currency size (alternative to quoteSz)

  // Contract grid params
  direction?:    'long' | 'short' | 'neutral'   // contract grid only
  lever?:        number                          // leverage (contract grid only)
  sz?:           number                          // contract size (contract grid only)
  basePos?:      boolean                         // open base position (default true for contract)

  // Optional
  runType?:      1 | 2           // 1 = arithmetic, 2 = geometric
}

export interface GridBotStatus {
  algoId:      string
  instId:      string
  algoOrdType: string
  state:       string
  direction:   string
  lever:       string
  pnlRatio:    number
  totalPnl:    number
  gridNum:     number
  maxPx:       number
  minPx:       number
  runDuration: number
  filledGrids: number
}

// ── Bot client ────────────────────────────────────────────────────────────────

export const botClient = {

  /** Create a grid bot (spot or contract) */
  create(cfg: GridBotConfig): string {
    const type = cfg.algoOrdType ?? 'grid'

    const args = [
      'bot', 'grid', 'create',
      '--instId',      cfg.instId,
      '--algoOrdType', type,
      '--maxPx',       String(cfg.maxPx),
      '--minPx',       String(cfg.minPx),
      '--gridNum',     String(cfg.gridNum),
    ]

    // Spot grid sizing
    if (cfg.quoteSz != null)  args.push('--quoteSz', String(cfg.quoteSz))
    if (cfg.baseSz != null)   args.push('--baseSz', String(cfg.baseSz))

    // Contract grid params
    if (type === 'contract_grid') {
      if (cfg.direction) args.push('--direction', cfg.direction)
      if (cfg.lever)     args.push('--lever', String(cfg.lever))
      if (cfg.sz)        args.push('--sz', String(cfg.sz))
      if (cfg.basePos === false) args.push('--no-basePos')
    }

    // Optional
    if (cfg.runType) args.push('--runType', String(cfg.runType))

    const result = runATK(args, true) as Array<{ algoId: string; sCode: string; sMsg: string }>
    if (!result?.[0]) throw new Error('No response from grid create')
    if (result[0].sCode !== '0') throw new Error(`Grid create error: ${result[0].sMsg}`)
    return result[0].algoId
  },

  /** List active grid bots (pass type to filter) */
  list(algoOrdType: GridType = 'grid'): Array<{ algoId: string; instId: string; state: string }> {
    const result = runATK([
      'bot', 'grid', 'orders', '--algoOrdType', algoOrdType,
    ], true) as Array<Record<string, string>> | null
    if (!result) return []
    return result.map(r => ({
      algoId: r.algoId,
      instId: r.instId,
      state:  r.state,
    }))
  },

  /** List ALL active grid bots (spot + contract) */
  listAll(): Array<{ algoId: string; instId: string; state: string; type: GridType }> {
    const types: GridType[] = ['grid', 'contract_grid']
    const all: Array<{ algoId: string; instId: string; state: string; type: GridType }> = []
    for (const t of types) {
      try {
        const bots = this.list(t)
        all.push(...bots.map(b => ({ ...b, type: t })))
      } catch {}
    }
    return all
  },

  /** Get details of a specific grid bot */
  details(algoId: string, algoOrdType: GridType = 'grid'): GridBotStatus | null {
    // Try the given type first, then fallback to other types
    const typesToTry = [algoOrdType, ...(['grid', 'contract_grid'] as GridType[]).filter(t => t !== algoOrdType)]

    for (const type of typesToTry) {
      try {
        const result = runATK([
          'bot', 'grid', 'details',
          '--algoOrdType', type,
          '--algoId',      algoId,
        ], true) as Array<Record<string, string>> | null
        if (!result?.[0]) continue
        const r = result[0]
        return {
          algoId:      r.algoId,
          instId:      r.instId,
          algoOrdType: r.algoOrdType ?? type,
          state:       r.state,
          direction:   r.direction ?? 'neutral',
          lever:       r.lever ?? '1',
          pnlRatio:    parseFloat(r.pnlRatio  ?? '0'),
          totalPnl:    parseFloat(r.totalPnl  ?? '0'),
          gridNum:     parseInt(r.gridNum     ?? '0'),
          maxPx:       parseFloat(r.maxPx     ?? '0'),
          minPx:       parseFloat(r.minPx     ?? '0'),
          runDuration: parseInt(r.runDuration ?? '0'),
          filledGrids: parseInt(r.filledGrids ?? '0'),
        }
      } catch {
        continue
      }
    }
    return null
  },

  /** Get sub-orders (fills) for a grid bot */
  subOrders(algoId: string, algoOrdType: GridType = 'grid'): Array<{ side: string; fillPx: string; fillSz: string; pnl: string }> {
    // Try both types if needed
    const typesToTry = [algoOrdType, ...(['grid', 'contract_grid'] as GridType[]).filter(t => t !== algoOrdType)]

    for (const type of typesToTry) {
      try {
        const result = runATK([
          'bot', 'grid', 'sub-orders',
          '--algoOrdType', type,
          '--algoId',      algoId,
          '--live',
        ], true) as Array<Record<string, string>> | null
        if (result && result.length > 0) {
          return result.map(r => ({
            side:   r.side,
            fillPx: r.fillPx,
            fillSz: r.fillSz,
            pnl:    r.pnl ?? '0',
          }))
        }
      } catch {
        continue
      }
    }
    return []
  },

  /** Stop a running grid bot */
  stop(algoId: string, instId: string, algoOrdType: GridType = 'grid', stopType: '1' | '2' | '3' = '1'): void {
    // Try both types if needed
    const typesToTry = [algoOrdType, ...(['grid', 'contract_grid'] as GridType[]).filter(t => t !== algoOrdType)]

    for (const type of typesToTry) {
      try {
        runATK([
          'bot', 'grid', 'stop',
          '--algoId',      algoId,
          '--algoOrdType', type,
          '--instId',      instId,
          '--stopType',    stopType,
        ], true)
        return // success
      } catch {
        continue
      }
    }
  },
}
