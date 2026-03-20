/**
 * DARWIN Configuration
 * Loads from .env file. All modules import from here.
 */

import { readFileSync } from 'fs'
import path from 'path'

function loadEnv(): Record<string, string> {
  try {
    const envPath = path.join(process.cwd(), '.env')
    const content = readFileSync(envPath, 'utf8')
    const result: Record<string, string> = {}
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const idx = trimmed.indexOf('=')
      if (idx === -1) continue
      const key = trimmed.slice(0, idx).trim()
      const val = trimmed.slice(idx + 1).trim()
      result[key] = val
    }
    return result
  } catch {
    return {}
  }
}

const env = { ...loadEnv(), ...process.env }

/** 现货 instId → 合约 instId（处理 OKX 改名：XAUT-USDT-SWAP → XAU-USDT-SWAP） */
export function toSwapId(spotId: string): string {
  if (spotId.startsWith('XAUT-USDT')) return 'XAU-USDT-SWAP'
  return spotId.replace('-USDT', '-USDT-SWAP')
}

/** 合约 instId → 现货 instId（toSwapId 的逆映射） */
export function fromSwapId(swapId: string): string {
  if (swapId === 'XAU-USDT-SWAP') return 'XAUT-USDT'
  return swapId.replace('-USDT-SWAP', '-USDT')
}

export const config = {
  okx: {
    apiKey:     env.OKX_API_KEY     ?? '',
    secretKey:  env.OKX_SECRET_KEY  ?? '',
    passphrase: env.OKX_PASSPHRASE  ?? '',
    demoMode:   (env.OKX_DEMO_MODE  ?? 'true') === 'true',
  },
  risk: {
    tier: (env.RISK_TIER ?? 'balanced') as 'conservative' | 'balanced' | 'aggressive',
  },
  db: {
    path: env.DARWIN_DB_PATH ?? path.join(process.env.HOME ?? '/tmp', '.darwin', 'darwin.db'),
  },
  // 用户可通过 .env ASSETS 配置白名单币种，AI 在白名单范围内选择调控
  assets: (env.ASSETS ?? 'BTC-USDT,ETH-USDT,SOL-USDT,XRP-USDT,DOGE-USDT,TRX-USDT,HYPE-USDT,OKB-USDT,XAUT-USDT').split(',').map(s => s.trim()),
  heartbeatMinutes: parseInt(env.HEARTBEAT_MINUTES ?? '15'),
  telegram: {
    botToken: env.TELEGRAM_BOT_TOKEN ?? '',
    chatId:   env.TELEGRAM_CHAT_ID ?? '',
    enabled:  !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
  },
}
