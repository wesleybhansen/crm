import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

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

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object
      const meta = session.metadata || {}

      // Record the payment
      await knex('payment_records').insert({
        id: require('crypto').randomUUID(),
        tenant_id: meta.tenantId || null,
        organization_id: meta.orgId || null,
        invoice_id: meta.invoiceId || null,
        amount: (session.amount_total || 0) / 100,
        currency: session.currency || 'usd',
        status: 'succeeded',
        stripe_checkout_session_id: session.id,
        stripe_payment_intent_id: session.payment_intent,
        metadata: JSON.stringify({ customerEmail: session.customer_email, type: meta.type }),
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
      if (session.customer_email && meta.orgId) {
        const existing = await knex('customer_entities')
          .where('primary_email', session.customer_email)
          .where('organization_id', meta.orgId)
          .whereNull('deleted_at').first()

        if (!existing) {
          await knex('customer_entities').insert({
            id: require('crypto').randomUUID(),
            tenant_id: meta.tenantId,
            organization_id: meta.orgId,
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

      console.log(`[stripe.webhook] Payment completed: $${(session.amount_total || 0) / 100} from ${session.customer_email}`)
    }

    return NextResponse.json({ received: true })
  } catch (error) {
    console.error('[stripe.webhook]', error)
    return NextResponse.json({ error: 'Webhook error' }, { status: 400 })
  }
}
