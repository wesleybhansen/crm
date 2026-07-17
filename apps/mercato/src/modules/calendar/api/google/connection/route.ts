export const metadata = { GET: { requireAuth: true }, DELETE: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

// Mounted at /api/calendar/google/connection (module-prefixed default).
// GET = connection status for the settings UI; DELETE = disconnect.

export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const container = await createRequestContainer()
  const knex = (container.resolve('em') as EntityManager).getKnex()
  const conn = await knex('google_calendar_connections')
    .where('user_id', auth.sub)
    .where('is_active', true)
    .first()

  return NextResponse.json({
    ok: true,
    connected: Boolean(conn),
    email: conn?.google_email || null,
  })
}

export async function DELETE() {
  const auth = await getAuthFromCookies()
  if (!auth?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const container = await createRequestContainer()
  const knex = (container.resolve('em') as EntityManager).getKnex()
  // Deactivate only the calendar connection. The Gmail email connection shares
  // the Google grant but is managed (and disconnected) from the email settings,
  // so we deliberately do not revoke the token at Google here.
  await knex('google_calendar_connections')
    .where('user_id', auth.sub)
    .update({ is_active: false, updated_at: new Date() })

  return NextResponse.json({ ok: true })
}
