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
const VALID_ACTIONS = new Set(['pause', 'auto_send', 'no_draft'])

// Sensible rules ON by default; the automated/no-reply rule withholds drafting.
const DEFAULT_FLAG_SCENARIOS = [
  { key: 'automated_or_noreply', label: 'Automated / no-reply messages (newsletters, receipts)', enabled: true, action: 'no_draft', instructions: '' },
  { key: 'angry_or_upset', label: 'Upset or angry customer', enabled: true, action: 'pause', instructions: '' },
  { key: 'incoherent', label: 'Incoherent or unclear message', enabled: true, action: 'pause', instructions: '' },
  { key: 'cancel', label: 'Customer wants to cancel', enabled: true, action: 'pause', instructions: '' },
  { key: 'refund', label: 'Customer wants a refund', enabled: true, action: 'pause', instructions: '' },
  { key: 'complaint', label: 'Complaint about product or service', enabled: true, action: 'pause', instructions: '' },
  { key: 'legal', label: 'Legal or compliance matter', enabled: true, action: 'pause', instructions: '' },
]

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeScenarios(raw: any): { key: string; label: string; enabled: boolean; action: string; instructions: string; audience?: 'anyone' | 'new' | 'existing' }[] {
  if (!Array.isArray(raw)) return DEFAULT_FLAG_SCENARIOS.map((s) => ({ ...s }))
  const out: { key: string; label: string; enabled: boolean; action: string; instructions: string; audience?: 'anyone' | 'new' | 'existing' }[] = []
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
      audience: s.audience === 'new' || s.audience === 'existing' ? s.audience : 'anyone',
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

    if (op === 'stats') {
      // The "inbox getting lighter" signal: over the last 8 weeks, how many
      // customer-service replies the CoS sent on its own (metadata.auto_sent)
      // vs. ones the user had to approve. Both are audit rows in
      // inbox_proposal_actions with status 'sent'.
      const rows = await knex('inbox_proposal_actions')
        .where('organization_id', auth.orgId)
        .where('tenant_id', auth.tenantId)
        .whereRaw("metadata->>'feature_source' = 'customer_service'")
        .where('status', 'sent')
        .whereRaw("created_at >= now() - interval '56 days'")
        .select(knex.raw("to_char(date_trunc('week', created_at), 'YYYY-MM-DD') as wk"))
        .select(knex.raw("count(*) filter (where metadata->>'auto_sent' = 'true') as auto_count"))
        .select(knex.raw("count(*) filter (where metadata->>'auto_sent' is distinct from 'true') as manual_count"))
        .groupByRaw("date_trunc('week', created_at)")
        .orderByRaw("date_trunc('week', created_at) asc")

      const weeks = (rows as Array<Record<string, unknown>>).map((r) => ({
        week: String(r.wk),
        auto: Number(r.auto_count || 0),
        manual: Number(r.manual_count || 0),
      }))
      const totalAuto = weeks.reduce((s, w) => s + w.auto, 0)
      const totalHandled = weeks.reduce((s, w) => s + w.auto + w.manual, 0)
      return NextResponse.json({ ok: true, data: { weeks, totalAuto, totalHandled } })
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
