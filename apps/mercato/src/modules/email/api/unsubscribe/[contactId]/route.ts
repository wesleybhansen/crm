export const metadata = { GET: { requireAuth: false } }
export const openApi = { summary: 'Email unsubscribe redirect', methods: { GET: { summary: 'Redirect to preference center', tags: ['Email'] } } }

import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

export async function GET(req: Request, { params }: { params: { contactId: string } }) {
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const contact = await knex('customer_entities').where('id', params.contactId).first()
    if (!contact) return new NextResponse('Not found', { status: 404 })

    // Generate preference center token (base64 of contactId:orgId)
    const token = Buffer.from(`${params.contactId}:${contact.organization_id}`).toString('base64')
    const baseUrl = process.env.APP_URL || 'http://localhost:3000'

    // Redirect to the preference center
    return NextResponse.redirect(`${baseUrl}/api/email/preferences/${token}`)
  } catch {
    return new NextResponse('Error', { status: 500 })
  }
}
