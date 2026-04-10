export const metadata = { OPTIONS: { requireAuth: true }, POST: { requireAuth: true } }
export const openApi = { summary: 'checkout', methods: {} }
import { NextResponse } from 'next/server'
import { query, queryOne } from '@/app/api/funnels/db'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const { productId, email, name, landingPageSlug } = body

    if (!productId) {
      return NextResponse.json({ ok: false, error: 'Product ID required' }, { status: 400, headers: CORS_HEADERS })
    }

    // Handle course: prefix — look up course and map to product-like object
    let product: any
    if (productId.startsWith('course:')) {
      const courseId = productId.replace('course:', '')
      const course = await queryOne('SELECT * FROM courses WHERE id = $1 AND is_published = true', [courseId])
      if (!course) {
        return NextResponse.json({ ok: false, error: 'Course not found' }, { status: 404, headers: CORS_HEADERS })
      }
      product = {
        id: course.id,
        name: course.title,
        price: course.price,
        currency: course.currency || 'usd',
        billing_type: 'one_time',
        organization_id: course.organization_id,
        tenant_id: course.tenant_id,
        description: course.description,
        stripe_price_id: null,
      }
    } else {
      product = await queryOne('SELECT * FROM products WHERE id = $1 AND is_active = true', [productId])
      if (!product) {
        return NextResponse.json({ ok: false, error: 'Product not found' }, { status: 404, headers: CORS_HEADERS })
      }
    }

    // Check if Stripe is configured (platform key + connected account)
    const stripeKey = process.env.STRIPE_SECRET_KEY
    const stripeConn = await queryOne(
      'SELECT stripe_account_id FROM stripe_connections WHERE organization_id = $1 AND is_active = true',
      [product.organization_id]
    )

    if (!stripeKey || !stripeConn?.stripe_account_id) {
      return NextResponse.json(
        { ok: false, error: 'Payment processing is not configured. Please connect Stripe in Settings.' },
        { status: 400, headers: CORS_HEADERS }
      )
    }

    const Stripe = (await import('stripe')).default
    const stripe = new Stripe(stripeKey)
    const baseUrl = process.env.APP_URL || 'http://localhost:3000'

    const successUrl = landingPageSlug
      ? `${baseUrl}/api/landing-pages/public/${landingPageSlug}?payment=success`
      : `${baseUrl}/backend/payments`

    const sessionConfig: any = {
      payment_method_types: ['card'],
      mode: product.billing_type === 'recurring' ? 'subscription' : 'payment',
      success_url: `${successUrl}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: landingPageSlug
        ? `${baseUrl}/api/landing-pages/public/${landingPageSlug}`
        : `${baseUrl}/backend/payments`,
      metadata: {
        orgId: product.organization_id,
        tenantId: product.tenant_id,
        productId: product.id,
        landingPageSlug: landingPageSlug || '',
        source: 'landing-page',
        ...(productId.startsWith('course:') ? {
          courseId: productId.replace('course:', ''),
          studentEmail: email || '',
          studentName: name || '',
        } : {}),
      },
    }

    if (email) sessionConfig.customer_email = email

    // Use existing Stripe price if available, otherwise create ad-hoc price
    if (product.stripe_price_id) {
      sessionConfig.line_items = [{
        price: product.stripe_price_id,
        quantity: 1,
      }]
    } else {
      sessionConfig.line_items = [{
        price_data: {
          currency: (product.currency || 'usd').toLowerCase(),
          product_data: { name: product.name, description: product.description || undefined },
          unit_amount: Math.round(Number(product.price) * 100),
          ...(product.billing_type === 'recurring' ? {
            recurring: { interval: product.recurring_interval || 'month' },
          } : {}),
        },
        quantity: 1,
      }]
    }

    const session = await stripe.checkout.sessions.create(
      sessionConfig,
      { stripeAccount: stripeConn.stripe_account_id }
    )

    // Create/update contact if email provided
    if (email) {
      const now = new Date()
      const existing = await queryOne(
        'SELECT id FROM customer_entities WHERE primary_email = $1 AND organization_id = $2 AND deleted_at IS NULL',
        [email, product.organization_id]
      )
      if (!existing) {
        const contactId = require('crypto').randomUUID()
        await query(
          `INSERT INTO customer_entities (id, tenant_id, organization_id, kind, display_name, primary_email, source, source_details, status, lifecycle_stage, created_at, updated_at)
           VALUES ($1, $2, $3, 'person', $4, $5, 'landing_page', $6, 'active', 'Customer', $7, $7)`,
          [contactId, product.tenant_id, product.organization_id, name || email, email, JSON.stringify({ landingPageSlug, productId }), now]
        )
        if (name) {
          const parts = name.split(' ')
          await query(
            `INSERT INTO customer_people (id, tenant_id, organization_id, entity_id, first_name, last_name, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
            [require('crypto').randomUUID(), product.tenant_id, product.organization_id, contactId, parts[0], parts.slice(1).join(' ') || '', now]
          ).catch(() => {})
        }
      }
    }

    return NextResponse.json(
      { ok: true, checkoutUrl: session.url },
      { headers: CORS_HEADERS }
    )
  } catch (error) {
    console.error('[landing-page-checkout]', error)
    const message = error instanceof Error ? error.message : 'Checkout failed'
    return NextResponse.json({ ok: false, error: message }, { status: 500, headers: CORS_HEADERS })
  }
}
