import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { trackEngagement } from '@/modules/customers/lib/engagement-score'
import { signTrackedUrl } from '@/modules/email/services/email-sender'
import { createHash, timingSafeEqual } from 'crypto'

const SIGNING_SINCE = Date.parse('2026-09-11T20:00:00Z')

export const metadata = { GET: { requireAuth: false } }

export async function GET(req: Request, { params }: { params: { trackingId: string } }) {
  const url = new URL(req.url)
  const rawRedirect = url.searchParams.get('url')
  const sig = url.searchParams.get('sig') || ''
  const isHttp = Boolean(rawRedirect && /^https?:\/\//.test(rawRedirect))
  // Only a URL this app signed when it wrapped the link is followed. The
  // compare is over fixed-length digests, so an odd `sig` cannot throw.
  const digest = (v: string) => createHash('sha256').update(v).digest()
  const signed = isHttp && sig !== '' && timingSafeEqual(digest(sig), digest(signTrackedUrl(rawRedirect as string)))
  let redirectUrl: string | null = signed ? rawRedirect : null

  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const msg = await knex('email_messages')
      .where('tracking_id', params.trackingId)
      .whereNull('clicked_at')
      .first()
    // Mail sent before links were signed (2026-09-11) still carries unsigned
    // links; those are followed for that mail only, and only to http(s).
    if (!redirectUrl && isHttp && sig === '' && msg && msg.created_at && new Date(msg.created_at).getTime() < SIGNING_SINCE) {
      redirectUrl = rawRedirect
    }
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
