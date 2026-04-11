export const metadata = { path: '/inbox/contacts', GET: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CustomerEntity } from '@open-mercato/core/modules/customers/data/entities'

export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
    const url = new URL(req.url)
    const q = url.searchParams.get('q') || ''

    if (q.length < 2) return NextResponse.json({ ok: true, data: [] })

    const contacts = await findWithDecryption(
      em, CustomerEntity,
      {
        organizationId: auth.orgId, tenantId: auth.tenantId, deletedAt: null,
        $or: [
          { displayName: { $like: `%${q}%` } },
          { primaryEmail: { $like: `%${q}%` } },
          { primaryPhone: { $like: `%${q}%` } },
        ],
      },
      { fields: ['id', 'displayName', 'primaryEmail', 'primaryPhone'], orderBy: { displayName: 'asc' }, limit: 15 },
      { tenantId: auth.tenantId, organizationId: auth.orgId },
    )

    return NextResponse.json({ ok: true, data: contacts.map(c => ({
      id: c.id, display_name: c.displayName, primary_email: c.primaryEmail, primary_phone: c.primaryPhone,
    })) })
  } catch (error) {
    console.error('[inbox.contacts.search]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
