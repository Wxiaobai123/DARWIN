# DARWIN Strategy Specification — v1.0

Every strategy in DARWIN — whether official or community-submitted — must conform to this format. The spec is designed to be readable by humans and parseable by the strategy dispatch engine.

---

## Full Specification

```yaml
# ─────────────────────────────────────────────────────────
# SECTION 1: METADATA
# ─────────────────────────────────────────────────────────
metadata:
  id: ""                          # Auto-generated UUID on submission. Leave blank.
  name: "My Strategy Name"        # Human-readable name. Max 60 chars.
  author: "your_handle"           # Your username or alias.
  version: "1.0"                  # Increment on updates (1.0, 1.1, 2.0...)
  created_at: "2026-03-11"        # ISO date. Auto-filled on submission.
  description: |
    One to three sentences describing what this strategy does,
    when it works best, and the core logic behind it.
    Be specific — vague descriptions are penalized in leaderboard scoring.

# ─────────────────────────────────────────────────────────
# SECTION 2: APPLICABLE CONDITIONS
# ─────────────────────────────────────────────────────────
# Strategy will ONLY execute when ALL specified conditions are met.
# If conditions are not met, strategy enters standby — no orders placed.

conditions:
  market_states:                  # Required. At least one state.
    - "oscillation"               # Options: oscillation | trend | extreme
    # - "trend"                   # Can list multiple — strategy runs in any of them

  assets:                         # Required. Assets this strategy trades.
    - "BTC-USDT"                  # Format: ASSET-QUOTE
    # - "ETH-USDT"

  # Optional indicator filters (strategy only runs if current values are in range)
  min_atr_ratio: null             # Minimum ATR vs 30d avg (e.g., 0.5)
  max_atr_ratio: null             # Maximum ATR vs 30d avg (e.g., 1.5)
  min_funding_rate: null          # Absolute value (e.g., 0.01 = 0.01%)
  max_funding_rate: null
  min_volume_ratio: null          # vs 30d avg (e.g., 0.8)

  # Blackout events — strategy pauses automatically during these
  paused_during_events:
    - "fomc"                      # US Federal Reserve meetings
    - "cpi"                       # US CPI release
    # - "options_expiry"          # Major options expiry dates
    # - "none"                    # Remove this line to pause during nothing

# ─────────────────────────────────────────────────────────
# SECTION 3: EXECUTION LOGIC
# ─────────────────────────────────────────────────────────

execution:
  tool: "okx_grid_bot"            # Primary ATK tool. See whitelist below.

  params:                         # Tool-specific parameters.
    # For okx_grid_bot:
    grid_count: 20                # Number of grid levels. Range: 2–100.
    price_range_pct: 5.0          # ±% range around current price. Range: 0.5–50.
    order_amount_usdt: 50         # USDT per grid level. Min: 5.

    # For okx_spot_order / okx_futures_order:
    # order_type: "limit"         # limit | market | post_only
    # size_pct_of_allocation: 10  # % of allocated capital per trade. Max: 100.
    # leverage: 1                 # Futures only. Range: 1–20. Default: 1.

    # For okx_algo_order (trailing stop, iceberg, etc.):
    # algo_type: "trailing_stop"
    # trailing_pct: 2.0

  entry_signal: "immediate"
    # Options:
    # "immediate"           — enter as soon as conditions are met
    # "price_near_ma20"     — wait for price to touch 20-period MA
    # "price_near_ma50"     — wait for price to touch 50-period MA
    # "funding_rate_spike"  — enter when funding rate exceeds threshold
    # "volume_breakout"     — enter when volume exceeds 2× average
    # "rsi_oversold"        — RSI < 30
    # "rsi_overbought"      — RSI > 70

  exit_signal: "grid_completion"
    # Options:
    # "grid_completion"     — let grid run continuously (for grid strategies)
    # "take_profit"         — exit at take_profit_pct
    # "state_change"        — exit when market state changes
    # "trailing_stop"       — use trailing stop from execution params
    # "time_based"          — exit after max_hold_hours

  max_hold_hours: null            # Optional. Force exit after N hours. null = no limit.

# ─────────────────────────────────────────────────────────
# SECTION 4: RISK PARAMETERS
# ─────────────────────────────────────────────────────────
# These are YOUR declared limits. DARWIN enforces them as circuit breaker
# Tier 1 triggers. Exceeding them demotes the strategy.

risk:
  max_drawdown_pct: 8.0           # Required. Max acceptable drawdown %. Range: 1–25.
  stop_loss_pct: 12.0             # Required. Hard stop loss %. Must be > max_drawdown_pct.
  take_profit_pct: null           # Optional. null = no take profit (e.g., for grid).
  max_position_usdt: null         # Optional. Cap absolute position size. null = use allocation.

  # Consecutive loss protection
  pause_after_loss_days: 3        # Auto-pause if losing for N consecutive days. Min: 1.

# ─────────────────────────────────────────────────────────
# SECTION 5: PROMOTION CRITERIA
# ─────────────────────────────────────────────────────────
# Strategy must meet ALL criteria before DARWIN promotes it to live trading.
# You may tighten but not loosen these beyond system minimums.

promotion:
  min_shadow_days: 7              # Minimum: 7. You can set higher.
  min_trades: 20                  # Minimum: 20.
  min_win_rate: 0.55              # Minimum: 0.55. Range: 0.55–0.95.
  max_realized_drawdown: 0.10     # Must be ≤ declared max_drawdown_pct + 0.02 grace.

  # Must collect this many days of data in each declared market_state
  # before promotion is eligible. Default: 5 days per state.
  min_days_per_state: 5

# ─────────────────────────────────────────────────────────
# SECTION 6: DEMOTION / ELIMINATION CRITERIA
# ─────────────────────────────────────────────────────────

demotion:
  # Any one trigger is sufficient to demote from live → shadow
  live_drawdown_trigger_pct: 10.0  # Drawdown exceeds this → demote
  consecutive_loss_days: 3         # 3 straight losing days → demote

elimination:
  # Elimination = permanently archived, never runs again
  failed_shadow_attempts: 3        # 3× shadow failures → eliminate
  # Manual elimination always available via Strategy Manager Agent

# ─────────────────────────────────────────────────────────
# EXAMPLE: COMPLETE STRATEGY — BTC OSCILLATION GRID
# ─────────────────────────────────────────────────────────
```

---

## Complete Example: BTC Oscillation Grid

```yaml
metadata:
  id: ""
  name: "BTC Oscillation Grid v1"
  author: "darwin_official"
  version: "1.0"
  created_at: "2026-03-11"
  description: |
    Runs a symmetric grid bot on BTC during low-volatility oscillation periods.
    Captures small price oscillations through repeated buy-low/sell-high cycles.
    Pauses automatically when market transitions to trend or extreme state.

conditions:
  market_states:
    - "oscillation"
  assets:
    - "BTC-USDT"
  max_atr_ratio: 1.4
  paused_during_events:
    - "fomc"
    - "cpi"

execution:
  tool: "okx_grid_bot"
  params:
    grid_count: 20
    price_range_pct: 5.0
    order_amount_usdt: 50
  entry_signal: "immediate"
  exit_signal: "grid_completion"
  max_hold_hours: null

risk:
  max_drawdown_pct: 8.0
  stop_loss_pct: 12.0
  take_profit_pct: null
  max_position_usdt: null
  pause_after_loss_days: 3

promotion:
  min_shadow_days: 7
  min_trades: 30
  min_win_rate: 0.57
  max_realized_drawdown: 0.09
  min_days_per_state: 5

demotion:
  live_drawdown_trigger_pct: 9.0
  consecutive_loss_days: 3

elimination:
  failed_shadow_attempts: 3
```

---

## Complete Example: ETH DCA (All-Weather)

```yaml
metadata:
  id: ""
  name: "ETH DCA All-Weather v1"
  author: "darwin_official"
  version: "1.0"
  created_at: "2026-03-11"
  description: |
    Dollar-cost averaging into ETH on a fixed schedule regardless of market state.
    The most conservative strategy in the official library. Designed for users who
    want long-term ETH accumulation with minimal active management.

conditions:
  market_states:
    - "oscillation"
    - "trend"
    - "extreme"
  assets:
    - "ETH-USDT"
  paused_during_events: []

execution:
  tool: "okx_spot_order"
  params:
    order_type: "market"
    size_pct_of_allocation: 5     # Buy 5% of allocation every trigger
  entry_signal: "immediate"       # Triggered by Strategy Manager on schedule
  exit_signal: "time_based"
  max_hold_hours: null            # Hold indefinitely — accumulation strategy

risk:
  max_drawdown_pct: 20.0          # Higher tolerance: this is accumulation, not trading
  stop_loss_pct: 35.0
  take_profit_pct: null
  pause_after_loss_days: null     # DCA should NOT pause on loss — that's the point

promotion:
  min_shadow_days: 7
  min_trades: 7                   # DCA fires once/day — 7 trades = 7 days
  min_win_rate: 0.40              # Lower bar: DCA is about accumulation, not trades
  max_realized_drawdown: 0.22
  min_days_per_state: 3

demotion:
  live_drawdown_trigger_pct: 25.0
  consecutive_loss_days: null     # Never demote DCA for consecutive losses

elimination:
  failed_shadow_attempts: 3
```

---

## ATK Tool Whitelist

Community strategies may only reference tools from this list:

**Market Data (read-only)**
```
okx_market_ticker          — current price and 24h stats
okx_market_candles         — candlestick data (OHLCV)
okx_market_orderbook       — order book depth
okx_market_funding_rate    — perpetual funding rate
okx_market_open_interest   — open interest
okx_market_long_short_ratio — aggregated long/short positions
```

**Trading (write)**
```
okx_spot_order             — spot buy/sell (limit or market)
okx_spot_cancel            — cancel spot order
okx_futures_order          — futures buy/sell (max leverage: 10×)
okx_futures_cancel         — cancel futures order
okx_grid_bot_create        — start grid bot
okx_grid_bot_stop          — stop grid bot
okx_grid_bot_query         — query grid bot status
okx_algo_order             — trailing stop / iceberg / TWAP
okx_algo_cancel            — cancel algo order
okx_dex_swap               — on-chain token swap (via OnchainOS)
```

**Portfolio (read-only, own allocation only)**
```
okx_portfolio_positions    — current open positions
okx_portfolio_balance      — available balance in allocation
```

**Prohibited (will fail static check)**
```
okx_withdrawal             — fund withdrawals
okx_account_settings       — account configuration
okx_api_key_management     — API key operations
okx_subaccount_*           — sub-account management
Any external HTTP call      — no outbound requests from strategy code
```

---

## Validation Rules

Static checks run on every submission. Strategy is **rejected** if any of these fail:

```
STRUCTURE
  ✓ All required sections present (metadata, conditions, execution, risk, promotion)
  ✓ No unknown top-level keys

METADATA
  ✓ name length ≤ 60 characters
  ✓ version follows semver format

CONDITIONS
  ✓ market_states is non-empty array
  ✓ Each market_state is one of: oscillation | trend | extreme
  ✓ assets is non-empty array
  ✓ Each asset matches format: ASSET-QUOTE (e.g., BTC-USDT)
  ✓ atr_ratio values, if set, are positive numbers
  ✓ funding_rate values, if set, are 0–1 range

EXECUTION
  ✓ tool is in whitelist
  ✓ All tool params within allowed ranges (see tool docs)
  ✓ entry_signal is a recognized value
  ✓ exit_signal is a recognized value

RISK
  ✓ max_drawdown_pct is set (non-null)
  ✓ stop_loss_pct is set (non-null)
  ✓ stop_loss_pct > max_drawdown_pct
  ✓ max_drawdown_pct ≤ 25.0
  ✓ stop_loss_pct ≤ 50.0

PROMOTION
  ✓ min_shadow_days ≥ 7
  ✓ min_trades ≥ 20
  ✓ min_win_rate ≥ 0.55 and ≤ 0.95
  ✓ max_realized_drawdown ≤ max_drawdown_pct + 0.02

DEMOTION
  ✓ live_drawdown_trigger_pct > max_drawdown_pct
  ✓ failed_shadow_attempts ≥ 1
```

---

## Strategy Onboarding Checklist

Before onboarding a community strategy, verify:

- [ ] Tested the YAML parses without errors
- [ ] Declared `market_states` actually matches when your strategy works
- [ ] `max_drawdown_pct` is honest — strategies that exceed it get demoted
- [ ] `stop_loss_pct` is larger than `max_drawdown_pct`
- [ ] Description is specific (what does it do, when, why)
- [ ] You have tested it manually with a small amount first
- [ ] `paused_during_events` includes at least `fomc` and `cpi` for leveraged strategies

---

*DARWIN Strategy Spec v1.0 — 2026-03-11*
