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

    // Check current org first, fall back to all orgs for the user
    let courses = await knex('courses')
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .select('id', 'title as name', 'slug', 'status')
      .orderBy('title')

    if (courses.length === 0) {
      // User may have courses on a different org — show all accessible courses
      courses = await knex('courses')
        .whereNull('deleted_at')
        .select('id', 'title as name', 'slug', 'status')
        .orderBy('title')
    }

    return NextResponse.json({ ok: true, data: courses })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
