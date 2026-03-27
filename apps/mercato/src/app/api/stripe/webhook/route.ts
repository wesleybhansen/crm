import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

export const metadata = { POST: { requireAuth: false } }

export async function POST(req: Request) {
  const stripeKey = process.env.STRIPE_SECRET_KEY
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
  if (!stripeKey) return NextResponse.json({ error: 'Not configured' }, { status: 500 })

  try {
    const Stripe = (await import('stripe')).default
    const stripe = new Stripe(stripeKey)
    const body = await req.text()

    let event: any
    if (webhookSecret) {
      const sig = req.headers.get('stripe-signature') || ''
      event = stripe.webhooks.constructEvent(body, sig, webhookSecret)
    } else {
      event = JSON.parse(body)
    }

    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()

    // For Connect webhooks, the event includes an `account` field
    // identifying which connected account the event belongs to
    const connectedAccountId = event.account || null

    // Resolve the org context — either from metadata or from connected account lookup
    let orgId: string | null = null
    let tenantId: string | null = null

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object
      const meta = session.metadata || {}

      // Try metadata first (set during session creation)
      orgId = meta.orgId || null
      tenantId = meta.tenantId || null

      // If this is a Connect event, look up the org by connected account ID
      if (!orgId && connectedAccountId) {
        const connection = await knex('stripe_connections')
          .where('stripe_account_id', connectedAccountId)
          .where('is_active', true)
          .first()

        if (connection) {
          orgId = connection.organization_id
          tenantId = connection.tenant_id
        }
      }

      if (!orgId) {
        console.warn('[stripe.webhook] Could not resolve org for event', event.id)
        return NextResponse.json({ received: true })
      }

      // Record the payment
      await knex('payment_records').insert({
        id: require('crypto').randomUUID(),
        tenant_id: tenantId,
        organization_id: orgId,
        invoice_id: meta.invoiceId || null,
        amount: (session.amount_total || 0) / 100,
        currency: session.currency || 'usd',
        status: 'succeeded',
        stripe_checkout_session_id: session.id,
        stripe_payment_intent_id: session.payment_intent,
        metadata: JSON.stringify({
          customerEmail: session.customer_email,
          type: meta.type,
          connectedAccount: connectedAccountId,
        }),
        created_at: new Date(),
      }).catch(e => console.error('[stripe.webhook] payment record failed:', e))

      // Update invoice status if applicable
      if (meta.invoiceId) {
        await knex('invoices').where('id', meta.invoiceId).update({
          status: 'paid',
          paid_at: new Date(),
          updated_at: new Date(),
        }).catch(() => {})
      }

      // Auto-create contact from customer email if we have one
      if (session.customer_email && orgId) {
        const existing = await knex('customer_entities')
          .where('primary_email', session.customer_email)
          .where('organization_id', orgId)
          .whereNull('deleted_at').first()

        if (!existing) {
          await knex('customer_entities').insert({
            id: require('crypto').randomUUID(),
            tenant_id: tenantId,
            organization_id: orgId,
            kind: 'person',
            display_name: session.customer_details?.name || session.customer_email,
            primary_email: session.customer_email,
            source: 'stripe',
            status: 'active',
            lifecycle_stage: 'customer',
            created_at: new Date(),
            updated_at: new Date(),
          }).catch(() => {})
        }
      }

      console.log(`[stripe.webhook] Payment completed: $${(session.amount_total || 0) / 100} from ${session.customer_email} (account: ${connectedAccountId || 'platform'})`)
    }

    return NextResponse.json({ received: true })
  } catch (error) {
    console.error('[stripe.webhook]', error)
    return NextResponse.json({ error: 'Webhook error' }, { status: 400 })
  }
}
