export const metadata = { GET: { requireAuth: true }, DELETE: { requireAuth: true } }
export const openApi = { summary: "Email connections", methods: { GET: { summary: "List connections", tags: ["Email"] }, DELETE: { summary: "Disconnect", tags: ["Email"] } } }

import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import type { EntityManager } from '@mikro-orm/postgresql'

// GET: Return the user's email connections.
//   ?purpose=customer_service  -> only dedicated support inboxes
//   ?excludePurpose=customer_service -> only personal inbox mailboxes (purpose null)
// With no filter, every active connection is returned (back-compat).
export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.sub || !auth?.orgId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const url = new URL(req.url)
    const purposeFilter = url.searchParams.get('purpose')
    const excludePurpose = url.searchParams.get('excludePurpose')

    const query = knex('email_connections')
      .where('organization_id', auth.orgId)
      .where('user_id', auth.sub)
      .where('is_active', true)
      .select('id', 'provider', 'email_address', 'is_primary', 'is_active', 'purpose', 'created_at')
      .orderBy('is_primary', 'desc')

    if (purposeFilter) {
      query.where('purpose', purposeFilter)
    } else if (excludePurpose) {
      // Treat NULL purpose as "personal inbox". Postgres: NULL != 'x' is NULL,
      // so we must allow null explicitly.
      query.where(function (this: any) {
        this.whereNull('purpose').orWhere('purpose', '!=', excludePurpose)
      })
    }

    const connections = await query

    return NextResponse.json({ ok: true, data: connections })
  } catch (error) {
    console.error('[email.connections.list]', error)
    return NextResponse.json({ ok: false, error: 'Failed to list connections' }, { status: 500 })
  }
}

// DELETE: Disconnect an email connection by ?id=
export async function DELETE(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.sub || !auth?.orgId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(req.url)
  const connectionId = url.searchParams.get('id')
  if (!connectionId) {
    return NextResponse.json({ ok: false, error: 'Connection id is required' }, { status: 400 })
  }

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // Only allow deleting own connections within the same org
    const deleted = await knex('email_connections')
      .where('id', connectionId)
      .where('organization_id', auth.orgId)
      .where('user_id', auth.sub)
      .update({ is_active: false, updated_at: new Date() })

    if (!deleted) {
      return NextResponse.json({ ok: false, error: 'Connection not found' }, { status: 404 })
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[email.connections.delete]', error)
    return NextResponse.json({ ok: false, error: 'Failed to disconnect' }, { status: 500 })
  }
}
