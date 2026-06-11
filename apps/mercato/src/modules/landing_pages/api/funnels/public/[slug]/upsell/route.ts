import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import crypto from 'crypto'

// POST: Accept or decline an upsell/downsell offer
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    await bootstrap()
    const { slug } = await params
    const body = await req.json()
    const { sid, stepId, action } = body // action: 'accept' | 'decline'

    if (!sid || !stepId || !action) {
      return NextResponse.json({ ok: false, error: 'Missing required fields' }, { status: 400 })
    }

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const funnel = await knex('funnels').where('slug', slug).first()
    if (!funnel) return NextResponse.json({ ok: false, error: 'Funnel not found' }, { status: 404 })

    // Bind the session to THIS funnel — sid leaks via redirect query strings,
    // so a sid from one funnel must not authorize a one-click charge in another.
    const session = await knex('funnel_sessions').where('id', sid).where('funnel_id', funnel.id).first()
    if (!session) return NextResponse.json({ ok: false, error: 'Session not found' }, { status: 404 })

    const step = await knex('funnel_steps').where('id', stepId).where('funnel_id', funnel.id).first()
    if (!step) return NextResponse.json({ ok: false, error: 'Step not found' }, { status: 404 })

    const baseUrl = process.env.APP_URL || 'http://localhost:3000'

    // Record the action
    await knex('funnel_visits').insert({
      id: crypto.randomUUID(),
      funnel_id: funnel.id, step_id: step.id,
      session_id: session.id, visitor_id: session.visitor_id,
      action: action, created_at: new Date(),
    })

    if (action === 'accept') {
      // Charge the saved card
      if (!session.stripe_customer_id || !session.stripe_payment_method_id) {
        return NextResponse.json({ ok: false, error: 'No saved payment method. Please complete checkout first.' }, { status: 400 })
      }

      // Idempotency guard: this endpoint is public and the upsell button is a
      // one-click off-session charge. A double-click, browser retry, or replay
      // must not charge the card twice. If this (session, step) already has a
      // succeeded order, skip the charge and advance to the next step.
      const existingOrder = await knex('funnel_orders')
        .where('session_id', session.id)
        .where('step_id', step.id)
        .where('status', 'succeeded')
        .first()
      if (existingOrder) {
        const advanceStep = step.on_accept_step_id
          ? await knex('funnel_steps').where('id', step.on_accept_step_id).first()
          : await knex('funnel_steps').where('funnel_id', funnel.id).where('step_order', '>', step.step_order).orderBy('step_order').first()
        const redirectUrl = advanceStep
          ? `${baseUrl}/api/landing_pages/funnels/public/${slug}?step=${advanceStep.id}&sid=${session.id}`
          : `${baseUrl}/api/landing_pages/funnels/public/${slug}?step=thank_you&sid=${session.id}`
        return NextResponse.json({ ok: true, redirectUrl, alreadyCharged: true })
      }

      const product = step.product_id ? await knex('products').where('id', step.product_id).first() : null
      const config = typeof step.config === 'string' ? JSON.parse(step.config) : (step.config || {})
      const amount = product ? Math.round(Number(product.price) * 100) : Math.round(Number(config.price || 0) * 100)
      const currency = (product?.currency || 'usd').toLowerCase()

      if (amount <= 0) {
        return NextResponse.json({ ok: false, error: 'Invalid product price' }, { status: 400 })
      }

      const stripeConnection = await knex('stripe_connections')
        .where('organization_id', funnel.organization_id)
        .where('is_active', true)
        .first()

      if (!stripeConnection?.stripe_account_id || !process.env.STRIPE_SECRET_KEY) {
        return NextResponse.json({ ok: false, error: 'Payment processing not configured' }, { status: 400 })
      }

      const Stripe = (await import('stripe')).default
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-12-18.acacia' as any })

      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount,
          currency,
          customer: session.stripe_customer_id,
          payment_method: session.stripe_payment_method_id,
          off_session: true,
          confirm: true,
          metadata: {
            type: 'funnel_upsell',
            funnelId: funnel.id,
            stepId: step.id,
            sessionId: session.id,
            orgId: funnel.organization_id,
          },
        }, {
          stripeAccount: stripeConnection.stripe_account_id,
          // Stripe-side dedup: identical retries within 24h return the same
          // PaymentIntent instead of creating a second charge.
          idempotencyKey: `funnel_upsell_${session.id}_${step.id}`,
        })

        if (paymentIntent.status === 'succeeded') {
          // Create order record
          await knex('funnel_orders').insert({
            id: crypto.randomUUID(),
            session_id: session.id, funnel_id: funnel.id, step_id: step.id,
            product_id: step.product_id || null,
            amount: amount / 100, currency: currency.toUpperCase(),
            order_type: step.step_type, // 'upsell' or 'downsell'
            stripe_payment_intent_id: paymentIntent.id,
            status: 'succeeded', created_at: new Date(),
          })

          // Update session revenue
          await knex('funnel_sessions').where('id', session.id).update({
            total_revenue: knex.raw('total_revenue + ?', [amount / 100]),
            updated_at: new Date(),
          })
        }
      } catch (stripeError: any) {
        // Payment failed — treat as decline and redirect to decline path
        console.error('[funnel.upsell] Payment failed:', stripeError.message)

        await knex('funnel_orders').insert({
          id: crypto.randomUUID(),
          session_id: session.id, funnel_id: funnel.id, step_id: step.id,
          product_id: step.product_id || null,
          amount: amount / 100, currency: currency.toUpperCase(),
          order_type: step.step_type,
          status: 'failed', created_at: new Date(),
        })

        // Fall through to decline path
        const declineStep = step.on_decline_step_id
          ? await knex('funnel_steps').where('id', step.on_decline_step_id).first()
          : await knex('funnel_steps').where('funnel_id', funnel.id).where('step_order', '>', step.step_order).orderBy('step_order').first()

        const redirectUrl = declineStep
          ? `${baseUrl}/api/landing_pages/funnels/public/${slug}?step=${declineStep.id}&sid=${session.id}`
          : `${baseUrl}/api/landing_pages/funnels/public/${slug}?step=thank_you&sid=${session.id}`

        return NextResponse.json({ ok: false, error: 'Payment failed — card was declined', redirectUrl })
      }
    }

    // Determine next step based on action and branching
    let nextStep
    if (action === 'accept' && step.on_accept_step_id) {
      nextStep = await knex('funnel_steps').where('id', step.on_accept_step_id).first()
    } else if (action === 'decline' && step.on_decline_step_id) {
      nextStep = await knex('funnel_steps').where('id', step.on_decline_step_id).first()
    }

    // Fallback: next step by order
    if (!nextStep) {
      nextStep = await knex('funnel_steps')
        .where('funnel_id', funnel.id)
        .where('step_order', '>', step.step_order)
        .orderBy('step_order')
        .first()
    }

    // Update session
    if (nextStep) {
      await knex('funnel_sessions').where('id', session.id).update({ current_step_id: nextStep.id, updated_at: new Date() })
    }

    const redirectUrl = nextStep
      ? `${baseUrl}/api/landing_pages/funnels/public/${slug}?step=${nextStep.id}&sid=${session.id}`
      : `${baseUrl}/api/landing_pages/funnels/public/${slug}?step=thank_you&sid=${session.id}`

    return NextResponse.json({ ok: true, redirectUrl })
  } catch (error) {
    console.error('[funnel.upsell]', error)
    const message = error instanceof Error ? error.message : 'Failed'
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
