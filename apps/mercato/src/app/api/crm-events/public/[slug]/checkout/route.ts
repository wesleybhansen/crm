import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import crypto from 'crypto'

bootstrap()

export const metadata = { POST: { requireAuth: false } }

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const event = await knex('events').where('slug', slug).where('status', 'published').whereNull('deleted_at').first()
    if (!event) return NextResponse.json({ ok: false, error: 'Event not found' }, { status: 404 })
    if (event.is_free) return NextResponse.json({ ok: false, error: 'This event is free' }, { status: 400 })

    const body = await req.json()
    const { name, email, ticketQuantity, guestDetails, registrationData, acceptedTerms } = body
    if (!name?.trim() || !email?.trim()) return NextResponse.json({ ok: false, error: 'Name and email required' }, { status: 400 })
    if (event.terms_text && !acceptedTerms) return NextResponse.json({ ok: false, error: 'You must accept the terms' }, { status: 400 })

    const qty = ticketQuantity || 1

    // Capacity check
    if (event.capacity) {
      const currentCount = event.attendee_count || 0
      if (currentCount + qty > event.capacity) {
        return NextResponse.json({ ok: false, error: event.capacity - currentCount > 0 ? `Only ${event.capacity - currentCount} spots remaining` : 'Sold out' }, { status: 409 })
      }
    }

    // Duplicate check
    const existing = await knex('event_attendees').where('event_id', event.id).where('attendee_email', email.trim().toLowerCase()).where('status', 'registered').first()
    if (existing) return NextResponse.json({ ok: false, error: 'Already registered', alreadyRegistered: true }, { status: 409 })

    // Get Stripe connection
    const stripeConnection = await knex('stripe_connections').where('organization_id', event.organization_id).where('is_active', true).first()
    const stripeKey = process.env.STRIPE_SECRET_KEY
    if (!stripeKey || !stripeConnection?.stripe_account_id) {
      return NextResponse.json({ ok: false, error: 'Payment processing is not configured' }, { status: 400 })
    }

    const Stripe = (await import('stripe')).default
    const stripe = new Stripe(stripeKey, { apiVersion: '2024-12-18.acacia' as any })
    const origin = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: (event.currency || 'usd').toLowerCase(),
          product_data: { name: `${event.title}${qty > 1 ? ` (${qty} tickets)` : ''}` },
          unit_amount: Math.round(Number(event.price) * 100),
        },
        quantity: qty,
      }],
      customer_email: email.trim(),
      metadata: {
        type: 'event',
        eventId: event.id,
        eventSlug: event.slug,
        attendeeName: name.trim(),
        attendeeEmail: email.trim().toLowerCase(),
        ticketQuantity: String(qty),
        guestDetails: guestDetails ? JSON.stringify(guestDetails) : '',
        registrationData: registrationData ? JSON.stringify(registrationData) : '',
        acceptedTerms: acceptedTerms ? 'true' : 'false',
        orgId: event.organization_id,
        tenantId: event.tenant_id,
      },
      success_url: `${origin}/api/crm-events/public/${slug}?registered=true`,
      cancel_url: `${origin}/api/crm-events/public/${slug}`,
    }, { stripeAccount: stripeConnection.stripe_account_id })

    return NextResponse.json({ ok: true, data: { url: session.url } })
  } catch (error: any) {
    console.error('[crm-events.checkout]', error?.message)
    return NextResponse.json({ ok: false, error: 'Failed to create checkout' }, { status: 500 })
  }
}
