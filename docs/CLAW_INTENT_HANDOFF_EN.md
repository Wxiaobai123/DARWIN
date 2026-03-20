# Claw Intent Handoff

This document explains what DARWIN means, in product terms, when it says it is `powered by Claw`.

## User Intent

Example natural-language objective:

> Give me a conservative, local-first BTC / ETH posture that prefers range capture unless volatility clearly breaks into trend.

## Claw-Normalized Operating Objective

Claw turns that natural-language request into an operating objective DARWIN can execute:

- Risk tier: `balanced`
- Asset whitelist: `BTC-USDT, ETH-USDT, SOL-USDT`
- Preferred posture: oscillation first, expand directional risk only after trend confirmation
- Governance rules:
  - every strategy stays inside a shadow-first lifecycle
  - risk is enforced through the 4-tier breaker model
  - execution and reporting stay on the same accountable rail

## How DARWIN Takes Over

DARWIN does not handle the free-form language part. It handles the system execution layer after the intent is normalized:

1. `Overview`
Confirms equity, dominant market regime, strategy count, and system health.

2. `Decision`
Explains why the current market regime maps to the current strategy pack.

3. `Risk`
Shows the 4-tier breaker logic and approval gates.

4. `Reports`
Produces the daily report and audit record so every action stays on the same rail.

## Zero-Key Demo Entry

```bash
pnpm run proof
```

This command prints a deterministic `Claw -> DARWIN` handoff walkthrough without requiring exchange credentials.
