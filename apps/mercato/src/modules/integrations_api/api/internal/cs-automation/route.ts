import crypto from 'crypto'
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'

/* Internal service endpoint (shared NOLI_INTERNAL_SERVICE_SECRET) that exposes
 * the customer-service automation config to the hub inbox: the reply mode
 * (draft | hybrid | auto — the autonomy level) and the user's sorting rules
 * (flag scenarios: which situations to always hold for review vs. auto-send).
 * Reads/writes the same customer_service_settings the CRM's own engine uses, so
 * the hub controls drive the existing autopilot rather than a parallel system. */

export const metadata = {
  path: '/internal/cs-automation',
  POST: { requireAuth: false },
}

const VALID_MODES = new Set(['draft', 'hybrid', 'auto'])
const VALID_ACTIONS = new Set(['pause', 'auto_send'])

const DEFAULT_FLAG_SCENARIOS = [
  { key: 'angry_or_upset', label: 'Upset or angry customer', enabled: false, action: 'pause', instructions: '' },
  { key: 'incoherent', label: 'Incoherent or unclear message', enabled: false, action: 'pause', instructions: '' },
  { key: 'cancel', label: 'Customer wants to cancel', enabled: false, action: 'pause', instructions: '' },
  { key: 'refund', label: 'Customer wants a refund', enabled: false, action: 'pause', instructions: '' },
  { key: 'complaint', label: 'Complaint about product or service', enabled: false, action: 'pause', instructions: '' },
  { key: 'legal', label: 'Legal or compliance matter', enabled: false, action: 'pause', instructions: '' },
]

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeScenarios(raw: any): { key: string; label: string; enabled: boolean; action: string; instructions: string }[] {
  if (!Array.isArray(raw)) return DEFAULT_FLAG_SCENARIOS.map((s) => ({ ...s }))
  const out: { key: string; label: string; enabled: boolean; action: string; instructions: string }[] = []
  const seen = new Set<string>()
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue
    const key = typeof s.key === 'string' && s.key.trim() ? s.key.trim().slice(0, 80) : ''
    const label = typeof s.label === 'string' ? s.label.trim().slice(0, 200) : ''
    if (!key || !label || seen.has(key)) continue
    seen.add(key)
    out.push({
      key,
      label,
      enabled: s.enabled === true,
      action: VALID_ACTIONS.has(s.action) ? s.action : 'pause',
      instructions: typeof s.instructions === 'string' ? s.instructions.slice(0, 4000) : '',
    })
  }
  return out.length ? out : DEFAULT_FLAG_SCENARIOS.map((sc) => ({ ...sc }))
}

type Auth = { userId: string; orgId: string; tenantId: string }
async function resolveAuth(noliUserId: string): Promise<Auth | null> {
  const { findNoliUserById } = await import('@open-mercato/shared/lib/noli/core-client')
  const noliUser = await findNoliUserById(noliUserId)
  if (!noliUser?.clerk_user_id) return null
  const { resolveClerkUserToAuthContext } = await import('@open-mercato/shared/lib/auth/clerk')
  const a = await resolveClerkUserToAuthContext(noliUser.clerk_user_id)
  if (!a?.userId || !a?.orgId || !a?.tenantId) return null
  return { userId: String(a.userId), orgId: String(a.orgId), tenantId: String(a.tenantId) }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Knex = any

export async function POST(req: Request) {
  const secret = process.env.NOLI_INTERNAL_SERVICE_SECRET
  const authHeader = (req.headers.get('authorization') || '').trim()
  if (!secret || !safeEq(authHeader, `Bearer ${secret}`)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const op = typeof body.op === 'string' ? body.op : ''
  const noliUserId = typeof body.noliUserId === 'string' ? body.noliUserId.trim() : ''
  if (!op || !noliUserId) return NextResponse.json({ ok: false, error: 'op and noliUserId are required' }, { status: 400 })

  try {
    const auth = await resolveAuth(noliUserId)
    if (!auth) return NextResponse.json({ ok: false, error: 'no CRM account for this user' }, { status: 404 })
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex() as Knex

    if (op === 'get') {
      const row = await knex('customer_service_settings').where('organization_id', auth.orgId).first()
      const scenarios = (() => {
        const raw = row?.flag_scenarios
        const parsed = typeof raw === 'string' ? JSON.parse(raw || 'null') : raw
        return normalizeScenarios(parsed)
      })()
      return NextResponse.json({
        ok: true,
        data: {
          replyMode: row?.reply_mode && VALID_MODES.has(row.reply_mode) ? row.reply_mode : 'draft',
          hybridConfidenceThreshold: row?.hybrid_confidence_threshold != null ? Number(row.hybrid_confidence_threshold) : 0.8,
          flagScenarios: scenarios,
          autoSendPaused: row?.auto_send_paused === true,
          holdMinutes: row?.auto_send_hold_minutes != null ? Number(row.auto_send_hold_minutes) : 10,
          hourlyCap: row?.auto_send_hourly_cap != null ? Number(row.auto_send_hourly_cap) : 20,
        },
      })
    }

    if (op === 'set') {
      const replyMode = VALID_MODES.has(String(body.replyMode)) ? String(body.replyMode) : undefined
      const threshold =
        body.hybridConfidenceThreshold != null ? Math.min(1, Math.max(0, Number(body.hybridConfidenceThreshold))) : undefined
      const scenarios = body.flagScenarios !== undefined ? normalizeScenarios(body.flagScenarios) : undefined

      const existing = await knex('customer_service_settings').where('organization_id', auth.orgId).first()
      const now = new Date()
      const patch: Record<string, unknown> = { updated_at: now }
      if (replyMode !== undefined) patch.reply_mode = replyMode
      if (threshold !== undefined) patch.hybrid_confidence_threshold = threshold
      if (scenarios !== undefined) patch.flag_scenarios = JSON.stringify(scenarios)
      if (typeof body.autoSendPaused === 'boolean') {
        patch.auto_send_paused = body.autoSendPaused
        // Resuming clears the circuit-breaker window so old cancellations don't re-trip it.
        if (body.autoSendPaused === false) patch.auto_send_resumed_at = now
      }
      if (body.holdMinutes != null && Number.isFinite(Number(body.holdMinutes))) patch.auto_send_hold_minutes = Math.max(0, Math.min(120, Math.round(Number(body.holdMinutes))))
      if (body.hourlyCap != null && Number.isFinite(Number(body.hourlyCap))) patch.auto_send_hourly_cap = Math.max(1, Math.min(500, Math.round(Number(body.hourlyCap))))

      if (existing) {
        await knex('customer_service_settings').where('id', existing.id).update(patch)
      } else {
        await knex('customer_service_settings').insert({
          id: crypto.randomUUID(),
          tenant_id: auth.tenantId,
          organization_id: auth.orgId,
          reply_mode: replyMode ?? 'draft',
          hybrid_confidence_threshold: threshold ?? 0.8,
          flag_scenarios: JSON.stringify(scenarios ?? DEFAULT_FLAG_SCENARIOS),
          created_at: now,
          updated_at: now,
        })
      }
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ ok: false, error: 'unknown op' }, { status: 400 })
  } catch (error) {
    console.error('[internal.cs-automation]', op, error)
    return NextResponse.json({ ok: false, error: 'Server error' }, { status: 500 })
  }
}
