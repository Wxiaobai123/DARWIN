/**
 * DARWIN Daily Report Generator
 * Generates natural language summaries of the day's trading activity.
 */

import db from '../db.js'
import { getAllStrategies, getPerformance } from '../strategy/archive.js'
import { botClient } from '../atk/bot.js'
import { dcaClient } from '../atk/dca.js'
import { swapClient } from '../atk/swap.js'
import { getState } from '../risk/circuit-breaker.js'
import { getBotType } from '../shadow/runner.js'
import { toSwapId } from '../config.js'
import type { MarketState } from '../market/state-recognizer.js'

export interface DailyData {
  date:            string
  marketStates:    Record<string, MarketState>
  strategies:      Array<{
    name:       string
    status:     string
    pnl:        number
    pnlPct:     number
    trades:     number
    state:      string
  }>
  totalPnl:        number
  circuitBreakers: number[]
  promotions:      string[]
  demotions:       string[]
}

export function collectDailyData(): DailyData {
  // Use local date (not UTC) to match the user's timezone
  const now   = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

  // Get last known market states
  const stateRows = db.prepare(`
    SELECT asset, state FROM market_states
    WHERE date(recorded_at) = date('now')
    GROUP BY asset
    ORDER BY recorded_at DESC
  `).all() as Array<{ asset: string; state: MarketState }>

  const marketStates: Record<string, MarketState> = {}
  for (const r of stateRows) marketStates[r.asset] = r.state

  // Collect strategy performance
  const strategies = getAllStrategies()
  const stratData = []
  let totalPnl = 0

  for (const s of strategies) {
    if (s.status === 'eliminated') continue

    // Try to get live bot details
    const botRow = db.prepare(
      'SELECT algo_id FROM shadow_bots WHERE strategy_id = ? ORDER BY started_at DESC LIMIT 1'
    ).get(s.id) as { algo_id: string } | undefined

    let pnl = 0
    let trades = 0

    // Query OKX for real algoIds — route by bot type
    if (botRow?.algo_id && !botRow.algo_id.startsWith('monitor_')) {
      const botType = getBotType(botRow.algo_id)
      try {
        if (botType === 'grid') {
          const details = botClient.details(botRow.algo_id)
          if (details) { pnl = details.totalPnl; trades = details.filledGrids }
        } else if (botType === 'contract_grid') {
          const details = botClient.details(botRow.algo_id.slice(6), 'contract_grid')
          if (details) { pnl = details.totalPnl; trades = details.filledGrids }
        } else if (botType === 'dca') {
          const status = dcaClient.details(botRow.algo_id.slice(4))
          if (status) { pnl = parseFloat(status.pnl); trades = 1 }
        } else if (botType === 'swap') {
          const asset = s.spec.conditions.assets[0]
          const swapId = toSwapId(asset)
          const positions = swapClient.positions(swapId)
          if (positions.length > 0) { pnl = parseFloat(positions[0].upl); trades = 1 }
        }
        // spot, recurring, arb, twap — fall through to DB-cached performance
      } catch {
        // Bot may no longer exist — use DB-cached performance
      }
    }

    const perfs  = getPerformance(s.id)
    const totTr  = perfs.reduce((x, p) => x + p.trades, 0)

    totalPnl += pnl
    stratData.push({
      name:   s.name,
      status: s.status,
      pnl,
      pnlPct: pnl !== 0 ? pnl / 500 : 0,
      trades: trades || totTr,
      state:  s.spec.conditions.market_states.join('/'),
    })
  }

  // Circuit breaker events today
  const cbEvents = db.prepare(`
    SELECT DISTINCT tier FROM circuit_breaker_events
    WHERE date(triggered_at) = date('now')
  `).all() as Array<{ tier: number }>

  return {
    date:            today,
    marketStates,
    strategies:      stratData,
    totalPnl,
    circuitBreakers: cbEvents.map(e => e.tier),
    promotions:      [],
    demotions:       [],
  }
}

export function generateReport(data: DailyData): string {
  const { marketStates, strategies, totalPnl, circuitBreakers } = data

  // ── Market summary ──────────────────────────────────────────────────────
  const stateList = Object.entries(marketStates)
    .map(([asset, state]) => {
      const emoji = state === 'oscillation' ? '横盘震荡' : state === 'trend' ? '单边趋势' : '极端波动'
      return `${asset.replace('-USDT', '')} 处于${emoji}`
    })
    .join('，')

  const marketLine = stateList
    ? `今日市场：${stateList}。`
    : '今日市场：数据采集中，系统继续监控。'

  // ── Strategy performance ────────────────────────────────────────────────
  const activeStrats = strategies.filter(s => s.status === 'shadow' || s.status === 'live')
  let stratLine = ''

  if (activeStrats.length === 0) {
    stratLine = '当前无活跃策略，系统处于观察模式。'
  } else {
    const lines = activeStrats.map(s => {
      const pnlStr = s.pnl > 0 ? `+$${s.pnl.toFixed(2)}`
                   : s.pnl < 0 ? `-$${Math.abs(s.pnl).toFixed(2)}`
                   : '持平'
      const status = s.status === 'live' ? '实盘' : '模拟'
      return `${s.name}（${status}）${pnlStr}`
    })
    const netStr = totalPnl > 0 ? `+$${totalPnl.toFixed(2)}` : `-$${Math.abs(totalPnl).toFixed(2)}`
    stratLine = `策略表现：${lines.join('；')}。今日净收益 ${netStr}。`
  }

  // ── Risk events ─────────────────────────────────────────────────────────
  let riskLine = ''
  if (circuitBreakers.length > 0) {
    riskLine = `⚠️ 风控提示：今日触发 ${circuitBreakers.length} 次熔断保护（等级 ${circuitBreakers.join('/')}），系统已自动处理。`
  } else {
    riskLine = '风控状态：一切正常，未触发任何熔断保护。'
  }

  // ── Forward looking ─────────────────────────────────────────────────────
  const btcState = marketStates['BTC-USDT']
  const ethState = marketStates['ETH-USDT']
  let outlook = ''

  if (btcState === 'oscillation') {
    outlook = '明日展望：BTC 仍处震荡区间，网格策略预计继续有效，DARWIN 将维持当前配置。'
  } else if (btcState === 'trend') {
    outlook = '明日展望：BTC 进入趋势行情，DARWIN 将提升趋势追踪策略权重，降低网格比例。'
  } else if (btcState === 'extreme') {
    outlook = '明日展望：市场进入极端状态，DARWIN 已切换至防守模式，等待市场平稳后恢复主动策略。'
  } else {
    outlook = '明日展望：继续监控市场状态变化，策略配置将根据实际情况动态调整。'
  }

  const report = [marketLine, stratLine, riskLine, outlook].filter(Boolean).join('\n\n')

  return `【DARWIN 每日报告 ${data.date}】\n\n${report}`
}

export function saveAndPrintReport(): string {
  const data   = collectDailyData()
  const report = generateReport(data)

  // Save to DB
  try {
    db.prepare(`
      INSERT OR REPLACE INTO daily_reports (report_date, content, data)
      VALUES (?, ?, ?)
    `).run(data.date, report, JSON.stringify(data))
  } catch {
    // Non-fatal
  }

  return report
}

// ── CLI entry point ───────────────────────────────────────────────────────────

const isMain = process.argv[1]?.includes('generator')
if (isMain) {
  const _cy  = (s: string) => `\x1b[36m${s}\x1b[0m`
  const _b   = (s: string) => `\x1b[1m${s}\x1b[0m`
  const border = _cy('═'.repeat(62))
  const report = saveAndPrintReport()
  console.log('\n' + border)
  console.log(_cy('  📋 ') + _b('DARWIN 每日报告'))
  console.log(border)
  console.log(report)
  console.log(border + '\n')
}
