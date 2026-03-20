/**
 * DARWIN — Main entry point
 * Dynamic Adaptive Risk-Weighted Intelligence Network
 */

import { config } from './config.js'
import { recognizeState, type StateReport } from './market/state-recognizer.js'
import { account } from './atk/account.js'
import { loadOfficialStrategies } from './strategy/loader.js'
import { getAllStrategies, getLeaderboard } from './strategy/archive.js'
import { startShadowBot, syncPerformance, runPromotionCycle, printShadowStatus, restoreActiveBotsFromDB, computeDrawdowns, ensureShadowBotsRunning, cleanupDuplicateGridBots } from './shadow/runner.js'
import { runRiskChecks, printStatus as printRiskStatus, isSystemHalted, getState as getCBState, restoreStateFromDB } from './risk/circuit-breaker.js'
import { runCTOHeartbeat, printCTODecision } from './cto/agent.js'
import { calculateAllocations, printAllocationPlan } from './cto/allocator.js'
import { saveAndPrintReport } from './report/generator.js'
import { startBridgeServer } from './paperclip/server.js'
import { monitorPositions, closeAllPositions, printExecutionStatus } from './execution/manager.js'
import db from './db.js'

const HEARTBEAT_MS   = config.heartbeatMinutes * 60 * 1000
const RISK_TICK_MS   = 5  * 60 * 1000        // Risk agent: every 5 min
const CTO_TICK_MS    = 60 * 60 * 1000        // CTO agent: every hour
const PROMO_TICK_MS  = 24 * 60 * 60 * 1000   // Strategy manager: daily
let _lastGridCleanup = 0

let peakEquity = (() => {
  try {
    const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get('peak_equity') as { value: string } | undefined
    const v = row ? parseFloat(row.value) || 0 : 0
    if (v > 0) console.log(`  [Risk] Restored peakEquity from DB: $${v.toFixed(2)}`)
    return v
  } catch { return 0 }
})()
let dayStartEquity = (() => {
  try {
    const dateRow = db.prepare('SELECT value FROM kv_store WHERE key = ?').get('day_start_date') as { value: string } | undefined
    const today = new Date().toISOString().slice(0, 10)
    if (dateRow?.value === today) {
      const eqRow = db.prepare('SELECT value FROM kv_store WHERE key = ?').get('day_start_equity') as { value: string } | undefined
      return eqRow ? parseFloat(eqRow.value) || 0 : 0
    }
    return 0
  } catch { return 0 }
})()
let lastMarketStates: StateReport[] = []
let heartbeatCount = (() => {
  try {
    const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get('heartbeat_count') as { value: string } | undefined
    return row ? parseInt(row.value) || 0 : 0
  } catch { return 0 }
})()

// ANSI color helpers
const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  cyan:    '\x1b[36m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  red:     '\x1b[31m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  white:   '\x1b[97m',
  bgBlue:  '\x1b[44m',
  bgGreen: '\x1b[42m',
}
const bold   = (s: string) => `${C.bold}${s}${C.reset}`
const cyan   = (s: string) => `${C.cyan}${s}${C.reset}`
const green  = (s: string) => `${C.green}${s}${C.reset}`
const yellow = (s: string) => `${C.yellow}${s}${C.reset}`
const red    = (s: string) => `${C.red}${s}${C.reset}`
const dim    = (s: string) => `${C.dim}${s}${C.reset}`

function banner() {
  console.clear()
  console.log()
  console.log(cyan('  ██████╗  █████╗ ██████╗ ██╗    ██╗██╗███╗   ██╗'))
  console.log(cyan('  ██╔══██╗██╔══██╗██╔══██╗██║    ██║██║████╗  ██║'))
  console.log(cyan('  ██║  ██║███████║██████╔╝██║ █╗ ██║██║██╔██╗ ██║'))
  console.log(cyan('  ██║  ██║██╔══██║██╔══██╗██║███╗██║██║██║╚██╗██║'))
  console.log(cyan('  ██████╔╝██║  ██║██║  ██║╚███╔███╔╝██║██║ ╚████║'))
  console.log(cyan('  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝ ╚══╝╚══╝ ╚═╝╚═╝  ╚═══╝'))
  console.log()
  console.log(bold('  Dynamic Adaptive Risk-Weighted Intelligence Network'))
  console.log(dim( '  The First Self-Evolving AI Trading Strategy Platform'))
  console.log()
  console.log('  ' + '─'.repeat(58))
  console.log()
}

// ── Market Analyst heartbeat (every 15 min) ───────────────────────────────────

async function marketHeartbeat(): Promise<void> {
  heartbeatCount++
  try { db.prepare('INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)').run('heartbeat_count', String(heartbeatCount)) } catch {}
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  console.log()
  console.log(
    cyan('  ┌─') + cyan('─'.repeat(56)) + cyan('─┐')
  )
  console.log(
    cyan('  │') + bold(` 📡 市场分析师  `) + dim(`心跳 #${heartbeatCount}`) + `  ` + dim(ts) +
    ' '.repeat(Math.max(0, 41 - String(heartbeatCount).length - ts.length)) + cyan('│')
  )
  console.log(
    cyan('  └─') + cyan('─'.repeat(56)) + cyan('─┘')
  )

  lastMarketStates = []
  for (const asset of config.assets) {
    try {
      const report = await recognizeState(asset)
      lastMarketStates.push(report)

      const stateColor = report.state === 'oscillation' ? yellow
                       : report.state === 'trend'        ? green
                       : red
      const stateIcon  = report.state === 'oscillation' ? '〰 '
                       : report.state === 'trend'        ? '↗ '
                       : '⚡'
      const STATE_CN: Record<string, string> = { oscillation: '震荡', trend: '趋势', extreme: '极端' }
      const stateCN = STATE_CN[report.state] ?? report.state
      const filledBars = Math.round(report.confidence * 12)
      const bar = stateColor('█'.repeat(filledBars)) + dim('░'.repeat(12 - filledBars))
      const pct = Math.round(report.confidence * 100)
      const funding = report.indicators.fundingRate * 100
      const fundingStr = (funding >= 0 ? green('+' + funding.toFixed(4)) : red(funding.toFixed(4))) + '%'

      console.log(
        `\n  ${bold(asset.padEnd(12))}  ${stateColor(stateIcon)} ${stateColor(stateCN.padEnd(11))}` +
        `[${bar}] ${bold(String(pct).padStart(3))}%`
      )
      console.log(
        `  ${''.padEnd(12)}  ` +
        dim(`波动率 ${report.indicators.atrRatio.toFixed(2)}x  `) +
        dim(`资金费率 ${fundingStr}  `) +
        dim(`成交量 ${report.indicators.volumeRatio.toFixed(2)}x  `) +
        dim(`多空比 ${report.indicators.longShortRatio.toFixed(2)}`)
      )

      // Sync shadow bots for strategies matching this asset
      const shadows = getAllStrategies('shadow').filter(
        s => s.spec.conditions.assets.includes(asset)
      )
      for (const s of shadows) {
        syncPerformance(s.id, report.state)
      }
    } catch (err) {
      console.error(`  ${red('✗')} ${asset}: ${err}`)
    }
  }

  printShadowStatus()
}

// ── Risk Agent heartbeat (every 5 min) ───────────────────────────────────────

function riskHeartbeat(): void {
  if (isSystemHalted()) {
    console.log('\n  ' + red('⛔ 系统已停止') + dim(' — 等待手动重启'))
    return
  }

  try {
    const equity = account.totalEquityUSDT()
    if (equity > peakEquity) {
      peakEquity = equity
      try { db.prepare('INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)').run('peak_equity', String(peakEquity)) } catch {}
    }
    // Persist equity for CTO allocation sizing
    try { db.prepare('INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)').run('account_equity', String(equity)) } catch {}

    // Day-start equity tracking for accurate daily PnL
    const today = new Date().toISOString().slice(0, 10)
    try {
      const dateRow = db.prepare('SELECT value FROM kv_store WHERE key = ?').get('day_start_date') as { value: string } | undefined
      if (dateRow?.value !== today) {
        dayStartEquity = equity
        db.prepare('INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)').run('day_start_equity', String(dayStartEquity))
        db.prepare('INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)').run('day_start_date', today)
      }
    } catch {}
    if (dayStartEquity <= 0) dayStartEquity = equity

    const dailyPnl    = equity - dayStartEquity
    const drawdownPct = peakEquity > 0 ? ((equity - peakEquity) / peakEquity * 100) : 0
    const pnlStr      = dailyPnl >= 0
      ? green(`+$${dailyPnl.toFixed(2)}`)
      : red(`-$${Math.abs(dailyPnl).toFixed(2)}`)
    const ddStr       = drawdownPct <= -5 ? red(`${drawdownPct.toFixed(2)}%`) : dim(`${drawdownPct.toFixed(2)}%`)

    console.log(
      `\n  🛡  ${bold('风控代理')}  ` +
      `权益 ${cyan('$' + equity.toFixed(2))}  ` +
      `日盈亏 ${pnlStr}  ` +
      `回撤 ${ddStr}`
    )

    // Compute real drawdowns from active bots
    const { assetDrawdowns, strategyDrawdowns } = computeDrawdowns()

    runRiskChecks({
      totalEquity:       equity,
      peakEquity,
      dailyPnl,
      assetDrawdowns,
      strategyDrawdowns,
    }, config.risk.tier)

    printRiskStatus(config.risk.tier)

    // Execution manager: monitor stop-loss, take-profit, max-hold per strategy
    const execResult = monitorPositions()
    printExecutionStatus(execResult)

    // If circuit breaker T3+ fired, emergency-close all positions
    const cbState = getCBState()
    if (isSystemHalted() || cbState.activeTiers.includes(3)) {
      closeAllPositions(isSystemHalted() ? '熔断器 T4 触发 — 系统停止' : '熔断器 T3 触发 — 全部暂停')
    }

    // Periodic grid bot cleanup (once per hour) — remove duplicates to free OKX slots
    const now = Date.now()
    if (!(_lastGridCleanup > 0) || now - _lastGridCleanup > 60 * 60_000) {
      try { cleanupDuplicateGridBots() } catch {}
      _lastGridCleanup = now
    }

    // Dead bot recovery — restart shadow/live strategies whose bots died on OKX
    ensureShadowBotsRunning().catch(() => {})
  } catch {
    // Account API may not be available — non-fatal
    console.log(`  🛡  ${bold('风控代理')}  ` + dim('(账户数据不可用)'))
  }
}

// ── CTO Agent heartbeat (every hour) ─────────────────────────────────────────

async function ctoHeartbeat(): Promise<void> {
  try {
    const equity   = (() => { try { return account.totalEquityUSDT() } catch { return 0 } })()
    const decision = await runCTOHeartbeat()
    printCTODecision(decision)

    // Show capital allocation plan
    if (equity > 0) {
      const plan = calculateAllocations(equity, decision.currentState, config.risk.tier)
      printAllocationPlan(plan)
    }
  } catch (err) {
    console.error(`  ${red('✗')} CTO 代理异常: ${err}`)
  }
}

// ── Auditor Agent heartbeat (daily) ──────────────────────────────────────────

function auditorHeartbeat(): void {
  try {
    const report = saveAndPrintReport()
    const border = cyan('═'.repeat(62))
    console.log('\n' + border)
    console.log(cyan('  📋 ') + bold('DARWIN 每日报告'))
    console.log(border)
    console.log(report)
    console.log(border)
  } catch (err) {
    console.error(`  ${red('✗')} 审计报告生成失败: ${err}`)
  }
}

// ── Strategy Manager heartbeat (daily) ───────────────────────────────────────

function strategyManagerHeartbeat(): void {
  const currentState = lastMarketStates[0]?.state ?? 'oscillation'
  const STATE_CN: Record<string, string> = { oscillation: '震荡', trend: '趋势', extreme: '极端' }
  runPromotionCycle(currentState)

  // Show leaderboard
  const board = getLeaderboard(currentState)
  console.log()
  console.log(`  🧬 ${bold('策略管理器')}  ` + dim(`市场状态: ${STATE_CN[currentState] ?? currentState}`))

  if (board.length === 0) {
    console.log(dim('     暂无策略数据'))
    return
  }

  console.log(`  ${'─'.repeat(58)}`)
  console.log(
    dim(`  ${'#'.padEnd(3)} ${'策略名称'.padEnd(28)} ${'状态'.padEnd(8)} ${'评分'.padEnd(7)} 交易数`)
  )
  console.log(`  ${'─'.repeat(58)}`)

  const STATUS_CN: Record<string, string> = { live: '运行中', shadow: '影子', paused: '暂停', demoted: '降级' }
  for (const entry of board.slice(0, 5)) {
    const statusColor = entry.status === 'live'   ? green
                      : entry.status === 'shadow' ? yellow
                      : red
    const statusCN = STATUS_CN[entry.status] ?? entry.status
    const scoreBar = entry.score >= 0.7 ? green('●') : entry.score >= 0.4 ? yellow('●') : red('●')
    console.log(
      `  ${String(entry.rank).padEnd(3)} ` +
      `${entry.name.slice(0, 27).padEnd(28)} ` +
      `${statusColor(statusCN.padEnd(8))} ` +
      `${scoreBar} ${entry.score.toFixed(2).padEnd(5)} ` +
      `${String(entry.trades).padStart(4)}`
    )
  }
  console.log(`  ${'─'.repeat(58)}`)
}

// ── Startup ───────────────────────────────────────────────────────────────────

async function startup(): Promise<void> {
  banner()

  const modeLabel = config.okx.demoMode
    ? yellow('DEMO ✓')
    : red('⚡ LIVE TRADING')
  const tierLabel = config.risk.tier === 'conservative' ? green(config.risk.tier.toUpperCase())
                  : config.risk.tier === 'balanced'     ? yellow(config.risk.tier.toUpperCase())
                  : red(config.risk.tier.toUpperCase())

  console.log(`  ${dim('模式')}       ${modeLabel}`)
  console.log(`  ${dim('风控等级')}   ${tierLabel}`)
  console.log(`  ${dim('监控币种')}   ${cyan(config.assets.join('  '))}`)
  console.log(`  ${dim('心跳间隔')}   ${cyan(String(config.heartbeatMinutes) + ' 分钟')}`)
  console.log()

  // Start Paperclip HTTP bridge server
  try {
    await startBridgeServer()
    console.log(`  ${green('✓')} Paperclip 桥接服务就绪  ${dim('→ http://127.0.0.1:3200')}`)
    console.log(`  ${dim('Paperclip 面板')}  ${dim('→ http://127.0.0.1:3100')}`)
    console.log()
  } catch (err) {
    console.warn(`  ${yellow('⚠')} Paperclip 桥接启动失败: ${err}`)
    console.warn(`  ${dim('继续运行（无 Paperclip 集成）...')}`)
    console.log()
  }

  // Restore persisted state (crash recovery)
  restoreStateFromDB()
  restoreActiveBotsFromDB()

  // Restore persisted risk tier
  try {
    const tierRow = db.prepare('SELECT value FROM kv_store WHERE key = ?').get('risk_tier') as { value: string } | undefined
    if (tierRow?.value && ['conservative', 'balanced', 'aggressive'].includes(tierRow.value)) {
      config.risk.tier = tierRow.value as 'conservative' | 'balanced' | 'aggressive'
    }
  } catch {}

  // Load official strategies
  process.stdout.write(`  ${dim('加载策略中...')}`)
  loadOfficialStrategies()
  process.stdout.write(`  ${green('✓')}\n`)

  // Clean up duplicate/orphan grid bots to free up OKX bot slots
  try {
    const cleaned = cleanupDuplicateGridBots()
    if (cleaned > 0) console.log(`  ${green('✓')} 清理了 ${cleaned} 个重复/孤立网格机器人`)
  } catch {}

  // Start shadow bots for any registered shadow strategies without a running bot
  const shadows = getAllStrategies('shadow')
  console.log(`  ${dim('影子策略')}   ${cyan(String(shadows.length))} 个已注册\n`)

  for (const s of shadows) {
    // Only skip if there's an ACTIVE (non-stopped) bot running
    const activeBotRow = db.prepare(
      'SELECT id FROM shadow_bots WHERE strategy_id = ? AND stopped_at IS NULL ORDER BY started_at DESC LIMIT 1'
    ).get(s.id)

    if (!activeBotRow) {
      try {
        await startShadowBot(s.id)
      } catch (err) {
        console.warn(`  ${yellow('⚠')} 影子机器人 "${s.name}": ${err}`)
      }
    } else {
      console.log(`  ${green('▸')} "${s.name}" — 影子机器人运行中`)
    }
  }

  // Defer initial heartbeats — run after event loop is free so HTTP server
  // can serve requests immediately instead of blocking for 50-90s
  console.log(`  ${dim('初始心跳将在后台运行...')}`)
  setTimeout(async () => {
    try { await marketHeartbeat() } catch {}
    try { riskHeartbeat() } catch {}
  }, 500)
}

// ── Main ──────────────────────────────────────────────────────────────────────

await startup()

// Recurring heartbeats
setInterval(marketHeartbeat,          HEARTBEAT_MS)
setInterval(riskHeartbeat,            RISK_TICK_MS)
setInterval(ctoHeartbeat,             CTO_TICK_MS)
setInterval(strategyManagerHeartbeat, PROMO_TICK_MS)
setInterval(auditorHeartbeat,         PROMO_TICK_MS)

// Run key agents once on startup (after initial market scan settles)
setTimeout(ctoHeartbeat,             20_000)
setTimeout(strategyManagerHeartbeat, 30_000)
setTimeout(auditorHeartbeat,         40_000)

console.log()
console.log(green('  ✅ DARWIN 运行中') + dim('  │  按 Ctrl+C 停止'))
console.log()
console.log(dim(`  下次市场扫描 ${config.heartbeatMinutes} 分钟后  │  风控检查 每5分钟  │  每日报告`))
console.log()
