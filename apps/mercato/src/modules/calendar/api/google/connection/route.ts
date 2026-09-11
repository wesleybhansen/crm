export const metadata = { GET: { requireAuth: true }, DELETE: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { openSecretForTenant, tenantEncryptionFromContainer } from '@open-mercato/shared/lib/encryption/secretColumns'
import { revokeGoogleOAuthToken } from '@open-mercato/shared/lib/integrations/revokeTokens'

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

  const rows = await knex('google_calendar_connections')
    .where('user_id', auth.sub)
    .where('is_active', true)

  // Revoking a Google refresh token kills the whole grant for this client, and
  // a Gmail mailbox connection would ride on the same grant. Revoke only when
  // the user has no active Gmail mailbox left; otherwise scrub our copy and let
  // the mailbox disconnect do the revoking.
  let gmailStillConnected = false
  try {
    const gmail = await knex('email_connections')
      .where('user_id', auth.sub)
      .where('provider', 'gmail')
      .where('is_active', true)
      .first()
    gmailStillConnected = Boolean(gmail)
  } catch {
    // email_connections unavailable — treat as not connected and revoke.
  }

  if (!gmailStillConnected) {
    const encryption = tenantEncryptionFromContainer(container)
    for (const row of rows) {
      try {
        await revokeGoogleOAuthToken({
          refreshToken: await openSecretForTenant(encryption, row.tenant_id, row.refresh_token),
          accessToken: await openSecretForTenant(encryption, row.tenant_id, row.access_token),
        }, 'calendar.google')
      } catch (revokeErr) {
        console.warn('[calendar.google.disconnect] revoke failed', revokeErr)
      }
    }
  }

  // access_token / refresh_token are NOT NULL on this table, so '' is the
  // scrubbed value.
  await knex('google_calendar_connections')
    .where('user_id', auth.sub)
    .update({ is_active: false, access_token: '', refresh_token: '', updated_at: new Date() })

  return NextResponse.json({ ok: true })
}
