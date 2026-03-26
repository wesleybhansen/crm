import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

export async function GET(req: Request, { params }: { params: { contactId: string } }) {
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const contact = await knex('customer_entities').where('id', params.contactId).first()
    if (!contact) return new NextResponse('Not found', { status: 404 })

    // Record unsubscribe
    const existing = await knex('email_unsubscribes')
      .where('email', contact.primary_email)
      .where('organization_id', contact.organization_id).first()

    if (!existing) {
      await knex('email_unsubscribes').insert({
        id: require('crypto').randomUUID(),
        tenant_id: contact.tenant_id,
        organization_id: contact.organization_id,
        email: contact.primary_email,
        contact_id: params.contactId,
        created_at: new Date(),
      })
    }

    const html = `<!DOCTYPE html><html><head><title>Unsubscribed</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fafafa}
.card{text-align:center;padding:48px;background:#fff;border-radius:16px;box-shadow:0 2px 8px rgba(0,0,0,0.08);max-width:400px}
h1{font-size:20px;margin:0 0 8px}p{color:#666;font-size:14px}</style></head>
<body><div class="card"><h1>Unsubscribed</h1><p>You've been removed from our mailing list. You won't receive any more marketing emails from us.</p></div></body></html>`

    return new NextResponse(html, { status: 200, headers: { 'Content-Type': 'text/html' } })
  } catch {
    return new NextResponse('Error', { status: 500 })
  }
}
