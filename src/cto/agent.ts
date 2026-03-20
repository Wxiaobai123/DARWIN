/**
 * DARWIN CTO Agent
 *
 * Runs every hour. Detects market state changes and orchestrates
 * strategy mix transitions: which strategies to activate, pause,
 * or rebalance based on the current market regime.
 *
 * CTO = Chief Trading Officer — the brain that watches the other agents
 * and ensures the strategy portfolio stays aligned with market reality.
 */

import db from '../db.js'
import { config } from '../config.js'
import { getAllStrategies, getLeaderboard, getPerformance, type StrategyRecord } from '../strategy/archive.js'
import { startShadowBot, stopShadowBot } from '../shadow/runner.js'
import { isSystemHalted, isStrategyBlocked } from '../risk/circuit-breaker.js'
import { calculateAllocations } from './allocator.js'
import type { MarketState } from '../market/state-recognizer.js'
import { enrichCTODecision, listConfiguredProviders, type CTOLLMOutput, type AgentContext } from './llm.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CTODecision {
  timestamp:    string
  prevState:    MarketState | null
  currentState: MarketState
  stateChanged: boolean
  actions:      CTOAction[]
  rationale:    string
  llmInsight:   CTOLLMOutput | null   // enriched by Claude if API key available
}

export interface CTOAction {
  type:       'activate' | 'pause' | 'rebalance' | 'watchlist'
  strategyId: string
  name:       string
  reason:     string
}

// ── State cache ───────────────────────────────────────────────────────────────

interface CTOState {
  lastKnownState: MarketState | null
  lastDecisionAt: string | null
  consecutiveSame: number
}

const state: CTOState = {
  lastKnownState:  null,
  lastDecisionAt:  null,
  consecutiveSame: 0,
}

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const _C  = { reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m', cyan:'\x1b[36m', green:'\x1b[32m', yellow:'\x1b[33m', red:'\x1b[31m', magenta:'\x1b[35m' }
const _b  = (s: string) => `${_C.bold}${s}${_C.reset}`
const _cy = (s: string) => `${_C.cyan}${s}${_C.reset}`
const _gn = (s: string) => `${_C.green}${s}${_C.reset}`
const _yw = (s: string) => `${_C.yellow}${s}${_C.reset}`
const _rd = (s: string) => `${_C.red}${s}${_C.reset}`
const _mg = (s: string) => `${_C.magenta}${s}${_C.reset}`
const _dm = (s: string) => `${_C.dim}${s}${_C.reset}`

// ── Core logic ────────────────────────────────────────────────────────────────

/**
 * Get the latest confirmed market state from the DB
 * (uses the most recent 3-confirmation result stored by state-recognizer)
 */
function getLatestMarketState(): MarketState | null {
  // Filter by primary asset (config.assets[0]) for consistency with strategy manager
  const primaryAsset = config.assets[0]
  const row = db.prepare(`
    SELECT state FROM market_states
    WHERE asset = ?
    ORDER BY recorded_at DESC
    LIMIT 1
  `).get(primaryAsset) as { state: MarketState } | undefined

  return row?.state ?? null
}

/**
 * Determine which strategies should be active for a given market state.
 * Returns IDs of strategies that are appropriate for the state,
 * sorted by leaderboard score.
 */
function getTargetStrategies(marketState: MarketState): StrategyRecord[] {
  const all = getAllStrategies()
  return all.filter(s =>
    s.status !== 'eliminated' &&
    s.spec.conditions.market_states.includes(marketState)
  )
}

/**
 * Plan state-transition actions: what to start, stop, or watch.
 */
function planTransition(
  prevState:    MarketState | null,
  currentState: MarketState,
): CTOAction[] {
  const actions: CTOAction[] = []
  const allStrategies = getAllStrategies()

  for (const s of allStrategies) {
    if (s.status === 'eliminated') continue

    const fitsCurrentState = s.spec.conditions.market_states.includes(currentState)
    const fitsPrevState    = prevState ? s.spec.conditions.market_states.includes(prevState) : false

    if (fitsCurrentState && !fitsPrevState && s.status === 'shadow') {
      // Strategy becomes relevant — activate in shadow mode
      actions.push({
        type:       'activate',
        strategyId: s.id,
        name:       s.name,
        reason:     `State changed to ${currentState}, strategy conditions now match`,
      })
    } else if (!fitsCurrentState && fitsPrevState && s.status === 'live') {
      // Strategy no longer relevant for current state — demote to watchlist
      actions.push({
        type:       'pause',
        strategyId: s.id,
        name:       s.name,
        reason:     `State changed away from ${prevState}, strategy no longer active state`,
      })
    } else if (fitsCurrentState && s.status === 'shadow') {
      // Strategy already running in shadow for this state — maintain and watch
      actions.push({
        type:       'watchlist',
        strategyId: s.id,
        name:       s.name,
        reason:     `Continuing shadow observation in ${currentState} state`,
      })
    } else if (fitsCurrentState && s.status === 'live') {
      // Live strategy still relevant — consider rebalancing
      actions.push({
        type:       'rebalance',
        strategyId: s.id,
        name:       s.name,
        reason:     `Live strategy remains active in ${currentState} state`,
      })
    }
  }

  return actions
}

/**
 * Execute actions: start or stop shadow bots as needed.
 * Uses the allocator to determine proper sizing based on equity.
 */
async function executeActions(actions: CTOAction[], marketState: MarketState): Promise<void> {
  // Get current equity from DB for allocation-aware sizing
  let allocMap: Record<string, number> = {}
  try {
    const eqRow = db.prepare(
      'SELECT value FROM kv_store WHERE key = ?'
    ).get('account_equity') as { value: string } | undefined
    const equity = eqRow ? parseFloat(eqRow.value) : 10000

    // Read risk tier from DB
    const tierRow = db.prepare(
      'SELECT value FROM kv_store WHERE key = ?'
    ).get('risk_tier') as { value: string } | undefined
    const riskTier = (tierRow?.value ?? 'balanced') as 'conservative' | 'balanced' | 'aggressive'

    const plan = calculateAllocations(equity, marketState, riskTier)
    for (const a of plan.allocations) {
      allocMap[a.strategyId] = a.allocUSDT
    }
  } catch {
    // Fallback: no allocation info — bots use YAML defaults
  }

  for (const action of actions) {
    if (action.type === 'activate') {
      // Circuit breaker gate — block activations during active breakers
      if (isSystemHalted() || isStrategyBlocked(action.strategyId)) {
        console.warn(`  ${_yw('⚠')}  CTO: Skipping "${action.name}" — circuit breaker active`)
        continue
      }
      try {
        const allocUSDT = allocMap[action.strategyId]
        await startShadowBot(action.strategyId, allocUSDT)
      } catch (err) {
        console.warn(`  ${_yw('⚠')}  CTO: Failed to activate "${action.name}": ${err}`)
      }
    } else if (action.type === 'pause') {
      try {
        stopShadowBot(action.strategyId)
        const { setStrategyStatus } = await import('../strategy/archive.js')
        setStrategyStatus(action.strategyId, 'paused')
        console.log(`  ⏸  CTO: Paused "${action.name}"`)
      } catch (err) {
        console.warn(`  ${_yw('⚠')}  CTO: Failed to pause "${action.name}": ${err}`)
      }
    }
  }
}

/**
 * Build human-readable rationale for the decision
 */
function buildRationale(
  stateChanged:  boolean,
  prevState:     MarketState | null,
  currentState:  MarketState,
  actions:       CTOAction[],
): string {
  if (!stateChanged) {
    const relevant = actions.filter(a => a.type === 'watchlist' || a.type === 'rebalance')
    return `Market state stable at ${currentState.toUpperCase()}. ` +
           `Monitoring ${relevant.length} active strategies. No adjustments needed.`
  }

  const activated = actions.filter(a => a.type === 'activate')
  const paused    = actions.filter(a => a.type === 'pause')

  let msg = `State transition: ${(prevState ?? 'unknown').toUpperCase()} → ${currentState.toUpperCase()}. `

  if (activated.length > 0) {
    msg += `Activating ${activated.length} strategy(s) for new regime: ` +
           activated.map(a => a.name).join(', ') + '. '
  }
  if (paused.length > 0) {
    msg += `${paused.length} strategy(s) moved to watchlist (no longer state-matched): ` +
           paused.map(a => a.name).join(', ') + '. '
  }
  if (currentState === 'extreme') {
    msg += 'DARWIN switching to defensive mode. All non-defensive strategies paused.'
  } else if (currentState === 'trend') {
    msg += 'Trending regime detected. Shifting to wider-range, momentum-aligned strategies.'
  } else {
    msg += 'Oscillation regime confirmed. Grid strategies prioritised for range capture.'
  }

  return msg
}

/**
 * Save decision to DB for audit trail
 */
function saveDecision(decision: CTODecision): void {
  try {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS cto_decisions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        decided_at    TEXT    NOT NULL DEFAULT (datetime('now')),
        prev_state    TEXT,
        current_state TEXT    NOT NULL,
        state_changed INTEGER NOT NULL,
        actions       TEXT    NOT NULL,
        rationale     TEXT    NOT NULL,
        llm_insight   TEXT
      )
    `).run()

    db.prepare(`
      INSERT INTO cto_decisions (decided_at, prev_state, current_state, state_changed, actions, rationale, llm_insight)
      VALUES (datetime('now'), ?, ?, ?, ?, ?, ?)
    `).run(
      decision.prevState,
      decision.currentState,
      decision.stateChanged ? 1 : 0,
      JSON.stringify(decision.actions),
      decision.rationale,
      decision.llmInsight ? JSON.stringify(decision.llmInsight) : null,
    )
  } catch {
    // Non-fatal
  }
}

// ── LLM context builder ───────────────────────────────────────────────────────

function buildLLMInput(
  currentState:  MarketState,
  prevState:     MarketState | null,
  stateChanged:  boolean,
) {
  const allStrategies = getAllStrategies()

  // Latest ATR ratios from DB
  const atrRatios: Record<string, number> = {}
  try {
    const rows = db.prepare(`
      SELECT asset, indicators FROM market_states
      WHERE recorded_at >= datetime('now', '-30 minutes')
      ORDER BY recorded_at DESC
    `).all() as Array<{ asset: string; indicators: string }>

    const seen = new Set<string>()
    for (const row of rows) {
      if (seen.has(row.asset)) continue
      seen.add(row.asset)
      try {
        const ind = JSON.parse(row.indicators) as { atrRatio?: number }
        if (typeof ind.atrRatio === 'number') atrRatios[row.asset] = ind.atrRatio
      } catch {}
    }
  } catch {}

  // Circuit breaker state (read from DB to avoid circular imports)
  const cbState = (() => {
    try {
      const row = db.prepare(
        'SELECT tiers_active, system_halted FROM circuit_breaker_state LIMIT 1'
      ).get() as { tiers_active: string; system_halted: number } | undefined
      const tiers: number[] = row?.tiers_active ? JSON.parse(row.tiers_active) : []
      return { activeTiers: tiers, systemHalted: (row?.system_halted ?? 0) === 1 }
    } catch { return { activeTiers: [] as number[], systemHalted: false } }
  })()

  // Strategy performance summary
  const strategies = allStrategies
    .filter(s => s.status !== 'eliminated')
    .map(s => {
      const perfs    = getPerformance(s.id)
      const trades   = perfs.reduce((n, p) => n + p.trades, 0)
      const winRate  = trades > 0
        ? perfs.reduce((n, p) => n + p.winning_trades, 0) / trades : 0
      const returns  = perfs.map(p => p.total_return)
      const avgRet   = returns.length > 0 ? returns.reduce((a, b) => a + b) / returns.length : 0
      const variance = returns.length > 1
        ? returns.reduce((s, r) => s + (r - avgRet) ** 2, 0) / returns.length : 0.01
      const sharpe   = variance > 0 ? Math.min(avgRet / Math.sqrt(variance), 3) : 0
      const score    = winRate * 0.4 + Math.max(0, sharpe / 3) * 0.3 +
                       (s.spec.conditions.market_states.includes(currentState) ? 1.0 : 0.3) * 0.2 + 0.1

      return {
        name:   s.name,
        status: s.status,
        score,
        asset:  s.spec.conditions.assets[0] ?? 'UNKNOWN',
        states: s.spec.conditions.market_states,
        trades,
        winRate,
      }
    })
    .sort((a, b) => b.score - a.score)

  // Rough allocation preview
  const deployed   = strategies.filter(s => s.status === 'live').length
  const total      = strategies.length
  const deployedPct = total > 0 ? deployed / total * 0.5 : 0
  const topStrategy = strategies[0]?.name ?? null

  return {
    marketState:   currentState,
    prevState,
    stateChanged,
    strategies,
    allocation: {
      deployedPct,
      reservePct: 1 - deployedPct,
      topStrategy,
    },
    circuitBreaker: {
      activeTiers: cbState.activeTiers,
      halted:      cbState.systemHalted,
    },
    atrRatios,
  }
}

// ── Agent context reader (BettaFish ForumHost injection pattern) ──────────────
//
// Reads the latest Risk Agent and Auditor outputs from DB to inject into
// the CTO LLM prompt — so the LLM sees what other agents observed.

function readAgentContext(): AgentContext {
  const ctx: AgentContext = {}

  try {
    // Latest risk check result
    const riskRow = db.prepare(`
      SELECT tiers_active, system_halted, last_updated FROM circuit_breaker_state LIMIT 1
    `).get() as { tiers_active: string; system_halted: number; last_updated?: string } | undefined

    if (riskRow) {
      const tiers = riskRow.tiers_active ? JSON.parse(riskRow.tiers_active) as number[] : []
      const halted = (riskRow.system_halted ?? 0) === 1
      ctx.riskSummary = halted
        ? 'SYSTEM HALTED — awaiting manual approval'
        : tiers.length > 0
          ? `Circuit breaker tiers [${tiers.join(',')}] active — reduced position limits`
          : 'All clear — no circuit breakers active'
    }
  } catch {}

  try {
    // Latest auditor report (last 200 chars of most recent saved report)
    const auditRow = db.prepare(`
      SELECT content FROM daily_reports ORDER BY created_at DESC LIMIT 1
    `).get() as { content: string } | undefined

    if (auditRow?.content) {
      // Extract first meaningful line from the report
      const lines = auditRow.content.split('\n').filter(l => l.trim().length > 10)
      ctx.auditorNote = lines[0]?.slice(0, 200) ?? undefined
    }
  } catch {}

  return ctx
}

// ── Main CTO heartbeat ────────────────────────────────────────────────────────

export async function runCTOHeartbeat(
  overrideState?: MarketState,   // for testing / demo scenarios
): Promise<CTODecision> {

  const currentState = overrideState ?? getLatestMarketState() ?? 'oscillation'
  const prevState    = state.lastKnownState
  const stateChanged = prevState !== null && prevState !== currentState

  // Determine rule-based actions (always runs — deterministic constraints first)
  const actions         = planTransition(prevState, currentState)
  const baseRationale   = buildRationale(stateChanged, prevState, currentState, actions)

  // Optional: enrich with LLM insight (graceful fallback if API unavailable)
  // Inject latest Risk Agent + Auditor context (BettaFish ForumHost pattern)
  const llmInput   = buildLLMInput(currentState, prevState, stateChanged)
  const agentCtx   = readAgentContext()
  const llmInsight = await enrichCTODecision(llmInput, agentCtx).catch(() => null)

  // Combine: use LLM rationale if available, otherwise rule-based
  const rationale = llmInsight
    ? `[AI] ${llmInsight.rationale}  ${llmInsight.riskComment ? `⚠ ${llmInsight.riskComment}` : ''}`
    : baseRationale

  const decision: CTODecision = {
    timestamp:    new Date().toISOString(),
    prevState,
    currentState,
    stateChanged,
    actions,
    rationale,
    llmInsight,
  }

  // Execute state-change actions
  if (stateChanged) {
    await executeActions(actions, currentState)
  }

  // Update state
  state.lastKnownState  = currentState
  state.lastDecisionAt  = decision.timestamp
  state.consecutiveSame = stateChanged ? 0 : state.consecutiveSame + 1

  saveDecision(decision)
  return decision
}

// ── Display ───────────────────────────────────────────────────────────────────

export function printCTODecision(decision: CTODecision): void {
  const stateColor = decision.currentState === 'oscillation' ? _yw
                   : decision.currentState === 'trend'        ? _gn
                   : _rd

  console.log()
  console.log(
    `  ${_mg('🤖')} ${_b('CTO Agent')}  ` +
    `State: ${stateColor(decision.currentState.toUpperCase())}` +
    (decision.stateChanged && decision.prevState
      ? `  ${_dm('(' + decision.prevState.toUpperCase() + ' →')} ${stateColor(decision.currentState.toUpperCase() + ')')}`
      : ''
    )
  )

  if (decision.stateChanged) {
    console.log(`  ${_cy('⚡ STATE CHANGE DETECTED')}`)
  }

  // Show actions
  const active = decision.actions.filter(a => a.type !== 'watchlist')
  if (active.length > 0) {
    for (const a of active) {
      const icon = a.type === 'activate'   ? _gn('▲ ACTIVATE')
                 : a.type === 'pause'      ? _rd('▼ PAUSE   ')
                 : a.type === 'rebalance'  ? _cy('↺ REBALANCE')
                 : _dm('◉ WATCHLIST')
      console.log(`    ${icon}  ${a.name}  ${_dm(a.reason)}`)
    }
  }

  // LLM insight or rule-based rationale
  if (decision.llmInsight) {
    const providerTag = _dm(`[${decision.llmInsight.provider}]`)
    console.log(`    ${_mg('✦ AI')} ${providerTag}  ${decision.llmInsight.rationale.slice(0, 120)}`)
    if (decision.llmInsight.riskComment) {
      console.log(`    ${_yw('⚠')}  ${_dm(decision.llmInsight.riskComment)}`)
    }
    if (decision.llmInsight.priority.length > 0) {
      console.log(`    ${_dm('Priority: ' + decision.llmInsight.priority.join(' → '))}`)
    }
  } else {
    console.log(`    ${_dm(decision.rationale.slice(0, 100) + (decision.rationale.length > 100 ? '…' : ''))}`)
  }
}

// ── CLI entry point ───────────────────────────────────────────────────────────

const isMain = process.argv[1]?.includes('agent')
if (isMain) {
  const providers = listConfiguredProviders()
  if (providers.length > 0) {
    console.log(`  ${_dm('LLM providers: ' + providers.join(' → '))}`)
  } else {
    console.log(`  ${_dm('No LLM configured — running rule-based only')}`)
    console.log(`  ${_dm('Set ANTHROPIC_API_KEY / OPENAI_API_KEY / DEEPSEEK_API_KEY / OLLAMA_BASE_URL to enable')}`)
  }
  const decision = await runCTOHeartbeat()
  printCTODecision(decision)
}
