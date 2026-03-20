/**
 * Local system overview
 *
 * Prints a repository-local, deterministic overview of the operating model
 * without requiring exchange credentials, network data, or seeded state.
 *
 *   pnpm run overview
 */

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
}

const b  = (s: string) => `${C.bold}${s}${C.reset}`
const cy = (s: string) => `${C.cyan}${s}${C.reset}`
const gn = (s: string) => `${C.green}${s}${C.reset}`
const yw = (s: string) => `${C.yellow}${s}${C.reset}`
const dm = (s: string) => `${C.dim}${s}${C.reset}`
const mg = (s: string) => `${C.magenta}${s}${C.reset}`

function section(title: string): void {
  console.log()
  console.log(cy('  ╔' + '═'.repeat(74) + '╗'))
  console.log(cy('  ║ ') + b(title.padEnd(73)) + cy('║'))
  console.log(cy('  ╚' + '═'.repeat(74) + '╝'))
  console.log()
}

const operatorObjective = 'Give me a conservative, local-first BTC/ETH posture that prefers range capture unless volatility clearly breaks into trend.'

const normalizedObjective = {
  riskTier: 'balanced',
  assets: ['BTC-USDT', 'ETH-USDT', 'SOL-USDT'],
  posture: 'Prefer oscillation-first strategy packs. Only expand directional risk after trend confirmation.',
  guardrails: [
    'Use demo-safe operating assumptions first',
    'Escalate through the 4-tier breaker model before adding exposure',
    'Keep reporting on the same rail as execution',
  ],
}

const regimeSnapshot = {
  dominantRegime: 'Oscillation',
  confidence: '81%',
  evidence: ['ATR 0.92x', 'Funding +0.0042%', 'Volume 1.11x', 'L/S 1.03'],
}

const strategyPack = [
  { name: 'Spot Grid', role: 'Primary', note: 'range capture on spot' },
  { name: 'Contract Grid', role: 'Secondary', note: 'leveraged bilateral range capture' },
  { name: 'Funding Arb', role: 'Hedge', note: 'delta-neutral carry posture' },
]

const atkLayer = [
  { area: 'ATK Market', detail: 'ATR / funding / volume / long-short ratio feed regime detection' },
  { area: 'ATK Account', detail: 'equity, positions, margin, and deployment snapshots constrain decisions' },
  { area: 'ATK Execution', detail: 'spot / swap / trailing-stop execution provides live entry and exit paths' },
  { area: 'ATK Bot + Algo', detail: 'grid, martingale, funding arb, TWAP, and iceberg stay on the same operating rail' },
]

const auditExcerpt = [
  'Market: BTC is in Oscillation, ETH is in Oscillation.',
  'Strategy posture: Spot Grid primary, Contract Grid secondary, Funding Arb hedge.',
  'Risk status: no breaker tiers active; deployment remains inside the balanced envelope.',
  'Tomorrow outlook: range-bound conditions still favor grid harvesting while reserve capital stays available for regime changes.',
]

console.clear()
console.log()
console.log(cy('  ╔' + '═'.repeat(74) + '╗'))
console.log(cy('  ║ ') + b('DARWIN Local Overview'.padEnd(73)) + cy('║'))
console.log(cy('  ╠' + '═'.repeat(74) + '╣'))
console.log(cy('  ║ ') + 'Repository-local deterministic output · no exchange credentials required'.padEnd(73) + cy('║'))
console.log(cy('  ╚' + '═'.repeat(74) + '╝'))

section('1. System Summary')
console.log(`  ${b('DARWIN coordinates market interpretation, strategy selection, live execution, risk controls, and reporting on one operating rail.')}`)
console.log(`  ${dm('This overview is designed for local inspection of the operating model before connecting a live or demo account.')}`)

section('2. Intent Pipeline')
console.log(`  ${mg('Operator objective')}:`)
console.log(`    ${operatorObjective}`)
console.log()
console.log(`  ${mg('Normalized operating objective')}:`)
console.log(`    riskTier   = ${normalizedObjective.riskTier}`)
console.log(`    assets     = ${normalizedObjective.assets.join(', ')}`)
console.log(`    posture    = ${normalizedObjective.posture}`)
for (const rule of normalizedObjective.guardrails) {
  console.log(`    ${cy('•')} ${rule}`)
}

section('3. Deterministic Market Snapshot')
console.log(`  ${yw('Dominant regime')}: ${regimeSnapshot.dominantRegime}  ${dm(`confidence ${regimeSnapshot.confidence}`)}`)
for (const item of regimeSnapshot.evidence) {
  console.log(`    ${cy('•')} ${item}`)
}

console.log()
console.log(`  ${b('Resulting strategy pack')}:`)
for (const item of strategyPack) {
  console.log(`    ${cy('•')} ${item.name.padEnd(14)} ${gn(item.role.padEnd(9))} ${dm(item.note)}`)
}

section('4. OKX Agent Trade Kit Integration')
for (const item of atkLayer) {
  console.log(`  ${b(item.area)}:`)
  console.log(`    ${item.detail}`)
}

section('5. Risk and Reporting')
console.log(`  ${b('Breaker posture')}: balanced tier, no active breaker resets required`)
console.log(`  ${b('Report excerpt')}:`)
for (const line of auditExcerpt) {
  console.log(`    ${line}`)
}

section('Next Commands')
console.log(`  ${cy('1.')} pnpm run overview     ${dm('# local operating overview')}`)
console.log(`  ${cy('2.')} pnpm run verify       ${dm('# OKX demo integration validation')}`)
console.log(`  ${cy('3.')} pnpm run bridge       ${dm('# local dashboard on http://localhost:3200')}`)
console.log()
