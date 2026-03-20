# DARWIN Intent Pipeline

This document explains how a natural-language operating objective enters DARWIN and is normalized into a structured system objective.

## Operator Objective

Example natural-language objective:

> Give me a conservative, local-first BTC / ETH posture; if the market remains range-bound, prioritize range strategies, and only expand directional risk after trend confirmation.

## Structured Operating Objective

DARWIN uses a structured operating objective to drive market interpretation, strategy selection, and risk controls:

- Risk tier: `balanced`
- Asset whitelist: `BTC-USDT, ETH-USDT, SOL-USDT`
- Preferred posture: oscillation-first, expand directional exposure only after trend confirmation
- Governance requirements:
  - all strategies begin with a shadow-first lifecycle
  - risk controls are enforced through the 4-tier circuit breaker
  - execution and reporting stay on the same accountability rail

## What the System Does Next

1. `Overview`
Confirms equity, dominant regime, strategy count, and system health.

2. `Decision`
Explains the current posture, strategy mix, and capital plan.

3. `Risk`
Confirms that the 4-tier breaker logic and approval gates are active.

4. `Reports`
Produces daily reports and audit records for the operating history.

## Local Entry Point

```bash
pnpm run overview
```

This command prints a deterministic local system overview without requiring exchange credentials.
