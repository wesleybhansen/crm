export const metadata = { GET: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const contacts = await knex('customer_entities')
      .where('organization_id', auth.orgId).whereNull('deleted_at')
      .orderBy('display_name')

    // Build CSV
    const headers = ['Name', 'Email', 'Phone', 'Type', 'Source', 'Stage', 'Status', 'Created']
    const rows = contacts.map((c: any) => [
      c.display_name || '', c.primary_email || '', c.primary_phone || '',
      c.kind || '', c.source || '', c.lifecycle_stage || '', c.status || '',
      c.created_at ? new Date(c.created_at).toISOString().split('T')[0] : '',
    ])

    const csv = [headers.join(','), ...rows.map((r: string[]) =>
      r.map(v => `"${(v || '').replace(/"/g, '""')}"`).join(',')
    )].join('\n')

    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="contacts-${new Date().toISOString().split('T')[0]}.csv"`,
      },
    })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
