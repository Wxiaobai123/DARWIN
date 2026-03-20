/**
 * Guided demo launcher
 *
 * This is a curated product walkthrough, intentionally shorter and more
 * structured than the raw `demo:a|b|c` scenarios.
 *
 *   pnpm run demo:guided       # run A -> B -> C
 *   pnpm run demo:guided a     # run only scenario A
 *   pnpm run demo:guided b     # run only scenario B
 *   pnpm run demo:guided c     # run only scenario C
 */

import { recognizeState, type MarketState } from '../market/state-recognizer.js'
import { account } from '../atk/account.js'
import { saveAndPrintReport } from '../report/generator.js'
import { getState, resetTier3, triggerTier3ForDemo } from '../risk/circuit-breaker.js'

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m',
  red: '\x1b[31m', magenta: '\x1b[35m', blue: '\x1b[34m',
}
const b  = (s: string) => `${C.bold}${s}${C.reset}`
const cy = (s: string) => `${C.cyan}${s}${C.reset}`
const gn = (s: string) => `${C.green}${s}${C.reset}`
const yw = (s: string) => `${C.yellow}${s}${C.reset}`
const rd = (s: string) => `${C.red}${s}${C.reset}`
const mg = (s: string) => `${C.magenta}${s}${C.reset}`
const dm = (s: string) => `${C.dim}${s}${C.reset}`

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

function allocationPack(state: MarketState, equity: number): Array<{ name: string; pct: number }> {
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
  console.log(cy('  ║ ') + b('DARWIN Guided Demo'.padEnd(71)) + cy('║'))
  console.log(cy('  ╠' + '═'.repeat(72) + '╣'))
  console.log(cy('  ║ ') + 'Claw-driven · Risk-first · Built on OKX Agent Trade Kit'.padEnd(71) + cy('║'))
  console.log(cy('  ╚' + '═'.repeat(72) + '╝'))
  console.log()
  console.log(`  ${b('One-line thesis:')} DARWIN governs the full trading loop`)
  console.log(`  ${dm('natural-language objective -> market state -> strategy -> ATK execution -> circuit breaker -> report')}`)
  console.log()
  console.log(`  ${b('Fastest verification path:')}`)
  console.log(`  ${cy('1.')} pnpm run verify`)
  console.log(`  ${cy('2.')} pnpm run demo:guided`)
  console.log()
}

async function currentStateSnapshot(): Promise<{ state: MarketState; confidence: number }> {
  try {
    const r = await recognizeState('BTC-USDT')
    return { state: r.state, confidence: r.confidence }
  } catch {
    return { state: 'oscillation', confidence: 0.6 }
  }
}

async function scenarioA(): Promise<void> {
  section('Scenario A — Normal Operation', '📡')
  console.log(`  ${b('Goal:')} show the main DARWIN loop in one screenful`)
  console.log()

  const snap = await currentStateSnapshot()
  console.log(`  ${mg('Market state')}: BTC-USDT is currently ${stateLabel(snap.state)}  ${dm(`confidence ${Math.round(snap.confidence * 100)}%`)}`)
  console.log(`  ${mg('Interpretation')}: DARWIN uses live OKX market data before choosing any strategy.`)
  await sleep(900)

  console.log()
  console.log(`  ${b('Focused strategy pack for this regime:')}`)
  for (const item of strategyPack(snap.state)) {
    const role = item.role === 'Primary' ? gn(item.role) : item.role === 'Secondary' ? yw(item.role) : dm(item.role)
    console.log(`  ${cy('•')} ${item.name}  ${role}  ${dm(`(${item.tag})`)}`)
  }
  await sleep(900)

  let equity = 0
  try { equity = account.totalEquityUSDT() } catch {}
  if (equity <= 0) equity = 20_000

  console.log()
  console.log(`  ${b('Illustrative capital plan')}  ${dm(`(equity baseline: $${Math.round(equity)})`)}`)
  for (const item of allocationPack(snap.state, equity)) {
    const usdt = Math.round(equity * item.pct)
    console.log(`  ${cy('•')} ${item.name.padEnd(10)}  ${String(Math.round(item.pct * 100)).padStart(2)}%  ${gn('$' + usdt)}`)
  }
  await sleep(900)

  const report = saveAndPrintReport()
  const excerpt = report
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
  console.log(`  ${b('Auditor output excerpt:')}`)
  console.log(dm('  ' + '─'.repeat(58)))
  console.log(excerpt.split('\n').map(line => `  ${line}`).join('\n'))
  console.log(dm('  ' + '─'.repeat(58)))
  console.log()
  console.log(gn('  ✓ Scenario A complete — full loop summarized'))
}

async function scenarioB(): Promise<void> {
  section('Scenario B — State-Aware Strategy Switching', '⚡')
  console.log(`  ${b('Goal:')} prove DARWIN is not a fixed-strategy bot`)
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
  console.log(`  ${b('Goal:')} show risk-first behavior, not blind execution`)
  console.log()

  const before = getState()
  console.log(`  ${cy('Before trigger:')} tiers=${JSON.stringify(before.activeTiers)}  halted=${before.systemHalted}`)
  await sleep(700)

  withMutedConsole(() => triggerTier3ForDemo())
  const active = getState()
  console.log(`  ${rd('After trigger:')} tiers=${JSON.stringify(active.activeTiers)}  assets=${JSON.stringify(active.affectedAssets)}  strategies=${JSON.stringify(active.affectedStrategies)}`)
  console.log(`  ${yw('Meaning:')} new entries are blocked until a user-approved reset.`)
  await sleep(1200)

  withMutedConsole(() => resetTier3('guided_demo'))
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
  console.log(`  ${gn('✓ Guided demo complete')}`)
  console.log(`  ${dm('Use `pnpm run verify` as the hard proof, and this demo as the product walkthrough.')}`)
  console.log()
}

const mode = (process.argv[2] ?? 'all').toLowerCase()

printHeader()

if (mode === 'all') await runAll()
else if (mode === 'a') await scenarioA()
else if (mode === 'b') await scenarioB()
else if (mode === 'c') await scenarioC()
else {
  console.log('Usage: pnpm run demo:guided [a|b|c]')
  console.log('  no arg = run full A -> B -> C sequence')
  process.exit(1)
}
