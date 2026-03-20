# DARWIN 系统导航

这份文档用于说明首次查看 DARWIN 时，建议按什么顺序理解系统结构和运行主线。

## 建议查看顺序

1. `Overview`
先看权益、市场主导状态、策略数量、已部署资金和系统健康。

2. `Decision`
再看多智能体协作、市场判断、策略建议和资金分配。

3. `Risk`
确认 4 层熔断、审批门禁和风险事件记录是否正常工作。

4. `Reports`
最后看每日报告、策略分类、风险摘要和历史时间线。

## 快速开始

```bash
pnpm install
pnpm run overview
pnpm run bridge
```

补充说明：

- `pnpm run overview`：本地静态系统概览，不依赖交易所凭证。
- `pnpm run verify`：需要配置 OKX Demo 凭证，用来验证真实 ATK 执行链路。
- `pnpm run demo:walkthrough:deterministic`：固定夹具运行导览，适合本地演示主链路。

打开：

- `http://localhost:3200/dashboard?lang=cn#overview`
- `http://localhost:3200/dashboard?lang=en#overview`

## 意图管线

如果你想确认自然语言目标如何进入系统，请看：

- [Intent Pipeline](INTENT_PIPELINE.md)

## 核心设计特征

| 设计维度 | DARWIN |
|---|---|
| 市场适配 | 根据市场状态切换策略簇 |
| 运行闭环 | 执行、风控、熔断、报告在同一条轨道上 |
| 风险控制 | 4 层熔断 + 审批门禁 |
| 运行留痕 | 自动生成日报与审计记录 |

## OKX Agent Trade Kit 集成

| ATK 能力 | DARWIN 里的位置 |
|---|---|
| `market` | ATR、资金费率、成交量、多空比、市场状态识别 |
| `account` | 权益、仓位、保证金、资金部署和风险快照 |
| `execution` | 现货、合约、Trailing Stop、真实开平仓 |
| `bot / algo` | Spot Grid、Contract Grid、Martingale、Funding Arb、TWAP、Iceberg |

没有 OKX Agent Trade Kit，DARWIN 无法同时完成市场感知、账户约束、真实执行和策略机器人编排。
