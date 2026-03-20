/**
 * Strategy Integration Test — opens and closes each tool type
 * Tests: grid, contract grid, DCA, swap, spot, recurring buy, funding arb
 *
 * Usage:
 *   pnpm run test:strategies          # BTC-USDT only (fast)
 *   pnpm run test:strategies -- --all  # All 6 coins
 */

import { config } from './config.js'
import db from './db.js'
import { loadOfficialStrategies } from './strategy/loader.js'
import { getAllStrategies } from './strategy/archive.js'
import { startShadowBot, stopShadowBot } from './shadow/runner.js'
import { restoreStateFromDB } from './risk/circuit-breaker.js'

const C = {
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  dim:    '\x1b[2m',
  bold:   '\x1b[1m',
  reset:  '\x1b[0m',
}

const pass = (msg: string) => console.log(`  ${C.green}✓${C.reset} ${msg}`)
const fail = (msg: string, err: unknown) => console.log(`  ${C.red}✗${C.reset} ${msg}: ${C.dim}${String(err).slice(0, 200)}${C.reset}`)
const skip = (msg: string, reason: string) => console.log(`  ${C.yellow}⊘${C.reset} ${msg} ${C.dim}(${reason})${C.reset}`)

const ALL_MODE = process.argv.includes('--all')
const TEST_ASSETS = ALL_MODE ? config.assets : ['BTC-USDT']

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

async function main() {
  console.log()
  console.log(`${C.bold}  DARWIN Strategy Integration Test${C.reset}`)
  console.log(`  ${'─'.repeat(50)}`)
  console.log(`  ${C.dim}Assets: ${TEST_ASSETS.join(', ')}  Mode: ${config.okx.demoMode ? 'DEMO' : 'LIVE'}${C.reset}`)
  console.log()

  // Initialize DB and load strategies
  restoreStateFromDB()

  // Override ASSETS to test set
  ;(config as any).assets = TEST_ASSETS
  loadOfficialStrategies()

  const strategies = getAllStrategies('shadow')
  console.log(`  ${C.dim}Loaded ${strategies.length} strategy instances${C.reset}`)
  console.log()

  // Group by tool type
  const toolGroups = new Map<string, typeof strategies>()
  for (const s of strategies) {
    const tool = s.spec.execution.tool
    if (!toolGroups.has(tool)) toolGroups.set(tool, [])
    toolGroups.get(tool)!.push(s)
  }

  let passed = 0
  let failed = 0
  let skipped = 0
  const skippedTools: Array<{ tool: string; strat: typeof strategies[0] }> = []

  for (const [tool, strats] of toolGroups) {
    // In --all mode: test every coin. In default mode: test first coin only.
    const toTest = ALL_MODE ? strats : [strats[0]]

    for (const strat of toTest) {
      const asset = strat.spec.conditions.assets[0]
      console.log(`${C.bold}  [${tool}]${C.reset} ${strat.name} ${C.dim}(${asset})${C.reset}`)

      // ── OPEN ──
      let opened = false
      try {
        const botId = await startShadowBot(strat.id)
        pass(`开仓成功  botId=${botId.slice(0, 20)}...`)
        opened = true
      } catch (err) {
        const errStr = String(err)
        if (errStr.includes('skipping')) {
          skip('跳过', errStr.match(/Signal.*skipping|Funding.*skipping|ATR.*skipping/)?.[0] ?? '')
          // Only add to forced retry for BTC (avoid duplicate forced tests for all coins)
          if (asset === 'BTC-USDT') skippedTools.push({ tool, strat })
          skipped++
          console.log()
          continue
        }
        fail('开仓失败', err)
        failed++
        console.log()
        continue
      }

      await sleep(2000)

      // ── CLOSE ──
      if (opened) {
        try {
          stopShadowBot(strat.id)
          pass('平仓成功')
          passed++
        } catch (err) {
          fail('平仓失败', err)
          failed++
        }
      }

      console.log()
    }
  }

  // ── Second pass: force-test skipped tools by overriding entry signals ──
  if (skippedTools.length > 0) {
    console.log(`  ${'─'.repeat(50)}`)
    console.log(`${C.bold}  强制测试跳过的策略 (绕过入场信号)${C.reset}`)
    console.log()

    for (const { tool, strat } of skippedTools) {
      const asset = strat.spec.conditions.assets[0]
      console.log(`${C.bold}  [${tool}]${C.reset} ${strat.name} ${C.dim}(${asset}) (强制)${C.reset}`)

      // Save original spec JSON from DB
      const origRow = db.prepare('SELECT spec FROM strategies WHERE id = ?').get(strat.id) as { spec: string }
      const origSpec = origRow.spec

      // Override spec in DB to bypass signal/condition checks
      const modSpec = JSON.parse(origSpec)
      modSpec.execution.entry_signal = 'immediate'
      delete modSpec.conditions.min_funding_rate
      if (tool === 'okx_funding_arb') {
        modSpec.execution.params.min_annual_pct = 0
      }
      db.prepare('UPDATE strategies SET spec = ? WHERE id = ?').run(JSON.stringify(modSpec), strat.id)

      let opened = false
      try {
        const botId = await startShadowBot(strat.id)
        pass(`开仓成功  botId=${botId.slice(0, 20)}...`)
        opened = true
      } catch (err) {
        fail('开仓失败', err)
        failed++
        db.prepare('UPDATE strategies SET spec = ? WHERE id = ?').run(origSpec, strat.id)
        console.log()
        continue
      }

      await sleep(2000)

      if (opened) {
        try {
          stopShadowBot(strat.id)
          pass('平仓成功')
          passed++
          skipped--
        } catch (err) {
          fail('平仓失败', err)
          failed++
          skipped--
        }
      }

      // Restore original spec in DB
      db.prepare('UPDATE strategies SET spec = ? WHERE id = ?').run(origSpec, strat.id)
      console.log()
    }
  }

  // ── Summary ──
  console.log(`  ${'─'.repeat(50)}`)
  console.log(
    `  ${C.bold}结果:${C.reset}  ` +
    `${C.green}${passed} 通过${C.reset}  ` +
    `${C.red}${failed} 失败${C.reset}  ` +
    `${C.yellow}${skipped} 跳过${C.reset}`
  )
  console.log()

  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error(`Fatal: ${err}`)
  process.exit(1)
})
