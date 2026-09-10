export const metadata = { GET: { requireAuth: false } }
export const openApi = { summary: 'Email unsubscribe redirect', methods: { GET: { summary: 'Redirect to preference center', tags: ['Email'] } } }

import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { signEmailToken, verifyEmailToken } from '@/lib/email-token'

// Signed links shipped 2026-09-08; mail older than this is past any lawful
// opt-out window, so the token-less grace closes here.
const LEGACY_LINK_HONOURED_UNTIL = new Date('2026-11-08T00:00:00Z')

export async function GET(req: Request, { params }: { params: { contactId: string } }) {
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // The link in every outbound email carries a signed token; a bare contact
    // UUID (they leak in exports, timeline links, screenshots) must not be
    // enough to open someone's preference center and opt them out.
    const presented = new URL(req.url).searchParams.get('t') ?? ''
    const verified = verifyEmailToken(presented)
    let contact: { id: string; organization_id: string } | undefined
    let scope: 'full' | 'unsubscribe' = 'full'
    if (verified && verified.contactId === params.contactId) {
      contact = await knex('customer_entities')
        .where({ id: params.contactId, organization_id: verified.orgId })
        .first()
      scope = verified.scope
    } else if (!presented && Date.now() < LEGACY_LINK_HONOURED_UNTIL.getTime()) {
      // Mail delivered before 2026-09-08 carries a bare contact id and no
      // token, and the body link is the only opt-out path (no List-Unsubscribe
      // header). Refusing it 404s a lawful unsubscribe. Honour a token-less
      // link only for contacts that existed before signing was introduced,
      // only until the grace window closes, and only with an unsubscribe-only
      // token: it cannot show the address or re-subscribe, so a guessed
      // contact id gains an outsider nothing.
      contact = await knex('customer_entities')
        .where({ id: params.contactId })
        .where('created_at', '<', new Date('2026-09-08T00:00:00Z'))
        .first()
      scope = 'unsubscribe'
      if (contact) console.warn('[unsubscribe] legacy token-less link honoured', { contactId: params.contactId })
    }
    if (!contact) return new NextResponse('Not found', { status: 404 })

    const token = signEmailToken(params.contactId, contact.organization_id, scope)
    const baseUrl = process.env.APP_URL || 'http://localhost:3000'

    // Redirect to the preference center
    return NextResponse.redirect(`${baseUrl}/api/email/preferences/${token}`)
  } catch {
    return new NextResponse('Error', { status: 500 })
  }
}
