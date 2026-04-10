export const metadata = { POST: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

// Generate a Stripe Checkout Session for a product/invoice
// Uses the org's connected Stripe account via Stripe Connect
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

    // Look up the org's connected Stripe account
    const stripeConnection = await knex('stripe_connections')
      .where('organization_id', auth.orgId)
      .where('is_active', true)
      .first()

    if (!stripeConnection) {
      return NextResponse.json(
        { ok: false, error: 'Connect your Stripe account in Settings to accept payments' },
        { status: 400 },
      )
    }

    const body = await req.json()
    const { type, productId, invoiceId } = body
    const baseUrl = process.env.APP_URL || 'http://localhost:3000'

    let lineItems: Array<{ price_data: any; quantity: number }> = []
    let metadata: Record<string, string> = { orgId: auth.orgId, tenantId: auth.tenantId || '' }
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

    // Create Stripe Checkout Session on behalf of the connected account
    const Stripe = (await import('stripe')).default
    const stripe = new Stripe(stripeKey)

    // Resolve terms URL: body override → product/invoice terms_url → business profile fallback
    const profile = await knex('business_profiles').where('organization_id', auth.orgId).first()
    let termsUrl: string | null = null
    if (body.termsUrl) {
      termsUrl = body.termsUrl
    } else if (type === 'product' && productId) {
      const productRow = await knex('products').where('id', productId).where('organization_id', auth.orgId).first()
      termsUrl = productRow?.terms_url || null
    } else if (type === 'invoice' && invoiceId) {
      const invoiceRow = await knex('invoices').where('id', invoiceId).where('organization_id', auth.orgId).first()
      termsUrl = invoiceRow?.terms_url || null
    }
    if (!termsUrl) {
      termsUrl = profile?.terms_url || null
    }

    const isSubscription = lineItems.some((li: any) => li.price_data.recurring)

    const sessionParams: any = {
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: isSubscription ? 'subscription' : 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata,
      customer_email: body.customerEmail || undefined,
    }

    // Add free trial period for subscription products
    if (isSubscription && type === 'product' && productId) {
      const prod = await knex('products').where('id', productId).where('organization_id', auth.orgId).first()
      if (prod?.trial_days && prod.trial_days > 0) {
        sessionParams.subscription_data = {
          trial_period_days: prod.trial_days,
          metadata,
        }
      }
    }

    // Add terms of service consent if a terms URL is available
    if (termsUrl) {
      sessionParams.consent_collection = {
        terms_of_service: 'required',
      }
      sessionParams.custom_text = {
        terms_of_service_acceptance: {
          message: `I agree to the [Terms of Service](${termsUrl})`,
        },
      }
    }

    const session = await stripe.checkout.sessions.create(
      sessionParams,
      {
        stripeAccount: stripeConnection.stripe_account_id,
      },
    )

    // Store the payment link on the invoice (don't change status — that happens when user sends email)
    if (invoiceId) {
      await knex('invoices').where('id', invoiceId).update({
        stripe_payment_link: session.url,
        updated_at: new Date(),
      })
    }

    return NextResponse.json({ ok: true, url: session.url, sessionId: session.id })
  } catch (error) {
    console.error('[stripe.connect]', error)
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'Stripe error' }, { status: 500 })
  }
}
