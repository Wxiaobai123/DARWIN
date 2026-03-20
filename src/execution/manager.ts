/**
 * DARWIN Execution Manager
 *
 * Monitors active positions and enforces per-strategy risk parameters:
 *   • stop_loss_pct    — close position if P&L drops below threshold
 *   • take_profit_pct  — close position to lock in gains
 *   • max_hold_hours   — close position after time limit
 *   • max_position_usdt — prevent over-sized entries
 *
 * Also provides emergency close for circuit breaker T3/T4.
 *
 * Called from the risk heartbeat (every 5 min).
 */

import { botClient } from '../atk/bot.js'
import { dcaClient } from '../atk/dca.js'
import { swapClient } from '../atk/swap.js'
import { getActiveBots, getBotType, stopShadowBot } from '../shadow/runner.js'
import { isAssetBlocked, isStrategyBlocked } from '../risk/circuit-breaker.js'
import { getStrategy, setStrategyStatus, type StrategyRecord } from '../strategy/archive.js'
import { tickRecurringBuy, type RecurringBuyConfig } from './recurring-buy.js'
import { shouldCloseArb, type FundingArbConfig } from './arb-funding.js'
import { tickTWAP, tickIceberg, isTWAPComplete, type TWAPConfig, type IcebergConfig } from './twap.js'
import db from '../db.js'
import { toSwapId } from '../config.js'
import type { MarketState } from '../market/state-recognizer.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PositionCheck {
  strategyId: string
  name:       string
  action:     'stop_loss' | 'take_profit' | 'max_hold' | 'atr_out_of_range' | 'funding_out_of_range' | 'loss_pause' | 'ok'
  detail:     string
  pnlPct?:    number
}

export interface MonitorResult {
  checked:  number
  closed:   PositionCheck[]
  healthy:  number
}

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const _C  = { reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m', cyan:'\x1b[36m', green:'\x1b[32m', yellow:'\x1b[33m', red:'\x1b[31m' }
const _b  = (s: string) => `${_C.bold}${s}${_C.reset}`
const _gn = (s: string) => `${_C.green}${s}${_C.reset}`
const _yw = (s: string) => `${_C.yellow}${s}${_C.reset}`
const _rd = (s: string) => `${_C.red}${s}${_C.reset}`
const _dm = (s: string) => `${_C.dim}${s}${_C.reset}`

// ── Position monitoring (called every risk tick) ──────────────────────────────

export function monitorPositions(): MonitorResult {
  const activeBots = getActiveBots()
  const closed: PositionCheck[] = []
  let healthy = 0

  for (const [strategyId, algoId] of activeBots) {
    // Skip sentinel monitor entries
    if (algoId.startsWith('monitor_')) continue

    const rec = getStrategy(strategyId)
    if (!rec) continue

    const spec = rec.spec
    const asset = spec.conditions?.assets?.[0] ?? ''

    // Circuit breaker gate — close blocked strategies
    if (isStrategyBlocked(strategyId) || isAssetBlocked(asset)) {
      try {
        stopShadowBot(strategyId)
        closed.push({
          strategyId, name: rec.name, action: 'stop_loss',
          detail: `Circuit breaker — ${isStrategyBlocked(strategyId) ? 'strategy' : 'asset'} blocked`,
        })
      } catch {}
      continue
    }

    // ── Max hold hours check (no API call needed) ──────────────────────────
    if (spec.execution.max_hold_hours != null) {
      const botRow = db.prepare(
        'SELECT started_at FROM shadow_bots WHERE strategy_id = ? AND stopped_at IS NULL ORDER BY started_at DESC LIMIT 1'
      ).get(strategyId) as { started_at: string } | undefined

      if (botRow) {
        const startedAt = new Date(botRow.started_at).getTime()
        const hoursElapsed = (Date.now() - startedAt) / (3_600_000)

        if (hoursElapsed > spec.execution.max_hold_hours) {
          const check: PositionCheck = {
            strategyId, name: rec.name, action: 'max_hold',
            detail: `${hoursElapsed.toFixed(1)}h > limit ${spec.execution.max_hold_hours}h`,
          }
          executeClose(strategyId, rec, 'paused')
          closed.push(check)
          logExecution(check)
          continue
        }
      }
    }

    // ── Recurring buy tick (runs every risk heartbeat, self-throttles) ─────
    const botType = getBotType(algoId)

    if (botType === 'recurring') {
      try {
        const p = spec.execution.params
        const asset = spec.conditions.assets[0]
        const cfg: RecurringBuyConfig = {
          instId:        asset,
          amountUsdt:    (p.order_amount_usdt as number) ?? 50,
          intervalHours: (p.interval_hours as number) ?? 24,
          skipRsiAbove:  (p.skip_rsi_above as number) ?? undefined,
          maxBuys:       (p.max_buys as number) ?? undefined,
        }
        tickRecurringBuy(strategyId, cfg)
      } catch {}
      healthy++
      continue
    }

    // ── Funding arb monitoring (auto-close when funding drops) ────────────
    if (botType === 'arb') {
      try {
        const p = spec.execution.params
        const asset = spec.conditions.assets[0]
        const swapId = toSwapId(asset)
        const cfg: FundingArbConfig = {
          spotInstId:    asset,
          swapInstId:    swapId,
          amountUsdt:    (p.order_amount_usdt as number) ?? 100,
          lever:         (p.lever as number) ?? 2,
          minAnnualPct:  (p.min_annual_pct as number) ?? 15,
          exitAnnualPct: (p.exit_annual_pct as number) ?? 5,
        }
        const arbCheck = shouldCloseArb(strategyId, cfg)
        if (arbCheck.shouldClose) {
          const check: PositionCheck = {
            strategyId, name: rec.name, action: 'funding_out_of_range',
            detail: arbCheck.reason,
          }
          executeClose(strategyId, rec, 'paused')
          closed.push(check)
          logExecution(check)
          continue
        }
      } catch {}
      healthy++
      continue
    }

    // ── TWAP/Iceberg tick (execute next slice) ───────────────────────────
    if (botType === 'twap') {
      try {
        const p = spec.execution.params
        const asset = spec.conditions.assets[0]
        const tool = spec.execution.tool
        const useSwap = (p.use_swap as boolean) ?? false
        const instId = useSwap ? toSwapId(asset) : asset

        if (tool === 'okx_iceberg') {
          const cfg: IcebergConfig = {
            instId,
            side:              (p.direction as 'buy' | 'sell') ?? 'buy',
            totalAmountUsdt:   (p.total_amount_usdt as number) ?? 500,
            visibleAmountUsdt: (p.visible_amount_usdt as number) ?? 50,
            priceOffset:       (p.price_offset_pct as number) ?? 0.1,
            useSwap,
            lever:             (p.lever as number) ?? undefined,
          }
          tickIceberg(strategyId, cfg)
        } else {
          const cfg: TWAPConfig = {
            instId,
            side:            (p.direction as 'buy' | 'sell') ?? 'buy',
            totalAmountUsdt: (p.total_amount_usdt as number) ?? 500,
            slices:          (p.slices as number) ?? 10,
            intervalMinutes: (p.interval_minutes as number) ?? 5,
            useSwap,
            lever:           (p.lever as number) ?? undefined,
            maxSlippage:     (p.max_slippage_pct as number) ?? undefined,
          }
          tickTWAP(strategyId, cfg)
        }

        // Auto-close when all slices are done
        if (isTWAPComplete(strategyId)) {
          const check: PositionCheck = {
            strategyId, name: rec.name, action: 'take_profit',
            detail: `TWAP/冰山委托已全部成交`,
          }
          executeClose(strategyId, rec, 'shadow')
          closed.push(check)
          logExecution(check)
          continue
        }
      } catch {}
      healthy++
      continue
    }

    // ── P&L-based checks (tool-aware) ──────────────────────────────────────
    let pnlPct = 0
    let hasPnlData = false

    try {
      const deployedEstimate = estimateDeployed(rec)

      if (botType === 'grid') {
        const status = botClient.details(algoId, 'grid')
        if (status) {
          pnlPct = deployedEstimate > 0 ? (status.totalPnl / deployedEstimate) * 100 : 0
          hasPnlData = true
        } else {
          // Bot not found on exchange — likely expired or cancelled
          // Keep strategy in current status (shadow/live) so recovery restarts it
          console.warn(`  [Execution] Grid bot ${algoId} not found — cleaning up stale reference`)
          try { stopShadowBot(strategyId) } catch {}
          closed.push({ strategyId, name: rec.name, action: 'stop_loss', detail: 'Bot expired on exchange — will be restarted' })
          continue
        }
      } else if (botType === 'contract_grid') {
        const status = botClient.details(algoId.slice(6), 'contract_grid')
        if (status) {
          pnlPct = deployedEstimate > 0 ? (status.totalPnl / deployedEstimate) * 100 : 0
          hasPnlData = true
        } else {
          console.warn(`  [Execution] Contract grid ${algoId} not found — cleaning up stale reference`)
          try { stopShadowBot(strategyId) } catch {}
          closed.push({ strategyId, name: rec.name, action: 'stop_loss', detail: 'Bot expired on exchange — will be restarted' })
          continue
        }
      } else if (botType === 'dca') {
        const status = dcaClient.details(algoId.slice(4))
        if (status) {
          const pnl = parseFloat(status.pnl)
          pnlPct = deployedEstimate > 0 ? (pnl / deployedEstimate) * 100 : 0
          hasPnlData = true
        } else {
          console.warn(`  [Execution] DCA bot ${algoId} not found — cleaning up stale reference`)
          try { stopShadowBot(strategyId) } catch {}
          closed.push({ strategyId, name: rec.name, action: 'stop_loss', detail: 'Bot expired on exchange — will be restarted' })
          continue
        }
      } else if (botType === 'swap') {
        const asset  = rec.spec.conditions.assets[0]
        const swapId = toSwapId(asset)
        const positions = swapClient.positions(swapId)
        if (positions.length > 0) {
          const pos = positions[0]
          const upl = parseFloat(pos.upl)
          pnlPct = deployedEstimate > 0 ? (upl / deployedEstimate) * 100 : 0
          hasPnlData = true

          // Liquidation price proximity check — close if mark price within 5% of liqPx
          const liqPx  = parseFloat(pos.liqPx || '0')
          const markPx = parseFloat(pos.markPx || pos.last || '0')
          if (liqPx > 0 && markPx > 0) {
            const distToLiq = Math.abs(markPx - liqPx) / markPx
            if (distToLiq < 0.05) {
              const check: PositionCheck = {
                strategyId, name: rec.name, action: 'stop_loss',
                detail: `Liquidation risk: mark=$${markPx.toFixed(2)} liq=$${liqPx.toFixed(2)} (${(distToLiq*100).toFixed(1)}% gap)`,
                pnlPct,
              }
              console.error(`  [Execution] ⚠️ LIQUIDATION WARNING: ${rec.name} — closing immediately`)
              executeClose(strategyId, rec, 'paused')
              closed.push(check)
              logExecution(check)
              continue
            }
          }
        }
      }
      // spot — limited P&L tracking, skip
    } catch {
      // API unavailable — skip P&L checks but don't close
    }

    if (hasPnlData) {

      // Take profit (check first — it's the desirable outcome)
      if (spec.risk.take_profit_pct != null && pnlPct >= spec.risk.take_profit_pct) {
        const check: PositionCheck = {
          strategyId, name: rec.name, action: 'take_profit',
          detail: `P&L ${pnlPct.toFixed(2)}% >= +${spec.risk.take_profit_pct}%`,
          pnlPct,
        }
        // Take profit = success — pause for re-entry, don't demote
        executeClose(strategyId, rec, 'shadow')
        closed.push(check)
        logExecution(check)
        continue
      }

      // Stop loss
      if (spec.risk.stop_loss_pct != null && pnlPct <= -spec.risk.stop_loss_pct) {
        const check: PositionCheck = {
          strategyId, name: rec.name, action: 'stop_loss',
          detail: `P&L ${pnlPct.toFixed(2)}% <= -${spec.risk.stop_loss_pct}%`,
          pnlPct,
        }
        executeClose(strategyId, rec, 'paused')
        closed.push(check)
        logExecution(check)
        continue
      }
    }

    // ── Pause after loss days ──────────────────────────────────────────────
    if (spec.risk.pause_after_loss_days != null && rec.status === 'live') {
      const lossDays = spec.risk.pause_after_loss_days
      try {
        const rows = db.prepare(`
          SELECT total_return FROM strategy_performance
          WHERE strategy_id = ?
          ORDER BY last_updated DESC LIMIT ?
        `).all(strategyId, lossDays) as Array<{ total_return: number }>

        if (rows.length >= lossDays && rows.every(r => r.total_return < 0)) {
          const check: PositionCheck = {
            strategyId, name: rec.name, action: 'loss_pause',
            detail: `连续${lossDays}期亏损 — 自动暂停`,
          }
          executeClose(strategyId, rec, 'paused')
          closed.push(check)
          logExecution(check)
          continue
        }
      } catch {}
    }

    healthy++
  }

  return { checked: activeBots.size, closed, healthy }
}

// ── Entry condition checker ──────────────────────────────────────────────────
//
// Called before starting a shadow bot or activating a strategy.
// Checks ATR ratio, funding rate conditions from the strategy YAML.

export function checkEntryConditions(
  strategyId: string,
  atrRatio:    number,
  fundingRate: number,
): { allowed: boolean; reason: string } {
  const rec = getStrategy(strategyId)
  if (!rec) return { allowed: false, reason: '策略未找到' }

  const spec = rec.spec

  // ATR ratio bounds
  if (spec.conditions.min_atr_ratio != null && atrRatio < spec.conditions.min_atr_ratio)
    return { allowed: false, reason: `ATR ${atrRatio.toFixed(2)}x < 最小值 ${spec.conditions.min_atr_ratio}` }

  if (spec.conditions.max_atr_ratio != null && atrRatio > spec.conditions.max_atr_ratio)
    return { allowed: false, reason: `ATR ${atrRatio.toFixed(2)}x > 最大值 ${spec.conditions.max_atr_ratio}` }

  // Funding rate bounds
  if (spec.conditions.min_funding_rate != null && fundingRate < spec.conditions.min_funding_rate)
    return { allowed: false, reason: `费率 ${(fundingRate * 100).toFixed(4)}% < 最小值 ${(spec.conditions.min_funding_rate * 100).toFixed(4)}%` }

  if (spec.conditions.max_funding_rate != null && fundingRate > spec.conditions.max_funding_rate)
    return { allowed: false, reason: `费率 ${(fundingRate * 100).toFixed(4)}% > 最大值 ${(spec.conditions.max_funding_rate * 100).toFixed(4)}%` }

  return { allowed: true, reason: '' }
}

// ── Emergency close (called by circuit breaker T3/T4) ────────────────────────

export function closeAllPositions(reason: string): number {
  const activeBots = getActiveBots()
  let count = 0

  for (const [strategyId, algoId] of activeBots) {
    if (algoId.startsWith('monitor_')) continue
    try {
      stopShadowBot(strategyId)
      count++
    } catch (err) {
      console.warn(`  [执行] 平仓失败 ${strategyId}: ${err}`)
    }
  }

  if (count > 0) {
    console.log(`  ${_rd('⛔')} ${_b('执行管理器')}  紧急平仓: ${count} 个仓位 — ${reason}`)
    try {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS execution_events (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          strategy_id TEXT,
          action     TEXT NOT NULL,
          detail     TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `).run()
      db.prepare(
        'INSERT INTO execution_events (strategy_id, action, detail) VALUES (?, ?, ?)'
      ).run('ALL', 'emergency_close', reason)
    } catch {}
  }

  return count
}

// ── Max position cap (used by allocator) ────────────────────────────────────

export function getMaxPositionUSDT(strategyId: string): number | null {
  const rec = getStrategy(strategyId)
  if (!rec) return null
  return rec.spec.risk.max_position_usdt ?? null
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function estimateDeployed(rec: StrategyRecord): number {
  const p = rec.spec.execution.params as Record<string, unknown>
  const tool = rec.spec.execution.tool

  switch (tool) {
    case 'okx_grid_bot':
    case 'okx_grid_bot_create':
    case 'okx_contract_grid': {
      const gridCount = (p.grid_count as number) ?? 10
      const orderSize = (p.order_amount_usdt as number) ?? 10
      return gridCount * orderSize
    }
    case 'okx_dca_bot':
    case 'okx_dca_bot_create': {
      const initAmt   = (p.init_order_amt as number) ?? (p.order_amount_usdt as number) ?? 50
      const safetyN   = (p.max_safety_orders as number) ?? 3
      const safetyAmt = (p.safety_order_amt as number) ?? initAmt
      const volMult   = (p.vol_mult as number) ?? 2.0
      let total = initAmt
      let amt = safetyAmt
      for (let i = 0; i < safetyN; i++) { total += amt; amt *= volMult }
      return total
    }
    case 'okx_swap_place':
    case 'okx_swap_trailing_stop':
      return (p.order_amount_usdt as number) ?? 50
    case 'okx_spot_order':
      return (p.order_amount_usdt as number) ?? 50
    case 'okx_recurring_buy':
      return (p.order_amount_usdt as number) ?? 50
    case 'okx_funding_arb':
      // Both legs (spot + swap)
      return ((p.order_amount_usdt as number) ?? 100) * 2
    case 'okx_twap':
    case 'okx_iceberg':
      return (p.total_amount_usdt as number) ?? 500
    default:
      return 500
  }
}

function executeClose(strategyId: string, rec: StrategyRecord, newStatus: 'paused' | 'shadow' | 'demoted'): void {
  try {
    stopShadowBot(strategyId)
  } catch (err) {
    console.warn(`  [Execution] Close failed for "${rec.name}": ${err}`)
  }
  try {
    setStrategyStatus(strategyId, newStatus)
  } catch {}
}

function logExecution(check: PositionCheck): void {
  const icon = check.action === 'stop_loss'            ? _rd('⛔ STOP LOSS')
             : check.action === 'take_profit'          ? _gn('💰 TAKE PROFIT')
             : check.action === 'max_hold'             ? _yw('⏰ MAX HOLD')
             : check.action === 'loss_pause'           ? _rd('📉 LOSS PAUSE')
             : check.action === 'funding_out_of_range' ? _yw('💱 FUNDING EXIT')
             : _dm(check.action)

  console.log(`  ${icon}  "${check.name}"  ${_dm(check.detail)}`)

  try {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS execution_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        strategy_id TEXT,
        action     TEXT NOT NULL,
        detail     TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `).run()
    db.prepare(
      'INSERT INTO execution_events (strategy_id, action, detail) VALUES (?, ?, ?)'
    ).run(check.strategyId, check.action, check.detail)
  } catch {}
}

// ── Status display ───────────────────────────────────────────────────────────

export function printExecutionStatus(result: MonitorResult): void {
  if (result.closed.length === 0 && result.checked <= 0) return

  if (result.closed.length > 0) {
    console.log(`\n  ⚙️  ${_b('执行管理器')}  ${_dm(`检查 ${result.checked}`)}  ` +
      `${_rd(`平仓 ${result.closed.length}`)}  ${_gn(`健康 ${result.healthy}`)}`)
  }
}
