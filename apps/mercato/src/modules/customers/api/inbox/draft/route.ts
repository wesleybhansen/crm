// ORM-SKIP: cross-table read + send over inbox AI draft proposals
export const metadata = {
  path: '/inbox/draft',
  GET: { requireAuth: true },
  POST: { requireAuth: true, requireFeatures: ['email.send'] },
}

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { sendReply } from '@/modules/customers/lib/send-reply'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

function safeParse(s: any) {
  if (s && typeof s === 'object') return s
  try { return JSON.parse(s) } catch { return null }
}

// GET ?conversationId= : return the latest PENDING inbox AI draft
// (feature_source='inbox') for that conversation, for the thread composer to
// surface. Org-scoped from auth. Returns { data: null } when there is no
// pending draft for the conversation.
export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const conversationId = new URL(req.url).searchParams.get('conversationId')
    if (!conversationId) return NextResponse.json({ ok: false, error: 'conversationId required' }, { status: 400 })

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // Pending inbox draft_reply actions for this org, newest first. The
    // conversation id lives inside the JSON payload, so match it there. Limit the
    // scan to recent inbox drafts before filtering by conversation in-memory.
    const actions = await knex('inbox_proposal_actions')
      .where('organization_id', auth.orgId)
      .where('tenant_id', auth.tenantId)
      .where('action_type', 'draft_reply')
      .where('status', 'pending')
      .whereRaw(`metadata->>'feature_source' = ?`, ['inbox'])
      .whereRaw(`payload->>'conversationId' = ?`, [conversationId])
      .orderBy('created_at', 'desc')
      .limit(1)

    const row = actions[0]
    if (!row) return NextResponse.json({ ok: true, data: null })

    const payload = safeParse(row.payload) || {}
    const meta = safeParse(row.metadata) || {}
    return NextResponse.json({
      ok: true,
      data: {
        id: row.id,
        proposalId: row.proposal_id,
        conversationId: payload.conversationId || conversationId,
        to: payload.to || null,
        toName: payload.toName || null,
        subject: payload.subject || null,
        body: payload.body || null,
        confidence: typeof row.confidence === 'number' ? row.confidence : Number(row.confidence) || null,
        flagged: meta.flagged === true,
        flagReasons: Array.isArray(meta.flagReasons) ? meta.flagReasons : [],
        createdAt: row.created_at,
      },
    })
  } catch (error) {
    console.error('[inbox.draft.get]', error)
    return NextResponse.json({ ok: false, error: 'Failed to load draft' }, { status: 500 })
  }
}

// POST { id, action: 'approve' | 'dismiss', body? } : act on a pending inbox AI
// draft. approve = send via the shared sendReply path + mark sent; dismiss =
// mark dismissed. Org-scoped: the action must be a pending inbox draft for the
// caller's org. Mirrors the Customer Service approve/dismiss routes.
export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const reqBody = await req.json().catch(() => ({}))
    const id: string | undefined = typeof reqBody?.id === 'string' ? reqBody.id : undefined
    const action: string = reqBody?.action === 'dismiss' ? 'dismiss' : 'approve'
    if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // Self-scoped lookup: action must be a pending inbox draft for this org.
    const dbAction = await knex('inbox_proposal_actions')
      .where('id', id)
      .where('organization_id', auth.orgId)
      .where('tenant_id', auth.tenantId)
      .where('action_type', 'draft_reply')
      .whereRaw(`metadata->>'feature_source' = ?`, ['inbox'])
      .first()

    if (!dbAction) return NextResponse.json({ ok: false, error: 'Draft not found' }, { status: 404 })
    if (dbAction.status === 'sent') return NextResponse.json({ ok: false, error: 'Draft already sent' }, { status: 409 })
    if (dbAction.status === 'dismissed') return NextResponse.json({ ok: false, error: 'Draft was dismissed' }, { status: 409 })

    const now = new Date()

    if (action === 'dismiss') {
      await knex('inbox_proposal_actions')
        .where('id', dbAction.id)
        .update({ status: 'dismissed', updated_at: now })
      await knex('inbox_proposals')
        .where('id', dbAction.proposal_id)
        .where('organization_id', auth.orgId)
        .update({ status: 'rejected', reviewed_by_user_id: auth.sub || null, reviewed_at: now, updated_at: now })
      return NextResponse.json({ ok: true, data: { id: dbAction.id, status: 'dismissed' } })
    }

    // approve: send the email via the shared send path, then mark sent.
    const payload = safeParse(dbAction.payload) || {}
    const to: string | undefined = payload.to
    const subject: string = payload.subject || 'Re: your message'
    // Allow the UI to send an edited body; fall back to the stored draft.
    const editedBody = typeof reqBody?.body === 'string' ? reqBody.body : undefined
    const bodyText: string = (editedBody !== undefined && editedBody.trim().length > 0)
      ? editedBody
      : (payload.body || '')
    const contactId: string | null = payload.contactId || null

    if (!to || !bodyText) {
      return NextResponse.json({ ok: false, error: 'Draft is missing a recipient or body' }, { status: 400 })
    }

    const sendResult = await sendReply(knex, auth.orgId, auth.tenantId, {
      to,
      subject,
      body: bodyText,
      contactId,
      sentByUserId: auth.sub || null,
    })

    if (!sendResult.ok) {
      return NextResponse.json({ ok: false, error: sendResult.error || 'Failed to send email' }, { status: sendResult.status || 502 })
    }

    await knex('inbox_proposal_actions')
      .where('id', dbAction.id)
      .update({ status: 'sent', executed_at: now, executed_by_user_id: auth.sub || null, updated_at: now })
    await knex('inbox_proposals')
      .where('id', dbAction.proposal_id)
      .where('organization_id', auth.orgId)
      .update({ status: 'accepted', reviewed_by_user_id: auth.sub || null, reviewed_at: now, updated_at: now })

    return NextResponse.json({ ok: true, data: { id: dbAction.id, status: 'sent', sentVia: sendResult.sentVia } })
  } catch (error) {
    console.error('[inbox.draft.post]', error)
    return NextResponse.json({ ok: false, error: 'Failed to act on draft' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Inbox',
  summary: 'Inbox AI draft read + approve/dismiss',
  methods: {
    GET: { summary: 'Get the latest pending inbox AI draft for a conversation', tags: ['Inbox'] },
    POST: { summary: 'Approve (send) or dismiss a pending inbox AI draft', tags: ['Inbox'] },
  },
}
