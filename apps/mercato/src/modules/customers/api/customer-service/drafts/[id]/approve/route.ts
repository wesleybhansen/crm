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
import { sendChatReply } from '@/modules/customers/lib/send-chat-reply'
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
    const channel: string = payload.channel === 'sms' ? 'sms' : payload.channel === 'chat' ? 'chat' : 'email'
    const to: string | undefined = payload.to
    const subject: string = payload.subject || 'Re: your message'
    // Allow the UI to send an edited body. Fall back to the stored draft.
    const reqBody = await req.json().catch(() => ({}))
    const editedBody = typeof reqBody?.body === 'string' ? reqBody.body : undefined
    const bodyText: string = (editedBody !== undefined && editedBody.trim().length > 0)
      ? editedBody
      : (payload.body || '')
    const contactId: string | null = payload.contactId || null

    // Chat drafts deliver into the chat conversation (no email/phone recipient),
    // so only require a body + a conversation. Email/SMS still require a recipient.
    if (channel === 'chat') {
      if (!bodyText) {
        return NextResponse.json({ ok: false, error: 'Draft is missing a body' }, { status: 400 })
      }
    } else if (!to || !bodyText) {
      return NextResponse.json({ ok: false, error: 'Draft is missing a recipient or body' }, { status: 400 })
    }

    // Shared send path (also used by the auto/hybrid Customer Service engine).
    //  chat  -> post a business message into the chat conversation (the website
    //           visitor sees it on their next poll) via sendChatReply.
    //  sms   -> the org's BYO Twilio FROM the dedicated CS number.
    //  email -> the email router.
    // All record the outbound message and keep the inbox current.
    let sendResult: { ok: boolean; error?: string; status?: number; sentVia?: string }
    if (channel === 'chat') {
      const conversationId: string | undefined = payload.conversationId
      if (!conversationId) {
        return NextResponse.json({ ok: false, error: 'Draft is missing the chat conversation' }, { status: 400 })
      }
      // Org-scoped: the conversation must belong to the caller's org.
      const conversation = await knex('chat_conversations')
        .where('id', conversationId)
        .where('organization_id', auth.orgId)
        .first()
      if (!conversation) {
        return NextResponse.json({ ok: false, error: 'Chat conversation not found' }, { status: 404 })
      }
      try {
        await sendChatReply(knex, {
          id: conversation.id,
          organization_id: auth.orgId,
          tenant_id: auth.tenantId,
          contact_id: conversation.contact_id || null,
          visitor_name: conversation.visitor_name,
          visitor_email: conversation.visitor_email,
        }, { body: bodyText, isBot: false })
        sendResult = { ok: true, sentVia: 'chat' }
      } catch (chatErr) {
        console.error('[customer-service.approve] chat send failed', chatErr)
        sendResult = { ok: false, error: 'Failed to deliver the chat reply', status: 502 }
      }
    } else if (channel === 'sms') {
      sendResult = await sendSmsReply(knex, auth.orgId, auth.tenantId, {
        to: to!,
        body: bodyText,
        contactId,
      })
    } else {
      sendResult = await sendReply(knex, auth.orgId, auth.tenantId, {
        to: to!,
        subject,
        body: bodyText,
        contactId,
        sentByUserId: auth.sub || null,
      })
    }

    if (!sendResult.ok) {
      const failMsg = channel === 'chat' ? 'Failed to deliver the chat reply' : channel === 'sms' ? 'Failed to send SMS' : 'Failed to send email'
      return NextResponse.json({ ok: false, error: sendResult.error || failMsg }, { status: sendResult.status || 502 })
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

    // Learning loop: a human EDITING a draft before sending is the strongest
    // correction signal we get. Capture the corrected reply as a model answer
    // so the drafter's grounding improves — approved-as-is drafts are skipped
    // (the AI was already right; storing them would only bloat the library).
    // Best-effort: never let this fail the send response.
    try {
      const originalBody = (payload.body || '').toString()
      const changed = editedBody !== undefined
        && editedBody.trim().length > 0
        && originalBody.trim().length > 0
        && editedBody.replace(/\s+/g, ' ').trim() !== originalBody.replace(/\s+/g, ' ').trim()
      if (changed) {
        const title = `Approved reply: ${(subject || 'customer inquiry').replace(/^re:\s*/i, '').slice(0, 120)}`
        const content = bodyText.slice(0, 6000)
        // Match regardless of is_active so a correction that aged out of the
        // cap can be re-captured (reactivated) rather than blocked forever.
        const duplicate = await knex('customer_service_knowledge')
          .where('organization_id', auth.orgId)
          .where('kind', 'model_answer')
          .where('content', content)
          .first()
        if (duplicate && duplicate.is_active === false) {
          await knex('customer_service_knowledge')
            .where('id', duplicate.id)
            .update({ is_active: true, updated_at: now })
        }
        if (!duplicate) {
          await knex('customer_service_knowledge').insert({
            id: require('crypto').randomUUID(),
            tenant_id: auth.tenantId,
            organization_id: auth.orgId,
            kind: 'model_answer',
            title,
            content,
            is_active: true,
            created_at: now,
            updated_at: now,
          })
          // Cap the auto-captured set so corrections can't grow unbounded:
          // keep the newest 50 "Approved reply:" entries, deactivate the rest.
          const excess = await knex('customer_service_knowledge')
            .where('organization_id', auth.orgId)
            .where('kind', 'model_answer')
            .where('title', 'like', 'Approved reply:%')
            .where('is_active', true)
            .orderBy('updated_at', 'desc')
            .offset(50)
            .select('id')
          if (excess.length > 0) {
            await knex('customer_service_knowledge')
              .whereIn('id', excess.map((r: { id: string }) => r.id))
              .update({ is_active: false, updated_at: now })
          }
        }
      }
    } catch (learnErr) {
      console.error('[customer-service.approve] learning capture failed (non-fatal):', learnErr)
    }

    const sentVia = channel === 'sms' ? 'sms' : channel === 'chat' ? 'chat' : (sendResult as { sentVia?: string }).sentVia
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
