export const metadata = { GET: { requireAuth: true }, DELETE: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

// Get the org's Stripe connection status
export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const connection = await knex('stripe_connections')
      .where('organization_id', auth.orgId)
      .where('is_active', true)
      .first()

    if (!connection) {
      return NextResponse.json({ ok: true, data: null })
    }

    return NextResponse.json({
      ok: true,
      data: {
        id: connection.id,
        stripeAccountId: connection.stripe_account_id,
        businessName: connection.business_name,
        livemode: connection.livemode,
        isActive: connection.is_active,
        connectedAt: connection.created_at,
      },
    })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed to fetch connection' }, { status: 500 })
  }
}

// Disconnect Stripe account
export async function DELETE() {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    await knex('stripe_connections')
      .where('organization_id', auth.orgId)
      .update({ is_active: false, updated_at: new Date() })

    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed to disconnect' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Stripe Connect',
  summary: 'Manage Stripe Connect connections',
  methods: {
    GET: { summary: 'Get Stripe connection status for the organization', tags: ['Stripe Connect'] },
    DELETE: { summary: 'Disconnect Stripe account from the organization', tags: ['Stripe Connect'] },
  },
}
