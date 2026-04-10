import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

// Lightweight contact search for the inbox compose flow
export async function GET(req: Request) {
  await bootstrap()
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const url = new URL(req.url)
    const q = url.searchParams.get('q') || ''

    if (q.length < 2) return NextResponse.json({ ok: true, data: [] })

    const contacts = await knex('customer_entities')
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .where(function () {
        this.where('display_name', 'ilike', `%${q}%`)
          .orWhere('primary_email', 'ilike', `%${q}%`)
          .orWhere('primary_phone', 'ilike', `%${q}%`)
      })
      .select('id', 'display_name', 'primary_email', 'primary_phone')
      .orderBy('display_name', 'asc')
      .limit(15)

    return NextResponse.json({ ok: true, data: contacts })
  } catch (error) {
    console.error('[inbox.contacts.search]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
