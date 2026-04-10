export const metadata = { POST: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const stripeKey = process.env.STRIPE_SECRET_KEY
  if (!stripeKey) return NextResponse.json({ ok: false, error: 'Stripe not configured' }, { status: 500 })

  try {
    const Stripe = (await import('stripe')).default
    const stripe = new Stripe(stripeKey)

    const body = await req.json()
    const { paymentRecordId, amount, reason } = body as {
      paymentRecordId: string
      amount?: number
      reason?: 'requested_by_customer' | 'duplicate' | 'fraudulent'
    }

    if (!paymentRecordId) {
      return NextResponse.json({ ok: false, error: 'paymentRecordId is required' }, { status: 400 })
    }

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // Look up the payment record
    const paymentRecord = await knex('payment_records')
      .where('id', paymentRecordId)
      .where('organization_id', auth.orgId)
      .first()

    if (!paymentRecord) {
      return NextResponse.json({ ok: false, error: 'Payment record not found' }, { status: 404 })
    }

    if (paymentRecord.status === 'refunded') {
      return NextResponse.json({ ok: false, error: 'This payment has already been fully refunded' }, { status: 400 })
    }

    // Look up the org's Stripe connected account
    const connection = await knex('stripe_connections')
      .where('organization_id', auth.orgId)
      .where('is_active', true)
      .first()

    const stripeAccount = connection?.stripe_account_id || undefined

    // Resolve the payment intent ID
    let paymentIntentId = paymentRecord.stripe_payment_intent_id

    if (!paymentIntentId && paymentRecord.stripe_checkout_session_id) {
      const sessionId = paymentRecord.stripe_checkout_session_id
      if (sessionId.startsWith('cs_')) {
        const retrieveOpts = stripeAccount ? { stripeAccount } : {}
        const session = await stripe.checkout.sessions.retrieve(sessionId, {}, retrieveOpts)
        paymentIntentId = (session.payment_intent as string) || null
      }
    }

    if (!paymentIntentId) {
      return NextResponse.json({ ok: false, error: 'No payment intent found for this payment' }, { status: 400 })
    }

    // Validate refund amount
    const originalAmount = Number(paymentRecord.amount)
    const previouslyRefunded = Number(paymentRecord.refunded_amount || 0)
    const maxRefundable = originalAmount - previouslyRefunded

    if (amount !== undefined && amount !== null && amount > maxRefundable) {
      return NextResponse.json({ ok: false, error: `Maximum refundable amount is $${maxRefundable.toFixed(2)}` }, { status: 400 })
    }

    // Build refund params
    const refundParams: Record<string, any> = { payment_intent: paymentIntentId }
    if (amount !== undefined && amount !== null) {
      refundParams.amount = Math.round(amount * 100)
    }
    if (reason) {
      refundParams.reason = reason
    }

    // Create the refund via Stripe
    const createOpts = stripeAccount ? { stripeAccount } : {}
    const refund = await stripe.refunds.create(refundParams, createOpts)

    // Determine new status
    const thisRefundAmount = amount || maxRefundable
    const totalRefunded = previouslyRefunded + thisRefundAmount
    const isFullRefund = totalRefunded >= originalAmount
    const newStatus = isFullRefund ? 'refunded' : 'partially_refunded'

    // Parse existing metadata
    let existingMetadata: Record<string, any> = {}
    try {
      existingMetadata = typeof paymentRecord.metadata === 'string'
        ? JSON.parse(paymentRecord.metadata)
        : (paymentRecord.metadata || {})
    } catch {
      existingMetadata = {}
    }

    // Update payment record
    await knex('payment_records')
      .where('id', paymentRecordId)
      .where('organization_id', auth.orgId)
      .update({
        status: newStatus,
        refunded_amount: totalRefunded,
        metadata: JSON.stringify({
          ...existingMetadata,
          refund_id: refund.id,
          last_refund_amount: thisRefundAmount,
          total_refunded: totalRefunded,
          refunded_at: new Date().toISOString(),
        }),
      })

    // Log to contact timeline if contact_id exists
    if (paymentRecord.contact_id) {
      const { logTimelineEvent } = await import('@/lib/timeline')
      await logTimelineEvent(knex, {
        tenantId: paymentRecord.tenant_id,
        organizationId: auth.orgId,
        contactId: paymentRecord.contact_id,
        eventType: 'refund',
        title: isFullRefund ? 'Payment refunded' : 'Partial refund issued',
        description: `$${thisRefundAmount.toFixed(2)} ${(paymentRecord.currency || 'USD').toUpperCase()} refunded`,
        metadata: {
          refundId: refund.id,
          amount: thisRefundAmount,
          currency: paymentRecord.currency,
          reason: reason || null,
          isFullRefund,
        },
      })
    }

    return NextResponse.json({
      ok: true,
      data: {
        refundId: refund.id,
        amount: thisRefundAmount,
        totalRefunded,
        status: newStatus,
      },
    })
  } catch (error) {
    console.error('[stripe.refund]', error)
    const message = error instanceof Error ? error.message : 'Refund failed'
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
