/**
 * DARWIN Strategy Validator
 * Static validation of strategy YAML before it enters the shadow queue.
 */

export interface StrategySpec {
  metadata: {
    id:          string
    name:        string
    author:      string
    version:     string
    created_at:  string
    description: string
  }
  conditions: {
    market_states:        Array<'oscillation' | 'trend' | 'extreme'>
    assets:               string[]
    min_atr_ratio?:       number | null
    max_atr_ratio?:       number | null
    min_funding_rate?:    number | null
    max_funding_rate?:    number | null
    paused_during_events: string[]
  }
  execution: {
    tool:         string
    params:       Record<string, unknown>
    entry_signal: string
    exit_signal:  string
    max_hold_hours?: number | null
  }
  risk: {
    max_drawdown_pct:     number
    stop_loss_pct:        number
    take_profit_pct?:     number | null
    max_position_usdt?:   number | null
    pause_after_loss_days?: number | null
  }
  promotion: {
    min_shadow_days:          number
    min_trades:               number
    min_win_rate:             number
    max_realized_drawdown:    number
    min_days_per_state:       number
  }
  demotion: {
    live_drawdown_trigger_pct: number
    consecutive_loss_days:     number
  }
  elimination: {
    failed_shadow_attempts: number
  }
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] }

const ALLOWED_TOOLS = new Set([
  // Market data (read-only)
  'okx_market_ticker', 'okx_market_candles', 'okx_market_orderbook',
  'okx_market_funding_rate', 'okx_market_open_interest', 'okx_market_long_short_ratio',
  // Spot trading
  'okx_spot_order', 'okx_spot_cancel',
  // Futures trading
  'okx_futures_order', 'okx_futures_cancel',
  // Perpetual swap trading
  'okx_swap_place', 'okx_swap_close', 'okx_swap_trailing_stop',
  // Grid bots (spot + contract)
  'okx_grid_bot', 'okx_grid_bot_create', 'okx_grid_bot_stop', 'okx_grid_bot_query',
  'okx_contract_grid',
  // DCA / Martingale bots
  'okx_dca_bot', 'okx_dca_bot_create', 'okx_dca_bot_stop',
  // Algo orders (TP/SL/OCO)
  'okx_algo_order', 'okx_algo_cancel',
  // Composed strategies (DARWIN internal)
  'okx_recurring_buy', 'okx_funding_arb',
  // Order splitting (大单拆分)
  'okx_twap', 'okx_iceberg',
  // DEX
  'okx_dex_swap',
  // Portfolio / account
  'okx_portfolio_positions', 'okx_portfolio_balance',
])

const VALID_MARKET_STATES = new Set(['oscillation', 'trend', 'extreme'])

const VALID_ENTRY_SIGNALS = new Set([
  'immediate', 'time_interval', 'price_near_ma20', 'price_near_ma50',
  'funding_rate_spike', 'volume_breakout', 'rsi_oversold', 'rsi_overbought',
  'macd_cross_up', 'macd_cross_down', 'bollinger_squeeze',
])

const VALID_EXIT_SIGNALS = new Set([
  'grid_completion', 'take_profit', 'state_change',
  'trailing_stop', 'time_based', 'stop_loss', 'dca_tp', 'twap_complete',
  'none', 'funding_exit',
])

export function validateStrategy(spec: unknown): ValidationResult {
  const errors: string[] = []
  const s = spec as StrategySpec

  // ── metadata ──────────────────────────────────────────────────────────────
  if (!s?.metadata)             errors.push('Missing section: metadata')
  if (!s?.conditions)           errors.push('Missing section: conditions')
  if (!s?.execution)            errors.push('Missing section: execution')
  if (!s?.risk)                 errors.push('Missing section: risk')
  if (!s?.promotion)            errors.push('Missing section: promotion')
  if (!s?.demotion)             errors.push('Missing section: demotion')
  if (!s?.elimination)          errors.push('Missing section: elimination')

  if (errors.length) return { ok: false, errors }

  if (!s.metadata.name || s.metadata.name.length > 60)
    errors.push('metadata.name: required, max 60 chars')
  if (!s.metadata.author)
    errors.push('metadata.author: required')
  if (!s.metadata.description || s.metadata.description.length < 20)
    errors.push('metadata.description: required, min 20 chars')

  // ── conditions ────────────────────────────────────────────────────────────
  if (!Array.isArray(s.conditions.market_states) || s.conditions.market_states.length === 0)
    errors.push('conditions.market_states: must be non-empty array')
  else {
    for (const ms of s.conditions.market_states) {
      if (!VALID_MARKET_STATES.has(ms))
        errors.push(`conditions.market_states: invalid value "${ms}"`)
    }
  }

  if (!Array.isArray(s.conditions.assets) || s.conditions.assets.length === 0)
    errors.push('conditions.assets: must be non-empty array')
  else {
    for (const asset of s.conditions.assets) {
      // "*" 通配符表示使用用户白名单中的所有币种
      if (asset === '*') continue
      if (!/^[A-Z]+-[A-Z]+$/.test(asset))
        errors.push(`conditions.assets: "${asset}" invalid format (expected e.g. BTC-USDT or "*")`)
    }
  }

  // ── execution ─────────────────────────────────────────────────────────────
  if (!s.execution.tool)
    errors.push('execution.tool: required')
  else if (!ALLOWED_TOOLS.has(s.execution.tool))
    errors.push(`execution.tool: "${s.execution.tool}" not in whitelist`)

  if (!s.execution.entry_signal)
    errors.push('execution.entry_signal: required')
  else if (!VALID_ENTRY_SIGNALS.has(s.execution.entry_signal))
    errors.push(`execution.entry_signal: invalid value "${s.execution.entry_signal}"`)

  if (!s.execution.exit_signal)
    errors.push('execution.exit_signal: required')
  else if (!VALID_EXIT_SIGNALS.has(s.execution.exit_signal))
    errors.push(`execution.exit_signal: invalid value "${s.execution.exit_signal}"`)

  // ── Tool-specific param validation ──────────────────────────────────────
  const p = s.execution.params as Record<string, unknown>

  // Grid bot params
  if (s.execution.tool === 'okx_grid_bot' || s.execution.tool === 'okx_grid_bot_create' || s.execution.tool === 'okx_contract_grid') {
    const gc = p.grid_count as number
    if (gc < 2 || gc > 100)
      errors.push('execution.params.grid_count: must be 2–100')
    const prp = p.price_range_pct as number
    if (prp < 0.5 || prp > 50)
      errors.push('execution.params.price_range_pct: must be 0.5–50')
    const oau = p.order_amount_usdt as number
    if (oau < 5)
      errors.push('execution.params.order_amount_usdt: minimum 5')
  }

  // DCA bot params
  if (s.execution.tool === 'okx_dca_bot' || s.execution.tool === 'okx_dca_bot_create') {
    if (p.lever != null && ((p.lever as number) < 1 || (p.lever as number) > 100))
      errors.push('execution.params.lever: must be 1–100')
    if (p.direction != null && p.direction !== 'long' && p.direction !== 'short')
      errors.push('execution.params.direction: must be "long" or "short"')
    const ioa = (p.init_order_amt ?? p.order_amount_usdt) as number
    if (ioa == null || ioa < 5)
      errors.push('execution.params.init_order_amt (or order_amount_usdt): minimum 5')
    if (p.tp_pct != null && ((p.tp_pct as number) <= 0 || (p.tp_pct as number) > 50))
      errors.push('execution.params.tp_pct: must be 0.1–50')
  }

  // Swap params
  if (s.execution.tool === 'okx_swap_place' || s.execution.tool === 'okx_swap_trailing_stop') {
    if (p.lever != null && ((p.lever as number) < 1 || (p.lever as number) > 100))
      errors.push('execution.params.lever: must be 1–100')
    if (p.direction != null && p.direction !== 'long' && p.direction !== 'short')
      errors.push('execution.params.direction: must be "long" or "short"')
    const amt = p.order_amount_usdt as number
    if (amt == null || amt < 5)
      errors.push('execution.params.order_amount_usdt: minimum 5')
    if (s.execution.tool === 'okx_swap_trailing_stop') {
      const cb = p.callback_ratio as number
      if (cb == null || cb <= 0 || cb > 0.5)
        errors.push('execution.params.callback_ratio: must be 0.001–0.5 (e.g. 0.03 = 3%)')
    }
  }

  // ── risk ──────────────────────────────────────────────────────────────────
  if (s.risk.max_drawdown_pct == null)
    errors.push('risk.max_drawdown_pct: required')
  else if (s.risk.max_drawdown_pct < 1 || s.risk.max_drawdown_pct > 25)
    errors.push('risk.max_drawdown_pct: must be 1–25')

  if (s.risk.stop_loss_pct == null)
    errors.push('risk.stop_loss_pct: required')
  else if (s.risk.stop_loss_pct > 50)
    errors.push('risk.stop_loss_pct: max 50')

  if (s.risk.max_drawdown_pct != null && s.risk.stop_loss_pct != null) {
    if (s.risk.stop_loss_pct <= s.risk.max_drawdown_pct)
      errors.push('risk.stop_loss_pct: must be > max_drawdown_pct')
  }

  // ── promotion (tool-aware thresholds) ────────────────────────────────────
  // Different tool types generate trades at different rates, so thresholds
  // are scaled accordingly.  High-frequency tools (grid) can prove themselves
  // faster; low-frequency tools (arb, TWAP) need more calendar days but
  // fewer trades.
  const { minShadowDays: reqDays, minTrades: reqTrades } = promotionThresholds(s.execution.tool)

  if (s.promotion.min_shadow_days < reqDays)
    errors.push(`promotion.min_shadow_days: minimum ${reqDays} for tool "${s.execution.tool}"`)
  if (s.promotion.min_trades < reqTrades)
    errors.push(`promotion.min_trades: minimum ${reqTrades} for tool "${s.execution.tool}"`)
  if (s.promotion.min_win_rate < 0.55 || s.promotion.min_win_rate > 0.95)
    errors.push('promotion.min_win_rate: must be 0.55–0.95')
  if (s.risk.max_drawdown_pct != null &&
      s.promotion.max_realized_drawdown > s.risk.max_drawdown_pct / 100 + 0.02)
    errors.push('promotion.max_realized_drawdown: cannot exceed max_drawdown_pct + 2% grace')

  if (errors.length) return { ok: false, errors }
  return { ok: true }
}

// ── Tool-aware promotion thresholds ─────────────────────────────────────────
// High-frequency tools (grid) accumulate trades quickly and can prove
// themselves in fewer calendar days.  Low-frequency tools (arb, TWAP,
// recurring buy) need more time but produce fewer trades.

function promotionThresholds(tool: string): { minShadowDays: number; minTrades: number } {
  switch (tool) {
    // Grid bots — many sub-orders per day
    case 'okx_grid_bot':
    case 'okx_grid_bot_create':
    case 'okx_contract_grid':
      return { minShadowDays: 3, minTrades: 3 }

    // DCA / Martingale — several trades per cycle
    case 'okx_dca_bot':
    case 'okx_dca_bot_create':
      return { minShadowDays: 3, minTrades: 3 }

    // Swap / trailing stop — single entry per activation
    case 'okx_swap_place':
    case 'okx_swap_trailing_stop':
      return { minShadowDays: 3, minTrades: 1 }

    // Spot orders — single trade
    case 'okx_spot_order':
      return { minShadowDays: 3, minTrades: 1 }

    // Recurring buy — 1 trade per interval (e.g. daily)
    case 'okx_recurring_buy':
      return { minShadowDays: 3, minTrades: 3 }

    // Funding arb — 1 entry, long hold
    case 'okx_funding_arb':
      return { minShadowDays: 3, minTrades: 1 }

    // TWAP / Iceberg — multiple slices but one logical order
    case 'okx_twap':
    case 'okx_iceberg':
      return { minShadowDays: 3, minTrades: 1 }

    default:
      return { minShadowDays: 3, minTrades: 1 }
  }
}
