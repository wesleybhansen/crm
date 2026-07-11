// ORM-SKIP: events/event_attendees are raw-knex tables (no mercato entity)
export const metadata = { path: '/crm-events/[id]/kiosk', POST: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import crypto from 'crypto'

// Mint (or rotate) the kiosk sign-in token for an event.
// Body: { rotate?: boolean } — by default an existing token is reused so a
// printed/displayed QR keeps working; rotate: true invalidates the old link.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthFromRequest(req)
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const { id } = await params
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const event = await knex('events')
      .where('id', id)
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .first()
    if (!event) return NextResponse.json({ ok: false, error: 'Event not found' }, { status: 404 })

    let body: Record<string, unknown> = {}
    try { body = await req.json() } catch { /* empty body */ }
    const rotate = body.rotate === true

    let token: string = event.kiosk_token || ''
    if (!token || rotate) {
      token = crypto.randomBytes(24).toString('base64url')
      await knex('events').where('id', id).where('organization_id', auth.orgId)
        .update({ kiosk_token: token, updated_at: new Date() })
    }

    const origin = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || new URL(req.url).origin
    const url = `${origin}/api/crm-events/kiosk/${token}`

    return NextResponse.json({ ok: true, data: { token, url, rotated: rotate || !event.kiosk_token } })
  } catch (error) {
    console.error('[crm-events.kiosk.mint] failed', error)
    return NextResponse.json({ ok: false, error: 'Failed to create kiosk link' }, { status: 500 })
  }
}
