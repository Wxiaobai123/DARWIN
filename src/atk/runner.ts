/**
 * Safe ATK CLI runner — NO shell injection risk
 *
 * Uses execFileSync with argument arrays (never string concatenation).
 * Environment variables passed via env option (never embedded in command string).
 */

import { execFileSync, execFile } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'
import { config } from '../config.js'

/** Resolve OKX CLI path: env → which → default */
const OKX_BIN = (() => {
  // 1. Environment variable override
  if (process.env.OKX_CLI_PATH && existsSync(process.env.OKX_CLI_PATH))
    return process.env.OKX_CLI_PATH

  // 2. Try `which okx` to find globally installed CLI
  try {
    const found = execFileSync('which', ['okx'], { encoding: 'utf8', timeout: 3000 }).trim()
    if (found && existsSync(found)) return found
  } catch {}

  // 3. Default path
  const defaultPath = path.join(
    process.env.HOME ?? '/tmp',
    '.local/lib/node_modules/okx-trade-cli/bin/okx.mjs'
  )
  if (!existsSync(defaultPath)) {
    console.warn(`  [ATK] OKX CLI not found at ${defaultPath}. Set OKX_CLI_PATH env or install globally.`)
  }
  return defaultPath
})()

/**
 * Run an ATK CLI command safely.
 * @param args  — CLI arguments as an array (e.g. ['market', 'ticker', 'BTC-USDT'])
 * @param auth  — if true, passes OKX API credentials via env (not command string)
 */
export function runATK(args: string[], auth = false): unknown {
  const fullArgs = ['--json', ...(config.okx.demoMode ? ['--demo'] : []), ...args]

  const env: Record<string, string> = { ...process.env as Record<string, string> }
  if (auth) {
    env.OKX_API_KEY     = config.okx.apiKey
    env.OKX_SECRET_KEY  = config.okx.secretKey
    env.OKX_PASSPHRASE  = config.okx.passphrase
  }

  try {
    const out = execFileSync('node', [OKX_BIN, ...fullArgs], {
      encoding: 'utf8',
      timeout:  15_000,
      env,
      stdio:    ['pipe', 'pipe', 'pipe'],  // 捕获 stderr，避免 ATK 错误直接打印到终端
    })
    const txt = out.trim()
    if (!txt) return null
    return JSON.parse(txt)
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    const detail = (e.stdout || e.stderr || e.message || String(err)).slice(0, 300)
    throw new Error(`ATK [${args.join(' ')}]: ${detail}`)
  }
}

/**
 * Async version of runATK — does NOT block event loop.
 */
export function runATKAsync(args: string[], auth = false): Promise<unknown> {
  const fullArgs = ['--json', ...(config.okx.demoMode ? ['--demo'] : []), ...args]

  const env: Record<string, string> = { ...process.env as Record<string, string> }
  if (auth) {
    env.OKX_API_KEY     = config.okx.apiKey
    env.OKX_SECRET_KEY  = config.okx.secretKey
    env.OKX_PASSPHRASE  = config.okx.passphrase
  }

  return new Promise((resolve, reject) => {
    execFile('node', [OKX_BIN, ...fullArgs], {
      encoding: 'utf8',
      timeout: 15_000,
      env,
    }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stdout || stderr || err.message || String(err)).slice(0, 300)
        reject(new Error(`ATK [${args.join(' ')}]: ${detail}`))
        return
      }
      const txt = (stdout || '').trim()
      if (!txt) { resolve(null); return }
      try { resolve(JSON.parse(txt)) }
      catch { reject(new Error(`ATK parse error: ${txt.slice(0, 100)}`)) }
    })
  })
}
