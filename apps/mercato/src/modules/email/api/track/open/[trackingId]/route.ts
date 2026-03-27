import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { trackEngagement } from '@/app/api/engagement/score'

export const metadata = { GET: { requireAuth: false } }

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

export async function GET(req: Request, { params }: { params: { trackingId: string } }) {
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const msg = await knex('email_messages')
      .where('tracking_id', params.trackingId)
      .whereNull('opened_at')
      .first()
    if (msg) {
      const now = new Date()
      await knex('email_messages').where('id', msg.id).update({ opened_at: now, status: 'opened' })
      if (msg.contact_id) {
        trackEngagement(knex, msg.organization_id, msg.tenant_id, msg.contact_id, 'email_opened').catch(() => {})
        knex('contact_open_times').insert({
          contact_id: msg.contact_id,
          organization_id: msg.organization_id,
          hour_of_day: now.getUTCHours(),
          day_of_week: now.getUTCDay(),
          opened_at: now,
        }).catch(() => {})
      }
    }
  } catch (error) {
    console.error('[email.track.open] failed', error)
  }
  return new NextResponse(PIXEL, {
    status: 200,
    headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' },
  })
}
