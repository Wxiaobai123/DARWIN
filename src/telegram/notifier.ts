/**
 * DARWIN Telegram Notifier
 *
 * Sends alerts to Telegram via Bot API using native fetch().
 * Gracefully no-ops if TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not configured.
 */

import { config } from '../config.js'

const API_BASE = () => `https://api.telegram.org/bot${config.telegram.botToken}`

let lastSentAt = 0
const MIN_INTERVAL_MS = 3000 // 3s between messages

async function sendMessage(text: string): Promise<void> {
  if (!config.telegram.enabled) return

  // Rate limit
  const now = Date.now()
  if (now - lastSentAt < MIN_INTERVAL_MS) {
    await new Promise(r => setTimeout(r, MIN_INTERVAL_MS - (now - lastSentAt)))
  }
  lastSentAt = Date.now()

  try {
    await fetch(`${API_BASE()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegram.chatId,
        text,
        parse_mode: 'Markdown',
      }),
    })
  } catch (e) {
    console.warn(`[Telegram] Send failed: ${e}`)
  }
}

// ── Public notification functions ─────────────────────────────────────────────

export async function notifyCBTriggered(tier: number, reason: string): Promise<void> {
  const emoji = tier >= 4 ? '\u{1F6A8}' : tier >= 3 ? '\u{26A0}\u{FE0F}' : '\u{1F6E1}'
  await sendMessage(
    `${emoji} *DARWIN \u7194\u65AD\u8B66\u62A5*\n\n` +
    `\u7B49\u7EA7: *T${tier}*\n` +
    `\u539F\u56E0: ${reason}\n` +
    `\u65F6\u95F4: ${new Date().toISOString().slice(0, 19).replace('T', ' ')}\n\n` +
    (tier >= 3 ? '\u{26A0}\u{FE0F} \u9700\u8981\u4EBA\u5DE5\u5BA1\u6279\u624D\u80FD\u6062\u590D\u4EA4\u6613' : '\u7CFB\u7EDF\u5DF2\u81EA\u52A8\u5904\u7406')
  )
}

export async function notifyDailyReport(summary: string): Promise<void> {
  await sendMessage(
    `\u{1F4CA} *DARWIN \u6BCF\u65E5\u62A5\u544A*\n\n${summary.slice(0, 3000)}`
  )
}

export async function notifyPromotion(name: string, from: string, to: string): Promise<void> {
  const emoji = to === 'live' ? '\u{1F389}' : to === 'demoted' ? '\u{1F53B}' : '\u{274C}'
  const CN: Record<string, string> = { shadow: '\u5F71\u5B50', live: '\u5B9E\u76D8', demoted: '\u964D\u7EA7', eliminated: '\u6DD8\u6C70' }
  await sendMessage(
    `${emoji} *\u7B56\u7565\u53D8\u66F4*\n\n` +
    `\u7B56\u7565: *${name}*\n` +
    `${CN[from] || from} \u2192 ${CN[to] || to}`
  )
}

export async function notifyStrategyAlert(name: string, msg: string): Promise<void> {
  await sendMessage(
    `\u{26A0}\u{FE0F} *\u7B56\u7565\u5F02\u5E38*\n\n\u7B56\u7565: *${name}*\n${msg}`
  )
}

export async function notifySystemEvent(msg: string): Promise<void> {
  await sendMessage(`\u{2139}\u{FE0F} *DARWIN*\n\n${msg}`)
}
