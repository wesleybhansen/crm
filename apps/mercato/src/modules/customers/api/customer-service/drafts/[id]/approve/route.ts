// ORM-SKIP: sends a drafted reply via the email router, then marks the action
export const metadata = {
  path: '/customer-service/drafts/[id]/approve',
  POST: { requireAuth: true, requireFeatures: ['email.send'] },
}

import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { sendEmailForOrg } from '@/modules/email/lib/email-router'
import { EmailSenderService } from '@/modules/email/services/email-sender'
import { upsertInboxConversation } from '@/lib/inbox-conversation'
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

    // Resolve a sending user: the owner of the org's primary/first active email
    // connection. Conversations are not tied to a user, and sendEmailForOrg
    // routes through that user's provider.
    const connection = await knex('email_connections')
      .where('organization_id', auth.orgId)
      .where('is_active', true)
      .orderBy('is_primary', 'desc')
      .first()

    if (!connection) {
      return NextResponse.json({ ok: false, error: 'No email account connected. Connect Gmail, Outlook, or an ESP in Settings.' }, { status: 400 })
    }

    const baseUrl = process.env.APP_URL || 'http://localhost:3000'
    const sender = new EmailSenderService()
    const trackingId = crypto.randomUUID()
    const bodyHtml = bodyText.replace(/\n/g, '<br>')

    let trackedHtml = sender.injectTrackingPixel(bodyHtml, trackingId, baseUrl)
    trackedHtml = sender.wrapLinksForTracking(trackedHtml, trackingId, baseUrl)
    if (contactId) trackedHtml = sender.injectUnsubscribeLink(trackedHtml, contactId, baseUrl)

    const routerResult = await sendEmailForOrg(knex, auth.orgId, auth.tenantId, connection.user_id, {
      to,
      subject,
      htmlBody: trackedHtml,
      textBody: bodyText,
      contactId: contactId || undefined,
    })

    if (!routerResult.ok) {
      return NextResponse.json({ ok: false, error: routerResult.error || 'Failed to send email' }, { status: 502 })
    }

    const now = new Date()
    const messageId = crypto.randomUUID()
    await knex('email_messages').insert({
      id: messageId,
      tenant_id: auth.tenantId,
      organization_id: auth.orgId,
      direction: 'outbound',
      from_address: routerResult.fromAddress || '',
      to_address: to,
      subject,
      body_html: bodyHtml,
      body_text: bodyText,
      contact_id: contactId || null,
      status: 'sent',
      tracking_id: trackingId,
      metadata: JSON.stringify({ providerId: routerResult.messageId, provider: routerResult.sentVia, source: 'customer_service' }),
      created_at: now,
      sent_at: now,
    })

    // Keep the unified inbox current + log to the contact timeline.
    if (contactId) {
      await upsertInboxConversation(knex, auth.orgId, auth.tenantId, {
        contactId,
        channel: 'email',
        preview: bodyText,
        direction: 'outbound',
        avatarEmail: to,
      })
      try {
        const { logTimelineEvent } = await import('@/lib/timeline')
        await logTimelineEvent(knex, {
          tenantId: auth.tenantId,
          organizationId: auth.orgId,
          contactId,
          eventType: 'email_sent',
          title: `Email sent: ${subject}`,
          metadata: { to, sentVia: routerResult.sentVia, source: 'customer_service' },
        })
      } catch {}
    }

    // Mark the action sent + the parent proposal accepted.
    await knex('inbox_proposal_actions')
      .where('id', action.id)
      .update({ status: 'sent', executed_at: now, executed_by_user_id: auth.sub || null, updated_at: now })
    await knex('inbox_proposals')
      .where('id', action.proposal_id)
      .where('organization_id', auth.orgId)
      .update({ status: 'accepted', reviewed_by_user_id: auth.sub || null, reviewed_at: now, updated_at: now })

    return NextResponse.json({ ok: true, data: { id: action.id, status: 'sent', sentVia: routerResult.sentVia } })
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
