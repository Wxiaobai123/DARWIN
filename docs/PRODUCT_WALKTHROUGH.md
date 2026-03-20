# DARWIN 产品导览

DARWIN 不是一个交易信号机器人，而是一个把市场识别、策略切换、真实执行、风险熔断和审计报告放在同一条责任链上的 AI 交易治理系统。

## 90 秒看懂 DARWIN

按这个顺序看，最容易理解产品主线：

1. `Overview`
说明 DARWIN 当前掌握了什么。
看权益、市场主导状态、策略数量、已部署资金、系统健康。

2. `Decision`
说明 DARWIN 为什么这样做。
看多智能体协作、市场判断、策略建议、资金分配。

3. `Risk`
说明 DARWIN 什么时候会停。
看 4 层熔断、审批门禁、风险事件记录。

4. `Reports`
说明 DARWIN 如何留下责任链。
看每日报告、策略分类、风险摘要、历史时间线。

## 最短验证路径

```bash
pnpm install
pnpm run verify
pnpm run demo:guided
pnpm run bridge
```

打开：

- `http://localhost:3200/dashboard?lang=cn#overview`
- `http://localhost:3200/dashboard?lang=en#overview`

## 为什么它不是普通 Trading Bot

| 普通 Bot | DARWIN |
|---|---|
| 执行单个固定策略 | 根据市场状态切换策略簇 |
| 下单后缺少治理层 | 执行、风控、熔断、报告在同一条轨道上 |
| 风控主要靠止损 | 4 层熔断 + 审批门禁 |
| 很少留下可审计产物 | 自动生成日报与审计记录 |

## OKX Agent Trade Kit 在哪里

| ATK 能力 | DARWIN 里的位置 |
|---|---|
| `market` | ATR、资金费率、成交量、多空比、市场状态识别 |
| `account` | 权益、仓位、保证金、资金部署和风险快照 |
| `execution` | 现货、合约、Trailing Stop、真实开平仓 |
| `bot / algo` | Spot Grid、Contract Grid、Martingale、Funding Arb、TWAP、Iceberg |

没有 OKX Agent Trade Kit，DARWIN 无法同时完成市场感知、账户约束、真实执行和策略机器人编排。
