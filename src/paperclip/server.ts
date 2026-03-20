/**
 * DARWIN × Paperclip HTTP Bridge Server
 *
 * Paperclip calls these endpoints when each agent's heartbeat fires.
 * This server is the "adapter" that translates Paperclip heartbeats
 * into DARWIN business logic (market scan, risk check, CTO decision, etc.)
 *
 * Port: 3200 (Paperclip itself runs on 3100)
 *
 * Endpoints:
 *   POST /heartbeat/market          → Market Analyst (every 15 min)
 *   POST /heartbeat/risk            → Risk Agent (every 5 min)
 *   POST /heartbeat/cto             → CTO Agent (every 60 min)
 *   POST /heartbeat/strategy-manager → Strategy Manager (daily)
 *   POST /heartbeat/auditor         → Auditor (daily)
 *   GET  /status                    → System snapshot (JSON)
 *   POST /approval/tier3-reset      → Paperclip approval webhook
 *   POST /approval/tier4-reset      → Emergency halt reset
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { readFileSync }            from 'fs'
import { join, dirname }           from 'path'
import { fileURLToPath }           from 'url'
import { recognizeState }          from '../market/state-recognizer.js'
import { account }                 from '../atk/account.js'
import { loadOfficialStrategies }  from '../strategy/loader.js'
import { getAllStrategies, getPerformance, getLeaderboard } from '../strategy/archive.js'
import { startShadowBot, stopShadowBot, syncPerformance, runPromotionCycle, printShadowStatus, getActiveBots, getBotType, computeDrawdowns } from '../shadow/runner.js'
import { runRiskChecks, getState, resetTier3, resetTier4, isSystemHalted } from '../risk/circuit-breaker.js'
import { runCTOHeartbeat, printCTODecision } from '../cto/agent.js'
import { calculateAllocations, printAllocationPlan } from '../cto/allocator.js'
import { saveAndPrintReport }      from '../report/generator.js'
import { runBacktest, type BacktestConfig, type BacktestResult } from '../backtest/engine.js'
import { config, fromSwapId }       from '../config.js'
import { notifyPaperclip, createCircuitBreakerApproval, consumeApprovedCircuitBreakerApprovals } from './client.js'
import { validate, validateMarketState, validateRiskStatus, validateCTODecision,
         defaultMarketState, defaultRiskStatus, defaultCTODecision } from '../utils/validate.js'
import db from '../db.js'
import { notifyCBTriggered, notifyDailyReport, notifyPromotion } from '../telegram/notifier.js'

const PORT = 3200

// ── State shared across heartbeat calls ───────────────────────────────────────

let peakEquity = (() => {
  try {
    const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get('peak_equity') as { value: string } | undefined
    return row ? parseFloat(row.value) || 0 : 0
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
let heartbeatCount = (() => {
  try {
    const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get('heartbeat_count') as { value: string } | undefined
    return row ? parseInt(row.value) || 0 : 0
  } catch { return 0 }
})()

function persistHeartbeatCount() {
  try { db.prepare('INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)').run('heartbeat_count', String(heartbeatCount)) } catch {}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', chunk => { data += chunk.toString() })
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}) }
      catch { resolve({}) }
    })
  })
}

function respond(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function ok(res: ServerResponse, data: unknown = { ok: true }) {
  respond(res, 200, data)
}

function err(res: ServerResponse, msg: string, code = 400) {
  respond(res, code, { error: msg })
}

// ── Heartbeat handlers ────────────────────────────────────────────────────────

async function handleMarket(res: ServerResponse) {
  heartbeatCount++
  persistHeartbeatCount()
  const ts = new Date().toISOString()
  console.log(`\n[Paperclip→DARWIN] 📡 Market Analyst heartbeat #${heartbeatCount}  ${ts}`)

  const states: Record<string, string> = {}
  const errors: string[] = []

  for (const asset of config.assets) {
    try {
      const report = await recognizeState(asset)
      states[asset] = report.state

      const icon = report.state === 'oscillation' ? '〰' : report.state === 'trend' ? '↗' : '⚡'
      console.log(`  ${asset.padEnd(12)} ${icon} ${report.state.toUpperCase()} [${Math.round(report.confidence*100)}%]`)

      // Sync shadow bots
      const shadows = getAllStrategies('shadow').filter(
        s => s.spec.conditions.assets.includes(asset)
      )
      for (const s of shadows) syncPerformance(s.id, report.state)

    } catch (e) {
      errors.push(`${asset}: ${e}`)
    }
  }

  // Notify Paperclip about the run result
  await notifyPaperclip('market-analyst', 'succeeded', { states, errors, heartbeatCount })

  ok(res, { heartbeatCount, states, errors, timestamp: ts })
}

async function handleRisk(res: ServerResponse) {
  // ── Step 1: Poll for approved circuit-breaker resets from Paperclip ──────
  const approvedResets = await consumeApprovedCircuitBreakerApprovals()
  for (const reset of approvedResets) {
    console.log(`\n[Paperclip→DARWIN] ✅ Approval consumed — Tier ${reset.tier} reset (by ${reset.decidedBy})`)
    if (reset.tier === 3) resetTier3(reset.decidedBy)
    if (reset.tier === 4) resetTier4(reset.decidedBy)
  }

  // ── Step 2: If system still halted, skip trading checks ──────────────────
  if (isSystemHalted()) {
    console.log('\n[Paperclip→DARWIN] 🛡  Risk Agent — system halted, awaiting approval')
    ok(res, { halted: true, pendingApproval: true })
    return
  }

  // ── Step 3: Normal risk check cycle ──────────────────────────────────────
  let equity = 0
  let result: Record<string, unknown> = {}
  try {
    equity = account.totalEquityUSDT()
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

    const dailyPnl   = equity - dayStartEquity
    const drawdownPct = peakEquity > 0 ? (equity - peakEquity) / peakEquity : 0
    const { assetDrawdowns, strategyDrawdowns } = computeDrawdowns()
    const snapshot   = { totalEquity: equity, peakEquity, dailyPnl, assetDrawdowns, strategyDrawdowns }
    runRiskChecks(snapshot, config.risk.tier)
    const cbState = getState()

    result = {
      equity:      equity.toFixed(2),
      peakEquity:  peakEquity.toFixed(2),
      dailyPnl:    dailyPnl.toFixed(2),
      activeTiers: cbState.activeTiers,
      halted:      cbState.systemHalted,
    }

    console.log(`\n[Paperclip→DARWIN] 🛡  Risk Agent  equity=$${equity.toFixed(2)}  tiers=[${cbState.activeTiers.join(',') || 'none'}]`)

    // ── Step 4: If Tier 3+ just fired, create Paperclip approval request ───
    if (cbState.activeTiers.includes(4)) {
      const approvalId = await createCircuitBreakerApproval({
        tier: 4, equity, peakEquity, drawdownPct,
      })
      await notifyPaperclip('risk-agent', 'pending_approval', {
        reason: 'Emergency halt (Tier 4) activated. Manual board approval required.',
        approvalId,
        ...result,
      })
      await notifyCBTriggered(4, `紧急停机 — 权益 $${equity.toFixed(2)}, 回撤 ${(drawdownPct * 100).toFixed(1)}%`)
    } else if (cbState.activeTiers.includes(3)) {
      const approvalId = await createCircuitBreakerApproval({
        tier: 3, equity, peakEquity, drawdownPct,
      })
      await notifyPaperclip('risk-agent', 'pending_approval', {
        reason: 'Portfolio drawdown (Tier 3) circuit breaker activated. Manual reset required.',
        approvalId,
        ...result,
      })
      await notifyCBTriggered(3, `组合回撤触发 — 权益 $${equity.toFixed(2)}, 回撤 ${(drawdownPct * 100).toFixed(1)}%`)
    } else {
      await notifyPaperclip('risk-agent', 'succeeded', result)
    }

  } catch (e) {
    console.warn('[Paperclip→DARWIN] 🛡  Risk Agent — account unavailable')
    result = { error: String(e) }
    await notifyPaperclip('risk-agent', 'failed', result)
  }

  ok(res, result)
}

async function handleCTO(res: ServerResponse) {
  console.log('\n[Paperclip→DARWIN] 🤖 CTO Agent heartbeat')

  let equity = 0
  try { equity = account.totalEquityUSDT() } catch {}

  const decision = await runCTOHeartbeat()
  printCTODecision(decision)

  let allocationResult = null
  if (equity > 0) {
    const plan = calculateAllocations(equity, decision.currentState, config.risk.tier)
    printAllocationPlan(plan)
    allocationResult = {
      totalEquity: plan.totalEquity.toFixed(2),
      deployedUSDT: plan.deployedUSDT.toFixed(2),
      deployedPct: (plan.deployedPct * 100).toFixed(1) + '%',
      strategies: plan.allocations.map(a => ({ name: a.name, allocUSDT: a.allocUSDT })),
    }
  }

  const result = {
    state: decision.currentState,
    stateChanged: decision.stateChanged,
    actionsCount: decision.actions.length,
    rationale: decision.rationale,
    allocation: allocationResult,
  }

  await notifyPaperclip('cto-agent', 'succeeded', result)
  ok(res, result)
}

async function handleStrategyManager(res: ServerResponse) {
  console.log('\n[Paperclip→DARWIN] 🧬 Strategy Manager heartbeat')

  const { getAllStrategies: get, getLeaderboard } = await import('../strategy/archive.js')
  const currentState = (await recognizeState(config.assets[0])).state

  runPromotionCycle(currentState)
  const board = getLeaderboard(currentState)

  const result = {
    state: currentState,
    leaderboard: board.slice(0, 5).map(e => ({
      rank: e.rank, name: e.name, status: e.status,
      score: e.score.toFixed(2), trades: e.trades,
    })),
  }

  console.log(`  State: ${currentState}  |  Leaderboard: ${board.length} strategies`)
  await notifyPaperclip('strategy-manager', 'succeeded', result)
  ok(res, result)
}

async function handleAuditor(res: ServerResponse) {
  console.log('\n[Paperclip→DARWIN] 📋 Auditor heartbeat')

  const report = saveAndPrintReport()
  const border = '\x1b[36m' + '═'.repeat(62) + '\x1b[0m'
  console.log('\n' + border)
  console.log('\x1b[36m  📋 \x1b[0m\x1b[1mDARWIN 每日报告\x1b[0m')
  console.log(border)
  console.log(report)
  console.log(border)

  await notifyPaperclip('auditor', 'succeeded', { reportLength: report.length, preview: report.slice(0, 200) })
  await notifyDailyReport(report.slice(0, 2000))
  ok(res, { ok: true, reportLength: report.length })
}

// ── Approval handlers ─────────────────────────────────────────────────────────

async function handleApprovalTier3(body: unknown, res: ServerResponse) {
  const b = body as Record<string, string>
  const approvedBy = b?.approvedBy ?? 'paperclip_approval'
  console.log(`\n[Paperclip→DARWIN] ✅ Tier 3 reset approved by: ${approvedBy}`)
  resetTier3(approvedBy)
  ok(res, { ok: true, message: `Tier 3 circuit breaker reset by ${approvedBy}` })
}

async function handleApprovalTier4(body: unknown, res: ServerResponse) {
  const b = body as Record<string, string>
  const approvedBy = b?.approvedBy ?? 'paperclip_emergency'
  console.log(`\n[Paperclip→DARWIN] 🚨 Emergency (T4) reset approved by: ${approvedBy}`)
  resetTier4(approvedBy)
  ok(res, { ok: true, message: `Emergency halt reset by ${approvedBy}` })
}

// ── Status endpoint ───────────────────────────────────────────────────────────

async function handleStatus(res: ServerResponse) {
  let equity = 0
  try { equity = account.totalEquityUSDT() } catch {}

  const strategies = getAllStrategies()
  const cbState    = getState()

  ok(res, {
    timestamp:      new Date().toISOString(),
    mode:           config.okx.demoMode ? 'demo' : 'live',
    riskTier:       config.risk.tier,
    equity:         equity.toFixed(2),
    heartbeats:     heartbeatCount,
    strategies: {
      total:    strategies.length,
      shadow:   strategies.filter(s => s.status === 'shadow').length,
      live:     strategies.filter(s => s.status === 'live').length,
    },
    circuitBreaker: {
      halted:      cbState.systemHalted,
      activeTiers: cbState.activeTiers,
    },
    paperclipUrl:   'http://127.0.0.1:3100',
  })
}

// ── Dashboard API endpoints ───────────────────────────────────────────────────

async function handleDashboardPage(res: ServerResponse) {
  return serveHtmlPage('dashboard.html', res)
}

async function handleShowcasePage(res: ServerResponse) {
  return serveHtmlPage('showcase.html', res)
}

function serveHtmlPage(filename: string, res: ServerResponse) {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const htmlPath = join(__dirname, '..', '..', filename)
    const html = readFileSync(htmlPath, 'utf8')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  } catch (e) {
    err(res, `HTML page not found: ${e}`, 500)
  }
}

async function handleApiMarketStates(res: ServerResponse) {
  try {
    const rows = db.prepare(`
      SELECT asset, state, confidence, indicators, recorded_at
      FROM market_states
      WHERE id IN (
        SELECT MAX(id) FROM market_states GROUP BY asset
      )
      ORDER BY asset
    `).all() as Array<{
      asset: string; state: string; confidence: number
      indicators: string; recorded_at: string
    }>

    ok(res, rows.map(r => ({
      ...r,
      indicators: JSON.parse(r.indicators),
    })))
  } catch (e) {
    console.warn(`  [API] /api/market-states error: ${e}`)
    ok(res, [])
  }
}

async function handleApiStrategies(res: ServerResponse) {
  const strategies = getAllStrategies()
  const activeBots = getActiveBots()

  ok(res, strategies.map(s => {
    const perfs = getPerformance(s.id)
    const totalTrades = perfs.reduce((n, p) => n + p.trades, 0)
    const totalWinning = perfs.reduce((n, p) => n + p.winning_trades, 0)
    const winRate = totalTrades > 0 ? totalWinning / totalTrades : 0
    const totalReturn = perfs.reduce((n, p) => n + p.total_return, 0)
    const maxDD = perfs.reduce((m, p) => Math.max(m, p.max_drawdown), 0)
    const algoId = activeBots.get(s.id)
    const botType = algoId ? getBotType(algoId) : null

    return {
      id:          s.id,
      name:        s.name,
      author:      s.author,
      status:      s.status,
      tool:        s.spec.execution.tool,
      assets:      s.spec.conditions.assets,
      marketStates: s.spec.conditions.market_states,
      trades:      totalTrades,
      winRate:     Math.round(winRate * 100),
      totalReturn: totalReturn,
      maxDrawdown: Math.round(maxDD * 100),
      botType,
      active:      !!algoId,
      createdAt:   s.created_at,
    }
  }))
}

async function handleApiCircuitBreaker(res: ServerResponse) {
  const cbState = getState()
  let events: unknown[] = []
  try {
    events = db.prepare(`
      SELECT tier, trigger_reason, affected, triggered_at, resolved_at, resolved_by
      FROM circuit_breaker_events
      ORDER BY triggered_at DESC
      LIMIT 20
    `).all()
  } catch {}
  ok(res, { state: cbState, events })
}

async function handleApiAllocations(res: ServerResponse) {
  let equity = 0
  try { equity = account.totalEquityUSDT() } catch {}

  if (equity <= 0) {
    ok(res, { totalEquity: 0, allocations: [], marketState: 'oscillation' })
    return
  }

  // Get latest market state for primary asset
  let marketState: 'oscillation' | 'trend' | 'extreme' = 'oscillation'
  try {
    const row = db.prepare(`
      SELECT state FROM market_states ORDER BY recorded_at DESC LIMIT 1
    `).get() as { state: string } | undefined
    if (row) marketState = row.state as typeof marketState
  } catch {}

  const plan = calculateAllocations(equity, marketState, config.risk.tier)
  ok(res, {
    totalEquity:  plan.totalEquity,
    deployedUSDT: plan.deployedUSDT,
    deployedPct:  plan.deployedPct,
    reserveUSDT:  plan.reserveUSDT,
    marketState:  plan.marketState,
    riskTier:     plan.riskTier,
    volatilityMap: plan.volatilityMap,
    allocations:  plan.allocations.map(a => ({
      name:       a.name,
      allocUSDT:  a.allocUSDT,
      allocPct:   a.allocPct,
      score:      a.score,
      reason:     a.reason,
    })),
  })
}

async function handleApiShadowBots(res: ServerResponse) {
  const activeBots = getActiveBots()
  const bots: Array<{ strategyId: string; algoId: string; botType: string }> = []
  for (const [strategyId, algoId] of activeBots) {
    bots.push({ strategyId, algoId, botType: getBotType(algoId) })
  }
  ok(res, { total: bots.length, bots })
}

async function handleApiAccount(res: ServerResponse) {
  try {
    const balances  = account.balance()
    const equity    = account.totalEquityUSDT()
    const positions = account.positions()

    // Compute daily PnL from persisted day-start equity
    let dailyPnl = 0
    try {
      const dateRow = db.prepare('SELECT value FROM kv_store WHERE key = ?').get('day_start_date') as { value: string } | undefined
      const today = new Date().toISOString().slice(0, 10)
      if (dateRow?.value === today) {
        const eqRow = db.prepare('SELECT value FROM kv_store WHERE key = ?').get('day_start_equity') as { value: string } | undefined
        if (eqRow) dailyPnl = equity - (parseFloat(eqRow.value) || equity)
      }
    } catch {}

    ok(res, { equity, dailyPnl, peakEquity, balances, positions })
  } catch (e) {
    ok(res, { equity: 0, dailyPnl: 0, peakEquity: 0, balances: [], positions: [], error: String(e) })
  }
}

async function handleApiPositions(res: ServerResponse) {
  try {
    // Use async versions to avoid blocking the event loop
    const [positions, equity] = await Promise.all([
      account.detailedPositionsAsync(),
      account.totalEquityUSDTAsync(),
    ])
    const totalUpl  = positions.reduce((s, p) => s + p.upl, 0)
    const totalNotional = positions.reduce((s, p) => s + p.notionalUsd, 0)
    const totalMargin   = positions.reduce((s, p) => s + p.margin, 0)
    ok(res, {
      equity,
      positionCount: positions.length,
      totalUpl,
      totalNotional,
      totalMargin,
      deployedPct: equity > 0 ? totalMargin / equity : 0,
      positions: positions.map(p => {
        const asset = p.instId.endsWith('-SWAP') ? fromSwapId(p.instId) : p.instId
        return {
          ...p,
          asset,
          uplPct: p.uplRatio * 100,
          openTime: p.cTime ? new Date(parseInt(p.cTime)).toISOString() : null,
        }
      }),
    })
  } catch (e) {
    ok(res, { equity: 0, positionCount: 0, totalUpl: 0, totalNotional: 0, totalMargin: 0, deployedPct: 0, positions: [], error: String(e) })
  }
}

async function handleApiLeaderboard(res: ServerResponse) {
  let marketState: 'oscillation' | 'trend' | 'extreme' = 'oscillation'
  try {
    const row = db.prepare(`SELECT state FROM market_states ORDER BY recorded_at DESC LIMIT 1`).get() as { state: string } | undefined
    if (row) marketState = row.state as typeof marketState
  } catch {}

  const board = getLeaderboard(marketState)
  ok(res, board.map((e, i) => ({
    rank: e.rank,
    id: e.id,
    name: e.name,
    status: e.status,
    score: e.score,
    trades: e.trades,
    winRate: e.win_rate,
    marketState,
  })))
}

async function handleApiEvents(res: ServerResponse) {
  try {
    const cbEvents = db.prepare(`
      SELECT 'circuit_breaker' as type, tier as detail, trigger_reason as message, triggered_at as timestamp
      FROM circuit_breaker_events ORDER BY triggered_at DESC LIMIT 20
    `).all()
    const stateEvents = db.prepare(`
      SELECT 'market_state' as type, asset || ' → ' || state as detail,
             'confidence ' || ROUND(confidence*100) || '%' as message, recorded_at as timestamp
      FROM market_states ORDER BY recorded_at DESC LIMIT 20
    `).all()
    const all = [...cbEvents, ...stateEvents]
      .sort((a: any, b: any) => (b.timestamp || '').localeCompare(a.timestamp || ''))
      .slice(0, 30)
    ok(res, all)
  } catch {
    ok(res, [])
  }
}

async function handleApiReportsLatest(res: ServerResponse) {
  try {
    const row = db.prepare(`
      SELECT report_date, content, data FROM daily_reports ORDER BY report_date DESC LIMIT 1
    `).get() as { report_date: string; content: string; data: string } | undefined
    if (row) {
      ok(res, { date: row.report_date, content: row.content, data: JSON.parse(row.data) })
    } else {
      ok(res, { date: null, content: '暂无报告', data: null })
    }
  } catch {
    ok(res, { date: null, content: '暂无报告', data: null })
  }
}

async function handleApiStrategyStart(strategyId: string, res: ServerResponse) {
  try {
    const botId = await startShadowBot(strategyId)
    ok(res, { ok: true, strategyId, botId })
  } catch (e) {
    err(res, `启动失败: ${e}`)
  }
}

async function handleApiStrategyStop(strategyId: string, res: ServerResponse) {
  try {
    stopShadowBot(strategyId)
    ok(res, { ok: true, strategyId })
  } catch (e) {
    err(res, `停止失败: ${e}`)
  }
}

async function handleApiHistory(res: ServerResponse) {
  try {
    const rows = db.prepare(`
      SELECT asset, state, confidence, recorded_at
      FROM market_states
      ORDER BY recorded_at DESC
      LIMIT 200
    `).all()
    ok(res, rows)
  } catch {
    ok(res, [])
  }
}

// ── New API endpoints ─────────────────────────────────────────────────────────

async function handleApiTrades(res: ServerResponse) {
  try {
    // Daily PnL from daily_reports
    const reportRows = db.prepare(`
      SELECT report_date, data FROM daily_reports ORDER BY report_date DESC LIMIT 30
    `).all() as Array<{ report_date: string; data: string }>

    const dailyPnl: Array<{ date: string; pnl: number; trades: number }> = []
    let totalPnl = 0

    for (const r of reportRows) {
      try {
        const d = JSON.parse(r.data)
        const pnl = d.totalPnl ?? 0
        const trades = d.strategies?.reduce((n: number, s: any) => n + (s.trades ?? 0), 0) ?? 0
        dailyPnl.push({ date: r.report_date, pnl, trades })
        totalPnl += pnl
      } catch {}
    }

    // Per-strategy breakdown from strategy_performance
    const perfRows = db.prepare(`
      SELECT s.name, s.status, sp.market_state, sp.trades, sp.winning_trades, sp.total_return, sp.max_drawdown
      FROM strategy_performance sp
      JOIN strategies s ON s.id = sp.strategy_id
      ORDER BY sp.total_return DESC
      LIMIT 500
    `).all() as Array<{
      name: string; status: string; market_state: string
      trades: number; winning_trades: number; total_return: number; max_drawdown: number
    }>

    // Aggregate by strategy name
    const stratMap = new Map<string, { name: string; status: string; trades: number; wins: number; pnl: number; maxDD: number }>()
    for (const r of perfRows) {
      const existing = stratMap.get(r.name)
      if (existing) {
        existing.trades += r.trades
        existing.wins += r.winning_trades
        existing.pnl += r.total_return
        existing.maxDD = Math.max(existing.maxDD, r.max_drawdown)
      } else {
        stratMap.set(r.name, { name: r.name, status: r.status, trades: r.trades, wins: r.winning_trades, pnl: r.total_return, maxDD: r.max_drawdown })
      }
    }
    const stratBreakdown = Array.from(stratMap.values()).sort((a, b) => b.pnl - a.pnl)
    const totalTrades = stratBreakdown.reduce((n, s) => n + s.trades, 0)

    // Execution events as trade log
    let tradeLog: unknown[] = []
    try {
      tradeLog = db.prepare(`
        SELECT strategy_id, action, detail, created_at FROM execution_events
        ORDER BY created_at DESC LIMIT 100
      `).all()
    } catch {} // table may not exist yet

    // Add real-time today PnL if no daily report entry yet
    if (dailyPnl.length === 0 || dailyPnl[0]?.date !== new Date().toISOString().slice(0, 10)) {
      try {
        const eq = account.totalEquityUSDT()
        const dateRow = db.prepare('SELECT value FROM kv_store WHERE key = ?').get('day_start_date') as { value: string } | undefined
        const today = new Date().toISOString().slice(0, 10)
        if (dateRow?.value === today) {
          const eqRow = db.prepare('SELECT value FROM kv_store WHERE key = ?').get('day_start_equity') as { value: string } | undefined
          const dayStart = eqRow ? parseFloat(eqRow.value) || eq : eq
          const todayPnl = eq - dayStart
          dailyPnl.unshift({ date: today, pnl: todayPnl, trades: totalTrades })
        }
      } catch {}
    }

    ok(res, { dailyPnl, totalPnl, totalTrades, stratBreakdown, tradeLog })
  } catch (e) {
    ok(res, { dailyPnl: [], totalPnl: 0, totalTrades: 0, stratBreakdown: [], tradeLog: [], error: String(e) })
  }
}

async function handleApiCTODecisions(res: ServerResponse) {
  try {
    const rows = db.prepare(`
      SELECT decided_at, prev_state, current_state, state_changed, actions, rationale, llm_insight
      FROM cto_decisions ORDER BY decided_at DESC LIMIT 10
    `).all() as Array<{ decided_at: string; prev_state: string; current_state: string; state_changed: number; actions: string; rationale: string; llm_insight: string | null }>
    ok(res, rows.map(r => ({
      decidedAt: r.decided_at,
      prevState: r.prev_state,
      currentState: r.current_state,
      stateChanged: !!r.state_changed,
      actions: JSON.parse(r.actions || '[]'),
      rationale: r.rationale,
      llmInsight: r.llm_insight ? JSON.parse(r.llm_insight) : null,
    })))
  } catch {
    ok(res, [])
  }
}

async function handleApiReports(res: ServerResponse) {
  try {
    const rows = db.prepare(`
      SELECT report_date, content, data FROM daily_reports ORDER BY report_date DESC LIMIT 30
    `).all() as Array<{ report_date: string; content: string; data: string }>

    ok(res, rows.map(r => {
      let data = null
      try { data = JSON.parse(r.data) } catch {}
      return { date: r.report_date, content: r.content, data }
    }))
  } catch {
    ok(res, [])
  }
}

async function handleApiConfig(res: ServerResponse) {
  let apiConnected = false
  try {
    const eq = account.totalEquityUSDT()
    apiConnected = eq > 0
  } catch {}

  ok(res, {
    mode: config.okx.demoMode ? 'demo' : 'live',
    riskTier: config.risk.tier,
    assets: config.assets,
    heartbeatMinutes: config.heartbeatMinutes,
    apiConnected,
    telegramEnabled: config.telegram.enabled,
    bridgePort: PORT,
    paperclipUrl: 'http://127.0.0.1:3100',
  })
}

async function handleApiSetRiskTier(body: Record<string, unknown>, res: ServerResponse) {
  const tier = body.tier as string
  if (!['conservative', 'balanced', 'aggressive'].includes(tier)) {
    err(res, '无效的风控等级，必须是 conservative / balanced / aggressive', 400)
    return
  }
  config.risk.tier = tier as 'conservative' | 'balanced' | 'aggressive'
  try { db.prepare('INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)').run('risk_tier', tier) } catch {}
  console.log(`[Bridge] 风控等级已切换为: ${tier}`)
  ok(res, { riskTier: tier })
}

async function handleApiStrategyDetail(strategyId: string, res: ServerResponse) {
  try {
    const strategies = getAllStrategies()
    const s = strategies.find(x => x.id === strategyId)
    if (!s) { err(res, '策略不存在', 404); return }

    const perfs = getPerformance(s.id)
    const totalTrades = perfs.reduce((n, p) => n + p.trades, 0)
    const totalWinning = perfs.reduce((n, p) => n + p.winning_trades, 0)
    const totalReturn = perfs.reduce((n, p) => n + p.total_return, 0)
    const maxDD = perfs.reduce((m, p) => Math.max(m, p.max_drawdown), 0)

    ok(res, {
      id: s.id,
      name: s.name,
      author: s.author,
      status: s.status,
      tool: s.spec.execution.tool,
      assets: s.spec.conditions.assets,
      marketStates: s.spec.conditions.market_states,
      params: s.spec.execution.params,
      risk: s.spec.risk,
      promotion: s.spec.promotion,
      demotion: s.spec.demotion,
      totalTrades,
      winRate: totalTrades > 0 ? Math.round(totalWinning / totalTrades * 100) : 0,
      totalReturn,
      maxDrawdown: Math.round(maxDD * 100),
      createdAt: s.created_at,
      shadowStartedAt: s.shadow_started_at,
      liveStartedAt: s.live_started_at,
      performances: perfs,
    })
  } catch (e) {
    err(res, `获取策略详情失败: ${e}`, 500)
  }
}

// ── Backtest API ──────────────────────────────────────────────────────────────

let backtestRunning = false

async function handleApiBacktestResults(res: ServerResponse) {
  try {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS backtest_results (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        run_at         TEXT    NOT NULL DEFAULT (datetime('now')),
        assets         TEXT    NOT NULL,
        days           INTEGER NOT NULL,
        risk_tier      TEXT    NOT NULL,
        initial_usdt   REAL    NOT NULL,
        total_return   REAL,
        annual_return  REAL,
        sharpe_ratio   REAL,
        sortino_ratio  REAL,
        max_drawdown   REAL,
        win_rate       REAL,
        final_equity   REAL,
        total_fills    INTEGER,
        snapshots      TEXT
      )
    `).run()
    const rows = db.prepare(`
      SELECT id, run_at, assets, days, risk_tier, initial_usdt,
             total_return, annual_return, sharpe_ratio, sortino_ratio,
             max_drawdown, win_rate, final_equity, total_fills
      FROM backtest_results ORDER BY run_at DESC LIMIT 20
    `).all()
    ok(res, rows)
  } catch {
    ok(res, [])
  }
}

async function handleApiBacktestDetail(id: string, res: ServerResponse) {
  try {
    const row = db.prepare(`
      SELECT * FROM backtest_results WHERE id = ?
    `).get(parseInt(id)) as any
    if (!row) { err(res, '回测记录不存在', 404); return }
    ok(res, {
      ...row,
      snapshots: row.snapshots ? JSON.parse(row.snapshots) : [],
    })
  } catch (e) {
    err(res, `获取回测详情失败: ${e}`, 500)
  }
}

async function handleApiBacktestRun(body: Record<string, unknown>, res: ServerResponse) {
  if (backtestRunning) {
    err(res, '已有回测正在运行，请等待完成', 409)
    return
  }

  const assets = (body.assets as string[] | undefined) ?? ['BTC-USDT', 'ETH-USDT']
  const days = Math.min(Math.max(parseInt(String(body.days ?? 30)), 7), 365)
  const riskTier = (['conservative', 'balanced', 'aggressive'].includes(String(body.riskTier))
    ? String(body.riskTier) : 'balanced') as BacktestConfig['riskTier']
  const initialUSDT = Math.min(Math.max(parseFloat(String(body.initialUSDT ?? 10000)), 100), 1000000)

  const btConfig: BacktestConfig = {
    assets,
    days,
    riskTier,
    initialUSDT,
    gridCount: 20,
    orderSizeUSDT: 10,
    rangeWidthPct: 5,
    stopLossPct: 10,
    takeProfitPct: 15,
  }

  backtestRunning = true
  console.log(`[Bridge] 开始回测: ${assets.join(',')} ${days}天 ${riskTier} $${initialUSDT}`)

  try {
    const result = await runBacktest(btConfig)
    backtestRunning = false
    console.log(`[Bridge] 回测完成: 收益${(result.totalReturn * 100).toFixed(2)}% Sharpe=${result.sharpeRatio}`)
    ok(res, {
      id: null,
      run_at: new Date().toISOString(),
      assets: assets.join(','),
      days,
      risk_tier: riskTier,
      initial_usdt: initialUSDT,
      total_return: result.totalReturn,
      annual_return: result.annualReturn,
      sharpe_ratio: result.sharpeRatio,
      sortino_ratio: result.sortinoRatio,
      max_drawdown: result.maxDrawdown,
      win_rate: result.winRate,
      final_equity: result.finalEquity,
      total_fills: result.totalFills,
      win_days: result.winDays,
      total_days: result.totalDays,
      snapshots: result.snapshots,
    })
  } catch (e) {
    backtestRunning = false
    console.error(`[Bridge] 回测失败:`, e)
    err(res, `回测失败: ${e}`, 500)
  }
}

// ── Request router ────────────────────────────────────────────────────────────

async function router(req: IncomingMessage, res: ServerResponse) {
  const method = req.method?.toUpperCase() ?? 'GET'
  const rawUrl = req.url ?? '/'
  const url    = new URL(rawUrl, 'http://127.0.0.1').pathname

  // CORS headers (for Paperclip dashboard)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const body = method === 'POST' ? await readBody(req) : {}

  try {
    if (method === 'POST' && url === '/heartbeat/market')           return await handleMarket(res)
    if (method === 'POST' && url === '/heartbeat/risk')             return await handleRisk(res)
    if (method === 'POST' && url === '/heartbeat/cto')              return await handleCTO(res)
    if (method === 'POST' && url === '/heartbeat/strategy-manager') return await handleStrategyManager(res)
    if (method === 'POST' && url === '/heartbeat/auditor')          return await handleAuditor(res)
    if (method === 'POST' && url === '/approval/tier3-reset')       return await handleApprovalTier3(body, res)
    if (method === 'POST' && url === '/approval/tier4-reset')       return await handleApprovalTier4(body, res)
    if (method === 'GET'  && url === '/status')                     return await handleStatus(res)
    if (method === 'GET'  && url === '/health')                     return ok(res, { status: 'ok', service: 'darwin-bridge' })

    // Dashboard
    if (method === 'GET'  && (url === '/' || url === '/dashboard')) return await handleDashboardPage(res)
    if (method === 'GET'  && url === '/showcase')                   return await handleShowcasePage(res)
    if (method === 'GET'  && url === '/api/market-states')         return await handleApiMarketStates(res)
    if (method === 'GET'  && url === '/api/strategies')            return await handleApiStrategies(res)
    if (method === 'GET'  && url === '/api/circuit-breaker')       return await handleApiCircuitBreaker(res)
    if (method === 'GET'  && url === '/api/allocations')           return await handleApiAllocations(res)
    if (method === 'GET'  && url === '/api/shadow-bots')           return await handleApiShadowBots(res)
    if (method === 'GET'  && url === '/api/history')               return await handleApiHistory(res)
    if (method === 'GET'  && url === '/api/account')               return await handleApiAccount(res)
    if (method === 'GET'  && url === '/api/positions')             return await handleApiPositions(res)
    if (method === 'GET'  && url === '/api/leaderboard')           return await handleApiLeaderboard(res)
    if (method === 'GET'  && url === '/api/events')                return await handleApiEvents(res)
    if (method === 'GET'  && url === '/api/reports/latest')        return await handleApiReportsLatest(res)
    if (method === 'GET'  && url === '/api/trades')               return await handleApiTrades(res)
    if (method === 'GET'  && url === '/api/reports')              return await handleApiReports(res)
    if (method === 'GET'  && url === '/api/config')               return await handleApiConfig(res)
    if (method === 'GET'  && url === '/api/cto-decisions')        return await handleApiCTODecisions(res)
    if (method === 'POST' && url === '/api/config/risk-tier')    return await handleApiSetRiskTier(body as Record<string, unknown>, res)
    if (method === 'GET'  && url === '/api/backtest/results')   return await handleApiBacktestResults(res)
    if (method === 'POST' && url === '/api/backtest/run')       return await handleApiBacktestRun(body as Record<string, unknown>, res)

    // Backtest detail by ID
    const btDetailMatch = url.match(/^\/api\/backtest\/(\d+)$/)
    if (method === 'GET' && btDetailMatch) return await handleApiBacktestDetail(btDetailMatch[1], res)

    // Strategy control endpoints
    const stratStartMatch = url.match(/^\/api\/strategy\/([^/]+)\/start$/)
    if (method === 'POST' && stratStartMatch) return await handleApiStrategyStart(stratStartMatch[1], res)
    const stratStopMatch = url.match(/^\/api\/strategy\/([^/]+)\/stop$/)
    if (method === 'POST' && stratStopMatch)  return await handleApiStrategyStop(stratStopMatch[1], res)

    // Strategy detail (must be after start/stop to avoid matching)
    const stratDetailMatch = url.match(/^\/api\/strategy\/([^/]+)$/)
    if (method === 'GET' && stratDetailMatch) return await handleApiStrategyDetail(stratDetailMatch[1], res)

    err(res, `Route not found: ${method} ${url}`, 404)
  } catch (e) {
    console.error(`[Bridge] Error on ${method} ${url}:`, e)
    err(res, `Internal error: ${e}`, 500)
  }
}

// ── Server startup ────────────────────────────────────────────────────────────

export async function startBridgeServer(): Promise<void> {
  // Load strategies on startup
  loadOfficialStrategies()

  return new Promise((resolve, reject) => {
    const server = createServer(router)
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`  \x1b[33m⚠\x1b[0m 端口 ${PORT} 已被占用，跳过桥接服务`)
        resolve()  // 非致命错误，继续运行
      } else {
        reject(err)
      }
    })
    server.listen(PORT, '127.0.0.1', () => {
      console.log(`\n  🌉 \x1b[1mPaperclip Bridge\x1b[0m  listening on \x1b[36mhttp://127.0.0.1:${PORT}\x1b[0m`)
      console.log(`  \x1b[2mPaperclip UI → http://127.0.0.1:3100\x1b[0m`)
      resolve()
    })
  })
}

// ── CLI entry point ───────────────────────────────────────────────────────────

const isMain = process.argv[1]?.includes('server')
if (isMain) {
  await startBridgeServer()
  console.log('  Bridge server running. Press Ctrl+C to stop.\n')
}
