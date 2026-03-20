# DARWIN Product Walkthrough

DARWIN is not a trading signal bot. It is an AI trading governance system that keeps market interpretation, strategy switching, live execution, risk halts, and audit reporting on one accountable rail.

## Understand DARWIN in 90 Seconds

Use this order for the clearest product walkthrough:

1. `Overview`
Shows what DARWIN currently knows.
Watch live equity, dominant regime, strategy count, deployed capital, and system health.

2. `Decision`
Shows why DARWIN is acting this way.
Watch multi-agent coordination, market interpretation, strategy selection, and capital plans.

3. `Risk`
Shows when DARWIN will stop.
Watch the 4-tier breaker logic, approval gates, and risk event log.

4. `Reports`
Shows how DARWIN closes the accountability loop.
Watch the daily report, strategy mix, risk summary, and historical timeline.

## Fastest Proof Path

```bash
pnpm install
pnpm run verify
pnpm run demo:guided
pnpm run bridge
```

Open:

- `http://localhost:3200/dashboard?lang=en#overview`
- `http://localhost:3200/dashboard?lang=cn#overview`

## Why This Is Not a Typical Trading Bot

| Typical bot | DARWIN |
|---|---|
| Runs one fixed strategy | Switches strategy packs by market regime |
| Stops at execution | Keeps execution, halts, and reports on one rail |
| Risk is mostly stop-loss based | 4-tier breaker with approval gates |
| Leaves little daily accountability | Produces audit-ready reports and logs |

## Where OKX Agent Trade Kit Appears

| ATK capability | Where it appears in DARWIN |
|---|---|
| `market` | ATR, funding, volume, long/short ratio, regime detection |
| `account` | Equity, positions, margin usage, capital deployment, risk snapshots |
| `execution` | Spot, swap, trailing stop, and live entry/exit flows |
| `bot / algo` | Spot Grid, Contract Grid, Martingale, Funding Arb, TWAP, Iceberg |

Without OKX Agent Trade Kit, DARWIN cannot combine market sensing, account constraints, live execution, and bot orchestration in one operating layer.
