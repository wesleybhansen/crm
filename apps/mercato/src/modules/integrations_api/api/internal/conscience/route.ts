import crypto from 'crypto'
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { sendReply } from '@/modules/customers/lib/send-reply'

/* Internal service endpoint (shared NOLI_INTERNAL_SERVICE_SECRET) for the hub's
 * Unified Inbox "Follow-ups" tab — the conscience. It surfaces the relationship-
 * decay proposals ("Re-engage <name> (going cold)") the CRM already generates
 * with a pre-drafted check-in email, so the owner never lets a relationship go
 * cold. list / approve (send the drafted check-in) / dismiss. */

export const metadata = {
  path: '/internal/conscience',
  POST: { requireAuth: false },
}

const DECAY_MARKER = 'Re-engage'

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}
function safeParse(s: unknown): Record<string, unknown> {
  if (s && typeof s === 'object') return s as Record<string, unknown>
  try {
    return JSON.parse(String(s)) as Record<string, unknown>
  } catch {
    return {}
  }
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

    // A pending going-cold nudge: draft_reply action whose parent proposal is a
    // relationship-decay ("Re-engage …") proposal. Org + tenant scoped.
    const baseAction = () =>
      knex('inbox_proposal_actions as a')
        .join('inbox_proposals as p', 'p.id', 'a.proposal_id')
        .where('a.organization_id', auth.orgId)
        .where('a.tenant_id', auth.tenantId)
        .where('a.action_type', 'draft_reply')
        .where('p.status', 'pending')
        .where('p.summary', 'like', `${DECAY_MARKER}%`)

    if (op === 'list') {
      const rows = await baseAction()
        .where('a.status', 'pending')
        .select('a.id as action_id', 'a.payload', 'a.created_at', 'p.summary')
        .orderBy('a.created_at', 'desc')
        .limit(50)
      const data = rows.map((row: Record<string, unknown>) => {
        const payload = safeParse(row.payload)
        return {
          id: row.action_id,
          contactName: (payload.toName as string) || null,
          contactAddress: (payload.to as string) || null,
          subject: (payload.subject as string) || null,
          draftBody: (payload.body as string) || '',
          summary: (row.summary as string) || null,
          createdAt: row.created_at,
        }
      })
      return NextResponse.json({ ok: true, data })
    }

    if (op === 'approve') {
      const actionId = typeof body.actionId === 'string' ? body.actionId : ''
      if (!actionId) return NextResponse.json({ ok: false, error: 'actionId required' }, { status: 400 })
      const action = await baseAction().where('a.id', actionId).select('a.*', 'p.summary as p_summary').first()
      if (!action) return NextResponse.json({ ok: false, error: 'Nudge not found' }, { status: 404 })
      if (action.status === 'sent') return NextResponse.json({ ok: false, error: 'Already sent' }, { status: 409 })
      if (action.status === 'dismissed') return NextResponse.json({ ok: false, error: 'Already dismissed' }, { status: 409 })

      const payload = safeParse(action.payload)
      const to = payload.to as string | undefined
      const subject = (payload.subject as string) || 'Checking in'
      const editedBody = typeof body.body === 'string' ? body.body : undefined
      const bodyText = editedBody !== undefined && editedBody.trim().length > 0 ? editedBody : (payload.body as string) || ''
      const contactId = (payload.contactId as string) || null
      if (!to || !bodyText) return NextResponse.json({ ok: false, error: 'This nudge is missing a recipient or body' }, { status: 400 })

      const sendResult = await sendReply(knex, auth.orgId, auth.tenantId, { to, subject, body: bodyText, contactId, sentByUserId: auth.userId })
      if (!sendResult.ok) return NextResponse.json({ ok: false, error: sendResult.error || 'Failed to send' }, { status: sendResult.status || 502 })

      const now = new Date()
      await knex('inbox_proposal_actions').where('id', action.id).update({ status: 'sent', executed_at: now, executed_by_user_id: auth.userId, updated_at: now })
      await knex('inbox_proposals').where('id', action.proposal_id).where('organization_id', auth.orgId).update({ status: 'accepted', reviewed_by_user_id: auth.userId, reviewed_at: now, updated_at: now })
      return NextResponse.json({ ok: true })
    }

    if (op === 'dismiss') {
      const actionId = typeof body.actionId === 'string' ? body.actionId : ''
      if (!actionId) return NextResponse.json({ ok: false, error: 'actionId required' }, { status: 400 })
      const action = await baseAction().where('a.id', actionId).select('a.id', 'a.proposal_id', 'a.status').first()
      if (!action) return NextResponse.json({ ok: false, error: 'Nudge not found' }, { status: 404 })
      if (action.status === 'sent') return NextResponse.json({ ok: false, error: 'Already sent' }, { status: 409 })
      const now = new Date()
      await knex('inbox_proposal_actions').where('id', action.id).update({ status: 'dismissed', updated_at: now })
      await knex('inbox_proposals').where('id', action.proposal_id).where('organization_id', auth.orgId).update({ status: 'rejected', reviewed_by_user_id: auth.userId, reviewed_at: now, updated_at: now })
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ ok: false, error: 'unknown op' }, { status: 400 })
  } catch (error) {
    console.error('[internal.conscience]', op, error)
    return NextResponse.json({ ok: false, error: 'Server error' }, { status: 500 })
  }
}
