/**
 * Strategy Loader — reads YAML files from strategies/ directory
 * and registers them into the database if not already present.
 *
 * Uses js-yaml for robust parsing (replaces fragile regex-based parser).
 */

import { readFileSync, readdirSync, existsSync } from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import yaml from 'js-yaml'
import db from '../db.js'
import { config } from '../config.js'
import { validateStrategy, type StrategySpec } from './validator.js'

/**
 * Parse a YAML strategy file into a StrategySpec.
 * Fills in defaults for optional fields.
 */
function parseStrategyYaml(content: string): StrategySpec {
  const raw = yaml.load(content) as Record<string, unknown>
  if (!raw || typeof raw !== 'object') throw new Error('Invalid YAML: not an object')

  const meta       = (raw.metadata   ?? {}) as Record<string, unknown>
  const conditions = (raw.conditions ?? {}) as Record<string, unknown>
  const execution  = (raw.execution  ?? {}) as Record<string, unknown>
  const params     = (execution.params ?? {}) as Record<string, unknown>
  const risk       = (raw.risk       ?? {}) as Record<string, unknown>
  const promotion  = (raw.promotion  ?? {}) as Record<string, unknown>
  const demotion   = (raw.demotion   ?? {}) as Record<string, unknown>
  const elimination = (raw.elimination ?? {}) as Record<string, unknown>

  return {
    metadata: {
      id:          String(meta.id ?? ''),
      name:        String(meta.name ?? ''),
      author:      String(meta.author ?? ''),
      version:     String(meta.version ?? '1.0'),
      created_at:  String(meta.created_at ?? new Date().toISOString()),
      description: String(meta.description ?? ''),
    },
    conditions: {
      market_states:        toStringArray(conditions.market_states) as Array<'oscillation' | 'trend' | 'extreme'>,
      assets:               toStringArray(conditions.assets),
      min_atr_ratio:        toNullableNum(conditions.min_atr_ratio),
      max_atr_ratio:        toNullableNum(conditions.max_atr_ratio),
      min_funding_rate:     toNullableNum(conditions.min_funding_rate),
      max_funding_rate:     toNullableNum(conditions.max_funding_rate),
      paused_during_events: toStringArray(conditions.paused_during_events),
    },
    execution: {
      tool:          String(execution.tool ?? ''),
      // Pass through ALL params from YAML — tool-specific params vary widely:
      //   grid:  grid_count, price_range_pct, order_amount_usdt
      //   dca:   lever, direction, init_order_amt, max_safety_orders, tp_pct, ...
      //   swap:  lever, direction, order_amount_usdt, callback_ratio, td_mode
      //   spot:  order_type, size_pct_of_allocation, order_amount_usdt
      params: { ...params },
      entry_signal:   String(execution.entry_signal ?? ''),
      exit_signal:    String(execution.exit_signal ?? ''),
      max_hold_hours: toNullableNum(execution.max_hold_hours),
    },
    risk: {
      max_drawdown_pct:      toNum(risk.max_drawdown_pct, 10),
      stop_loss_pct:         toNum(risk.stop_loss_pct, 15),
      take_profit_pct:       toNullableNum(risk.take_profit_pct),
      max_position_usdt:     toNullableNum(risk.max_position_usdt),
      pause_after_loss_days: toNullableInt(risk.pause_after_loss_days),
    },
    promotion: {
      min_shadow_days:       toInt(promotion.min_shadow_days, 7),
      min_trades:            toInt(promotion.min_trades, 20),
      min_win_rate:          toNum(promotion.min_win_rate, 0.55),
      max_realized_drawdown: toNum(promotion.max_realized_drawdown, 0.10),
      min_days_per_state:    toInt(promotion.min_days_per_state, 5),
    },
    demotion: {
      live_drawdown_trigger_pct: toNum(demotion.live_drawdown_trigger_pct, 10),
      consecutive_loss_days:     toInt(demotion.consecutive_loss_days, 3),
    },
    elimination: {
      failed_shadow_attempts: toInt(elimination.failed_shadow_attempts, 3),
    },
  }
}

// ── Type coercion helpers ───────────────────────────────────────────────────

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String)
  if (typeof v === 'string') return [v]
  return []
}

function toNullableNum(v: unknown): number | null {
  if (v == null) return null
  const n = Number(v)
  return isNaN(n) ? null : n
}

function toNullableInt(v: unknown): number | null {
  if (v == null) return null
  const n = parseInt(String(v))
  return isNaN(n) ? null : n
}

function toNum(v: unknown, fallback: number): number {
  return toNullableNum(v) ?? fallback
}

function toInt(v: unknown, fallback: number): number {
  return toNullableInt(v) ?? fallback
}

// ── Public API ──────────────────────────────────────────────────────────────

export function loadOfficialStrategies(): void {
  const strategiesDir = path.join(process.cwd(), 'strategies', 'official')
  if (!existsSync(strategiesDir)) return

  const files = readdirSync(strategiesDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))

  // ── Track base template names from YAML files for orphan cleanup ────────
  // We track the base strategy name (e.g. "现货网格") from each YAML, NOT the
  // per-asset instance names (e.g. "现货网格 · BTC").  This way, changing
  // the ASSETS env var doesn't delete strategies for other assets — only
  // strategies whose YAML file was truly deleted get cleaned up.
  const loadedNames = new Set<string>()
  const loadedBaseNames = new Set<string>()

  for (const file of files) {
    try {
      const content = readFileSync(path.join(strategiesDir, file), 'utf8')
      const spec = parseStrategyYaml(content)

      // 官方策略也需通过验证，确保 YAML 无误
      const vr = validateStrategy(spec)
      if (!vr.ok) {
        console.warn(`  [Loader] 验证失败 ${file}:\n    ${vr.errors.join('\n    ')}`)
        continue
      }

      // 通配符 "*" → 展开为用户白名单中的所有币种
      // 例如 ASSETS=BTC-USDT,ETH-USDT,SOL-USDT 时:
      //   "现货网格" with ["*"] → 展开为 ["BTC-USDT","ETH-USDT","SOL-USDT"]
      loadedBaseNames.add(spec.metadata.name)

      const assets = spec.conditions.assets.includes('*')
        ? config.assets
        : spec.conditions.assets
      const instances = assets.length > 1
        ? assets.map(a => ({
            name:  `${spec.metadata.name} · ${a.split('-')[0]}`,
            asset: a,
          }))
        : [{ name: spec.metadata.name, asset: assets[0] }]

      for (const inst of instances) {
        loadedNames.add(inst.name)

        const instanceSpec = JSON.parse(JSON.stringify(spec)) as StrategySpec
        instanceSpec.metadata.name = inst.name
        instanceSpec.conditions.assets = [inst.asset]

        // Check if already registered by name
        const existing = db.prepare('SELECT id, spec FROM strategies WHERE name = ?').get(inst.name) as { id: string; spec: string } | undefined
        if (existing) {
          // Update spec if YAML version changed
          try {
            const dbSpec = JSON.parse(existing.spec) as StrategySpec
            if (dbSpec.metadata.version !== instanceSpec.metadata.version) {
              instanceSpec.metadata.id = existing.id
              db.prepare('UPDATE strategies SET spec = ? WHERE id = ?')
                .run(JSON.stringify(instanceSpec), existing.id)
              console.log(`  [Loader] 已更新: "${inst.name}" v${dbSpec.metadata.version} → v${instanceSpec.metadata.version}`)
            }
          } catch {}
          continue
        }

        const id = randomUUID()
        instanceSpec.metadata.id = id

        db.prepare(`
          INSERT INTO strategies (id, name, author, spec, status, shadow_started_at)
          VALUES (?, ?, ?, ?, 'shadow', datetime('now'))
        `).run(id, inst.name, instanceSpec.metadata.author, JSON.stringify(instanceSpec))

        console.log(`  [Loader] 已注册: "${inst.name}"`)
      }
    } catch (err) {
      console.warn(`  [Loader] 加载失败 ${file}: ${err}`)
    }
  }

  // ── Clean up orphaned strategies whose YAML was deleted ─────────────────
  // Only remove official strategies (author = 'darwin_official') whose
  // base template name no longer exists in ANY YAML file.
  // Strategies for assets not in current ASSETS env are kept — they were
  // validly created from a YAML that still exists, just with a different
  // asset whitelist.
  try {
    const officialRows = db.prepare(
      `SELECT id, name FROM strategies WHERE author = 'darwin_official'`
    ).all() as Array<{ id: string; name: string }>

    for (const row of officialRows) {
      // Extract base name: "现货网格 · BTC" → "现货网格", "现货网格" → "现货网格"
      const baseName = row.name.includes(' · ') ? row.name.split(' · ')[0] : row.name
      if (!loadedBaseNames.has(baseName)) {
        db.prepare('DELETE FROM strategies WHERE id = ?').run(row.id)
        try { db.prepare('DELETE FROM shadow_bots WHERE strategy_id = ?').run(row.id) } catch {}
        try { db.prepare('DELETE FROM recurring_buys WHERE strategy_id = ?').run(row.id) } catch {}
        console.log(`  [Loader] 已清理孤儿策略: "${row.name}"`)
      }
    }
  } catch (err) {
    console.warn(`  [Loader] 孤儿清理失败: ${err}`)
  }
}

/**
 * Parse a community-submitted YAML strategy with full validation.
 * Returns the validated spec or throws on error.
 */
export function parseAndValidateStrategy(yamlContent: string): StrategySpec {
  const spec = parseStrategyYaml(yamlContent)
  const result = validateStrategy(spec)
  if (!result.ok) {
    throw new Error(`Strategy validation failed:\n  ${result.errors.join('\n  ')}`)
  }
  return spec
}
