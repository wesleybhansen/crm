import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { trackEngagement } from '@/modules/customers/lib/engagement-score'

export const metadata = { GET: { requireAuth: false } }

export async function GET(req: Request, { params }: { params: { trackingId: string } }) {
  const url = new URL(req.url)
  const redirectUrl = url.searchParams.get('url')

  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const msg = await knex('email_messages')
      .where('tracking_id', params.trackingId)
      .whereNull('clicked_at')
      .first()
    if (msg) {
      await knex('email_messages').where('id', msg.id).update({ clicked_at: new Date(), status: 'clicked' })
      if (msg.contact_id) {
        trackEngagement(knex, msg.organization_id, msg.tenant_id, msg.contact_id, 'email_clicked').catch(() => {})
      }
    }
  } catch (error) {
    console.error('[email.track.click] failed', error)
  }

  if (redirectUrl) return NextResponse.redirect(redirectUrl, 302)
  return new NextResponse('Redirecting...', { status: 200 })
}
