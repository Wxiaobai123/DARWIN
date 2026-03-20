# DARWIN — Full System Architecture

---

## 1. Architectural Principles

**1. Separation of concerns by layer**
Each layer has one job. Intelligence layer classifies markets. Risk layer enforces limits. Execution layer trades. No layer reaches into another layer's responsibility.

**2. Heartbeat-driven, not continuous**
Agents wake on scheduled intervals, act, and sleep. This prevents resource runaway and makes every decision auditable.

**3. Risk Agent is sovereign**
No trading agent can override Risk Agent. Circuit breakers are one-way — only Risk Agent triggers them, only the user resets tier 3+.

**4. Shadow before live**
Every strategy — official or community — must prove itself in demo mode before touching real capital.

---

## 2. Layer Definitions

### Layer 0: User Layer
**What it does:** The only human touchpoint.

User actions:
- Set risk preference (conservative / balanced / aggressive) — done once
- Approve large operations (tier 3+ circuit breaker reset, emergency capital deployment)
- Read daily/weekly reports
- Optionally submit strategies to the community platform

User actions are the only inputs that override any agent decision.

---

### Layer 1: Governance Layer (Paperclip)

Paperclip provides the organizational backbone: heartbeat scheduling, audit trails, approval workflows, budget tracking per agent.

**Agent roster and heartbeat schedule:**

```
Agent              Heartbeat    Triggered by          Primary Output
─────────────────────────────────────────────────────────────────────
CTO Agent          1 hour       Scheduled             Strategy mix adjustments
Risk Agent         5 minutes    Scheduled + Events    Circuit breaker triggers
Market Analyst     15 minutes   Scheduled             Market state report
Strategy Manager   Daily        Scheduled             Promote/demote decisions
Auditor            Daily        Market close event    Natural language report
Spot Trader        Event        CTO delegation        Spot order execution
Futures Trader     Event        CTO delegation        Futures order execution
Options Hedger     Event        CTO delegation        Options order execution
DEX Arbitrageur    Event        CTO delegation        On-chain trade execution
```

**Authority hierarchy (highest to lowest):**
```
1. Emergency circuit breaker (Risk Agent)     ← cannot be overridden
2. Market state constraint (Analyst output)  ← cannot be overridden by strategies
3. User manual instruction                   ← overrides all agents
4. CTO rebalancing decision                  ← overrides individual strategies
5. Individual strategy signal                ← lowest priority
```

**Approval gates (require user confirmation in Paperclip):**
- Any position change > 20% of total capital in one action
- Circuit breaker tier 3 or tier 4 reset
- Deployment of opportunity reserve
- Promotion of a community strategy to live trading

---

### Layer 2: Intelligence Layer — Market State Recognizer

**Purpose:** Determine the current market regime before any strategy is dispatched.

**Two-level state model:**

```
Global State (affects total position sizing and risk budget)
  └── Weighted by BTC market cap dominance (~50% weight)
      + Cross-asset correlation
      + Aggregate fear/greed signal

Per-Asset State (affects strategy selection for each asset)
  └── BTC-USDT:  independent calculation
      ETH-USDT:  independent calculation
      SOL-USDT:  independent calculation
      ... (any asset in the active strategy universe)
```

**State classification matrix:**

| Indicator | Oscillation | Trend | Extreme |
|-----------|-------------|-------|---------|
| ATR vs 30d avg | < 1.0× | 1.0–2.0× | > 3.0× |
| Funding rate | |rate| < 0.01% | Persistent direction > 0.03% | |rate| > 0.10% |
| Long/Short ratio | 0.8–1.2 | Persistent > 1.5 or < 0.67 | > 3.0 or < 0.33 |
| Volume vs 30d avg | < 1.0× | 1.0–2.0× | > 3.0× |
| Price vs Bollinger | Near midband | Sustained upper/lower | Outside bands |

**State confirmation rule:**
- State change requires ≥ 3 consecutive heartbeats (45 minutes) at the new classification
- Single-heartbeat anomalies are logged but do not trigger state change
- Confidence score (0.0–1.0) published with each state report

**Cross-asset correlation monitor:**
```
Every hour, compute 30-day rolling correlation for all active asset pairs.

If corr(A, B) > 0.85 (highly correlated):
  → Treat as single combined position for exposure limits
  → Combined allocation ≤ single_asset_limit × 1.2

If corr(A, B) < 0.40 (low correlation):
  → Treat as independent assets
  → Each gets its own allocation limit
```

---

### Layer 3: Risk Layer — Four-Tier Circuit Breaker

```
TIER 1: Strategy-level
─────────────────────
Trigger:   Single strategy's realized drawdown exceeds its declared max_drawdown_pct
Effect:    That strategy paused; its allocated capital redistributed to remaining strategies
Reset:     Automatic — Risk Agent evaluates at next daily Strategy Manager heartbeat
Scope:     Isolated to the single strategy

TIER 2: Asset-level
───────────────────
Trigger:   Single asset's total drawdown > risk_tier_limit × 0.5
           (e.g., Balanced: 15% × 0.5 = 7.5% drawdown on that asset)
           OR: 3+ strategies on the same asset trigger Tier 1 simultaneously
Effect:    All strategies on that asset paused; positions locked (no forced close)
Reset:     Risk Agent + CTO Agent joint evaluation at next hourly heartbeat
Scope:     All strategies on the affected asset

TIER 3: Portfolio-level
───────────────────────
Trigger:   Total portfolio drawdown ≥ risk_tier_limit
           (Conservative: 5%, Balanced: 15%, Aggressive: 30%)
Effect:    All strategies paused; existing positions maintained; no new orders
Reset:     USER APPROVAL REQUIRED via Paperclip approval workflow
Scope:     Entire system

TIER 4: Emergency
─────────────────
Trigger:   Single-day drawdown > risk_tier_limit × 2
           OR: ATK API disconnect > 30 consecutive minutes
           OR: Paperclip heartbeat failure > 60 minutes
Effect:    FULL LIQUIDATION — all positions closed, system halted, user notified
Reset:     MANUAL USER RESTART ONLY — no automatic recovery
Scope:     Entire system
```

**API disconnect handling timeline:**
```
t+5min:   Risk Agent alert (log + notification)
t+15min:  Stop all new orders; cancel all pending limit orders
t+30min:  Trigger Tier 4 emergency
t+0 (reconnect): Reconcile positions with ATK; verify no ghost orders
```

---

### Layer 4: Strategy Dispatch Layer

This layer has three sub-components:

#### 4a. Cold Start Protocol

Phase 1 — Observe (Day 1–3):
- Market Analyst runs continuously, accumulating state data
- 5 official starter strategies loaded into shadow accounts
- Zero real capital deployed
- Daily report shows hypothetical performance: "If your money was running today..."

Phase 2 — Toe in water (Day 4–14):
- Best-performing shadow strategy gets 10% of active pool
- All others remain in shadow
- User receives live performance data to build confidence

Phase 3 — Full operation (Day 15+):
- All strategies scored on real + shadow data
- Full capital allocation by Kelly-based scoring
- Cold start complete

**5 Official Starter Strategies:**
```
darwin-official-001: BTC Grid (oscillation market)
darwin-official-002: ETH DCA (all markets, most conservative)
darwin-official-003: BTC Momentum (trend market)
darwin-official-004: Funding Rate Arb (oscillation + high funding)
darwin-official-005: Extreme Defense (extreme market only — hold stablecoins)
```

#### 4b. Capital Allocation

**Three-tier capital structure:**
```
Total Capital
├── Safety Reserve (fixed 20%) — locked, never allocated to strategies
├── Active Pool (variable by risk tier)
│   Conservative: 50% of total
│   Balanced:     70% of total
│   Aggressive:   85% of total
└── Opportunity Reserve (remainder)
    Deployed by CTO Agent with user approval only
```

**Within Active Pool — Kelly-based scoring:**
```
Strategy Score = (Win Rate × 0.4)
               + (Sharpe Ratio × 0.3)
               + (Market State Match × 0.2)
               + (Stability Score × 0.1)

  where:
    Win Rate           = profitable trades / total trades
    Sharpe Ratio       = normalized 0–1 relative to strategy universe
    Market State Match = 1.0 if current state matches strategy's declared states, else 0.3
    Stability Score    = days_with_trades / total_days_running

Allocation = Active Pool × (Strategy Score / Σ all running strategy scores)
```

**Hard limits (override scoring):**
```
Per strategy cap:
  Conservative: 30% of active pool
  Balanced:     40% of active pool
  Aggressive:   50% of active pool

Per asset cap:
  Conservative: 40% of active pool
  Balanced:     60% of active pool
  Aggressive:   80% of active pool

New strategy cap (< 30 days live):
  Maximum 10% of active pool regardless of score

Cross-asset correlation adjustment:
  If corr > 0.85: combined allocation treated as single asset
```

#### 4c. State Transition Protocol

**Four-step procedure triggered when market state changes:**

```
Step 1: Confirm transition (prerequisite)
  ├── 3 consecutive Market Analyst heartbeats classify same new state
  └── Confidence score > 0.70 on all three

Step 2: Halt new positions
  ├── All running strategies: stop_new_orders = true
  ├── All pending limit orders: cancel
  └── Broadcast state_change event to all agents via Paperclip

Step 3: Evaluate existing positions (2-hour window)
  ├── Compatible with new state?
  │   └── Retain. Hand off management to new state's strategies.
  │       Example: oscillation→trend, existing long positions retained
  │                trend strategy takes over, may add to position
  ├── Incompatible with new state?
  │   └── Batch close within 2-hour window
  │       Split into 4 tranches × 30 minutes (avoid market impact)
  └── Extreme state triggered?
      └── Override: forced close all positions within 30 minutes
          No tranche splitting — speed priority over impact cost

Step 4: New strategies initialize
  ├── Confirm old positions fully handled
  ├── Recalculate capital allocation for new state
  └── New strategies begin building positions
```

---

### Layer 5: Shadow Account Layer

**State machine:**
```
         Submit
           │
    ┌──────▼──────┐
    │  PENDING    │ ← Awaiting static security check
    └──────┬──────┘
           │ Pass check
    ┌──────▼──────┐
    │  SHADOW     │ ← Running in demo account
    │  TESTING    │   Accumulating performance data
    └──────┬──────┘
           │
     ┌─────┴──────┐
     │            │
     │ Pass       │ Fail (3× attempts)
     ▼            ▼
┌─────────┐  ┌──────────┐
│LIVE     │  │ELIMINATED│
│TRADING  │  │(archived)│
└────┬────┘  └──────────┘
     │
     │ Drawdown trigger
     ▼
┌──────────────┐
│DEMOTED (back │ ← Demoted to shadow, keep live data in archive
│to shadow)    │
└──────────────┘
```

**Promotion criteria (all must be met):**
```
min_shadow_days:         7
min_trades:              20
min_win_rate:            0.55
max_realized_drawdown:   declared max_drawdown_pct × 1.0 (must not exceed)
market_state_coverage:   at least 5 days in each declared applicable state
```

**Demotion triggers (any one sufficient):**
```
live_drawdown > declared_max_drawdown + 2%   (2% grace margin)
consecutive_loss_days >= 3
market_state_mismatch_days >= 5              (strategy performing in wrong state)
```

**Performance archive format (per strategy, per market state):**
```json
{
  "strategy_id": "...",
  "market_state": "oscillation",
  "period_days": 14,
  "trades": 47,
  "win_rate": 0.617,
  "sharpe_ratio": 1.34,
  "max_drawdown_realized": 0.038,
  "total_return_pct": 2.1,
  "avg_hold_duration_hours": 6.2,
  "market_conditions_during_test": {
    "avg_atr": 0.024,
    "avg_funding_rate": 0.002
  }
}
```

---

### Layer 6: Execution Layer — Paperclip-ATK Adapter

The adapter is the nervous system. It translates Paperclip heartbeat signals into ATK tool calls and returns results back into the audit trail.

**Adapter data flow:**
```
Paperclip Heartbeat
    │
    ▼
Parse heartbeat type
  scheduled  → time-based task
  event      → price alert / circuit breaker / delegation
  delegation → instruction from superior agent

    │
    ▼
Build AgentContext
  ├── Current portfolio (live ATK query: okx-cex-portfolio)
  ├── Current market state (DARWIN state cache)
  ├── Current capital allocation (DARWIN DB)
  ├── Active circuit breakers (Risk Agent state)
  └── Delegation instruction (if event type = delegation)

    │
    ▼
Run Agent logic
  └── Returns AgentDecision {actions[], rationale, requires_approval}

    │
    ▼
Execute Actions
  ├── Each Action → specific ATK tool call
  ├── Log: action + params + result + timestamp → Paperclip audit
  ├── On success: update DARWIN state cache
  └── On failure: emit alert event, do NOT retry automatically

    │
    ▼
Broadcast results
  └── Post decision summary to Paperclip ticket system
```

**AgentContext interface:**
```typescript
interface AgentContext {
  agent_role: 'cto' | 'risk' | 'analyst' | 'strategy_manager' |
              'auditor' | 'spot_trader' | 'futures_trader' |
              'options_hedger' | 'dex_arbitrageur'

  heartbeat: {
    type: 'scheduled' | 'event' | 'delegation'
    triggered_at: Date
    event_data?: Record<string, unknown>
  }

  portfolio: {
    total_equity_usdt: number
    safety_reserve: number
    active_pool: number
    opportunity_reserve: number
    positions: Array<{
      asset: string
      side: 'long' | 'short'
      size_usdt: number
      unrealized_pnl: number
      strategy_id: string
    }>
    daily_pnl: number
    drawdown_from_peak: number
  }

  market: {
    global_state: 'oscillation' | 'trend' | 'extreme'
    global_confidence: number
    per_asset: Record<string, {
      state: 'oscillation' | 'trend' | 'extreme'
      confidence: number
      indicators: {
        atr_ratio: number
        funding_rate: number
        long_short_ratio: number
        volume_ratio: number
      }
    }>
    last_state_change: Date | null
    correlation_matrix: Record<string, Record<string, number>>
  }

  circuit_breakers: {
    active_tiers: number[]
    affected_assets: string[]
    affected_strategies: string[]
  }

  delegation?: {
    from_agent: string
    instruction: string
    priority: 'normal' | 'urgent' | 'emergency'
    requires_approval: boolean
    deadline?: Date
  }
}
```

**AgentDecision interface:**
```typescript
interface AgentDecision {
  actions: Array<{
    tool: string               // ATK tool name
    params: Record<string, unknown>
    rationale: string
    estimated_capital_usdt: number
  }>
  rationale: string            // Human-readable explanation → audit log
  requires_human_approval: boolean
  escalate_to?: string         // Agent role to escalate if needed
  estimated_impact: {
    capital_at_risk: number
    expected_outcome: string
    confidence: number
  }
}
```

**ATK tool whitelist per agent type:**
```
Market Analyst:
  okx_market_ticker, okx_market_candles, okx_market_orderbook,
  okx_market_funding_rate, okx_market_open_interest,
  okx_market_long_short_ratio

Risk Agent:
  okx_portfolio_balance, okx_portfolio_positions,
  okx_portfolio_pnl  (read-only)

CTO Agent:
  okx_portfolio_balance, okx_portfolio_positions
  + all delegation to trading agents

Trading Agents (Spot/Futures/Options/DEX):
  okx_spot_order, okx_spot_cancel, okx_futures_order,
  okx_futures_cancel, okx_grid_bot_create, okx_grid_bot_stop,
  okx_algo_order, okx_options_order, okx_dex_swap,
  okx_portfolio_positions (own allocation only)

Auditor:
  okx_portfolio_history, okx_trade_history  (read-only)
```

---

### Layer 7: Platform Layer — Community Strategy Hub

**Submission pipeline:**
```
1. User submits strategy YAML
2. Static validator checks:
   ✓ Only whitelist tools referenced
   ✓ All required fields present
   ✓ Parameters within safe ranges
   ✓ Risk fields non-null
   ✓ No external URLs or custom code blocks
3. Auto-assigned to shadow account for testing
4. Performance data published publicly after 7 days
5. Leaderboard updated hourly
```

**Leaderboard scoring:**
```
Rank Score = Sharpe Ratio         × 0.35
           + Drawdown Control      × 0.25   (1 - realized_dd / declared_dd)
           + State Adaptability    × 0.20   (performance across multiple states)
           + Replicability         × 0.10   (parameter simplicity score)
           + Community Adoption    × 0.10   (# of users running this strategy)

Minimum eligibility:
  Runtime:          ≥ 14 days
  Trades:           ≥ 30
  State coverage:   ≥ 2 different market states
  Shadow capital:   ≥ 500 USDT equivalent
```

**Anti-manipulation rules:**
```
- Outlier sessions flagged: if single-day PnL > 5× average, that day excluded
- Leaderboard only shows risk-adjusted metrics, never raw returns
- Strategy variants (same logic, slightly different params) deduplicated
  by cosine similarity of parameter vector
```

**Sandbox runtime limits:**
```
Per heartbeat:     max 10 actions
Execution timeout: 60 seconds
Capital access:    own allocation slice only
Tool access:       whitelist only (enforced at adapter layer)
```

---

### Layer 8: Report Layer

**Report taxonomy:**
```
Real-time alert (push notification, immediate):
  - Any circuit breaker triggered
  - Single position loss > 5% in 1 hour
  - ATK API connectivity issue

Hourly digest (optional subscription):
  - Net PnL last hour
  - Market state if changed
  - Any strategy status changes

Daily report (always generated, post-close):
  [Today's Market] + [Strategy Performance] + [Risk Status] +
  [System Activity] + [Tomorrow's Watch]

Weekly report (Sunday):
  - Strategy archive updates (promotions, demotions, eliminations)
  - Capital allocation changes
  - Risk tier recommendation (should user adjust?)
  - Community leaderboard highlights
```

**Daily report template:**
```
【Today's Market】
  BTC: oscillation (confidence 87%) · ETH: trend-up (confidence 73%)

【Strategy Performance】
  Running: 3 strategies
  BTC Grid:          +0.31%  ▲  (in-state, performing as expected)
  ETH Momentum:      +0.58%  ▲  (in-state, above average)
  SOL Funding Arb:   -0.12%  ▼  (market state mismatch, monitoring)

  Net today: +$143  |  From peak: -2.1%  |  Risk budget used: 14%

【System Activity】
  Promoted: BTC Grid v2 (7 days shadow complete, win rate 61%)
  Monitoring: SOL Funding Arb (3rd day of underperformance)

【Tomorrow's Watch】
  ETH funding rate rising — if it crosses 0.05%, DARWIN will
  activate funding rate arb strategy and reduce momentum allocation.
```

---

## 3. Data Flow Diagram

```
External Data Sources
  OKX Market Data API ──────────────────────────────────┐
  OKX Portfolio API ────────────────────────────────────┤
  OnchainOS (on-chain prices, DEX pools) ───────────────┤
                                                        │
                                                        ▼
                                              DARWIN State Cache
                                              (in-memory + PostgreSQL)
                                                        │
                         ┌──────────────────────────────┤
                         │                              │
              Market State Report              Portfolio Snapshot
                         │                              │
                         ▼                              ▼
                  CTO Agent                       Risk Agent
                (strategy mix)                 (circuit breakers)
                         │                              │
              ┌──────────┤                    ┌─────────┤
              │          │                    │         │
              ▼          ▼                    ▼         ▼
         Capital     Strategy            Alert     Emergency
         Allocation  Dispatch            Push      Halt Signal
              │          │
              └────┬─────┘
                   │
          Execution Agents
          (via ATK adapter)
                   │
         ┌─────────┴──────────┐
         │                    │
    CEX Orders           DEX Transactions
    (OKX ATK)            (OnchainOS)
         │                    │
         └─────────┬──────────┘
                   │
            Trade Results
                   │
                   ▼
           Auditor Agent
           (daily report)
                   │
                   ▼
              User Report
```

---

## 4. Database Schema (Key Tables)

```sql
-- Market state history
CREATE TABLE market_states (
  id          SERIAL PRIMARY KEY,
  asset       VARCHAR(20),           -- 'GLOBAL' or 'BTC-USDT' etc.
  state       VARCHAR(20),           -- 'oscillation'|'trend'|'extreme'
  confidence  DECIMAL(4,3),
  indicators  JSONB,
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);

-- Strategy archive
CREATE TABLE strategies (
  id                  UUID PRIMARY KEY,
  name                VARCHAR(100),
  author              VARCHAR(50),
  spec                JSONB,          -- full YAML parsed to JSON
  status              VARCHAR(20),    -- 'shadow'|'live'|'demoted'|'eliminated'
  shadow_started_at   TIMESTAMPTZ,
  live_started_at     TIMESTAMPTZ,
  demotion_count      INT DEFAULT 0,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Strategy performance by market state
CREATE TABLE strategy_performance (
  id            SERIAL PRIMARY KEY,
  strategy_id   UUID REFERENCES strategies(id),
  market_state  VARCHAR(20),
  period_start  DATE,
  period_end    DATE,
  trades        INT,
  win_rate      DECIMAL(5,4),
  sharpe        DECIMAL(6,3),
  max_drawdown  DECIMAL(5,4),
  total_return  DECIMAL(8,4),
  raw_data      JSONB
);

-- Capital allocation snapshots
CREATE TABLE capital_allocations (
  id            SERIAL PRIMARY KEY,
  strategy_id   UUID REFERENCES strategies(id),
  amount_usdt   DECIMAL(12,2),
  score         DECIMAL(5,4),
  effective_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Circuit breaker log
CREATE TABLE circuit_breaker_events (
  id            SERIAL PRIMARY KEY,
  tier          INT,
  trigger       VARCHAR(200),
  affected      JSONB,               -- assets or strategies affected
  triggered_at  TIMESTAMPTZ DEFAULT NOW(),
  resolved_at   TIMESTAMPTZ,
  resolved_by   VARCHAR(50)          -- 'auto'|'user'|'manual'
);
```

---

*Last updated: 2026-03-11*
*Version: 1.0.0*
