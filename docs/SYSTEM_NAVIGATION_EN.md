# DARWIN System Navigation

This document explains the recommended order for understanding DARWIN when you open the project for the first time.

## Recommended Order

1. `Overview`
Start with equity, dominant regime, strategy count, deployed capital, and system health.

2. `Decision`
Then inspect multi-agent coordination, market interpretation, strategy selection, and capital plans.

3. `Risk`
Confirm the 4-tier breaker logic, approval gates, and risk event log.

4. `Reports`
Finish with daily reports, strategy categories, risk summaries, and the historical timeline.

## Quick Start

```bash
pnpm install
pnpm run overview
pnpm run bridge
```

Additional notes:

- `pnpm run overview`: repository-local system overview with no exchange credentials required.
- `pnpm run verify`: requires configured OKX demo credentials and validates the live ATK execution path.
- `pnpm run demo:walkthrough:deterministic`: fixture-backed runtime walkthrough for local demonstrations.

Open:

- `http://localhost:3200/dashboard?lang=en#overview`
- `http://localhost:3200/dashboard?lang=cn#overview`

## Intent Pipeline

If you want to see how a natural-language operating objective enters the system, start here:

- [Intent Pipeline](INTENT_PIPELINE_EN.md)

## Core Design Characteristics

| Dimension | DARWIN |
|---|---|
| Market adaptation | Switches strategy packs by market regime |
| Operating loop | Keeps execution, halts, and reporting on one rail |
| Risk control | 4-tier circuit breaker with approval gates |
| Operational record | Produces audit-ready reports and logs |

## OKX Agent Trade Kit Integration

| ATK capability | Where it appears in DARWIN |
|---|---|
| `market` | ATR, funding, volume, long/short ratio, regime detection |
| `account` | Equity, positions, margin usage, capital deployment, risk snapshots |
| `execution` | Spot, swap, trailing stop, and live entry/exit flows |
| `bot / algo` | Spot Grid, Contract Grid, Martingale, Funding Arb, TWAP, Iceberg |

Without OKX Agent Trade Kit, DARWIN cannot combine market sensing, account constraints, live execution, and bot orchestration in one operating layer.
