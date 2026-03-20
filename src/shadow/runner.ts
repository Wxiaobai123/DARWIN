/**
 * DARWIN Shadow Account Runner
 *
 * Manages strategies running in OKX demo mode.
 * Routes to the appropriate execution tool based on strategy spec:
 *   - Spot Grid Bot                     → botClient (algoOrdType=grid)
 *   - Contract Grid Bot                 → botClient (algoOrdType=contract_grid)
 *   - DCA/Martingale Bot               → dcaClient
 *   - Swap (perpetual) + trailing stop  → swapClient
 *   - Spot orders                       → spotClient
 *   - Recurring Buy (定投)              → recurring-buy module
 *   - Funding Rate Arbitrage (套利)     → arb-funding module
 *   - Monitor-only (defensive/passive)  → sentinel
 *
 * Bot IDs are prefixed to identify their type:
 *   "cgrid_<algoId>"   — contract grid bot
 *   "dca_<algoId>"     — DCA bot
 *   "swap_<ordId>"     — swap position
 *   "spot_<ordId>"     — spot order
 *   "recur_<id>"       — recurring buy
 *   "arb_<id>"         — funding rate arbitrage
 *   "monitor_<id>"     — monitor-only sentinel
 *   <algoId>           — spot grid bot (no prefix, backward compatible)
 *
 * Performance is tracked and evaluated against promotion criteria.
 */

import db from '../db.js'
import { botClient, type GridBotConfig, type GridType } from '../atk/bot.js'
import { dcaClient } from '../atk/dca.js'
import { swapClient } from '../atk/swap.js'
import { spotClient } from '../atk/spot.js'
import { atk } from '../atk/client.js'
import { account } from '../atk/account.js'
import { toSwapId, fromSwapId } from '../config.js'
import { evaluateEntrySignal } from '../market/indicators.js'
import { initRecurringBuy, tickRecurringBuy, type RecurringBuyConfig } from '../execution/recurring-buy.js'
import { openFundingArb, closeFundingArb, checkFundingOpportunity, shouldCloseArb, getFundingArbState, type FundingArbConfig } from '../execution/arb-funding.js'
import { ensureSwapLeverage } from '../execution/ensure-swap-leverage.js'
import { getRecurringBuyState } from '../execution/recurring-buy.js'
import { initTWAP, tickTWAP, initIceberg, tickIceberg, getTWAPState, isTWAPComplete, type TWAPConfig, type IcebergConfig } from '../execution/twap.js'
import { isSystemHalted, isAssetBlocked, isStrategyBlocked } from '../risk/circuit-breaker.js'
import {
  getAllStrategies, getStrategy, setStrategyStatus,
  upsertPerformance, checkPromotion, checkDemotion,
  type StrategyRecord,
} from '../strategy/archive.js'
import type { StrategySpec } from '../strategy/validator.js'
import type { MarketState } from '../market/state-recognizer.js'

const EN = process.env.DARWIN_LANG === 'en' || /^en/i.test(process.env.LANG ?? '')
const L = (cn: string, en: string) => EN ? en : cn

// Maps strategy DB id → prefixed algoId (persisted to DB, restored on startup)
const activeBots = new Map<string, string>()

/**
 * Restore activeBots from DB on startup — crash recovery.
 * Loads all shadow_bots that haven't been stopped yet.
 */
export function restoreActiveBotsFromDB(): void {
  try {
    const rows = db.prepare(`
      SELECT strategy_id, algo_id FROM shadow_bots
      WHERE stopped_at IS NULL
      ORDER BY started_at DESC
    `).all() as Array<{ strategy_id: string; algo_id: string }>

    for (const row of rows) {
      if (!activeBots.has(row.strategy_id)) {
        activeBots.set(row.strategy_id, row.algo_id)
      }
    }
    if (rows.length > 0) {
      console.log(`  [Shadow] ${EN ? `Restored ${rows.length} active bot(s) from DB` : `已从数据库恢复 ${rows.length} 个活跃机器人`}`)
    }
  } catch {}
}

// ── Bot lifecycle ─────────────────────────────────────────────────────────────

export async function startShadowBot(strategyId: string, allocUSDT?: number): Promise<string> {
  // Circuit breaker gate — block new bots during active breakers
  if (isSystemHalted()) throw new Error('System halted — circuit breaker T4 active')
  if (isStrategyBlocked(strategyId)) throw new Error(`Strategy ${strategyId} blocked by circuit breaker`)

  const rec = getStrategy(strategyId)
  if (!rec) throw new Error(`Strategy ${strategyId} not found`)

  const spec = rec.spec
  const asset = spec.conditions.assets[0]

  if (isAssetBlocked(asset)) throw new Error(`Asset ${asset} blocked by circuit breaker`)

  // ── Pre-flight: validate SWAP instrument exists for strategies that need it ─
  const needsSwap = ['okx_contract_grid', 'okx_dca_bot', 'okx_dca_bot_create',
    'okx_swap_place', 'okx_swap_trailing_stop', 'okx_funding_arb'].includes(spec.execution.tool)
  if (needsSwap) {
    const swapId = toSwapId(asset)
    try {
      atk.instrument(swapId, 'SWAP')
    } catch {
      throw new Error(`Instrument ${swapId} does not exist on OKX — skipping`)
    }
  }

  // ── Entry condition checks (ATR, funding rate) ────────────────────────────
  try {
    const swapId = toSwapId(asset)
    let fundingRate = 0
    try { fundingRate = atk.fundingRate(swapId).fundingRate } catch {}

    // Fetch ATR ratio from latest market state
    const msRow = db.prepare(
      'SELECT indicators FROM market_states WHERE asset = ? ORDER BY recorded_at DESC LIMIT 1'
    ).get(asset) as { indicators: string } | undefined
    const atrRatio = msRow?.indicators
      ? (JSON.parse(msRow.indicators) as { atrRatio?: number }).atrRatio ?? 1.0
      : 1.0

    // Check min/max ATR ratio
    if (spec.conditions.min_atr_ratio != null && atrRatio < spec.conditions.min_atr_ratio)
      throw new Error(EN
        ? `ATR ${atrRatio.toFixed(2)}x < min ${spec.conditions.min_atr_ratio} — skipping`
        : `ATR ${atrRatio.toFixed(2)}x < 最小值 ${spec.conditions.min_atr_ratio} — 跳过`)
    if (spec.conditions.max_atr_ratio != null && atrRatio > spec.conditions.max_atr_ratio)
      throw new Error(EN
        ? `ATR ${atrRatio.toFixed(2)}x > max ${spec.conditions.max_atr_ratio} — skipping`
        : `ATR ${atrRatio.toFixed(2)}x > 最大值 ${spec.conditions.max_atr_ratio} — 跳过`)

    // Check min/max funding rate
    if (spec.conditions.min_funding_rate != null && fundingRate < spec.conditions.min_funding_rate)
      throw new Error(`Funding ${(fundingRate*100).toFixed(4)}% < min — skipping`)
    if (spec.conditions.max_funding_rate != null && fundingRate > spec.conditions.max_funding_rate)
      throw new Error(`Funding ${(fundingRate*100).toFixed(4)}% > max — skipping`)

    // ── Entry signal evaluation ─────────────────────────────────────────────
    if (spec.execution.entry_signal !== 'immediate') {
      try {
        const candles = atk.candles(asset, '1H', 60)
        const signalCheck = evaluateEntrySignal(spec.execution.entry_signal, candles, fundingRate)
        if (!signalCheck.triggered) {
          throw new Error(`Signal "${spec.execution.entry_signal}" not triggered: ${signalCheck.detail} — skipping`)
        }
        console.log(`  [Shadow] ${L('入场信号通过', 'Entry signal OK')}: ${signalCheck.detail}`)
      } catch (sigErr) {
        // Signal evaluation failed — fail-closed, do not proceed
        throw new Error(`Signal check failed: ${sigErr} — skipping`)
      }
    }
  } catch (condErr) {
    if (String(condErr).includes('skipping')) throw condErr
    // Other condition errors (API unavailable for ATR/funding) — proceed
  }

  // ── Compute allocation-based size scale factor ───────────────────────────
  //
  // YAML execution params (order_amount_usdt etc.) are authored for a $10K
  // reference portfolio.  When the allocator provides an allocation amount,
  // we derive a scale factor so bot order sizes grow with portfolio equity.
  //
  // sizeScale = max(allocUSDT / referenceDeployed, 1.0)
  //   where referenceDeployed = what this strategy would deploy at $10K
  //
  // When allocUSDT is not provided (startup restore, manual launch) we
  // fall back to 1.0 — original YAML sizes.

  // Auto-compute sizeScale from account equity when allocUSDT is not provided.
  // YAML amounts are authored for a $10K reference portfolio.
  // equityScale = totalEquity / 10_000  (floor 0.5)
  let sizeScale = 1.0
  let effectiveAlloc = allocUSDT
  if (effectiveAlloc == null || effectiveAlloc <= 0) {
    try {
      const equity = account.totalEquityUSDT()
      // Simple proportional scale: equity / $10K reference
      sizeScale = Math.max(equity / 10_000, 1.0)
    } catch {
      sizeScale = 1.0
    }
  }
  if (effectiveAlloc != null && effectiveAlloc > 0) {
    const p = spec.execution.params
    const tool = spec.execution.tool
    let refDeployed = 500  // fallback

    switch (tool) {
      case 'okx_grid_bot':
      case 'okx_grid_bot_create':
      case 'okx_contract_grid':
        refDeployed = ((p.grid_count as number) ?? 10) * ((p.order_amount_usdt as number) ?? 50)
        break
      case 'okx_dca_bot':
      case 'okx_dca_bot_create': {
        const initAmt   = (p.init_order_amt as number) ?? (p.order_amount_usdt as number) ?? 50
        const safetyN   = (p.max_safety_orders as number) ?? 3
        const safetyAmt = (p.safety_order_amt as number) ?? initAmt
        const volM      = (p.vol_mult as number) ?? 2.0
        let total = initAmt; let amt = safetyAmt
        for (let i = 0; i < safetyN; i++) { total += amt; amt *= volM }
        refDeployed = total
        break
      }
      case 'okx_funding_arb':
        refDeployed = ((p.order_amount_usdt as number) ?? 100) * 2
        break
      default:
        refDeployed = (p.order_amount_usdt as number) ?? (p.total_amount_usdt as number) ?? 50
    }

    sizeScale = Math.max(effectiveAlloc / refDeployed, 1.0)
  }
  if (sizeScale > 1.05) {
    console.log(`  [Shadow] ${L('仓位缩放', 'Size scale')}: ${sizeScale.toFixed(1)}x ${L('(基于权益)', '(equity-based)')}`)
  }

  // ── Route to tool-specific start ──────────────────────────────────────────
  const tool = spec.execution.tool
  switch (tool) {
    case 'okx_grid_bot':
    case 'okx_grid_bot_create':
    case 'okx_contract_grid':
      return startGridBot(strategyId, rec, spec, asset, sizeScale)

    case 'okx_dca_bot':
    case 'okx_dca_bot_create':
      return startDCABot(strategyId, rec, spec, asset, sizeScale)

    case 'okx_swap_place':
    case 'okx_swap_trailing_stop':
      return startSwapPosition(strategyId, rec, spec, asset, sizeScale)

    case 'okx_spot_order': {
      // Defensive strategies with 0 allocation → monitor only
      const sizePct = spec.execution.params.size_pct_of_allocation as number ?? 0
      if (sizePct === 0) return startSentinel(strategyId, rec)
      return startSpotOrder(strategyId, rec, spec, asset, sizeScale)
    }

    case 'okx_recurring_buy':
      return startRecurringBuy(strategyId, rec, spec, asset, sizeScale)

    case 'okx_funding_arb':
      return startFundingArb(strategyId, rec, spec, asset, sizeScale)

    case 'okx_twap':
      return startTWAPOrder(strategyId, rec, spec, asset, sizeScale)

    case 'okx_iceberg':
      return startIcebergOrder(strategyId, rec, spec, asset, sizeScale)

    default:
      return startSentinel(strategyId, rec)
  }
}

// ── Tool-specific start functions ─────────────────────────────────────────────

function startGridBot(
  strategyId: string, rec: StrategyRecord, spec: StrategySpec, asset: string,
  sizeScale = 1.0,
): string {
  const p        = spec.execution.params
  const isContract = spec.execution.tool === 'okx_contract_grid'

  // Contract grid uses SWAP instrument, spot grid uses spot pair
  const instId   = isContract ? toSwapId(asset) : asset
  const ticker   = atk.ticker(asset) // ticker uses spot pair for price
  const rangePct = ((p.price_range_pct as number) ?? 5) / 100
  // 根据价格自动选择精度：低价币需要更多小数位
  const pxDecimals = ticker.last >= 100 ? 0 : ticker.last >= 1 ? 2 : ticker.last >= 0.01 ? 4 : 6
  const maxPx    = parseFloat((ticker.last * (1 + rangePct)).toFixed(pxDecimals))
  const minPx    = parseFloat((ticker.last * (1 - rangePct)).toFixed(pxDecimals))
  const gridNum  = (p.grid_count as number) ?? 10

  const cfg: GridBotConfig = { instId, maxPx, minPx, gridNum }

  if (isContract) {
    // Contract grid — leverage, direction, sz (scaled by equity)
    cfg.algoOrdType = 'contract_grid'
    cfg.direction   = (p.direction as 'long' | 'short' | 'neutral') ?? 'neutral'
    cfg.lever       = (p.lever as number) ?? 5
    cfg.sz          = Math.round(((p.order_amount_usdt as number) ?? 100) * sizeScale)
    cfg.basePos     = (p.base_pos as boolean) ?? true

    console.log(`  [Shadow] ${L('启动合约网格', 'Starting CONTRACT grid')} for "${rec.name}"`)
    console.log(`    ${instId}  ${cfg.direction}  ${cfg.lever}x  Range: $${minPx}–$${maxPx}  Grids: ${gridNum}  Size: $${cfg.sz}`)
  } else {
    // Spot grid — quoteSz (scaled by equity)
    cfg.algoOrdType = 'grid'
    cfg.quoteSz     = Math.round(((p.order_amount_usdt as number) ?? 10) * gridNum * sizeScale)

    // Enforce max_position_usdt cap from strategy YAML
    const maxPos = spec.risk.max_position_usdt
    if (maxPos != null && maxPos > 0 && cfg.quoteSz > maxPos * sizeScale) {
      cfg.quoteSz = Math.round(maxPos * sizeScale)
      console.log(`  [Shadow] ${L('网格资金上限收敛', 'Grid quote size capped')} to $${cfg.quoteSz} (max_position_usdt)`)
    }

    console.log(`  [Shadow] ${L('启动现货网格', 'Starting SPOT grid')} for "${rec.name}"`)
    console.log(`    ${instId}  Range: $${minPx}–$${maxPx}  Grids: ${gridNum}  Size: $${cfg.quoteSz}`)
  }

  const algoId = botClient.create(cfg)
  // Prefix contract grid IDs for proper stop routing
  const botId = isContract ? `cgrid_${algoId}` : algoId
  persistBot(strategyId, botId)
  console.log(`  [Shadow] Grid bot started: algoId=${algoId}`)
  return botId
}

function startDCABot(
  strategyId: string, rec: StrategyRecord, spec: StrategySpec, asset: string,
  sizeScale = 1.0,
): string {
  const p = spec.execution.params
  const swapId = toSwapId(asset)

  const lever         = (p.lever as number) ?? 5
  const direction     = (p.direction as 'long' | 'short') ?? 'long'
  const initOrdAmt    = Math.round(((p.init_order_amt as number) ?? (p.order_amount_usdt as number) ?? 50) * sizeScale)
  const maxSafetyOrds = (p.max_safety_orders as number) ?? 3
  const tpPct         = (p.tp_pct as number) ?? 2.5

  const cfg = {
    instId:        swapId,
    lever,
    direction,
    initOrdAmt,
    maxSafetyOrds,
    tpPct,
    // Safety order params (when using averaging)
    // pxSteps is a ratio (0.02 = 2%), YAML stores percentage → divide by 100
    ...(maxSafetyOrds > 0 ? {
      safetyOrdAmt: Math.round(((p.safety_order_amt as number) ?? initOrdAmt) * sizeScale),
      pxSteps:      ((p.price_steps as number) ?? 2.0) / 100,
      pxStepsMult:  (p.price_steps_mult as number) ?? 1.5,
      volMult:      (p.vol_mult as number) ?? 2.0,
    } : {}),
    // Optional stop-loss — OKX expects ratio (0.15 = 15%) + slMode required
    ...(p.sl_pct != null ? { slPct: (p.sl_pct as number) / 100, slMode: 'market' as const } : {}),
  }

  console.log(`  [Shadow] ${L('启动 DCA 机器人', 'Starting DCA bot')} for "${rec.name}"`)
  console.log(`    ${swapId}  ${direction}  ${lever}x  Init: $${initOrdAmt}  Safety: ${maxSafetyOrds}  TP: ${tpPct}%`)

  const algoId = dcaClient.create(cfg)
  const botId = `dca_${algoId}`
  persistBot(strategyId, botId)
  console.log(`  [Shadow] ${L('DCA 机器人已启动', 'DCA bot started')}: algoId=${algoId}`)
  return botId
}

function startSwapPosition(
  strategyId: string, rec: StrategyRecord, spec: StrategySpec, asset: string,
  sizeScale = 1.0,
): string {
  const p = spec.execution.params
  const swapId    = toSwapId(asset)
  const lever     = (p.lever as number) ?? 5
  const direction = (p.direction as 'long' | 'short') ?? 'long'
  const szUsdt    = Math.round(((p.order_amount_usdt as number) ?? 50) * sizeScale)
  const tdMode    = (p.td_mode as 'cross' | 'isolated') ?? 'cross'
  const posSide   = direction === 'long' ? 'long' as const : 'short' as const

  // Set leverage with state-aware retries so recently stopped bots/algo orders
  // get a moment to settle before we abort the trade.
  const leverageOk = ensureSwapLeverage(swapId, lever, {
    mgnMode: tdMode,
    posSide,
    logPrefix: '  [Shadow]',
  })
  if (!leverageOk) {
    throw new Error(`Cannot set leverage ${lever}x on ${swapId} — aborting to prevent wrong-leverage position`)
  }

  // Calculate contract size: sz is in contracts, each contract = ctVal of underlying
  const ticker = atk.ticker(asset)
  const inst   = atk.instrument(swapId, 'SWAP')
  const contracts = szUsdt / (ticker.last * inst.ctVal)
  // Round down to lotSz, enforce minimum, fix floating point (e.g. 2754*0.01 = 27.540000000000003)
  const lotDecimals = inst.lotSz < 1 ? (String(inst.lotSz).split('.')[1]?.length ?? 0) : 0
  const sz = String(Number((Math.max(inst.minSz, Math.floor(contracts / inst.lotSz) * inst.lotSz)).toFixed(lotDecimals)))

  const side    = direction === 'long' ? 'buy' as const : 'sell' as const
  const ordId = swapClient.place({
    instId:  swapId,
    side,
    ordType: 'market',
    sz,
    tdMode,
    posSide,
  })

  console.log(`  [Shadow] ${L('合约仓位已打开', 'Swap position opened')} for "${rec.name}"`)
  console.log(`    ${swapId}  ${direction}  ${lever}x  Size: ${sz} contracts  ≈$${szUsdt}`)

  // If trailing stop tool, also place trailing stop order
  if (spec.execution.tool === 'okx_swap_trailing_stop' && p.callback_ratio != null) {
    try {
      const closeSide = direction === 'long' ? 'sell' as const : 'buy' as const
      swapClient.trailingStop({
        instId:        swapId,
        side:          closeSide,
        sz,
        callbackRatio: String(p.callback_ratio),
        tdMode,
        posSide,
      })
      console.log(`    Trailing stop: ${((p.callback_ratio as number) * 100).toFixed(1)}% callback`)
    } catch (err) {
      console.warn(`    [Shadow] Trailing stop failed: ${err}`)
    }
  }

  const botId = `swap_${ordId}`
  persistBot(strategyId, botId)
  return botId
}

function startSpotOrder(
  strategyId: string, rec: StrategyRecord, spec: StrategySpec, asset: string,
  sizeScale = 1.0,
): string {
  const p = spec.execution.params
  const ordType = (p.order_type as string) ?? 'market'
  const szUsdt  = Math.round(((p.order_amount_usdt as number) ?? 50) * sizeScale)

  // For market buy: OKX uses sz as quote currency (USDT)
  // For limit buy / sell: sz is in base currency
  const ticker = atk.ticker(asset)
  const baseSz = String(Math.floor(szUsdt / ticker.last * 100000000) / 100000000)
  const sz = ordType === 'market' ? String(szUsdt) : baseSz

  const ordId = spotClient.place({
    instId:  asset,
    side:    'buy',
    ordType: ordType as 'market' | 'limit',
    sz,
    tdMode:  'cash',
  })

  console.log(`  [Shadow] Spot order placed for "${rec.name}"`)
  console.log(`    ${asset}  buy  ${ordType}  Size: ${sz}${ordType === 'market' ? ' USDT' : ''}  ≈$${szUsdt}`)

  // TP/SL conditional sells use base currency size
  if (spec.risk.take_profit_pct != null) {
    try {
      const tpPrice = String(Math.round(ticker.last * (1 + spec.risk.take_profit_pct / 100)))
      spotClient.algoPlace({
        instId: asset,
        side:   'sell',
        sz:     baseSz,
        ordType:     'conditional',
        tpTriggerPx: tpPrice,
        tpOrdPx:     '-1',   // market at trigger
        tdMode:      'cash',
      })
      console.log(`    TP algo order at $${tpPrice}`)
    } catch (err) {
      console.warn(`    [Shadow] TP order failed: ${err}`)
    }
  }

  if (spec.risk.stop_loss_pct != null) {
    try {
      const slPrice = String(Math.round(ticker.last * (1 - spec.risk.stop_loss_pct / 100)))
      spotClient.algoPlace({
        instId: asset,
        side:   'sell',
        sz:     baseSz,
        ordType:     'conditional',
        slTriggerPx: slPrice,
        slOrdPx:     '-1',
        tdMode:      'cash',
      })
      console.log(`    SL algo order at $${slPrice}`)
    } catch (err) {
      // SL placement is critical — cancel the position if SL can't be set
      console.error(`    [Shadow] SL order FAILED — closing position for safety: ${err}`)
      try { spotClient.cancel(asset, ordId) } catch {}
      throw new Error(`Stop-loss placement failed for ${asset}: ${err}`)
    }
  }

  const botId = `spot_${ordId}`
  persistBot(strategyId, botId)
  return botId
}

function startRecurringBuy(
  strategyId: string, rec: StrategyRecord, spec: StrategySpec, asset: string,
  sizeScale = 1.0,
): string {
  const p = spec.execution.params
  const cfg: RecurringBuyConfig = {
    instId:        asset,
    amountUsdt:    Math.round(((p.order_amount_usdt as number) ?? 50) * sizeScale),
    intervalHours: (p.interval_hours as number) ?? 24,
    skipRsiAbove:  (p.skip_rsi_above as number) ?? undefined,
    maxBuys:       (p.max_buys as number) ?? undefined,
  }

  console.log(`  [Shadow] ${L('启动定投', 'Starting recurring buy')} for "${rec.name}"`)
  console.log(`    ${asset}  $${cfg.amountUsdt} every ${cfg.intervalHours}h`)

  const botId = initRecurringBuy(strategyId, cfg)
  persistBot(strategyId, botId)
  return botId
}

function startFundingArb(
  strategyId: string, rec: StrategyRecord, spec: StrategySpec, asset: string,
  sizeScale = 1.0,
): string {
  const p = spec.execution.params
  const swapId = toSwapId(asset)

  // Check if funding is attractive before opening
  const opportunity = checkFundingOpportunity(swapId)
  const minAnnual = (p.min_annual_pct as number) ?? 15

  if (!opportunity.attractive && opportunity.annualizedPct < minAnnual) {
    throw new Error(
      `费率 ${opportunity.annualizedPct.toFixed(1)}% 年化 < 最小值 ${minAnnual}% — 跳过`
    )
  }

  const cfg: FundingArbConfig = {
    spotInstId:    asset,
    swapInstId:    swapId,
    amountUsdt:    Math.round(((p.order_amount_usdt as number) ?? 100) * sizeScale),
    lever:         (p.lever as number) ?? 2,
    minAnnualPct:  minAnnual,
    exitAnnualPct: (p.exit_annual_pct as number) ?? 5,
  }

  console.log(`  [Shadow] ${L('启动资金费率套利', 'Opening funding arb')} for "${rec.name}"`)
  const botId = openFundingArb(strategyId, cfg)
  persistBot(strategyId, botId)
  return botId
}

function startTWAPOrder(
  strategyId: string, rec: StrategyRecord, spec: StrategySpec, asset: string,
  sizeScale = 1.0,
): string {
  const p = spec.execution.params
  const useSwap = (p.use_swap as boolean) ?? false
  const instId = useSwap ? toSwapId(asset) : asset

  const cfg: TWAPConfig = {
    instId,
    side:            (p.direction as 'buy' | 'sell') ?? 'buy',
    totalAmountUsdt: Math.round(((p.total_amount_usdt as number) ?? 500) * sizeScale),
    slices:          (p.slices as number) ?? 10,
    intervalMinutes: (p.interval_minutes as number) ?? 5,
    useSwap,
    lever:           (p.lever as number) ?? undefined,
    maxSlippage:     (p.max_slippage_pct as number) ?? undefined,
  }

  console.log(`  [Shadow] ${L('启动 TWAP', 'Starting TWAP')} for "${rec.name}"`)
  console.log(`    ${instId}  ${cfg.side}  $${cfg.totalAmountUsdt} in ${cfg.slices} slices @ ${cfg.intervalMinutes}min`)

  const botId = initTWAP(strategyId, cfg)
  persistBot(strategyId, botId)
  return botId
}

function startIcebergOrder(
  strategyId: string, rec: StrategyRecord, spec: StrategySpec, asset: string,
  sizeScale = 1.0,
): string {
  const p = spec.execution.params
  const useSwap = (p.use_swap as boolean) ?? false
  const instId = useSwap ? toSwapId(asset) : asset

  const cfg: IcebergConfig = {
    instId,
    side:              (p.direction as 'buy' | 'sell') ?? 'buy',
    totalAmountUsdt:   Math.round(((p.total_amount_usdt as number) ?? 500) * sizeScale),
    visibleAmountUsdt: Math.round(((p.visible_amount_usdt as number) ?? 50) * sizeScale),
    priceOffset:       (p.price_offset_pct as number) ?? 0.1,
    useSwap,
    lever:             (p.lever as number) ?? undefined,
  }

  console.log(`  [Shadow] ${L('启动 Iceberg', 'Starting Iceberg')} for "${rec.name}"`)
  console.log(`    ${instId}  ${cfg.side}  $${cfg.totalAmountUsdt} visible $${cfg.visibleAmountUsdt}`)

  const botId = initIceberg(strategyId, cfg)
  persistBot(strategyId, botId)
  return botId
}

function startSentinel(strategyId: string, rec: StrategyRecord): string {
  const sentinelId = `monitor_${strategyId}`
  persistBot(strategyId, sentinelId)
  console.log(`  [Shadow] "${rec.name}" — ${L('监控模式', 'monitoring mode')} (tool=${rec.spec.execution.tool})`)
  return sentinelId
}

// ── Stop ──────────────────────────────────────────────────────────────────────

export function stopShadowBot(strategyId: string): void {
  const algoId = getBotAlgoId(strategyId)
  if (!algoId) return

  // Skip sentinel / recurring / arb / twap entries that don't have OKX bots
  if (algoId.startsWith('monitor_') || algoId.startsWith('recur_') || algoId.startsWith('twap_')) {
    activeBots.delete(strategyId)
    markStopped(strategyId)
    return
  }

  // Funding arb — close both legs
  if (algoId.startsWith('arb_')) {
    const rec = getStrategy(strategyId)
    if (rec) {
      const asset = rec.spec.conditions.assets[0]
      const p = rec.spec.execution.params
      closeFundingArb(strategyId, {
        spotInstId:    asset,
        swapInstId:    toSwapId(asset),
        amountUsdt:    (p.order_amount_usdt as number) ?? 100,
        lever:         (p.lever as number) ?? 2,
        minAnnualPct:  (p.min_annual_pct as number) ?? 15,
        exitAnnualPct: (p.exit_annual_pct as number) ?? 5,
      })
    }
    activeBots.delete(strategyId)
    markStopped(strategyId)
    return
  }

  const rec = getStrategy(strategyId)
  if (!rec) return
  const asset = rec.spec.conditions.assets[0]

  try {
    if (algoId.startsWith('cgrid_')) {
      // Contract grid bot
      const swapId = toSwapId(asset)
      botClient.stop(algoId.slice(6), swapId, 'contract_grid')
      console.log(`  [Shadow] ${L('已停止合约网格', 'Stopped contract grid')} for "${rec.name}"`)

    } else if (algoId.startsWith('dca_')) {
      // DCA bot
      dcaClient.stop(algoId.slice(4))
      console.log(`  [Shadow] ${L('已停止 DCA 机器人', 'Stopped DCA bot')} for "${rec.name}"`)

    } else if (algoId.startsWith('swap_')) {
      // Swap position — cancel algo orders first (trailing stops), then close positions
      const swapId = toSwapId(asset)
      const tdMode = ((rec.spec.execution.params?.td_mode as string) ?? 'cross') as 'cross' | 'isolated'
      // Cancel all pending algo orders on this instrument (trailing stops, TP/SL)
      try {
        const algoOrders = swapClient.algoOrders(swapId)
        for (const o of algoOrders) {
          try { swapClient.algoCancel(swapId, o.algoId) } catch {}
        }
      } catch {}
      try { swapClient.close(swapId, tdMode, 'long') } catch {}
      try { swapClient.close(swapId, tdMode, 'short') } catch {}
      console.log(`  [Shadow] ${L('已关闭合约仓位', 'Closed swap position')} for "${rec.name}" (${tdMode})`)

    } else if (algoId.startsWith('spot_')) {
      // Spot order — cancel if still pending, then sell any acquired position
      try { spotClient.cancel(asset, algoId.slice(5)) } catch {}
      // Check fills to see if position was acquired, and sell it
      try {
        const fills = spotClient.fills(asset).filter(f => f.side === 'buy')
        const filledQty = fills.reduce((sum, f) => sum + parseFloat(f.fillSz), 0)
        if (filledQty > 0) {
          spotClient.place({
            instId: asset, side: 'sell', ordType: 'market',
            sz: String(filledQty),
          })
          console.log(`  [Shadow] ${L('已卖出', 'Sold')} ${filledQty} ${L('以关闭', 'for')} "${rec.name}"`)
        }
      } catch {}
      console.log(`  [Shadow] ${L('已取消现货订单', 'Cancelled spot order')} for "${rec.name}"`)

    } else {
      // Grid bot (default / backward compatible)
      botClient.stop(algoId, asset)
      console.log(`  [Shadow] ${L('已停止网格机器人', 'Stopped grid bot')} algoId=${algoId} for "${rec.name}"`)
    }
  } catch (err) {
    console.warn(`  [Shadow] Failed to stop ${algoId}: ${err}`)
  }

  activeBots.delete(strategyId)
  markStopped(strategyId)
}

// ── Performance tracking ──────────────────────────────────────────────────────

export function syncPerformance(strategyId: string, currentState: MarketState): void {
  const algoId = getBotAlgoId(strategyId)
  if (!algoId) return

  // Skip sentinel monitor entries
  if (algoId.startsWith('monitor_')) return

  let trades  = 0
  let winning = 0
  let totalPnl = 0
  const deployed = estimateDeployed(strategyId)

  try {
    if (algoId.startsWith('dca_')) {
      // DCA bot performance
      const status = dcaClient.details(algoId.slice(4))
      if (!status) return
      totalPnl = parseFloat(status.pnl)
      const subOrders = dcaClient.subOrders(algoId.slice(4))
      trades  = subOrders.length
      winning = subOrders.filter(o => parseFloat(o.pnl ?? '0') > 0).length

    } else if (algoId.startsWith('swap_')) {
      // Swap position P&L
      const rec = getStrategy(strategyId)
      if (!rec) return
      const asset  = rec.spec.conditions.assets[0]
      const swapId = toSwapId(asset)
      const positions = swapClient.positions(swapId)
      if (positions.length === 0) return
      totalPnl = parseFloat(positions[0].upl)
      trades   = 1
      winning  = totalPnl > 0 ? 1 : 0

    } else if (algoId.startsWith('spot_')) {
      // Spot — limited P&L tracking
      return

    } else if (algoId.startsWith('recur_')) {
      // Recurring buy — compute P&L from avg buy price vs current price
      const rec = getStrategy(strategyId)
      if (!rec) return
      const state = getRecurringBuyState(strategyId)
      if (!state || state.totalQty <= 0) return
      const ticker = atk.ticker(state.instId)
      totalPnl = (ticker.last - state.avgPrice) * state.totalQty
      trades   = state.totalBuys
      winning  = totalPnl > 0 ? trades : 0

    } else if (algoId.startsWith('arb_')) {
      // Funding arb — P&L is accumulated funding payments
      const arbState = getFundingArbState(strategyId)
      if (!arbState) return
      totalPnl = arbState.accumulatedPnl
      trades   = 1
      winning  = totalPnl > 0 ? 1 : 0

    } else if (algoId.startsWith('twap_')) {
      // TWAP/Iceberg — compute P&L from avg fill price vs current price
      const twapState = getTWAPState(strategyId)
      if (!twapState || twapState.filledAmount <= 0) return
      const spotInstId = fromSwapId(twapState.instId)
      const ticker = atk.ticker(spotInstId)
      // For buy orders: current value - cost; for sell: cost - current value
      const filledQty = twapState.filledAmount / twapState.avgFillPrice
      if (twapState.side === 'buy') {
        totalPnl = (ticker.last - twapState.avgFillPrice) * filledQty
      } else {
        totalPnl = (twapState.avgFillPrice - ticker.last) * filledQty
      }
      trades  = twapState.slicesDone
      winning = totalPnl > 0 ? trades : 0

    } else if (algoId.startsWith('cgrid_')) {
      // Contract grid bot
      const realId = algoId.slice(6)
      const status = botClient.details(realId, 'contract_grid')
      if (!status) return
      const subOrders = botClient.subOrders(realId, 'contract_grid')
      trades   = subOrders.length
      winning  = subOrders.filter(o => parseFloat(o.pnl) > 0).length
      totalPnl = status.totalPnl

    } else {
      // Spot grid bot (default — no prefix)
      const status = botClient.details(algoId, 'grid')
      if (!status) return
      const subOrders = botClient.subOrders(algoId, 'grid')
      trades   = subOrders.length
      winning  = subOrders.filter(o => parseFloat(o.pnl) > 0).length
      totalPnl = status.totalPnl
    }
  } catch {
    return
  }

  const maxDD = Math.min(0, totalPnl) / (deployed || 500)

  upsertPerformance({
    strategy_id:    strategyId,
    market_state:   currentState,
    trades,
    winning_trades: winning,
    total_return:   deployed > 0 ? totalPnl / deployed : 0,
    max_drawdown:   Math.abs(maxDD),
  })
}

// ── Promotion / demotion cycle (runs daily) ───────────────────────────────────

export function runPromotionCycle(currentState: MarketState): void {
  // Check shadow strategies for promotion
  const shadowStrategies = getAllStrategies('shadow')
  for (const strat of shadowStrategies) {
    syncPerformance(strat.id, currentState)
    const check = checkPromotion(strat.id)
    if (check.eligible) {
      console.log(`  ${_gn('▲ PROMOTED')}  "${strat.name}" → ${_gn('LIVE')}`)
      stopShadowBot(strat.id)
      setStrategyStatus(strat.id, 'live')
      // Restart bot with live allocation
      const deployed = estimateDeployed(strat.id)
      startShadowBot(strat.id, deployed).catch(err =>
        console.warn(`  ${_yw('⚠')} Failed to restart "${strat.name}" as live: ${err}`)
      )
    } else {
      console.log(`  ${_yw('◷ SHADOW')}    "${strat.name}"  ${_dm(check.reasons[0] ?? '')}`)
    }
  }

  // Check live strategies for demotion
  const liveStrategies = getAllStrategies('live')
  for (const strat of liveStrategies) {
    const check = checkDemotion(strat.id)
    if (check.shouldDemote) {
      console.log(`  ${_rd('▼ DEMOTED')}   "${strat.name}"  ${_dm(check.reason ?? '')}`)
      setStrategyStatus(strat.id, 'demoted')
      startShadowBot(strat.id).catch(console.error)
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function persistBot(strategyId: string, algoId: string): void {
  activeBots.set(strategyId, algoId)
  db.prepare(`
    INSERT OR REPLACE INTO shadow_bots (strategy_id, algo_id, started_at)
    VALUES (?, ?, datetime('now'))
  `).run(strategyId, algoId)
}

function markStopped(strategyId: string): void {
  try {
    db.prepare('UPDATE shadow_bots SET stopped_at = datetime(\'now\') WHERE strategy_id = ? AND stopped_at IS NULL')
      .run(strategyId)
  } catch {}
}

function getBotAlgoId(strategyId: string): string | null {
  if (activeBots.has(strategyId)) return activeBots.get(strategyId)!

  // Restore from DB after restart — only return active (non-stopped) bots
  const row = db.prepare(
    'SELECT algo_id FROM shadow_bots WHERE strategy_id = ? AND stopped_at IS NULL ORDER BY started_at DESC LIMIT 1'
  ).get(strategyId) as { algo_id: string } | undefined

  if (row?.algo_id) {
    activeBots.set(strategyId, row.algo_id)
    return row.algo_id
  }
  return null
}

/** Estimate deployed capital based on tool type and params */
function estimateDeployed(strategyId: string): number {
  const rec = getStrategy(strategyId)
  if (!rec) return 500
  const p = rec.spec.execution.params as Record<string, unknown>
  const tool = rec.spec.execution.tool

  switch (tool) {
    case 'okx_grid_bot':
    case 'okx_grid_bot_create':
    case 'okx_contract_grid': {
      const gridCount = (p.grid_count as number) ?? 10
      const orderSize = (p.order_amount_usdt as number) ?? 10
      return gridCount * orderSize
    }
    case 'okx_dca_bot':
    case 'okx_dca_bot_create': {
      const initAmt   = (p.init_order_amt as number) ?? (p.order_amount_usdt as number) ?? 50
      const safetyN   = (p.max_safety_orders as number) ?? 3
      const safetyAmt = (p.safety_order_amt as number) ?? initAmt
      const volMult   = (p.vol_mult as number) ?? 2.0
      // Geometric sum: initAmt + safetyAmt * (1 + volMult + volMult^2 + ...)
      let total = initAmt
      let amt = safetyAmt
      for (let i = 0; i < safetyN; i++) {
        total += amt
        amt *= volMult
      }
      return total
    }
    case 'okx_swap_place':
    case 'okx_swap_trailing_stop':
      return (p.order_amount_usdt as number) ?? 50
    case 'okx_spot_order':
      return (p.order_amount_usdt as number) ?? 50
    case 'okx_recurring_buy':
      return (p.order_amount_usdt as number) ?? 50
    case 'okx_funding_arb':
      return ((p.order_amount_usdt as number) ?? 100) * 2
    case 'okx_twap':
    case 'okx_iceberg':
      return (p.total_amount_usdt as number) ?? 500
    default:
      return 500
  }
}

/**
 * Resolve the bot type from the prefixed algoId.
 * Used by execution manager for tool-aware P&L checks.
 */
export function getBotType(algoId: string): 'grid' | 'contract_grid' | 'dca' | 'swap' | 'spot' | 'recurring' | 'arb' | 'twap' | 'monitor' {
  if (algoId.startsWith('cgrid_'))   return 'contract_grid'
  if (algoId.startsWith('dca_'))     return 'dca'
  if (algoId.startsWith('swap_'))    return 'swap'
  if (algoId.startsWith('spot_'))    return 'spot'
  if (algoId.startsWith('recur_'))   return 'recurring'
  if (algoId.startsWith('arb_'))     return 'arb'
  if (algoId.startsWith('twap_'))    return 'twap'
  if (algoId.startsWith('monitor_')) return 'monitor'
  return 'grid'
}

export function getActiveBots(): Map<string, string> {
  return new Map(activeBots)
}

/**
 * Compute per-asset and per-strategy drawdowns from active bots.
 * Reuses syncPerformance() PnL patterns. Returns data for runRiskChecks().
 */
export function computeDrawdowns(): {
  assetDrawdowns: Record<string, number>
  strategyDrawdowns: Record<string, { name: string; drawdown: number; maxDeclared: number }>
} {
  const assetPnl: Record<string, { pnl: number; deployed: number }> = {}
  const strategyDrawdowns: Record<string, { name: string; drawdown: number; maxDeclared: number }> = {}

  for (const [strategyId, algoId] of activeBots) {
    if (algoId.startsWith('monitor_')) continue

    const rec = getStrategy(strategyId)
    if (!rec) continue

    const spec = rec.spec
    const asset = spec.conditions.assets[0]
    const deployed = estimateDeployed(strategyId)
    let totalPnl = 0

    try {
      if (algoId.startsWith('dca_')) {
        const status = dcaClient.details(algoId.slice(4))
        if (status) totalPnl = parseFloat(status.pnl)
      } else if (algoId.startsWith('swap_')) {
        const swapId = toSwapId(asset)
        const positions = swapClient.positions(swapId)
        if (positions.length > 0) totalPnl = parseFloat(positions[0].upl)
      } else if (algoId.startsWith('recur_')) {
        const state = getRecurringBuyState(strategyId)
        if (state && state.totalQty > 0) {
          const ticker = atk.ticker(state.instId)
          totalPnl = (ticker.last - state.avgPrice) * state.totalQty
        }
      } else if (algoId.startsWith('arb_')) {
        const arbState = getFundingArbState(strategyId)
        if (arbState) totalPnl = arbState.accumulatedPnl
      } else if (algoId.startsWith('twap_')) {
        const twapState = getTWAPState(strategyId)
        if (twapState && twapState.filledAmount > 0) {
          const spotInstId = fromSwapId(twapState.instId)
          const ticker = atk.ticker(spotInstId)
          const filledQty = twapState.filledAmount / twapState.avgFillPrice
          totalPnl = twapState.side === 'buy'
            ? (ticker.last - twapState.avgFillPrice) * filledQty
            : (twapState.avgFillPrice - ticker.last) * filledQty
        }
      } else if (algoId.startsWith('cgrid_')) {
        const status = botClient.details(algoId.slice(6), 'contract_grid')
        if (status) totalPnl = status.totalPnl
      } else {
        const status = botClient.details(algoId, 'grid')
        if (status) totalPnl = status.totalPnl
      }
    } catch {
      continue
    }

    // Per-strategy drawdown
    const drawdown = deployed > 0 ? Math.abs(Math.min(0, totalPnl)) / deployed : 0
    const maxDeclared = (spec.risk?.max_drawdown_pct ?? 20) / 100
    strategyDrawdowns[strategyId] = { name: rec.name, drawdown, maxDeclared }

    // Aggregate per-asset
    if (!assetPnl[asset]) assetPnl[asset] = { pnl: 0, deployed: 0 }
    assetPnl[asset].pnl += totalPnl
    assetPnl[asset].deployed += deployed
  }

  // Convert asset PnL to drawdown ratios
  const assetDrawdowns: Record<string, number> = {}
  for (const [asset, data] of Object.entries(assetPnl)) {
    if (data.deployed > 0 && data.pnl < 0) {
      assetDrawdowns[asset] = Math.abs(data.pnl) / data.deployed
    }
  }

  return { assetDrawdowns, strategyDrawdowns }
}

// ── Dead bot recovery ─────────────────────────────────────────────────────────
//
// Detects shadow/live strategies that have no active bot (dead/expired on OKX)
// and restarts them. Called periodically from the risk heartbeat.
//
// Cooldown: strategies that fail to start are suppressed for 30 minutes
// to avoid log spam (e.g. HYPE/OKB with no SWAP instrument, unmet entry signals).

const _recoveryCooldown = new Map<string, number>()
const RECOVERY_COOLDOWN_MS = 30 * 60_000 // 30 minutes

/**
 * Clean up duplicate and orphan grid bots on OKX.
 * When the system creates new bots but old ones from previous runs are still active,
 * we end up with duplicates eating into the 25-bot limit.
 * This function stops older duplicates (keeping the newest per instId+type).
 */
export function cleanupDuplicateGridBots(): number {
  let stopped = 0
  try {
    const allGrids = botClient.listAll()
    // Group by instId + type
    const grouped = new Map<string, typeof allGrids>()
    for (const bot of allGrids) {
      const key = `${bot.instId}:${bot.type}`
      if (!grouped.has(key)) grouped.set(key, [])
      grouped.get(key)!.push(bot)
    }
    // For each group with >1 bots, stop all but the newest (highest algoId)
    for (const [key, bots] of grouped) {
      if (bots.length <= 1) continue
      // Sort by algoId descending (newer IDs are larger)
      bots.sort((a, b) => (BigInt(b.algoId) > BigInt(a.algoId) ? 1 : -1))
      const keep = bots[0]
      for (let i = 1; i < bots.length; i++) {
        const dup = bots[i]
        try {
          botClient.stop(dup.algoId, dup.instId, dup.type as GridType)
          console.log(`  [Shadow] Stopped duplicate ${key} bot ${dup.algoId} (keeping ${keep.algoId})`)
          stopped++
        } catch {}
      }
    }
    // Also stop bots for instruments that are no longer in our strategy config
    const configuredAssets = new Set<string>()
    const allStrats = [...getAllStrategies('shadow'), ...getAllStrategies('live')]
    for (const s of allStrats) {
      for (const a of s.spec.conditions.assets) configuredAssets.add(a)
    }
    for (const bot of allGrids) {
      const spotId = bot.instId.replace('-SWAP', '')
      if (!configuredAssets.has(spotId) && !configuredAssets.has('*')) {
        try {
          botClient.stop(bot.algoId, bot.instId, bot.type as GridType)
          console.log(`  [Shadow] Stopped orphan bot ${bot.instId} ${bot.algoId} (asset no longer configured)`)
          stopped++
        } catch {}
      }
    }
  } catch (err) {
    console.warn(`  [Shadow] Grid cleanup error: ${err}`)
  }
  return stopped
}

export async function ensureShadowBotsRunning(): Promise<void> {
  const shadows = getAllStrategies('shadow')
  const live    = getAllStrategies('live')

  for (const s of [...shadows, ...live]) {
    // Skip if already has an active bot in memory
    if (activeBots.has(s.id)) continue

    // Skip if has an active (non-stopped) bot in DB
    const activeRow = db.prepare(
      'SELECT id FROM shadow_bots WHERE strategy_id = ? AND stopped_at IS NULL LIMIT 1'
    ).get(s.id)
    if (activeRow) continue

    // Skip if recently failed (cooldown to prevent log/API spam)
    const lastFail = _recoveryCooldown.get(s.id)
    if (lastFail && Date.now() - lastFail < RECOVERY_COOLDOWN_MS) continue

    // No active bot — try to restart
    try {
      await startShadowBot(s.id)
      _recoveryCooldown.delete(s.id) // success — clear cooldown
    } catch {
      _recoveryCooldown.set(s.id, Date.now())
    }
  }
}

// ── ANSI helpers (mirrors index.ts, no shared dep needed) ────────────────────

const _C  = { reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m', cyan:'\x1b[36m', green:'\x1b[32m', yellow:'\x1b[33m', red:'\x1b[31m' }
const _b  = (s: string) => `${_C.bold}${s}${_C.reset}`
const _cy = (s: string) => `${_C.cyan}${s}${_C.reset}`
const _gn = (s: string) => `${_C.green}${s}${_C.reset}`
const _yw = (s: string) => `${_C.yellow}${s}${_C.reset}`
const _rd = (s: string) => `${_C.red}${s}${_C.reset}`
const _dm = (s: string) => `${_C.dim}${s}${_C.reset}`

// ── Status display ────────────────────────────────────────────────────────────

const TOOL_LABELS: Record<string, string> = {
  okx_grid_bot:           '现货网格',
  okx_grid_bot_create:    '现货网格',
  okx_contract_grid:      '合约网格',
  okx_dca_bot:            '马丁格尔',
  okx_dca_bot_create:     '马丁格尔',
  okx_swap_place:         '合约交易',
  okx_swap_trailing_stop: '趋势追踪',
  okx_spot_order:         '现货交易',
  okx_recurring_buy:      '定期买入',
  okx_funding_arb:        '费率套利',
  okx_twap:               '时间加权',
  okx_iceberg:            '冰山策略',
}

export function printShadowStatus(): void {
  const shadows = getAllStrategies('shadow')
  const live    = getAllStrategies('live')
  const all     = [...shadows, ...live]

  if (all.length === 0) {
    console.log(_dm('  暂无注册策略'))
    return
  }

  console.log()
  console.log(`  ${_b('策略列表')}`)
  console.log(_cy('  ┌──────────────────────────────────┬──────────┬──────────┬──────────────────────┐'))
  console.log(_cy('  │') + _dm(` ${'策略名称'.padEnd(32)}`) + _cy('│') + _dm(` ${'类型'.padEnd(8)}`) + _cy('│') + _dm(` ${'状态'.padEnd(8)}`) + _cy('│') + _dm(` ${'机器人ID'.padEnd(20)}`) + _cy('│'))
  console.log(_cy('  ├──────────────────────────────────┼──────────┼──────────┼──────────────────────┤'))

  const STATUS_CN: Record<string, string> = { live: '运行中', shadow: '影子测试', paused: '已暂停', demoted: '已降级' }

  for (const s of all) {
    const algoId   = getBotAlgoId(s.id)
    const botType  = algoId ? getBotType(algoId) : null
    const isSentinel = botType === 'monitor'
    const botStr   = isSentinel ? _dm('仅监控'.padEnd(20))
                   : algoId     ? _cy(('…' + algoId.slice(-12)).padEnd(20))
                   : _dm('─'.repeat(20))
    const statusCN = STATUS_CN[s.status] ?? s.status
    const statusColored = s.status === 'live'   ? _gn(statusCN.padEnd(8))
                        : s.status === 'shadow' ? _yw(statusCN.padEnd(8))
                        : _rd(statusCN.padEnd(8))
    const toolLabel = (TOOL_LABELS[s.spec.execution.tool] ?? s.spec.execution.tool.slice(4, 11)).padEnd(8)
    const nameStr  = s.name.slice(0, 32).padEnd(32)
    console.log(`  ${_cy('│')} ${nameStr}  ${_cy('│')} ${_dm(toolLabel)}${_cy('│')} ${statusColored}${_cy('│')} ${botStr}  ${_cy('│')}`)
  }
  console.log(_cy('  └──────────────────────────────────┴──────────┴──────────┴──────────────────────┘'))
}
