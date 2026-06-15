// ORM-SKIP: cross-table read of customer-service draft proposals
export const metadata = {
  path: '/customer-service/queue',
  GET: { requireAuth: true, requireFeatures: ['email.view'] },
}

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

// GET: list pending customer-service draft proposals for the org.
// Each item carries the linked contact summary + the drafted reply body so the
// CRM UI and the COS (via MCP) can render an approval queue without extra calls.
export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const url = new URL(req.url)
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '50')))

    // Pending draft_reply actions marked as customer_service, org-scoped.
    const actions = await knex('inbox_proposal_actions as a')
      .join('inbox_proposals as p', 'p.id', 'a.proposal_id')
      .where('a.organization_id', auth.orgId)
      .where('a.tenant_id', auth.tenantId)
      .where('a.action_type', 'draft_reply')
      .where('a.status', 'pending')
      .whereRaw(`a.metadata->>'feature_source' = ?`, ['customer_service'])
      .where('p.status', 'pending')
      .select(
        'a.id as action_id',
        'a.proposal_id',
        'a.payload',
        'a.created_at',
        'a.metadata as action_metadata',
        'p.summary',
        'p.participants',
      )
      .orderBy('a.created_at', 'desc')
      .limit(limit)

    // Pre-parse payloads so we can collect the contact ids the queue references,
    // then fetch the FULL latest inbound email body for each in a single pass.
    // The stored lastInboundPreview is only the first ~200 chars; this lets the
    // UI offer a "show full email" expansion without an extra round-trip.
    const parsed = actions.map((row: any) => {
      const payload = typeof row.payload === 'string' ? safeParse(row.payload) : (row.payload || {})
      const participants = typeof row.participants === 'string' ? safeParse(row.participants) : (row.participants || [])
      const meta = typeof row.action_metadata === 'string' ? safeParse(row.action_metadata) : (row.action_metadata || {})
      // Channel comes from the payload (set by the SMS proposal creator) and
      // falls back to the action metadata; defaults to email for legacy rows.
      const channel = payload?.channel || meta?.channel || 'email'
      // Flag info lives in the action metadata (set by the processor).
      const flagged = meta?.flagged === true
      const flagReasons = Array.isArray(meta?.flagReasons) ? meta.flagReasons : []
      return { row, payload, participants, channel, flagged, flagReasons }
    })

    // Contacts referenced by EMAIL drafts (for full-email expansion).
    const emailContactIds = Array.from(
      new Set(parsed.filter((p) => p.channel !== 'sms').map((p) => p.payload?.contactId).filter((id: any): id is string => !!id)),
    )
    // Contacts referenced by SMS drafts (for full-text expansion).
    const smsContactIds = Array.from(
      new Set(parsed.filter((p) => p.channel === 'sms').map((p) => p.payload?.contactId).filter((id: any): id is string => !!id)),
    )

    // Map of contactId -> full body text of that contact's latest inbound email.
    const fullBodyByContact: Record<string, string> = {}
    if (emailContactIds.length > 0) {
      const inbound = await knex('email_messages')
        .where('organization_id', auth.orgId)
        .where('direction', 'inbound')
        .whereIn('contact_id', emailContactIds)
        .orderBy('created_at', 'desc')
        .select('contact_id', 'body_text', 'body_html')
      for (const m of inbound) {
        const cid = m.contact_id
        if (!cid || fullBodyByContact[cid]) continue // first seen = latest (desc order)
        const text = (m.body_text && String(m.body_text).trim())
          ? String(m.body_text)
          : stripHtml(m.body_html || '')
        fullBodyByContact[cid] = text
      }
    }

    // Map of contactId -> full text of that contact's latest inbound SMS.
    const fullSmsByContact: Record<string, string> = {}
    if (smsContactIds.length > 0) {
      const inbound = await knex('sms_messages')
        .where('organization_id', auth.orgId)
        .where('direction', 'inbound')
        .whereIn('contact_id', smsContactIds)
        .orderBy('created_at', 'desc')
        .select('contact_id', 'body')
      for (const m of inbound) {
        const cid = m.contact_id
        if (!cid || fullSmsByContact[cid]) continue
        fullSmsByContact[cid] = String(m.body || '')
      }
    }

    const data = parsed.map(({ row, payload, participants, channel, flagged, flagReasons }) => {
      const first = Array.isArray(participants) ? participants[0] : null
      const contactId = payload?.contactId || null
      const isSms = channel === 'sms'
      return {
        id: row.action_id,
        proposalId: row.proposal_id,
        createdAt: row.created_at,
        channel,
        flagged,
        // [{ key, label }] of the scenarios this message matched. Empty unless flagged.
        flagReasons,
        summary: row.summary,
        contact: {
          id: contactId,
          name: payload?.toName || first?.name || null,
          // For SMS the "to" is a phone number; expose it as both email (legacy
          // field the UI already reads) and phone for clarity.
          email: isSms ? null : (payload?.to || first?.email || null),
          phone: isSms ? (payload?.to || first?.phone || null) : null,
        },
        conversationId: payload?.conversationId || null,
        lastInboundPreview: payload?.lastInboundPreview || null,
        lastInboundBody: contactId
          ? (isSms ? (fullSmsByContact[contactId] || null) : (fullBodyByContact[contactId] || null))
          : null,
        subject: isSms ? null : (payload?.subject || null),
        body: payload?.body || null,
      }
    })

    // Flagged items surface first; within each group keep the newest first
    // (the DB query already returned rows in created_at desc order).
    data.sort((a, b) => (a.flagged === b.flagged ? 0 : a.flagged ? -1 : 1))

    return NextResponse.json({ ok: true, data })
  } catch (error) {
    console.error('[customer-service.queue]', error)
    return NextResponse.json({ ok: false, error: 'Failed to load queue' }, { status: 500 })
  }
}

function safeParse(s: string) {
  try { return JSON.parse(s) } catch { return null }
}

// Best-effort plain-text fallback when an inbound email has no body_text: strip
// tags + collapse common block elements to line breaks. The value is rendered
// as plain text in the UI (never via dangerouslySetInnerHTML).
function stripHtml(html: string): string {
  if (!html) return ''
  return String(html)
    .replace(/<\s*(br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Customer Service',
  summary: 'Customer Service draft queue',
  methods: {
    GET: { summary: 'List pending customer-service draft replies awaiting approval', tags: ['Customer Service'] },
  },
}
