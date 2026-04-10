export const metadata = { POST: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

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
    const { subscriptionId, cancelAtPeriodEnd } = body

    if (!subscriptionId) {
      return NextResponse.json({ ok: false, error: 'subscriptionId is required' }, { status: 400 })
    }

    const stripeConnection = await knex('stripe_connections')
      .where('organization_id', auth.orgId)
      .where('is_active', true)
      .first()

    if (!stripeConnection) {
      return NextResponse.json(
        { ok: false, error: 'Connect your Stripe account in Settings to manage subscriptions' },
        { status: 400 },
      )
    }

    const stripeAccount = stripeConnection.stripe_account_id
    const Stripe = (await import('stripe')).default
    const stripe = new Stripe(stripeKey)

    let subscription
    if (cancelAtPeriodEnd) {
      subscription = await stripe.subscriptions.update(
        subscriptionId,
        { cancel_at_period_end: true },
        { stripeAccount },
      )
    } else {
      subscription = await stripe.subscriptions.cancel(
        subscriptionId,
        { stripeAccount },
      )
    }

    return NextResponse.json({
      ok: true,
      data: {
        status: subscription.status,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        currentPeriodEnd: subscription.current_period_end,
      },
    })
  } catch (error) {
    console.error('[stripe.cancel-subscription]', error)
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'Stripe error' }, { status: 500 })
  }
}
