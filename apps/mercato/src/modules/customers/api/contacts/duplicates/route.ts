// ORM-SKIP: analytics/aggregation — complex GROUP BY/JSONB/multi-table joins better served by raw SQL
export const metadata = { path: '/contacts/duplicates', GET: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // Find emails that appear on more than one non-deleted contact
    const duplicateEmails = await knex('customer_entities')
      .select(knex.raw('LOWER(primary_email) as email'))
      .count('* as count')
      .where('organization_id', auth.orgId)
      .whereNotNull('primary_email')
      .whereRaw("primary_email != ''")
      .whereNull('deleted_at')
      .groupByRaw('LOWER(primary_email)')
      .havingRaw('COUNT(*) > 1')
      .orderByRaw('COUNT(*) DESC')
      .limit(100)

    if (duplicateEmails.length === 0) {
      return NextResponse.json({ ok: true, data: [] })
    }

    const emails = duplicateEmails.map((row: any) => row.email)

    // Fetch all contacts for those emails
    const contacts = await knex('customer_entities')
      .whereRaw('LOWER(primary_email) IN (?)', [emails])
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .select('id', 'display_name', 'primary_email', 'created_at', 'source', 'lifecycle_stage')
      .orderBy('created_at', 'asc')

    // Group by lowercase email
    const groups: Record<string, { email: string; contacts: any[] }> = {}
    for (const contact of contacts) {
      const lowerEmail = (contact.primary_email || '').toLowerCase()
      if (!groups[lowerEmail]) {
        groups[lowerEmail] = { email: lowerEmail, contacts: [] }
      }
      groups[lowerEmail].contacts.push({
        id: contact.id,
        displayName: contact.display_name,
        createdAt: contact.created_at,
        source: contact.source,
        lifecycleStage: contact.lifecycle_stage,
      })
    }

    const data = Object.values(groups)
    return NextResponse.json({ ok: true, data })
  } catch (error) {
    console.error('[contacts.duplicates]', error)
    return NextResponse.json({ ok: false, error: 'Failed to scan for duplicates' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Contacts',
  summary: 'Duplicate contact detection',
  methods: {
    GET: {
      summary: 'Find potential duplicate contacts grouped by email',
      tags: ['Contacts'],
    },
  },
}
