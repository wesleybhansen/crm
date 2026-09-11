import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { trackEngagement } from '@/modules/customers/lib/engagement-score'
import { signTrackedUrl } from '@/modules/email/services/email-sender'
import { timingSafeEqual } from 'crypto'

export const metadata = { GET: { requireAuth: false } }

export async function GET(req: Request, { params }: { params: { trackingId: string } }) {
  const url = new URL(req.url)
  const rawRedirect = url.searchParams.get('url')
  const sig = url.searchParams.get('sig') || ''
  // Only a URL this app signed when it wrapped the link is followed.
  const signed = rawRedirect && sig && /^https?:\/\//.test(rawRedirect) && timingSafeEqual(Buffer.from(sig), Buffer.from(signTrackedUrl(rawRedirect).slice(0, sig.length).padEnd(sig.length, '0')))
  const redirectUrl = signed && sig === signTrackedUrl(rawRedirect) ? rawRedirect : null

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
  return new NextResponse('This link is not valid.', { status: 400 })
}
