/**
 * DARWIN × Paperclip REST Client
 *
 * Posts run results, activity log entries, and approval requests
 * back to the Paperclip server at http://127.0.0.1:3100.
 *
 * Design principles (aligned with Paperclip's agent org model):
 *  • Every heartbeat execution is logged as an activity event
 *  • Risk events requiring human sign-off become Paperclip approvals
 *  • The Risk Agent polls for resolved approvals on every tick
 *    and auto-resumes trading once the human approves
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const PAPERCLIP_URL = 'http://127.0.0.1:3100/api'
const COMPANY_ID    = 'dd2ca47a-b060-4b7e-9b14-60a0acc0a12c'

/** Agent URL-key → Paperclip agent UUID  */
const AGENT_IDS: Record<string, string> = {
  'market-analyst':   '81c70dbd-bfec-4b96-86c8-0de8eef7b198',
  'risk-agent':       'a5d406a8-ad1c-4ea3-895d-20001d779747',
  'cto-agent':        'b63082a3-c353-43c7-82ed-38aab1287561',
  'strategy-manager': 'ceba81e3-50c8-42e3-ad25-6d53f160303b',
  'auditor':          'ee3a75a5-7b6b-4760-ad40-f17f63edbc03',
}

// Track approval IDs we've already processed so we don't double-reset
const processedApprovals = new Set<string>()

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function apiPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${PAPERCLIP_URL}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(5_000),
  })
  if (!res.ok) return null
  return res.json()
}

async function apiGet(path: string): Promise<unknown> {
  const res = await fetch(`${PAPERCLIP_URL}${path}`, {
    signal: AbortSignal.timeout(5_000),
  })
  if (!res.ok) return null
  return res.json()
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PaperclipApproval {
  id:                 string
  type:               string
  status:             'pending' | 'approved' | 'rejected'
  requestedByAgentId: string
  payload:            Record<string, unknown>
  decidedByUserId:    string | null
  decidedAt:          string | null
  createdAt:          string
}

// ── Core API calls ────────────────────────────────────────────────────────────

/**
 * Log a heartbeat run result to Paperclip's activity feed.
 *
 * Aligns with Paperclip's audit-trail principle: every agent action
 * is recorded so the org dashboard reflects real-time DARWIN activity.
 *
 * status:
 *   'succeeded'        — nominal run, all checks green
 *   'failed'           — error during run
 *   'pending_approval' — circuit breaker fired, waiting for human reset
 */
export async function notifyPaperclip(
  agentSlug: string,
  status:    'succeeded' | 'failed' | 'pending_approval',
  result:    Record<string, unknown>,
): Promise<void> {
  const agentId = AGENT_IDS[agentSlug]
  if (!agentId) return

  const action =
    status === 'succeeded'        ? 'agent.run.completed'        :
    status === 'failed'           ? 'agent.run.failed'           :
                                    'agent.run.pending_approval'

  try {
    await apiPost(`/companies/${COMPANY_ID}/activity`, {
      actorType:  'agent',
      actorId:    agentId,
      action,
      entityType: 'agent',
      entityId:   agentId,
      details:    { status, timestamp: new Date().toISOString(), ...result },
    })
  } catch {
    // Non-fatal: Paperclip offline or unavailable
  }
}

/**
 * Create a Paperclip approval request when a circuit breaker fires.
 *
 * Aligns with Paperclip's human-in-the-loop principle for high-stakes actions:
 * Tier 3 (portfolio-level halt) and Tier 4 (emergency halt) require board sign-off
 * before DARWIN resumes live trading.
 *
 * Returns the approval ID (for tracking), or null if creation failed.
 */
export async function createCircuitBreakerApproval(opts: {
  tier:        3 | 4
  equity:      number
  peakEquity:  number
  drawdownPct: number
}): Promise<string | null> {
  const agentId = AGENT_IDS['risk-agent']
  if (!agentId) return null

  const tierLabel = opts.tier === 4 ? 'EMERGENCY HALT (Tier 4)' : 'Portfolio Drawdown (Tier 3)'
  const title     = `⚠️  DARWIN — ${tierLabel} — Manual Reset Required`
  const desc      = [
    `DARWIN's ${opts.tier === 4 ? 'emergency' : 'portfolio-level'} circuit breaker has fired.`,
    ``,
    `📊  Current equity:  $${opts.equity.toFixed(2)}`,
    `📈  Peak equity:     $${opts.peakEquity.toFixed(2)}`,
    `📉  Drawdown:        ${(opts.drawdownPct * 100).toFixed(2)}%`,
    ``,
    `All live strategy execution has been paused.`,
    `Approve to resume trading. Reject to keep the system halted.`,
  ].join('\n')

  try {
    const res = await apiPost(`/companies/${COMPANY_ID}/approvals`, {
      type:               'approve_ceo_strategy',
      requestedByAgentId: agentId,
      payload: {
        title,
        description:  desc,
        tier:         opts.tier,
        equity:       opts.equity,
        peakEquity:   opts.peakEquity,
        drawdownPct:  opts.drawdownPct,
        callbackUrl:  `http://localhost:3200/approval/tier${opts.tier}-reset`,
        resolvedBy:   null,
      },
    }) as { id?: string } | null

    if (res?.id) {
      console.log(`\n  [Paperclip] 📋 Approval request created: ${res.id}`)
      console.log(`  [Paperclip]    Visit http://127.0.0.1:3100 to review and approve`)
    }
    return res?.id ?? null
  } catch {
    return null
  }
}

/**
 * Poll Paperclip for circuit-breaker approval requests that have been
 * approved by the board. Returns approvals not yet processed by DARWIN.
 *
 * Called every Risk Agent heartbeat (every 5 min) so that once the
 * human approves in the Paperclip UI, trading resumes within 5 minutes.
 */
export async function consumeApprovedCircuitBreakerApprovals(): Promise<
  Array<{ id: string; tier: number; decidedBy: string }>
> {
  try {
    const list = await apiGet(`/companies/${COMPANY_ID}/approvals`) as PaperclipApproval[] | null
    if (!list) return []

    const results: Array<{ id: string; tier: number; decidedBy: string }> = []

    for (const approval of list) {
      if (approval.status !== 'approved') continue
      if (processedApprovals.has(approval.id)) continue
      if (!approval.payload?.tier) continue

      const tier = Number(approval.payload.tier)
      if (tier !== 3 && tier !== 4) continue

      processedApprovals.add(approval.id)
      results.push({
        id:        approval.id,
        tier,
        decidedBy: approval.decidedByUserId ?? 'paperclip_board',
      })

      // Mark approval as processed in activity log
      await apiPost(`/companies/${COMPANY_ID}/activity`, {
        actorType:  'agent',
        actorId:    AGENT_IDS['risk-agent'],
        action:     'agent.approval.consumed',
        entityType: 'agent',
        entityId:   AGENT_IDS['risk-agent'],
        details:    {
          approvalId: approval.id,
          tier,
          decidedBy: approval.decidedByUserId,
          message:   `Tier ${tier} circuit breaker reset approved. Resuming trading.`,
        },
      }).catch(() => {})
    }

    return results
  } catch {
    return []
  }
}

/**
 * List all pending circuit-breaker approvals (for status endpoint).
 */
export async function getPendingApprovals(): Promise<PaperclipApproval[]> {
  try {
    const list = await apiGet(`/companies/${COMPANY_ID}/approvals`) as PaperclipApproval[] | null
    return (list ?? []).filter(a => a.status === 'pending')
  } catch {
    return []
  }
}
