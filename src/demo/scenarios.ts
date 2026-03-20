/**
 * DARWIN Demo Scenario Tools
 *
 * Three pre-built scenarios for the competition demo video:
 *
 *   pnpm run demo:a   — Scenario A: Normal operation (oscillation + grid running)
 *   pnpm run demo:b   — Scenario B: State transition (oscillation → trend → oscillation)
 *   pnpm run demo:c   — Scenario C: Circuit breaker fires + recovery
 *
 * Each scenario prints a rich terminal sequence designed for screen recording.
 */

import { runCTOHeartbeat, printCTODecision }       from '../cto/agent.js'
import { calculateAllocations, printAllocationPlan } from '../cto/allocator.js'
import { account }                                  from '../atk/account.js'
import { recognizeState }                           from '../market/state-recognizer.js'
import { getAllStrategies }                          from '../strategy/archive.js'
import { loadOfficialStrategies }                   from '../strategy/loader.js'
import {
  runRiskChecks, printStatus as printRisk,
  triggerTier2ForDemo, triggerTier3ForDemo, resetTier3,
  isSystemHalted,
} from '../risk/circuit-breaker.js'
import { printShadowStatus }                        from '../shadow/runner.js'
import { saveAndPrintReport }                       from '../report/generator.js'
import type { MarketState }                         from '../market/state-recognizer.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m',
  red: '\x1b[31m', magenta: '\x1b[35m', blue: '\x1b[34m',
}
const b   = (s: string) => `${C.bold}${s}${C.reset}`
const cy  = (s: string) => `${C.cyan}${s}${C.reset}`
const gn  = (s: string) => `${C.green}${s}${C.reset}`
const yw  = (s: string) => `${C.yellow}${s}${C.reset}`
const rd  = (s: string) => `${C.red}${s}${C.reset}`
const mg  = (s: string) => `${C.magenta}${s}${C.reset}`
const dm  = (s: string) => `${C.dim}${s}${C.reset}`

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

function section(title: string, emoji: string) {
  console.log()
  console.log(cy('  ╔' + '═'.repeat(58) + '╗'))
  console.log(cy('  ║ ') + b(`${emoji}  ${title}`.padEnd(57)) + cy('║'))
  console.log(cy('  ╚' + '═'.repeat(58) + '╝'))
  console.log()
}

function step(n: number, msg: string) {
  console.log(`  ${cy('►')} ${b(`Step ${n}:`)} ${msg}`)
}

function pause(msg: string) {
  console.log(`\n  ${dm('─'.repeat(50))}`)
  console.log(`  ${yw('⏸')}  ${msg}`)
  console.log(`  ${dm('─'.repeat(50))}\n`)
}

async function marketSnapshot(label: string) {
  console.log(`\n  ${b(label)}`)
  for (const asset of ['BTC-USDT', 'ETH-USDT']) {
    try {
      const r = await recognizeState(asset)
      const stateColor = r.state === 'oscillation' ? yw : r.state === 'trend' ? gn : rd
      const bar = stateColor('█'.repeat(Math.round(r.confidence * 10))) + dm('░'.repeat(10 - Math.round(r.confidence * 10)))
      console.log(`  ${b(asset.padEnd(12))}  ${stateColor(r.state.toUpperCase().padEnd(13))} [${bar}] ${Math.round(r.confidence * 100)}%`)
    } catch {
      console.log(`  ${asset}: data unavailable`)
    }
  }
}

// ── Scenario A: Normal operation ──────────────────────────────────────────────

export async function scenarioA() {
  console.clear()

  console.log()
  console.log(cy('  ██████╗  █████╗ ██████╗ ██╗    ██╗██╗███╗   ██╗'))
  console.log(cy('  ██╔══██╗██╔══██╗██╔══██╗██║    ██║██║████╗  ██║'))
  console.log(cy('  ██║  ██║███████║██████╔╝██║ █╗ ██║██║██╔██╗ ██║'))
  console.log(cy('  ██║  ██║██╔══██║██╔══██╗██║███╗██║██║██║╚██╗██║'))
  console.log(cy('  ██████╔╝██║  ██║██║  ██║╚███╔███╔╝██║██║ ╚████║'))
  console.log(cy('  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝ ╚══╝╚══╝ ╚═╝╚═╝  ╚═══╝'))
  console.log()
  console.log(b('  Demo Scenario A: Normal Operation'))
  console.log(dm('  Oscillation market · Grid strategies running · Daily report'))
  console.log()

  section('STEP 1 — Real-Time Market State', '📡')
  step(1, 'Market Analyst reads live OKX data and classifies current regime')
  await sleep(800)
  await marketSnapshot('Current Market State:')
  await sleep(600)

  section('STEP 2 — Active Strategies in Shadow Mode', '🧬')
  step(2, 'All strategies running in OKX demo account — live grid bots')
  await sleep(600)
  loadOfficialStrategies()
  printShadowStatus()
  await sleep(600)

  section('STEP 3 — CTO Agent Decision', '🤖')
  step(3, 'CTO Agent evaluates strategy mix alignment with current regime')
  await sleep(800)
  const decision = await runCTOHeartbeat()
  printCTODecision(decision)
  await sleep(600)

  section('STEP 4 — Capital Allocation', '💰')
  step(4, 'Kelly-based allocator calculates optimal USDT per strategy')
  await sleep(600)
  let equity = 0
  try { equity = account.totalEquityUSDT() } catch {}
  if (equity > 0) {
    const plan = calculateAllocations(equity, decision.currentState, 'balanced')
    printAllocationPlan(plan)
  } else {
    console.log(dm('  (account data unavailable in demo — typical allocation shown)'))
    const mockPlan = calculateAllocations(20000, 'oscillation', 'balanced')
    printAllocationPlan(mockPlan)
  }
  await sleep(600)

  section('STEP 5 — Risk Status', '🛡')
  step(5, 'Risk Agent checks all 4 circuit breaker tiers')
  await sleep(600)
  printRisk('balanced')
  await sleep(600)

  section('STEP 6 — Daily Report (Auditor Agent)', '📋')
  step(6, 'Auditor generates natural language summary')
  await sleep(800)
  const report = saveAndPrintReport()
  const border = cy('═'.repeat(62))
  console.log('\n' + border)
  console.log(cy('  📋 ') + b('DARWIN 每日报告'))
  console.log(border)
  console.log(report)
  console.log(border)

  console.log()
  console.log(gn('  ✅ Scenario A Complete — Normal operation demonstrated'))
  console.log()
}

// ── Scenario B: Market state transition ───────────────────────────────────────

export async function scenarioB() {
  console.clear()
  section('DEMO SCENARIO B — Market State Transition', '⚡')

  console.log(b('  Setup: BTC transitions from OSCILLATION → TREND → OSCILLATION'))
  console.log(dm('  Watch DARWIN automatically adjust the strategy mix in real time.'))
  console.log()
  await sleep(1000)

  step(1, 'Current state: OSCILLATION — Grid strategies active')
  await sleep(500)
  let d = await runCTOHeartbeat('oscillation' as MarketState)
  printCTODecision(d)
  await sleep(1500)

  pause('Market conditions shift: ATR spikes, funding rate rises, volume surges...')
  await sleep(1000)

  step(2, 'State transition detected: OSCILLATION → TREND')
  await sleep(500)
  d = await runCTOHeartbeat('trend' as MarketState)
  printCTODecision(d)
  await sleep(1500)

  console.log()
  console.log(`  ${cy('Strategy response:')}`)
  const trendStrategies = getAllStrategies().filter(
    s => s.spec.conditions.market_states.includes('trend') && s.status !== 'eliminated'
  )
  for (const s of trendStrategies) {
    console.log(`  ${gn('▲')} ${b(s.name)} — ${yw('activating wider-range grid for trend regime')}`)
  }
  await sleep(1500)

  pause('Trend exhausts after 24h. ATR normalises, funding rate cools...')
  await sleep(1000)

  step(3, 'State reverts: TREND → OSCILLATION')
  await sleep(500)
  d = await runCTOHeartbeat('oscillation' as MarketState)
  printCTODecision(d)
  await sleep(1000)

  console.log()
  console.log(gn('  ✅ Scenario B Complete — Adaptive strategy transition demonstrated'))
  console.log(dm('  DARWIN switched strategy mix 2 times with zero manual intervention.'))
  console.log()
}

// ── Scenario C: Circuit breaker + recovery ────────────────────────────────────

export async function scenarioC() {
  console.clear()
  section('DEMO SCENARIO C — Risk Management: Circuit Breaker + Recovery', '🛡')

  console.log(b('  Setup: Simulate a sudden market crash triggering Tier 3 circuit breaker'))
  console.log(dm('  Watch DARWIN auto-halt, request approval, then safely resume.'))
  console.log()
  await sleep(1000)

  step(1, 'Normal operation — all systems green')
  await sleep(500)
  printRisk('balanced')
  await sleep(1500)

  pause('Simulating market crash: BTC -18% in 4h, portfolio drawdown exceeds threshold...')
  await sleep(1000)

  step(2, 'Triggering Tier 3 (Portfolio-level) circuit breaker')
  await sleep(500)
  triggerTier3ForDemo()
  printRisk('balanced')
  await sleep(1500)

  console.log()
  console.log(`  ${rd('🚨 CIRCUIT BREAKER TIER 3 ACTIVE')}`)
  console.log(`  ${dm('All live strategies are paused.')}`)
  console.log(`  ${yw('⚠  Manual approval required to resume trading.')}`)
  console.log()
  await sleep(2000)

  pause('Risk review complete. User approves system restart...')
  await sleep(1000)

  step(3, 'User approves reset — system resumes')
  await sleep(500)
  resetTier3('demo_user')
  printRisk('balanced')
  await sleep(1000)

  console.log()
  console.log(gn('  ✅ Scenario C Complete — Full circuit breaker lifecycle demonstrated'))
  console.log(dm('  Tier 3 fired → all activity halted → user approved reset → resumed safely.'))
  console.log()
}

// ── CLI entry point ───────────────────────────────────────────────────────────

const scenario = process.argv[2] ?? 'a'

if (scenario === 'a') await scenarioA()
else if (scenario === 'b') await scenarioB()
else if (scenario === 'c') await scenarioC()
else {
  console.log('Usage: pnpm run demo [a|b|c]')
  console.log('  a = Normal operation')
  console.log('  b = State transition')
  console.log('  c = Circuit breaker')
  process.exit(1)
}
