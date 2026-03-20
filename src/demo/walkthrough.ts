/**
 * Walkthrough launcher
 *
 * A structured runtime walkthrough for the main operating loop.
 *
 *   pnpm run demo:walkthrough       # run A -> B -> C
 *   pnpm run demo:walkthrough a     # run only scenario A
 *   pnpm run demo:walkthrough b     # run only scenario B
 *   pnpm run demo:walkthrough c     # run only scenario C
 *   pnpm run demo:walkthrough -- --deterministic  # fixture-backed walkthrough
 */

import { recognizeState, type MarketState } from '../market/state-recognizer.js'
import { account } from '../atk/account.js'
import { saveAndPrintReport } from '../report/generator.js'
import { getState, resetTier3, triggerTier3ForDemo } from '../risk/circuit-breaker.js'

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m',
  red: '\x1b[31m', magenta: '\x1b[35m',
}
const b  = (s: string) => `${C.bold}${s}${C.reset}`
const cy = (s: string) => `${C.cyan}${s}${C.reset}`
const gn = (s: string) => `${C.green}${s}${C.reset}`
const yw = (s: string) => `${C.yellow}${s}${C.reset}`
const rd = (s: string) => `${C.red}${s}${C.reset}`
const mg = (s: string) => `${C.magenta}${s}${C.reset}`
const dm = (s: string) => `${C.dim}${s}${C.reset}`
const args = process.argv.slice(2)
const DETERMINISTIC = args.includes('--deterministic') || args.includes('--fixture')

function section(title: string, icon: string): void {
  console.log()
  console.log(cy('  ╔' + '═'.repeat(62) + '╗'))
  console.log(cy('  ║ ') + b(`${icon}  ${title}`.padEnd(61)) + cy('║'))
  console.log(cy('  ╚' + '═'.repeat(62) + '╝'))
  console.log()
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function withMutedConsole<T>(fn: () => T): T {
  const oldLog = console.log
  const oldWarn = console.warn
  const oldError = console.error
  console.log = () => {}
  console.warn = () => {}
  console.error = () => {}
  try {
    return fn()
  } finally {
    console.log = oldLog
    console.warn = oldWarn
    console.error = oldError
  }
}

function stateLabel(state: MarketState): string {
  if (state === 'oscillation') return yw('OSCILLATION')
  if (state === 'trend') return gn('TREND')
  return rd('EXTREME')
}

function strategyPack(state: MarketState): Array<{ name: string; role: string; tag: string }> {
  if (state === 'trend') {
    return [
      { name: '趋势追踪', role: 'Primary', tag: 'swap + trailing stop' },
      { name: '合约网格', role: 'Secondary', tag: 'wider trend-aligned range' },
      { name: '资金费率套利', role: 'Hedge', tag: 'delta-neutral carry' },
    ]
  }
  if (state === 'extreme') {
    return [
      { name: '极端行情防守哨兵', role: 'Primary', tag: 'monitor + defense' },
      { name: '现货网格', role: 'De-emphasized', tag: 'range capture paused down' },
      { name: '趋势追踪', role: 'De-emphasized', tag: 'new entries blocked first' },
    ]
  }
  return [
    { name: '现货网格', role: 'Primary', tag: 'range capture on spot' },
    { name: '合约网格', role: 'Secondary', tag: 'leveraged range capture' },
    { name: '资金费率套利', role: 'Hedge', tag: 'carry while staying neutral' },
  ]
}

function allocationPack(state: MarketState): Array<{ name: string; pct: number }> {
  if (state === 'trend') {
    return [
      { name: '趋势追踪', pct: 0.16 },
      { name: '合约网格', pct: 0.12 },
      { name: '资金费率套利', pct: 0.08 },
    ]
  }
  if (state === 'extreme') {
    return [
      { name: '极端行情防守哨兵', pct: 0.05 },
    ]
  }
  return [
    { name: '现货网格', pct: 0.15 },
    { name: '合约网格', pct: 0.12 },
    { name: '资金费率套利', pct: 0.08 },
  ]
}

function printHeader(): void {
  console.clear()
  console.log()
  console.log(cy('  ╔' + '═'.repeat(72) + '╗'))
  console.log(cy('  ║ ') + b('DARWIN Walkthrough'.padEnd(71)) + cy('║'))
  console.log(cy('  ╠' + '═'.repeat(72) + '╣'))
  console.log(cy('  ║ ') + 'Local walkthrough for the operating model and runtime behavior'.padEnd(71) + cy('║'))
  console.log(cy('  ╚' + '═'.repeat(72) + '╝'))
  console.log()
  console.log(`  ${b('System summary:')} DARWIN coordinates market interpretation, execution, risk controls, and reporting.`)
  console.log(`  ${dm('market interpretation -> strategy switching -> ATK execution -> circuit breaker -> reporting')}`)
  console.log()
  console.log(`  ${b('Suggested local workflow:')}`)
  console.log(`  ${cy('1.')} pnpm run overview`)
  console.log(`  ${cy('2.')} pnpm run bridge`)
  console.log(`  ${cy('3.')} pnpm run verify`)
  if (DETERMINISTIC) {
    console.log(`  ${dm('Running in deterministic fixture mode.')}`)
  }
  console.log()
}

async function currentStateSnapshot(): Promise<{ state: MarketState; confidence: number }> {
  if (DETERMINISTIC) {
    return { state: 'oscillation', confidence: 0.81 }
  }
  try {
    const r = await recognizeState('BTC-USDT')
    return { state: r.state, confidence: r.confidence }
  } catch {
    return { state: 'oscillation', confidence: 0.6 }
  }
}

async function scenarioA(): Promise<void> {
  section('Scenario A — Normal Operation', '📡')
  console.log(`  ${b('Goal:')} summarize the main operating loop in one sequence`)
  console.log()

  const snap = await currentStateSnapshot()
  console.log(`  ${mg('Market state')}: BTC-USDT is currently ${stateLabel(snap.state)}  ${dm(`confidence ${Math.round(snap.confidence * 100)}%`)}`)
  console.log(`  ${mg('Interpretation')}: DARWIN evaluates market context before selecting an operating posture.`)
  await sleep(900)

  console.log()
  console.log(`  ${b('Active strategy pack for this regime:')}`)
  for (const item of strategyPack(snap.state)) {
    const role = item.role === 'Primary' ? gn(item.role) : item.role === 'Secondary' ? yw(item.role) : dm(item.role)
    console.log(`  ${cy('•')} ${item.name}  ${role}  ${dm(`(${item.tag})`)}`)
  }
  await sleep(900)

  let equity = 0
  if (!DETERMINISTIC) {
    try { equity = account.totalEquityUSDT() } catch {}
  }
  if (equity <= 0) equity = 20_000

  console.log()
  console.log(`  ${b('Illustrative capital plan')}  ${dm(`(equity baseline: $${Math.round(equity)})`)}`)
  for (const item of allocationPack(snap.state)) {
    const usdt = Math.round(equity * item.pct)
    console.log(`  ${cy('•')} ${item.name.padEnd(10)}  ${String(Math.round(item.pct * 100)).padStart(2)}%  ${gn('$' + usdt)}`)
  }
  await sleep(900)

  const excerpt = DETERMINISTIC
    ? [
      'Market: BTC is in Oscillation and ETH is in Oscillation.',
      'Strategy posture: Spot Grid primary, Contract Grid secondary, Funding Arb hedge.',
      'Risk status: no breaker tiers active; deployment remains inside the balanced envelope.',
      'Tomorrow outlook: range-bound conditions still favor grid harvesting while reserve capital stays available.',
    ].join('\n')
    : saveAndPrintReport()
      .split('\n')
      .filter(line =>
        line.trim() &&
        !line.includes('策略表现') &&
        !line.includes('风控提示') &&
        !line.includes('熔断保护')
      )
      .slice(0, 4)
      .join('\n')
  console.log()
  console.log(`  ${b('Report excerpt:')}`)
  console.log(dm('  ' + '─'.repeat(58)))
  console.log(excerpt.split('\n').map(line => `  ${line}`).join('\n'))
  console.log(dm('  ' + '─'.repeat(58)))
  console.log()
  console.log(gn('  ✓ Scenario A complete — main operating loop summarized'))
}

async function scenarioB(): Promise<void> {
  section('Scenario B — State-Aware Strategy Switching', '⚡')
  console.log(`  ${b('Goal:')} show that DARWIN adjusts posture with market regime changes`)
  console.log()

  const states: Array<{ state: MarketState; note: string }> = [
    { state: 'oscillation', note: 'range-bound market, grids preferred' },
    { state: 'trend', note: 'ATR and directional pressure rise' },
    { state: 'oscillation', note: 'trend cools, grid mix restored' },
  ]

  for (const [idx, item] of states.entries()) {
    console.log(`  ${cy(String(idx + 1) + '.')} ${stateLabel(item.state)}  ${dm(item.note)}`)
    for (const s of strategyPack(item.state)) {
      console.log(`     ${cy('→')} ${s.name}  ${dm(`(${s.role})`)}`)
    }
    await sleep(1000)
  }

  console.log()
  console.log(gn('  ✓ Scenario B complete — strategy mix adapts to regime changes'))
}

async function scenarioC(): Promise<void> {
  section('Scenario C — Circuit Breaker and Safe Recovery', '🛡')
  console.log(`  ${b('Goal:')} show risk-first controls instead of blind execution`)
  console.log()

  const before = getState()
  console.log(`  ${cy('Before trigger:')} tiers=${JSON.stringify(before.activeTiers)}  halted=${before.systemHalted}`)
  await sleep(700)

  withMutedConsole(() => triggerTier3ForDemo())
  const active = getState()
  console.log(`  ${rd('After trigger:')} tiers=${JSON.stringify(active.activeTiers)}  assets=${JSON.stringify(active.affectedAssets)}  strategies=${JSON.stringify(active.affectedStrategies)}`)
  console.log(`  ${yw('Meaning:')} new entries are blocked until a user-approved reset.`)
  await sleep(1200)

  withMutedConsole(() => resetTier3('walkthrough'))
  const after = getState()
  console.log(`  ${gn('After reset:')} tiers=${JSON.stringify(after.activeTiers)}  halted=${after.systemHalted}`)
  console.log()
  console.log(gn('  ✓ Scenario C complete — halt and recovery lifecycle demonstrated'))
}

async function runAll(): Promise<void> {
  await sleep(800)
  await scenarioA()
  await sleep(1200)
  await scenarioB()
  await sleep(1200)
  await scenarioC()
  console.log()
  console.log(`  ${gn('✓ Walkthrough complete')}`)
  console.log(`  ${dm('Use `pnpm run overview` for the local system summary, `pnpm run verify` for the OKX demo integration path, and this walkthrough for a narrated runtime sequence.')}`)
  console.log()
}

const modeArg = args.find(arg => !arg.startsWith('--')) ?? 'all'
const mode = modeArg.toLowerCase()

printHeader()

if (mode === 'all') await runAll()
else if (mode === 'a') await scenarioA()
else if (mode === 'b') await scenarioB()
else if (mode === 'c') await scenarioC()
else {
  console.log('Usage: pnpm run demo:walkthrough [a|b|c] [--deterministic]')
  console.log('  no arg = run full A -> B -> C sequence')
  process.exit(1)
}
