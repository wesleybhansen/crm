// ORM-SKIP: sends a drafted reply via the email router, then marks the action
export const metadata = {
  path: '/customer-service/drafts/[id]/approve',
  POST: { requireAuth: true, requireFeatures: ['email.send'] },
}

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { sendReply } from '@/modules/customers/lib/send-reply'
import { sendSmsReply } from '@/modules/customers/lib/send-sms-reply'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

function safeParse(s: any) {
  if (s && typeof s === 'object') return s
  try { return JSON.parse(s) } catch { return null }
}

// POST: approve a customer-service draft. Sends the email via the org's
// connected provider, records the outbound message, then marks the proposal
// action as sent. Org-scoped; the draft must belong to the caller's org.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const { id } = await params
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // Self-scoped lookup: action must be a pending customer_service draft for this org.
    const action = await knex('inbox_proposal_actions')
      .where('id', id)
      .where('organization_id', auth.orgId)
      .where('tenant_id', auth.tenantId)
      .where('action_type', 'draft_reply')
      .whereRaw(`metadata->>'feature_source' = ?`, ['customer_service'])
      .first()

    if (!action) return NextResponse.json({ ok: false, error: 'Draft not found' }, { status: 404 })
    if (action.status === 'sent') return NextResponse.json({ ok: false, error: 'Draft already sent' }, { status: 409 })
    if (action.status === 'dismissed') return NextResponse.json({ ok: false, error: 'Draft was dismissed' }, { status: 409 })

    const payload = safeParse(action.payload) || {}
    const channel: string = payload.channel === 'sms' ? 'sms' : 'email'
    const to: string | undefined = payload.to
    const subject: string = payload.subject || 'Re: your message'
    // Allow the UI to send an edited body. Fall back to the stored draft.
    const reqBody = await req.json().catch(() => ({}))
    const editedBody = typeof reqBody?.body === 'string' ? reqBody.body : undefined
    const bodyText: string = (editedBody !== undefined && editedBody.trim().length > 0)
      ? editedBody
      : (payload.body || '')
    const contactId: string | null = payload.contactId || null

    if (!to || !bodyText) {
      return NextResponse.json({ ok: false, error: 'Draft is missing a recipient or body' }, { status: 400 })
    }

    // Shared send path (also used by the auto/hybrid Customer Service engine).
    // SMS drafts go out over the org's BYO Twilio FROM the dedicated CS number;
    // email drafts go via the email router. Both record the outbound message and
    // keep the inbox + timeline current.
    const sendResult = channel === 'sms'
      ? await sendSmsReply(knex, auth.orgId, auth.tenantId, {
          to,
          body: bodyText,
          contactId,
        })
      : await sendReply(knex, auth.orgId, auth.tenantId, {
          to,
          subject,
          body: bodyText,
          contactId,
          sentByUserId: auth.sub || null,
        })

    if (!sendResult.ok) {
      return NextResponse.json({ ok: false, error: sendResult.error || (channel === 'sms' ? 'Failed to send SMS' : 'Failed to send email') }, { status: sendResult.status || 502 })
    }

    const now = new Date()

    // Mark the action sent + the parent proposal accepted.
    await knex('inbox_proposal_actions')
      .where('id', action.id)
      .update({ status: 'sent', executed_at: now, executed_by_user_id: auth.sub || null, updated_at: now })
    await knex('inbox_proposals')
      .where('id', action.proposal_id)
      .where('organization_id', auth.orgId)
      .update({ status: 'accepted', reviewed_by_user_id: auth.sub || null, reviewed_at: now, updated_at: now })

    const sentVia = channel === 'sms' ? 'sms' : (sendResult as { sentVia?: string }).sentVia
    return NextResponse.json({ ok: true, data: { id: action.id, status: 'sent', channel, sentVia } })
  } catch (error) {
    console.error('[customer-service.approve]', error)
    return NextResponse.json({ ok: false, error: 'Failed to approve draft' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Customer Service',
  summary: 'Approve a customer-service draft',
  methods: {
    POST: { summary: 'Send a queued customer-service draft reply', tags: ['Customer Service'] },
  },
}
