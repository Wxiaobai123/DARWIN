import { swapClient } from '../atk/swap.js'

interface EnsureSwapLeverageOptions {
  mgnMode?: 'cross' | 'isolated'
  posSide?: 'net' | 'long' | 'short'
  attempts?: number
  delayMs?: number
  logPrefix?: string
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function blockerMessage(msg: string): boolean {
  return (
    msg.includes('Cancel cross-margin TP/SL') ||
    msg.includes('trailing, trigger, and chase orders') ||
    msg.includes('stop bots before adjusting your leverage')
  )
}

export function ensureSwapLeverage(
  instId: string,
  lever: number,
  opts: EnsureSwapLeverageOptions = {},
): boolean {
  const {
    mgnMode = 'cross',
    posSide,
    attempts = 4,
    delayMs = 1500,
    logPrefix = '  [Leverage]',
  } = opts

  try {
    if (swapClient.leverageMatches(instId, lever, mgnMode, posSide)) {
      return true
    }
  } catch {
    // If leverage lookup fails we still try to set it below.
  }

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      swapClient.setLeverage(instId, lever, mgnMode, posSide)
      if (swapClient.leverageMatches(instId, lever, mgnMode, posSide)) {
        return true
      }
    } catch (e) {
      const msg = String(e)
      console.warn(`${logPrefix} setLeverage ${instId} ${lever}x attempt ${attempt + 1} failed: ${msg}`)

      if (mgnMode === 'cross' && blockerMessage(msg)) {
        const cleared = swapClient.clearAlgoOrders(instId)
        if (cleared > 0) {
          console.log(`${logPrefix} Cleared ${cleared} pending swap algo order(s) on ${instId}`)
        }
      }
    }

    try {
      if (swapClient.leverageMatches(instId, lever, mgnMode, posSide)) {
        return true
      }
    } catch {
      // Ignore lookup errors between retries.
    }

    if (attempt < attempts - 1) {
      sleepSync(delayMs * (attempt + 1))
    }
  }

  try {
    return swapClient.leverageMatches(instId, lever, mgnMode, posSide)
  } catch {
    return false
  }
}
