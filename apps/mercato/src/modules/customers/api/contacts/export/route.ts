export const metadata = { path: '/contacts/export', GET: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CustomerEntity } from '@open-mercato/core/modules/customers/data/entities'

export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()

    const contacts = await findWithDecryption(
      em, CustomerEntity,
      { organizationId: auth.orgId, tenantId: auth.tenantId, deletedAt: null },
      { orderBy: { displayName: 'asc' } },
      { tenantId: auth.tenantId, organizationId: auth.orgId },
    )

    // Build CSV
    const headers = ['Name', 'Email', 'Phone', 'Type', 'Source', 'Stage', 'Status', 'Created']
    const rows = contacts.map((c) => [
      c.displayName || '', c.primaryEmail || '', c.primaryPhone || '',
      c.kind || '', c.source || '', c.lifecycleStage || '', c.status || '',
      c.createdAt ? new Date(c.createdAt).toISOString().split('T')[0] : '',
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
