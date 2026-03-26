import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

// Generate a Stripe Checkout Session for a product/invoice
export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const stripeKey = process.env.STRIPE_SECRET_KEY
  if (!stripeKey) {
    return NextResponse.json({ ok: false, error: 'Stripe not configured. Add STRIPE_SECRET_KEY to .env' }, { status: 500 })
  }

  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const body = await req.json()
    const { type, productId, invoiceId } = body
    const baseUrl = process.env.APP_URL || 'http://localhost:3000'

    let lineItems: Array<{ price_data: any; quantity: number }> = []
    let metadata: Record<string, string> = { orgId: auth.orgId }
    let successUrl = `${baseUrl}/api/stripe/success?session_id={CHECKOUT_SESSION_ID}`
    let cancelUrl = `${baseUrl}/backend/payments`

    if (type === 'product' && productId) {
      const product = await knex('products').where('id', productId).where('organization_id', auth.orgId).first()
      if (!product) return NextResponse.json({ ok: false, error: 'Product not found' }, { status: 404 })

      lineItems = [{
        price_data: {
          currency: (product.currency || 'usd').toLowerCase(),
          product_data: { name: product.name, description: product.description || undefined },
          unit_amount: Math.round(Number(product.price) * 100),
          ...(product.billing_type === 'recurring' ? { recurring: { interval: product.recurring_interval || 'month' } } : {}),
        },
        quantity: 1,
      }]
      metadata.productId = productId
      metadata.type = 'product'
    } else if (type === 'invoice' && invoiceId) {
      const invoice = await knex('invoices').where('id', invoiceId).where('organization_id', auth.orgId).first()
      if (!invoice) return NextResponse.json({ ok: false, error: 'Invoice not found' }, { status: 404 })

      const items = typeof invoice.line_items === 'string' ? JSON.parse(invoice.line_items) : invoice.line_items
      lineItems = items.map((item: any) => ({
        price_data: {
          currency: (invoice.currency || 'usd').toLowerCase(),
          product_data: { name: item.name },
          unit_amount: Math.round(Number(item.price) * 100),
        },
        quantity: item.quantity || 1,
      }))
      metadata.invoiceId = invoiceId
      metadata.type = 'invoice'
    } else {
      return NextResponse.json({ ok: false, error: 'type (product|invoice) and corresponding ID required' }, { status: 400 })
    }

    // Create Stripe Checkout Session
    const Stripe = (await import('stripe')).default
    const stripe = new Stripe(stripeKey)

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: lineItems.some(li => li.price_data.recurring) ? 'subscription' : 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata,
      customer_email: body.customerEmail || undefined,
    })

    // Store the checkout session reference
    if (invoiceId) {
      await knex('invoices').where('id', invoiceId).update({
        stripe_payment_link: session.url,
        status: 'sent',
        sent_at: new Date(),
        updated_at: new Date(),
      })
    }

    return NextResponse.json({ ok: true, url: session.url, sessionId: session.id })
  } catch (error) {
    console.error('[stripe.connect]', error)
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'Stripe error' }, { status: 500 })
  }
}
