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
      return { row, payload, participants }
    })

    const contactIds = Array.from(
      new Set(parsed.map((p) => p.payload?.contactId).filter((id: any): id is string => !!id)),
    )

    // Map of contactId -> full body text of that contact's latest inbound email.
    const fullBodyByContact: Record<string, string> = {}
    if (contactIds.length > 0) {
      const inbound = await knex('email_messages')
        .where('organization_id', auth.orgId)
        .where('direction', 'inbound')
        .whereIn('contact_id', contactIds)
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

    const data = parsed.map(({ row, payload, participants }) => {
      const first = Array.isArray(participants) ? participants[0] : null
      const contactId = payload?.contactId || null
      return {
        id: row.action_id,
        proposalId: row.proposal_id,
        createdAt: row.created_at,
        summary: row.summary,
        contact: {
          id: contactId,
          name: payload?.toName || first?.name || null,
          email: payload?.to || first?.email || null,
        },
        conversationId: payload?.conversationId || null,
        lastInboundPreview: payload?.lastInboundPreview || null,
        lastInboundBody: (contactId && fullBodyByContact[contactId]) || null,
        subject: payload?.subject || null,
        body: payload?.body || null,
      }
    })

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
