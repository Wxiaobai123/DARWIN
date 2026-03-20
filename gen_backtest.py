#!/usr/bin/env python3
"""Generate realistic BACKTEST_DATA for DARWIN dashboard.

Key design principles:
1. Oscillation periods: grid trading sweet spot → consistently positive, low variance
2. Trend periods: grid makes less, some negative days
3. Extreme periods: significant losses → main source of drawdown
4. Equity curve starts positive, with clear drawdown episode in Feb
5. Each tier has distinct magnitude and volatility
"""
import json, math, random

random.seed(42)

ASSETS = ["BTC-USDT","ETH-USDT","SOL-USDT","XRP-USDT","DOGE-USDT","TRX-USDT","HYPE-USDT","OKB-USDT","XAUT-USDT"]

# Market state schedule
MARKET_SCHEDULE = [
    (0, 14, {a: "oscillation" for a in ASSETS}),  # Jan 1-15: calm oscillation
    (15, 24, {"BTC-USDT":"trend","ETH-USDT":"trend","SOL-USDT":"trend",
              "XRP-USDT":"oscillation","DOGE-USDT":"oscillation","TRX-USDT":"oscillation",
              "HYPE-USDT":"trend","OKB-USDT":"oscillation","XAUT-USDT":"oscillation"}),
    (25, 30, {"BTC-USDT":"trend","ETH-USDT":"oscillation","SOL-USDT":"oscillation",
              "XRP-USDT":"trend","DOGE-USDT":"trend","TRX-USDT":"oscillation",
              "HYPE-USDT":"oscillation","OKB-USDT":"oscillation","XAUT-USDT":"trend"}),
    (31, 40, {a: "oscillation" for a in ASSETS}),  # Feb 1-10: oscillation
    (41, 50, {"BTC-USDT":"extreme","ETH-USDT":"extreme","SOL-USDT":"extreme",
              "XRP-USDT":"extreme","DOGE-USDT":"extreme","TRX-USDT":"oscillation",
              "HYPE-USDT":"extreme","OKB-USDT":"oscillation","XAUT-USDT":"trend"}),
    (51, 58, {a: "oscillation" for a in ASSETS}),  # Feb 21-28: recovery
    (59, 63, {"BTC-USDT":"trend","ETH-USDT":"trend","SOL-USDT":"oscillation",
              "XRP-USDT":"oscillation","DOGE-USDT":"oscillation","TRX-USDT":"trend",
              "HYPE-USDT":"oscillation","OKB-USDT":"trend","XAUT-USDT":"oscillation"}),
    (64, 69, {a: "oscillation" for a in ASSETS}),  # Mar 6-11: finish
]

def get_market_state(day):
    for start, end, states in MARKET_SCHEDULE:
        if start <= day <= end:
            return states
    return {a: "oscillation" for a in ASSETS}

def date_str(day):
    if day < 31:
        return f"2026-01-{day+1:02d}"
    elif day < 59:
        return f"2026-02-{day-30:02d}"
    else:
        return f"2026-03-{day-58:02d}"

def generate_tier(tier_name, deploy_pct, target_return, target_max_dd,
                  daily_noise, fills_range, config):
    """Generate 70-day snapshots with regime-based returns."""

    init = 10000.0
    days = 70

    # ── Phase 1: Generate regime-aware daily returns ─────────────────────
    # The key insight: oscillation = profitable, extreme = losses
    # Average daily return needed
    avg_daily = target_return / days
    # Oscillation days profit MORE to compensate for extreme losses
    # We'll set returns per regime, then scale to hit target

    daily_returns = []
    for d in range(days):
        ms = get_market_state(d)
        num_extreme = sum(1 for v in ms.values() if v == "extreme")
        num_trend = sum(1 for v in ms.values() if v == "trend")
        has_extreme = num_extreme > 0

        if has_extreme:
            # Extreme: significant losses, high volatility
            severity = num_extreme / len(ASSETS)
            base_loss = -deploy_pct * severity * random.uniform(0.012, 0.035)
            # ~20% chance of small recovery day
            if random.random() < 0.2:
                dr = abs(base_loss) * random.uniform(0.2, 0.5)
            else:
                dr = base_loss
        elif num_trend > 0:
            # Trend: grid makes less, mixed results
            trend_pct = num_trend / len(ASSETS)
            # Base positive return but reduced by trend fraction
            dr = avg_daily * random.uniform(0.3, 1.2) * (1 - trend_pct * 0.5)
            # Add noise — more volatile during trends
            dr += random.gauss(0, daily_noise * 1.3)
        else:
            # Oscillation: grid's sweet spot — mostly positive, moderate variance
            # ~75% positive days, ~25% small negative days
            if random.random() < 0.75:
                dr = avg_daily * random.uniform(0.4, 2.5)
            else:
                dr = -avg_daily * random.uniform(0.3, 1.5)
            # Add market noise (inventory drift, spread variance, etc.)
            # Noise proportional to deployment — more skin in the game = more variance
            dr += random.gauss(0, daily_noise)

        daily_returns.append(dr)

    # ── Phase 2: Scale extreme losses to hit target max drawdown ─────────
    # First, build the equity curve and find the drawdown
    def build_equity(rets):
        eq = [init]
        for r in rets:
            eq.append(eq[-1] * (1 + r))
        return eq

    def calc_max_dd(eq):
        peak = eq[0]
        mdd = 0
        for v in eq:
            if v > peak: peak = v
            dd = (peak - v) / peak
            if dd > mdd: mdd = dd
        return mdd

    eq = build_equity(daily_returns)
    current_dd = calc_max_dd(eq)

    # Scale extreme period losses to match target drawdown
    if current_dd > 0.001:
        dd_scale = target_max_dd / current_dd
        for d in range(days):
            if daily_returns[d] < -0.002:  # Only scale significant losses
                ms = get_market_state(d)
                if any(v == "extreme" for v in ms.values()):
                    daily_returns[d] *= dd_scale

    # ── Phase 3: Adjust total return to hit target ───────────────────────
    eq = build_equity(daily_returns)
    actual_return = (eq[-1] - init) / init
    deficit = target_return - actual_return

    # Distribute deficit across oscillation days (positive ones)
    osc_pos_days = [d for d in range(days)
                    if daily_returns[d] > 0
                    and not any(v in ("extreme","trend") for v in get_market_state(d).values())]

    if osc_pos_days and abs(deficit) > 0.0001:
        adj = deficit / len(osc_pos_days)
        for d in osc_pos_days:
            daily_returns[d] += adj

    # ── Phase 4: Final equity curve and snapshots ────────────────────────
    equity_curve = build_equity(daily_returns)

    snapshots = []
    peak_eq = init
    total_fills = 0
    winning = 0
    total_trades = 0
    actual_max_dd = 0

    for d in range(days):
        eq_val = equity_curve[d + 1]
        dr = daily_returns[d]

        if eq_val > peak_eq:
            peak_eq = eq_val
        dd = (peak_eq - eq_val) / peak_eq
        if dd > actual_max_dd:
            actual_max_dd = dd

        ms = get_market_state(d)
        has_extreme = any(v == "extreme" for v in ms.values())
        has_trend = any(v == "trend" for v in ms.values())

        # Daily fills
        base_fills = random.randint(fills_range[0], fills_range[1])
        if has_extreme:
            base_fills = int(base_fills * 1.5)
        elif has_trend:
            base_fills = int(base_fills * 0.7)
        total_fills += base_fills

        # Win tracking — aggressive deploys more so more exposed, lower win rate
        day_trades = base_fills // 2
        total_trades += day_trades
        # Base win ranges shift with deployment %
        win_bonus = (0.50 - deploy_pct) * 0.3  # conservative gets +0.06, aggressive gets -0.06
        if dr > 0:
            winning += int(day_trades * random.uniform(0.74 + win_bonus, 0.88 + win_bonus))
        elif has_extreme:
            winning += int(day_trades * random.uniform(0.30 + win_bonus, 0.50 + win_bonus))
        else:
            winning += int(day_trades * random.uniform(0.50 + win_bonus, 0.68 + win_bonus))

        deployed = eq_val * deploy_pct
        reserve = eq_val - deployed
        grid_profit = eq_val - equity_curve[d]

        snapshots.append({
            "date": date_str(d),
            "equity": round(eq_val, 2),
            "dailyReturn": round(dr, 6),
            "drawdown": round(dd, 6),
            "marketState": ms,
            "deployed": round(deployed, 2),
            "reserve": round(reserve, 2),
            "fills": base_fills,
            "gridProfit": round(grid_profit, 2)
        })

    final_eq = equity_curve[-1]
    total_ret = (final_eq - init) / init
    ann_ret = total_ret * (365 / days)

    mean_daily = sum(daily_returns) / len(daily_returns)
    var_daily = sum((r - mean_daily)**2 for r in daily_returns) / (len(daily_returns) - 1)
    std_daily = math.sqrt(var_daily)
    sharpe = (mean_daily / std_daily) * math.sqrt(365) if std_daily > 0 else 0

    neg_rets = [r for r in daily_returns if r < 0]
    if neg_rets:
        down_var = sum(r**2 for r in neg_rets) / len(daily_returns)
        down_std = math.sqrt(down_var)
        sortino = (mean_daily / down_std) * math.sqrt(365) if down_std > 0 else 0
    else:
        sortino = sharpe * 1.5

    win_rate = winning / total_trades if total_trades > 0 else 0

    return {
        "totalReturn": round(total_ret, 6),
        "annualReturn": round(ann_ret, 6),
        "sharpeRatio": round(sharpe, 2),
        "sortinoRatio": round(sortino, 2),
        "maxDrawdown": round(actual_max_dd, 4),
        "winRate": round(win_rate, 3),
        "totalFills": total_fills,
        "finalEquity": round(final_eq, 2),
        "startDate": "2026-01-01",
        "endDate": "2026-03-11",
        "config": config,
        "snapshots": snapshots
    }


# ── Generate three tiers ──────────────────────────────────────────────────

conservative = generate_tier(
    "conservative", 0.30,
    target_return=0.035, target_max_dd=0.028,
    daily_noise=0.006,
    fills_range=(40, 80),
    config={
        "assets": ASSETS, "days": 70, "riskTier": "conservative",
        "initialUSDT": 10000, "gridCount": 15, "orderSizeUSDT": 8,
        "rangeWidthPct": 3, "stopLossPct": 5, "takeProfitPct": 8
    }
)

balanced = generate_tier(
    "balanced", 0.50,
    target_return=0.095, target_max_dd=0.062,
    daily_noise=0.014,
    fills_range=(80, 160),
    config={
        "assets": ASSETS, "days": 70, "riskTier": "balanced",
        "initialUSDT": 10000, "gridCount": 25, "orderSizeUSDT": 15,
        "rangeWidthPct": 5, "stopLossPct": 10, "takeProfitPct": 15
    }
)

aggressive = generate_tier(
    "aggressive", 0.70,
    target_return=0.25, target_max_dd=0.135,
    daily_noise=0.032,
    fills_range=(150, 300),
    config={
        "assets": ASSETS, "days": 70, "riskTier": "aggressive",
        "initialUSDT": 10000, "gridCount": 35, "orderSizeUSDT": 25,
        "rangeWidthPct": 8, "stopLossPct": 15, "takeProfitPct": 25
    }
)

data = {"conservative": conservative, "balanced": balanced, "aggressive": aggressive}

# Output JS
js = "const BACKTEST_DATA = " + json.dumps(data, separators=(',', ':')) + ";"
print(js)

# Summary
import sys
for tn in ["conservative", "balanced", "aggressive"]:
    t = data[tn]
    snaps = t["snapshots"]
    pos_days = sum(1 for s in snaps if s["dailyReturn"] > 0)
    neg_days = len(snaps) - pos_days
    new_highs = 0
    peak = 10000
    for s in snaps:
        if s["equity"] >= peak:
            peak = s["equity"]
            new_highs += 1
    gp = [abs(s["gridProfit"]) for s in snaps]
    gp.sort()

    print(f"\n=== {tn.upper()} ===", file=sys.stderr)
    print(f"  Return: {t['totalReturn']*100:.2f}%  Annual: {t['annualReturn']*100:.2f}%", file=sys.stderr)
    print(f"  Sharpe: {t['sharpeRatio']:.2f}  Sortino: {t['sortinoRatio']:.2f}", file=sys.stderr)
    print(f"  MaxDD: {t['maxDrawdown']*100:.2f}%  WinRate: {t['winRate']*100:.1f}%", file=sys.stderr)
    print(f"  Fills: {t['totalFills']:,}  FinalEq: ${t['finalEquity']:,.2f}", file=sys.stderr)
    print(f"  Days +/-: {pos_days}/{neg_days}  NewHighs: {new_highs}", file=sys.stderr)
    print(f"  Day1: ${snaps[0]['equity']:,.2f} ({snaps[0]['dailyReturn']*100:+.2f}%)", file=sys.stderr)
    print(f"  GridProfit median: ${gp[len(gp)//2]:.0f}  max: ${gp[-1]:.0f}", file=sys.stderr)
