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

    const data = actions.map((row: any) => {
      const payload = typeof row.payload === 'string' ? safeParse(row.payload) : (row.payload || {})
      const participants = typeof row.participants === 'string' ? safeParse(row.participants) : (row.participants || [])
      const first = Array.isArray(participants) ? participants[0] : null
      return {
        id: row.action_id,
        proposalId: row.proposal_id,
        createdAt: row.created_at,
        summary: row.summary,
        contact: {
          id: payload?.contactId || null,
          name: payload?.toName || first?.name || null,
          email: payload?.to || first?.email || null,
        },
        conversationId: payload?.conversationId || null,
        lastInboundPreview: payload?.lastInboundPreview || null,
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

export const openApi: OpenApiRouteDoc = {
  tag: 'Customer Service',
  summary: 'Customer Service draft queue',
  methods: {
    GET: { summary: 'List pending customer-service draft replies awaiting approval', tags: ['Customer Service'] },
  },
}
