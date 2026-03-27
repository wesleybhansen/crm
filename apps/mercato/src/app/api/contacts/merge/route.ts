import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { mergeContacts } from '../dedup'

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { primaryId, secondaryId } = body

    if (!primaryId || !secondaryId) {
      return NextResponse.json({ ok: false, error: 'primaryId and secondaryId are required' }, { status: 400 })
    }

    if (primaryId === secondaryId) {
      return NextResponse.json({ ok: false, error: 'primaryId and secondaryId must be different' }, { status: 400 })
    }

    // Validate both contacts exist and belong to the org
    const primary = await knex('customer_entities')
      .where('id', primaryId)
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .first()

    if (!primary) {
      return NextResponse.json({ ok: false, error: 'Primary contact not found' }, { status: 404 })
    }

    const secondary = await knex('customer_entities')
      .where('id', secondaryId)
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .first()

    if (!secondary) {
      return NextResponse.json({ ok: false, error: 'Secondary contact not found' }, { status: 404 })
    }

    const result = await mergeContacts(knex, auth.orgId, primaryId, secondaryId)

    return NextResponse.json({ ok: true, data: result })
  } catch (error) {
    console.error('[contacts.merge]', error)
    return NextResponse.json({ ok: false, error: 'Merge failed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Contacts',
  summary: 'Merge duplicate contacts',
  methods: {
    POST: {
      summary: 'Merge two contacts by moving all records to the primary contact',
      tags: ['Contacts'],
    },
  },
}
