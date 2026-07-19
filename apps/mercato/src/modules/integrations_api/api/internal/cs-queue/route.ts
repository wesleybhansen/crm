import crypto from 'crypto'
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { sendReply } from '@/modules/customers/lib/send-reply'
import { sendSmsReply } from '@/modules/customers/lib/send-sms-reply'
import { sendChatReply } from '@/modules/customers/lib/send-chat-reply'

/* Internal service endpoint (shared NOLI_INTERNAL_SERVICE_SECRET) that lets the
 * hub's Unified Inbox drive the customer-service draft queue for a user without
 * a CRM session: list pending drafts, approve/send (with an edited body), and
 * dismiss. It resolves the noli user -> Clerk -> Mercato org/tenant the same
 * way the receptionist endpoint does, then runs the same send + learning-capture
 * path the CRM's own approve route uses. Kept self-contained so it can never
 * regress the working user-facing routes. */

export const metadata = {
  path: '/internal/cs-queue',
  POST: { requireAuth: false },
}

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

function stripHtml(html: string): string {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

type Auth = { userId: string; orgId: string; tenantId: string }

async function resolveAuth(noliUserId: string): Promise<Auth | null> {
  const { findNoliUserById } = await import('@open-mercato/shared/lib/noli/core-client')
  const noliUser = await findNoliUserById(noliUserId)
  if (!noliUser?.clerk_user_id) return null
  const { resolveClerkUserToAuthContext } = await import('@open-mercato/shared/lib/auth/clerk')
  const auth = await resolveClerkUserToAuthContext(noliUser.clerk_user_id)
  if (!auth?.userId || !auth?.orgId || !auth?.tenantId) return null
  return { userId: String(auth.userId), orgId: String(auth.orgId), tenantId: String(auth.tenantId) }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Knex = any

async function listDrafts(knex: Knex, auth: Auth, limit: number, source: string) {
  const actions = await knex('inbox_proposal_actions as a')
    .join('inbox_proposals as p', 'p.id', 'a.proposal_id')
    .where('a.organization_id', auth.orgId)
    .where('a.tenant_id', auth.tenantId)
    .where('a.action_type', 'draft_reply')
    .where('a.status', 'pending')
    .whereRaw(`a.metadata->>'feature_source' = ?`, [source])
    .where('p.status', 'pending')
    .select('a.id as action_id', 'a.proposal_id', 'a.payload', 'a.created_at', 'a.metadata as action_metadata', 'p.summary', 'p.participants')
    .orderBy('a.created_at', 'desc')
    .limit(limit)

  return actions.map((row: Record<string, unknown>) => {
    const payload = safeParse(row.payload)
    const participants = (() => {
      const p = row.participants
      if (Array.isArray(p)) return p
      const parsed = safeParse(p)
      return Array.isArray(parsed) ? parsed : []
    })()
    const meta = safeParse(row.action_metadata)
    const channel = (payload.channel as string) || (meta.channel as string) || 'email'
    const first = (participants[0] as Record<string, unknown>) || null
    const inbound = (payload.lastInboundPreview as string) || (payload.lastInbound as string) || ''
    return {
      id: row.action_id,
      channel,
      createdAt: row.created_at,
      flagged: meta.flagged === true,
      flagReasons: Array.isArray(meta.flagReasons) ? meta.flagReasons : [],
      scheduledSendAt: meta.auto_scheduled === true ? (meta.scheduled_send_at as string) || null : null,
      contactId: (payload.contactId as string) || null,
      contactName: (payload.toName as string) || (first?.name as string) || null,
      contactAddress: (payload.to as string) || (first?.email as string) || null,
      inboundPreview: stripHtml(inbound).slice(0, 400),
      subject: (payload.subject as string) || null,
      draftBody: (payload.body as string) || '',
      summary: (row.summary as string) || null,
    }
  })
}

async function approveDraft(knex: Knex, auth: Auth, actionId: string, editedBody?: string) {
  const action = await knex('inbox_proposal_actions')
    .where('id', actionId)
    .where('organization_id', auth.orgId)
    .where('tenant_id', auth.tenantId)
    .where('action_type', 'draft_reply')
    .whereRaw(`metadata->>'feature_source' in (?, ?)`, ['customer_service', 'inbox'])
    .first()
  if (!action) return { ok: false, error: 'Draft not found', status: 404 }
  if (action.status === 'sent') return { ok: false, error: 'Draft already sent', status: 409 }
  if (action.status === 'dismissed') return { ok: false, error: 'Draft was dismissed', status: 409 }

  const payload = safeParse(action.payload)
  const channel = payload.channel === 'sms' ? 'sms' : payload.channel === 'chat' ? 'chat' : 'email'
  const to = payload.to as string | undefined
  const subject = (payload.subject as string) || 'Re: your message'
  const originalBody = (payload.body as string) || ''
  const bodyText = editedBody !== undefined && editedBody.trim().length > 0 ? editedBody : originalBody
  const contactId = (payload.contactId as string) || null

  if (channel === 'chat') {
    if (!bodyText) return { ok: false, error: 'Draft is missing a body', status: 400 }
  } else if (!to || !bodyText) {
    return { ok: false, error: 'Draft is missing a recipient or body', status: 400 }
  }

  // Atomic claim: flip pending→sending in one guarded update so this manual
  // approve can't race the auto scheduled-send pass (or a concurrent approve)
  // and double-send. Only the winner (rowcount 1) proceeds.
  const claimNow = new Date()
  const claimed = await knex('inbox_proposal_actions').where('id', action.id).where('status', 'pending').update({ status: 'sending', updated_at: claimNow })
  if (!claimed) return { ok: false, error: 'This reply was just handled.', status: 409 }

  let sendResult: { ok: boolean; error?: string; status?: number; sentVia?: string }
  if (channel === 'chat') {
    const conversationId = payload.conversationId as string | undefined
    if (!conversationId) return { ok: false, error: 'Draft is missing the chat conversation', status: 400 }
    const conversation = await knex('chat_conversations').where('id', conversationId).where('organization_id', auth.orgId).first()
    if (!conversation) return { ok: false, error: 'Chat conversation not found', status: 404 }
    try {
      await sendChatReply(
        knex,
        {
          id: conversation.id,
          organization_id: auth.orgId,
          tenant_id: auth.tenantId,
          contact_id: conversation.contact_id || null,
          visitor_name: conversation.visitor_name,
          visitor_email: conversation.visitor_email,
        },
        { body: bodyText, isBot: false },
      )
      sendResult = { ok: true, sentVia: 'chat' }
    } catch (chatErr) {
      console.error('[cs-queue.approve] chat send failed', chatErr)
      sendResult = { ok: false, error: 'Failed to deliver the chat reply', status: 502 }
    }
  } else if (channel === 'sms') {
    sendResult = await sendSmsReply(knex, auth.orgId, auth.tenantId, { to: to!, body: bodyText, contactId })
  } else {
    sendResult = await sendReply(knex, auth.orgId, auth.tenantId, { to: to!, subject, body: bodyText, contactId, sentByUserId: auth.userId })
  }

  if (!sendResult.ok) {
    // Release the claim so the user can retry (or the schedule can re-fire).
    await knex('inbox_proposal_actions').where('id', action.id).where('status', 'sending').update({ status: 'pending', updated_at: new Date() })
    const failMsg = channel === 'chat' ? 'Failed to deliver the chat reply' : channel === 'sms' ? 'Failed to send SMS' : 'Failed to send email'
    return { ok: false, error: sendResult.error || failMsg, status: sendResult.status || 502 }
  }

  const now = new Date()
  await knex('inbox_proposal_actions').where('id', action.id).update({ status: 'sent', executed_at: now, executed_by_user_id: auth.userId, updated_at: now })
  await knex('inbox_proposals').where('id', action.proposal_id).where('organization_id', auth.orgId).update({ status: 'accepted', reviewed_by_user_id: auth.userId, reviewed_at: now, updated_at: now })

  // Learning loop: a human editing a draft before sending is the strongest
  // correction signal — capture the corrected reply as a model answer so the
  // drafter's grounding improves. Best-effort; never fails the send.
  try {
    const changed =
      editedBody !== undefined &&
      editedBody.trim().length > 0 &&
      originalBody.trim().length > 0 &&
      editedBody.replace(/\s+/g, ' ').trim() !== originalBody.replace(/\s+/g, ' ').trim()
    if (changed) {
      const title = `Approved reply: ${(subject || 'customer inquiry').replace(/^re:\s*/i, '').slice(0, 120)}`
      const content = bodyText.slice(0, 6000)
      const duplicate = await knex('customer_service_knowledge').where('organization_id', auth.orgId).where('kind', 'model_answer').where('content', content).first()
      if (duplicate && duplicate.is_active === false) {
        await knex('customer_service_knowledge').where('id', duplicate.id).update({ is_active: true, updated_at: now })
      }
      if (!duplicate) {
        await knex('customer_service_knowledge').insert({
          id: crypto.randomUUID(),
          tenant_id: auth.tenantId,
          organization_id: auth.orgId,
          kind: 'model_answer',
          title,
          content,
          is_active: true,
          created_at: now,
          updated_at: now,
        })
        const excess = await knex('customer_service_knowledge')
          .where('organization_id', auth.orgId)
          .where('kind', 'model_answer')
          .where('title', 'like', 'Approved reply:%')
          .where('is_active', true)
          .orderBy('updated_at', 'desc')
          .offset(50)
          .select('id')
        if (excess.length > 0) {
          await knex('customer_service_knowledge').whereIn('id', excess.map((r: { id: string }) => r.id)).update({ is_active: false, updated_at: now })
        }
      }
    }
  } catch (learnErr) {
    console.error('[cs-queue.approve] learning capture failed (non-fatal):', learnErr)
  }

  return { ok: true, status: 200, channel, sentVia: sendResult.sentVia }
}

async function dismissDraft(knex: Knex, auth: Auth, actionId: string) {
  const action = await knex('inbox_proposal_actions')
    .where('id', actionId)
    .where('organization_id', auth.orgId)
    .where('tenant_id', auth.tenantId)
    .where('action_type', 'draft_reply')
    .whereRaw(`metadata->>'feature_source' in (?, ?)`, ['customer_service', 'inbox'])
    .first()
  if (!action) return { ok: false, error: 'Draft not found', status: 404 }
  if (action.status === 'sent') return { ok: false, error: 'Draft already sent', status: 409 }

  const now = new Date()
  await knex('inbox_proposal_actions').where('id', action.id).update({ status: 'dismissed', updated_at: now })
  await knex('inbox_proposals').where('id', action.proposal_id).where('organization_id', auth.orgId).update({ status: 'rejected', reviewed_by_user_id: auth.userId, reviewed_at: now, updated_at: now })
  return { ok: true, status: 200 }
}

export async function POST(req: Request) {
  const secret = process.env.NOLI_INTERNAL_SERVICE_SECRET
  const authHeader = (req.headers.get('authorization') || '').trim()
  if (!secret || !safeEq(authHeader, `Bearer ${secret}`)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const op = typeof body.op === 'string' ? body.op : ''
  const noliUserId = typeof body.noliUserId === 'string' ? body.noliUserId.trim() : ''
  if (!op || !noliUserId) {
    return NextResponse.json({ ok: false, error: 'op and noliUserId are required' }, { status: 400 })
  }

  try {
    const auth = await resolveAuth(noliUserId)
    if (!auth) return NextResponse.json({ ok: false, error: 'no CRM account for this user' }, { status: 404 })

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    if (op === 'list') {
      const limit = Math.min(100, Math.max(1, Number(body.limit) || 50))
      // source: 'customer_service' (desk drafts, default) or 'inbox' (personal-inbox drafts).
      const source = body.source === 'inbox' ? 'inbox' : 'customer_service'
      const drafts = await listDrafts(knex, auth, limit, source)
      return NextResponse.json({ ok: true, data: drafts })
    }
    if (op === 'approve') {
      const actionId = typeof body.actionId === 'string' ? body.actionId : ''
      if (!actionId) return NextResponse.json({ ok: false, error: 'actionId required' }, { status: 400 })
      const editedBody = typeof body.body === 'string' ? body.body : undefined
      const r = await approveDraft(knex, auth, actionId, editedBody)
      return NextResponse.json({ ok: r.ok, ...(r.ok ? { data: r } : { error: r.error }) }, { status: r.status || (r.ok ? 200 : 500) })
    }
    if (op === 'dismiss') {
      const actionId = typeof body.actionId === 'string' ? body.actionId : ''
      if (!actionId) return NextResponse.json({ ok: false, error: 'actionId required' }, { status: 400 })
      const r = await dismissDraft(knex, auth, actionId)
      return NextResponse.json({ ok: r.ok, ...(r.ok ? {} : { error: r.error }) }, { status: r.status || (r.ok ? 200 : 500) })
    }
    if (op === 'unschedule') {
      // The user started editing a held auto-send — cancel the auto-send so their
      // edit is never overtaken by the original body. Stays a normal pending draft.
      const actionId = typeof body.actionId === 'string' ? body.actionId : ''
      if (!actionId) return NextResponse.json({ ok: false, error: 'actionId required' }, { status: 400 })
      const action = await knex('inbox_proposal_actions')
        .where('id', actionId)
        .where('organization_id', auth.orgId)
        .where('tenant_id', auth.tenantId)
        .where('action_type', 'draft_reply')
        .whereRaw(`metadata->>'feature_source' in (?, ?)`, ['customer_service', 'inbox'])
        .first()
      if (action && action.status === 'pending') {
        const meta = safeParse(action.metadata)
        await knex('inbox_proposal_actions').where('id', action.id).update({ metadata: JSON.stringify({ ...meta, auto_scheduled: false }), updated_at: new Date() })
      }
      return NextResponse.json({ ok: true })
    }
    return NextResponse.json({ ok: false, error: 'unknown op' }, { status: 400 })
  } catch (error) {
    console.error('[internal.cs-queue]', op, error)
    return NextResponse.json({ ok: false, error: 'Server error' }, { status: 500 })
  }
}
