
import { NextResponse } from 'next/server'
import { createPersonContact } from '@/modules/customers/lib/contact-write'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { sendEmailByPurpose } from '@/modules/email/lib/email-router'
import { findOrMergeContact } from '@/modules/customers/lib/dedup'
import {
  claimLandingPageCheckout,
  completeLandingPageCheckout,
  releaseLandingPageCheckout,
} from '../../../services/public-checkout'
import { insertContactNote } from '../../../../customers/lib/contact-notes'
import { paidEnrollmentRow, sendEnrollmentEmailOnce } from '../../../../courses/lib/enrollment-email'

export const metadata = { POST: { requireAuth: false } }

/** "Course Enrolled" automations and sequences for a paid enrollment, once per
 *  enrollment. Never throws: a recorded payment must not be retried by Stripe
 *  because an automation failed. */
async function dispatchCourseEnrolledSafely(
  knex: ReturnType<EntityManager['getKnex']>,
  input: {
    organizationId: string
    tenantId: string
    enrollmentId: string
    courseId: string
    contactId: string | null
    courseTitle: string | null
    paid: boolean
  },
): Promise<void> {
  try {
    const { dispatchCourseEnrolled } = await import('@/modules/sequences/lib/automation-dispatch')
    await dispatchCourseEnrolled(knex, input)
  } catch (err) {
    console.error('[stripe.webhook] course_enrolled automations failed (non-fatal):', err)
  }
}

export async function POST(req: Request) {
  const stripeKey = process.env.STRIPE_SECRET_KEY
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
  if (!stripeKey) return NextResponse.json({ error: 'Not configured' }, { status: 500 })

  // A landing-page checkout this delivery claimed; handed back if it fails so
  // Stripe's retry can process it.
  let releaseLandingClaim: (() => Promise<void>) | null = null

  try {
    const Stripe = (await import('stripe')).default
    const stripe = new Stripe(stripeKey)
    const body = await req.text()

    // Fail closed: never trust an unsigned body. Without the secret we can't
    // verify Stripe sent this, so refuse rather than JSON.parse it — a forged
    // event here would fabricate payments, paid invoices, and affiliate credit.
    if (!webhookSecret) {
      console.error('[stripe.webhook] STRIPE_WEBHOOK_SECRET not set — refusing to process')
      return NextResponse.json({ error: 'Not configured' }, { status: 500 })
    }
    const sig = req.headers.get('stripe-signature') || ''
    const event: any = stripe.webhooks.constructEvent(body, sig, webhookSecret)

    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()

    // For Connect webhooks, the event includes an `account` field
    // identifying which connected account the event belongs to
    const connectedAccountId = event.account || null

    // Resolve the org context — either from metadata or from connected account lookup
    let orgId: string | null = null
    let tenantId: string | null = null

    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data.object
      const meta = session.metadata || {}

      // Delayed-notification methods (ACH debit, Klarna, Cash App) complete
      // the session before any money moves and report the real outcome later
      // via async_payment_succeeded / async_payment_failed. Treating an
      // unpaid session as paid marked invoices paid, moved deals to Won and
      // credited affiliates on money that had not arrived.
      const paymentStatus = typeof session.payment_status === 'string' ? session.payment_status : 'paid'
      if (paymentStatus !== 'paid' && paymentStatus !== 'no_payment_required') {
        return NextResponse.json({ received: true, deferred: paymentStatus })
      }

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

      // Public checkouts (offers and CRM landing pages, services/public-checkout.ts):
      // the session must be one a published page started, the event must come
      // from the business account it was created on, and exactly one delivery
      // claims it. The org comes from our own row, never from metadata alone.
      let landingCheckoutId: string | null = null
      if (meta.landingPageCheckoutId) {
        const verdict = await claimLandingPageCheckout(knex, {
          checkoutId: meta.landingPageCheckoutId,
          sessionId: session.id,
          connectedAccountId,
          metaOrgId: meta.orgId || null,
        })
        if (verdict.kind === 'reject') {
          console.warn('[stripe.webhook] landing-page checkout ignored:', verdict.reason, event.id)
          return NextResponse.json({ received: true, ignored: true })
        }
        if (verdict.kind === 'duplicate') return NextResponse.json({ received: true, duplicate: true })
        if (verdict.kind === 'busy') {
          // Another delivery is recording it right now; a non-2xx makes Stripe retry later.
          return NextResponse.json({ received: false, retry: true }, { status: 409 })
        }
        landingCheckoutId = String(verdict.row.id)
        orgId = String(verdict.row.organization_id)
        tenantId = String(verdict.row.tenant_id)
        const claimedId = landingCheckoutId
        releaseLandingClaim = () => releaseLandingPageCheckout(knex, claimedId)
      }

      if (!orgId || !tenantId) {
        console.warn('[stripe.webhook] Could not resolve org for event', event.id)
        return NextResponse.json({ received: true })
      }

      // Resolve customer email — Stripe puts it in different places
      const customerEmail = session.customer_email || session.customer_details?.email || null

      // Idempotency: if we already recorded this checkout session, this is a
      // replay/redelivery — skip the whole handler (avoids double payments,
      // double affiliate commission, duplicate enrollments).
      const alreadyProcessed = await knex('payment_records')
        .where('stripe_checkout_session_id', session.id)
        .where('organization_id', orgId)
        .first()
      if (alreadyProcessed) {
        if (landingCheckoutId) {
          await completeLandingPageCheckout(knex, landingCheckoutId, {
            paymentRecordId: alreadyProcessed.id ?? null,
            contactId: alreadyProcessed.contact_id ?? null,
          })
          releaseLandingClaim = null
        }
        return NextResponse.json({ received: true, duplicate: true })
      }

      // Record the payment
      const paymentRecordId = require('crypto').randomUUID()
      await knex('payment_records').insert({
        id: paymentRecordId,
        tenant_id: tenantId,
        organization_id: orgId,
        invoice_id: meta.invoiceId || null,
        amount: (session.amount_total || 0) / 100,
        currency: session.currency || 'usd',
        status: 'succeeded',
        stripe_checkout_session_id: session.id,
        stripe_payment_intent_id: session.payment_intent,
        stripe_subscription_id: session.subscription || null,
        metadata: JSON.stringify({
          customerEmail,
          customerName: session.customer_details?.name || null,
          customerPhone: session.customer_details?.phone || null,
          shippingName: session.shipping_details?.name || null,
          shippingAddress: session.shipping_details?.address || null,
          shippingPhone: session.customer_details?.phone || null,
          type: meta.type,
          connectedAccount: connectedAccountId,
        }),
        created_at: new Date(),
      }).catch((e) => {
        // Do NOT swallow. A lost payment_records insert means the payment
        // disappears from the CRM while Stripe sees a 2xx and never retries.
        // Rethrow so the outer handler returns 400 and Stripe redelivers.
        console.error('[stripe.webhook] payment record failed:', e)
        throw e
      })

      // Update invoice status if applicable
      if (meta.invoiceId) {
        const paidAt = new Date()
        // Only an unpaid invoice flips (and announces itself) once.
        const flipped = await knex('invoices').where('id', meta.invoiceId).whereNot('status', 'paid').update({
          status: 'paid',
          paid_at: paidAt,
          updated_at: paidAt,
        }).catch(() => 0)
        if (flipped) {
          const paidInvoice = await knex('invoices').where('id', meta.invoiceId).first('id', 'organization_id', 'tenant_id', 'contact_id').catch(() => null)
          if (paidInvoice?.organization_id && paidInvoice?.tenant_id) {
            const { emitInvoicePaid } = await import('@/lib/crm-business-events')
            await emitInvoicePaid(container.resolve('eventBus') as Parameters<typeof emitInvoicePaid>[0], {
              id: String(paidInvoice.id),
              organizationId: String(paidInvoice.organization_id),
              tenantId: String(paidInvoice.tenant_id),
              paidAt: paidAt.toISOString(),
              contactId: paidInvoice.contact_id ?? null,
            })
          }
        }
      }

      // Auto-create contact from customer email and link to payment record
      let resolvedContactId: string | null = null
      if (customerEmail && orgId) {
        // primary_email is encrypted at rest for ORM-written contacts, so a
        // plaintext WHERE could never match them: every checkout by such a
        // customer fell through to the insert below and created a DUPLICATE
        // contact — storing the address as plaintext, since a raw knex insert
        // also skips the encrypting subscriber. findOrMergeContact does the
        // plaintext match first and then decrypt-matches candidates.
        const dedup = await findOrMergeContact(
          knex, orgId, tenantId as string, customerEmail,
          session.customer_details?.name || undefined, undefined, em,
        )
        let contactEntity: { id: string } | null = dedup.existing

        if (!contactEntity) {
          const stripeName = session.customer_details?.name || customerEmail
          const newId = await createPersonContact(em, {
            organizationId: orgId, tenantId: tenantId as string,
            displayName: stripeName, primaryEmail: customerEmail, source: 'stripe', lifecycleStage: 'customer',
          }).catch(() => null)
          contactEntity = newId ? { id: newId } : null
        }

        // Link the payment record to the contact
        if (contactEntity?.id) {
          resolvedContactId = contactEntity.id
          await knex('payment_records')
            .where('stripe_checkout_session_id', session.id)
            .where('organization_id', orgId)
            .whereNull('contact_id')
            .update({ contact_id: contactEntity.id })
            .catch(() => {})

          // Log payment to timeline
          const { logTimelineEvent } = await import('@/lib/timeline')
          await logTimelineEvent(knex, {
            tenantId, organizationId: orgId, contactId: contactEntity.id,
            eventType: 'payment', title: `Payment received`,
            description: `$${((session.amount_total || 0) / 100).toFixed(2)} ${session.currency?.toUpperCase() || 'USD'}`,
            metadata: { amount: (session.amount_total || 0) / 100, currency: session.currency, type: meta.type },
          })

          // Auto-add to email lists with source_type 'product_purchased'
          try {
            const autoLists = await knex('email_lists')
              .where('organization_id', orgId)
              .where('source_type', 'product_purchased')
            for (const list of autoLists) {
              const desc = list.description || ''
              const triggerMatch = desc.match(/\[auto_trigger:(.+?)\]/)
              if (triggerMatch) {
                try {
                  const targetIds = JSON.parse(triggerMatch[1])
                  if (Array.isArray(targetIds) && targetIds.length > 0 && !targetIds.includes(meta.productId)) continue
                } catch {}
              }
              await knex.raw('INSERT INTO email_list_members (id, list_id, contact_id, added_at, tenant_id, organization_id) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (list_id, contact_id) DO NOTHING',
                [require('crypto').randomUUID(), list.id, contactEntity.id, new Date(), list.tenant_id, list.organization_id])
              const [{ count }] = await knex('email_list_members').where('list_id', list.id).count()
              await knex('email_lists').where('id', list.id).update({ member_count: Number(count), updated_at: new Date() })
            }
          } catch {}
        }
      }

      // SPEC-064 money wire: emit the payment-captured event from the LIVE
      // Stripe path. The pipeline-automation trigger ("Payment received" →
      // e.g. move deal to Won) and the payment notification both subscribe to
      // this event but historically only the idle legacy payment_gateways
      // module emitted it — so real payments never fired them. Payload is
      // payload-first (amount/contactId inline) with the legacy transactionId
      // key kept for consumer compatibility. Non-fatal: a bus failure must
      // never make Stripe retry a recorded payment.
      try {
        const bus = container.resolve('eventBus') as { emitEvent?: (name: string, payload: unknown) => Promise<void> }
        if (bus?.emitEvent) {
          await bus.emitEvent('payment_gateways.payment.captured', {
            transactionId: paymentRecordId,
            paymentRecordId,
            providerKey: 'stripe',
            invoiceId: meta.invoiceId || null,
            contactId: resolvedContactId,
            amount: (session.amount_total || 0) / 100,
            currency: session.currency || 'usd',
            organizationId: orgId,
            tenantId,
          })
        }
      } catch (busErr) {
        console.error('[stripe.webhook] payment.captured emit failed (non-fatal):', busErr)
      }

      // Auto-send payment receipt email
      if (session.customer_email && meta.invoiceId) {
        try {
          const invoice = await knex('invoices').where('id', meta.invoiceId).first()
          if (invoice) {
            const amount = ((session.amount_total || 0) / 100).toFixed(2)
            const currency = (session.currency || 'USD').toUpperCase()
            const receiptHtml = `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#1a1a1a">
              <div style="text-align:center;margin-bottom:24px">
                <div style="display:inline-block;background:#10B981;color:white;padding:8px 16px;border-radius:9999px;font-size:14px;font-weight:600">Payment Received</div>
              </div>
              <h2 style="margin-bottom:4px">Receipt for ${invoice.invoice_number}</h2>
              <p style="color:#666;margin-bottom:24px">We received your payment of <strong>$${amount} ${currency}</strong> on ${new Date().toLocaleDateString()}.</p>
              <div style="background:#f9fafb;border-radius:8px;padding:16px;margin-bottom:24px">
                <p style="margin:0;font-size:14px"><strong>Invoice:</strong> ${invoice.invoice_number}</p>
                <p style="margin:8px 0 0;font-size:14px"><strong>Amount Paid:</strong> $${amount} ${currency}</p>
                <p style="margin:8px 0 0;font-size:14px"><strong>Date:</strong> ${new Date().toLocaleDateString()}</p>
                <p style="margin:8px 0 0;font-size:14px"><strong>Status:</strong> Paid</p>
              </div>
              <p style="color:#888;font-size:13px">Thank you for your payment. Please keep this email as your receipt.</p>
            </body></html>`

            // Send receipt email via email router
            try {
              const emailResult = await sendEmailByPurpose(knex, orgId!, tenantId!, 'invoices', {
                to: session.customer_email,
                subject: `Payment Receipt — ${invoice.invoice_number} ($${amount})`,
                htmlBody: receiptHtml,
                contactId: invoice.contact_id || undefined,
              })
              if (!emailResult.ok) {
                console.warn('[stripe.webhook] Auto-receipt email failed:', emailResult.error)
              }
            } catch (emailErr) {
              console.warn('[stripe.webhook] Auto-receipt email failed:', emailErr)
            }
          }
        } catch (receiptErr) {
          console.warn('[stripe.webhook] Receipt generation failed:', receiptErr)
        }
      }

      // ── Affiliate attribution ──
      // Check session metadata for affiliate_id, or check if a promo code was used
      const affiliateId = meta.affiliate_id || null
      let attributedAffiliateId: string | null = affiliateId

      // If no explicit affiliate_id in metadata, check if a promotion code was used
      if (!attributedAffiliateId && session.total_details?.breakdown?.discounts?.length) {
        for (const disc of session.total_details.breakdown.discounts) {
          const promoCodeId = disc.discount?.promotion_code
          if (promoCodeId) {
            // Look up the promo code in our affiliates table
            const affByPromo = await knex('affiliates')
              .where('stripe_promo_code_id', promoCodeId)
              .where('organization_id', orgId)
              .where('status', 'active')
              .first()
            if (affByPromo) {
              attributedAffiliateId = affByPromo.id
              break
            }
          }
        }
      }

      if (attributedAffiliateId && orgId) {
        try {
          // Idempotency: skip if this Stripe session was already attributed (a
          // replayed/redelivered event) so commission isn't double-credited.
          const existingReferral = await knex('affiliate_referrals')
            .where('stripe_session_id', session.id)
            .first()
          const affiliate = existingReferral
            ? null
            : await knex('affiliates').where('id', attributedAffiliateId).where('organization_id', orgId).first()
          if (affiliate) {
            const saleAmount = (session.amount_total || 0) / 100
            // Tier-aware commission: if the affiliate's campaign defines tiers,
            // the highest tier whose minConversions <= total_conversions BEFORE
            // this conversion wins; otherwise the affiliate's own rate applies.
            const { computeCommission } = await import('@/modules/customers/api/affiliates/commission')
            const affCampaign = affiliate.campaign_id
              ? await knex('affiliate_campaigns').where('id', affiliate.campaign_id).first().catch(() => null)
              : null
            const commission = computeCommission(saleAmount, affiliate, affCampaign).amount

            // Create referral record
            await knex('affiliate_referrals').insert({
              id: require('crypto').randomUUID(),
              affiliate_id: attributedAffiliateId,
              referred_contact_id: null,
              referred_email: customerEmail,
              referral_source: affiliateId ? 'link' : 'promo_code',
              converted: true,
              conversion_value: saleAmount,
              commission_amount: commission,
              campaign_id: affiliate.campaign_id || null,
              stripe_session_id: session.id,
              stripe_payment_intent_id: session.payment_intent || null,
              referred_at: new Date(),
              converted_at: new Date(),
            }).catch(e => console.error('[stripe.webhook] affiliate referral insert failed:', e))

            // Update affiliate stats
            await knex('affiliates').where('id', attributedAffiliateId).where('organization_id', orgId).update({
              total_conversions: knex.raw('total_conversions + 1'),
              total_earned: knex.raw('total_earned + ?', [commission]),
              updated_at: new Date(),
            }).catch(e => console.error('[stripe.webhook] affiliate stats update failed:', e))

            console.log(`[stripe.webhook] Affiliate attribution: ${affiliate.name} earned $${commission.toFixed(2)} from $${saleAmount.toFixed(2)} sale`)
          }
        } catch (affErr) {
          console.error('[stripe.webhook] affiliate attribution failed:', affErr)
        }
      }
      // Clawback note: an event-driven path would handle `charge.refunded` here
      // by resolving charge.payment_intent -> affiliate_referrals.stripe_payment_intent_id
      // and un-converting the matched referral. This endpoint currently only
      // receives checkout.session.completed, and refund events are not routed
      // to it, so clawbacks are handled manually via the per-referral "Reverse"
      // action (PATCH /api/affiliates/[id] with { referralId, action: 'reverse' }).

      // ── Course enrollment on payment ──
      // Runs after the payment is recorded above (payment_records, unique per
      // checkout session), so a redelivered event never reaches this block.
      if (meta.type === 'course' && meta.courseId && meta.studentEmail) {
        try {
          const courseId = meta.courseId
          const studentName = meta.studentName || meta.studentEmail
          const studentEmail = meta.studentEmail.trim().toLowerCase()
          const courseTenantId = String(tenantId || meta.tenantId)
          const courseOrgId = String(orgId || meta.orgId)

          // The course must be this organization's own.
          const paidCourse = await knex('courses')
            .where('id', courseId)
            .where('tenant_id', courseTenantId)
            .where('organization_id', courseOrgId)
            .first('id', 'title')

          // Check not already enrolled
          const existingEnrollment = paidCourse ? await knex('course_enrollments')
            .where('tenant_id', courseTenantId)
            .where('organization_id', courseOrgId)
            .where('course_id', courseId)
            .where('student_email', studentEmail)
            .where('status', 'active')
            .first() : null

          if (!paidCourse) {
            console.error(`[stripe.webhook] course enrollment skipped: course ${courseId} not found in org ${courseOrgId}`)
          } else if (!existingEnrollment) {
            const enrollmentId = require('crypto').randomUUID()
            await knex('course_enrollments').insert(paidEnrollmentRow({
              enrollmentId,
              tenantId: courseTenantId,
              organizationId: courseOrgId,
              courseId,
              studentName,
              studentEmail,
              paymentRecordId,
            }))

            // Create/link CRM contact with Student tag
            let contactId: string | null = null
            const existingContact = (await findOrMergeContact(knex, orgId || meta.orgId, tenantId || meta.tenantId, studentEmail, studentName, undefined, em)).existing

            if (existingContact) {
              contactId = existingContact.id
            } else {
              contactId = await createPersonContact(em, {
                organizationId: orgId || meta.orgId, tenantId: tenantId || meta.tenantId,
                displayName: studentName, primaryEmail: studentEmail, source: 'course', lifecycleStage: 'customer',
              }).catch(() => null)
            }

            if (contactId) {
              await knex('course_enrollments').where('id', enrollmentId).update({ contact_id: contactId }).catch(() => {})

              // Add Student tag
              try {
                let tag = await knex('customer_tags').where('label', 'Student').where('organization_id', orgId || meta.orgId).first()
                if (!tag) {
                  const tagId = require('crypto').randomUUID()
                  await knex('customer_tags').insert({ id: tagId, tenant_id: tenantId || meta.tenantId, organization_id: orgId || meta.orgId, label: 'Student', slug: 'student', created_at: new Date(), updated_at: new Date() })
                  tag = { id: tagId }
                }
                const tagLink = await knex('customer_entity_tags').where('entity_id', contactId).where('tag_id', tag.id).first()
                if (!tagLink) await knex('customer_entity_tags').insert({ id: require('crypto').randomUUID(), entity_id: contactId, tag_id: tag.id, created_at: new Date() })
              } catch { /* non-critical */ }
            }

            // The same "You're enrolled!" email free students get, once per
            // enrollment (course_enrollments.welcome_email_sent_at).
            const emailResult = await sendEnrollmentEmailOnce(knex, {
              enrollmentId,
              tenantId: courseTenantId,
              organizationId: courseOrgId,
              studentEmail,
              courseTitle: String(paidCourse.title || 'your course'),
              contactId,
            }, { send: sendEmailByPurpose }).catch((err: unknown) => ({ sent: false as const, reason: 'send_failed' as const, error: err instanceof Error ? err.message : String(err) }))
            if (!emailResult.sent && emailResult.reason !== 'already_sent') {
              console.warn('[stripe.webhook] course enrollment email not sent:', emailResult.reason, emailResult.error || '')
            }

            await dispatchCourseEnrolledSafely(knex, {
              organizationId: courseOrgId,
              tenantId: courseTenantId,
              enrollmentId,
              courseId,
              contactId,
              courseTitle: paidCourse.title ?? null,
              paid: true,
            })

            console.log(`[stripe.webhook] Course enrollment: ${studentName} enrolled in course ${courseId} via payment`)
          }
        } catch (courseErr) {
          console.error('[stripe.webhook] course enrollment failed:', courseErr)
        }
      }

      // ── Event registration on payment ──
      if (meta.type === 'event' && meta.eventId && meta.attendeeEmail) {
        try {
          const eventId = meta.eventId
          const attendeeName = meta.attendeeName || meta.attendeeEmail
          const attendeeEmail = meta.attendeeEmail.toLowerCase()
          const ticketQty = parseInt(meta.ticketQuantity) || 1

          // Registrations are encrypted and matched on the keyed email hash (M11).
          const { attendeeEmailHashes, encryptAttendeeRow, whereAttendeeEmail } = await import('../../../../customers/lib/event-attendees')
          const attTenantId = String(meta.tenantId || tenantId)
          const attOrgId = String(meta.orgId || orgId)
          const existingAtt = await whereAttendeeEmail(knex('event_attendees').where('event_id', eventId), attendeeEmail, await attendeeEmailHashes(attendeeEmail, attTenantId)).where('status', 'registered').first()
          if (!existingAtt) {
            const attendeeId = require('crypto').randomUUID()
            await knex('event_attendees').insert(await encryptAttendeeRow({
              id: attendeeId, tenant_id: attTenantId, organization_id: attOrgId,
              event_id: eventId, attendee_name: attendeeName, attendee_email: attendeeEmail,
              status: 'registered', ticket_quantity: ticketQty,
              guest_details: meta.guestDetails || null,
              registration_data: meta.registrationData || '{}',
              accepted_terms: meta.acceptedTerms === 'true',
              payment_id: session.payment_intent?.toString() || session.id,
              registered_at: new Date(), created_at: new Date(),
            }, attTenantId, attOrgId))
            await knex('events').where('id', eventId).increment('attendee_count', ticketQty)

            // Create CRM contact
            let contactId: string | null = null
            const existingContact = (await findOrMergeContact(knex, meta.orgId || orgId, meta.tenantId || tenantId, attendeeEmail, attendeeName, undefined, em)).existing
            if (existingContact) { contactId = existingContact.id }
            else {
              contactId = await createPersonContact(em, {
                organizationId: meta.orgId || orgId, tenantId: meta.tenantId || tenantId,
                displayName: attendeeName, primaryEmail: attendeeEmail, source: 'event', lifecycleStage: 'customer',
              }).catch(() => null)
            }
            // Look up the event BEFORE its first use below (event?.title) — it was
            // declared later, a TDZ ReferenceError masked by ignoreBuildErrors.
            const event = await knex('events').where('id', eventId).first()
            if (contactId) {
              await knex('event_attendees').where('id', attendeeId).update({ contact_id: contactId }).catch(() => {})
              await insertContactNote(knex, em, {
                contactId, organizationId: meta.orgId || orgId, tenantId: meta.tenantId || tenantId,
                content: `Registered for event: ${event?.title || 'Unknown'} (paid)`,
              }).catch(() => {})
            }

            // Send confirmation email
            if (event) {
              const eventDate = new Date(event.start_time).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
              const eventTime = new Date(event.start_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
              const location = event.event_type === 'virtual' ? (event.virtual_link || 'Virtual') : (event.location_name || 'TBD')
              const emailHtml = `<div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:32px"><h2 style="font-size:20px;margin:0 0 8px">You're in, ${attendeeName.split(' ')[0]}!</h2><p style="color:#475569;font-size:15px;line-height:1.6;margin-bottom:20px">Your payment is confirmed. You're registered for <strong>${event.title}</strong>.</p><div style="background:#f8fafc;border-radius:8px;padding:16px;margin-bottom:20px"><p style="margin:0 0 6px;font-size:14px"><strong>Date:</strong> ${eventDate}</p><p style="margin:0 0 6px;font-size:14px"><strong>Time:</strong> ${eventTime}</p><p style="margin:0;font-size:14px"><strong>Location:</strong> ${location}</p></div><p style="color:#94a3b8;font-size:12px">See you there!</p></div>`
              // Send through the org's own routing (this used to only write a
              // 'queued' row that nothing ever sent), and record what happened.
              const subject = `You're registered: ${event.title}`
              const sendResult = await sendEmailByPurpose(knex, meta.orgId || orgId!, meta.tenantId || tenantId!, 'transactional', {
                to: attendeeEmail, subject, htmlBody: emailHtml, contactId: contactId || undefined,
              }).catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : 'Send failed', fromAddress: undefined }))
              await knex('email_messages').insert({
                id: require('crypto').randomUUID(), tenant_id: meta.tenantId || tenantId, organization_id: meta.orgId || orgId,
                direction: 'outbound', from_address: sendResult.fromAddress || '',
                to_address: attendeeEmail, subject, body_html: emailHtml,
                contact_id: contactId, status: sendResult.ok ? 'sent' : 'failed',
                ...(sendResult.ok ? { sent_at: new Date() } : { metadata: JSON.stringify({ error: sendResult.error || 'Send failed' }) }),
                tracking_id: require('crypto').randomUUID(), created_at: new Date(),
              }).catch(() => {})
            }
            console.log(`[stripe.webhook] Event registration: ${attendeeName} registered for event ${eventId} via payment`)
          }
        } catch (eventErr) {
          console.error('[stripe.webhook] event registration failed:', eventErr)
        }
      }

      // ── Funnel checkout completion ──
      if (meta.type === 'funnel' && meta.sessionId) {
        try {
          const funnelSession = await knex('funnel_sessions').where('id', meta.sessionId).first()
          if (funnelSession) {
            // Get payment intent to extract saved payment method
            let stripeCustomerId = session.customer?.toString() || null
            let paymentMethodId = null
            if (session.payment_intent) {
              try {
                const stripeKey = process.env.STRIPE_SECRET_KEY
                if (stripeKey) {
                  const Stripe = (await import('stripe')).default
                  const stripe = new Stripe(stripeKey, { apiVersion: '2024-12-18.acacia' as any })
                  const pi = connectedAccountId
                    ? await stripe.paymentIntents.retrieve(session.payment_intent.toString(), { stripeAccount: connectedAccountId })
                    : await stripe.paymentIntents.retrieve(session.payment_intent.toString())
                  paymentMethodId = pi.payment_method?.toString() || null
                  if (!stripeCustomerId) stripeCustomerId = pi.customer?.toString() || null
                }
              } catch {}
            }

            // Update funnel session with Stripe info for one-click upsells
            const sessionUpdates: Record<string, any> = { updated_at: new Date() }
            if (stripeCustomerId) sessionUpdates.stripe_customer_id = stripeCustomerId
            if (paymentMethodId) sessionUpdates.stripe_payment_method_id = paymentMethodId
            if (meta.customerEmail) sessionUpdates.email = meta.customerEmail
            const checkoutAmount = (session.amount_total || 0) / 100
            sessionUpdates.total_revenue = knex.raw('total_revenue + ?', [checkoutAmount])
            await knex('funnel_sessions').where('id', meta.sessionId).update(sessionUpdates)

            // Update funnel_orders status
            if (session.id) {
              await knex('funnel_orders')
                .where('stripe_checkout_session_id', session.id)
                .where('status', 'pending')
                .update({ status: 'succeeded' })
            }

            // Create contact if not exists. `contactId` is declared OUTSIDE the
            // funnelEmail block — it's used later (confirmation email, automation
            // rules, course enrollment), which was a runtime ReferenceError when
            // declared inside the block (masked by ignoreBuildErrors).
            let contactId: string | null = funnelSession.contact_id ?? null
            const funnelEmail = meta.customerEmail || session.customer_email
            if (funnelEmail) {
              if (!contactId) {
                const contactName = meta.customerName || funnelEmail.split('@')[0]
                const existing = (await findOrMergeContact(knex, meta.orgId || orgId, meta.tenantId || tenantId, funnelEmail.toLowerCase(), contactName, undefined, em)).existing
                if (existing) {
                  contactId = existing.id
                } else {
                  contactId = await createPersonContact(em, {
                    organizationId: meta.orgId || orgId, tenantId: meta.tenantId || tenantId,
                    displayName: contactName, primaryEmail: funnelEmail, source: 'funnel', lifecycleStage: 'customer',
                  }).catch(() => null)
                }
                if (contactId) {
                  await knex('funnel_sessions').where('id', meta.sessionId).update({ contact_id: contactId })
                }
              }
            }

            // Send purchase confirmation email
            const funnelContactEmail = meta.customerEmail || session.customer_email
            if (funnelContactEmail) {
              try {
                const orders = await knex('funnel_orders')
                  .where('session_id', meta.sessionId)
                  .where('status', 'succeeded')
                  .leftJoin('products', 'funnel_orders.product_id', 'products.id')
                  .select('funnel_orders.*', 'products.name as product_name')
                const total = orders.reduce((s: number, o: any) => s + Number(o.amount), 0)
                const itemRows = orders.map((o: any) => `<tr><td style="padding:8px 16px;border-bottom:1px solid #e5e7eb">${o.product_name || o.order_type}</td><td style="padding:8px 16px;border-bottom:1px solid #e5e7eb;text-align:right">$${Number(o.amount).toFixed(2)}</td></tr>`).join('')

                await sendEmailByPurpose(knex, meta.orgId || orgId!, meta.tenantId || tenantId!, 'transactional', {
                  to: funnelContactEmail,
                  subject: `Order Confirmation — $${total.toFixed(2)}`,
                  htmlBody: `<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px">
                    <h2 style="font-size:22px;margin:0 0 16px">Thank you for your purchase!</h2>
                    <table style="width:100%;border-collapse:collapse">${itemRows}
                      <tr><td style="padding:12px 16px;font-weight:700">Total</td><td style="padding:12px 16px;font-weight:700;text-align:right">$${total.toFixed(2)}</td></tr>
                    </table>
                    <p style="color:#888;font-size:13px;margin-top:24px">If you have any questions, simply reply to this email.</p>
                  </div>`,
                  contactId: contactId || undefined,
                })
              } catch (emailErr) {
                console.error('[stripe.webhook] Funnel confirmation email failed:', emailErr)
              }
            }

            // Fire automation rules
            if (contactId) {
              try {
                const { executeAutomationRules } = await import('@/modules/sequences/lib/automation-execute')
                await executeAutomationRules(knex, meta.orgId || orgId!, meta.tenantId || tenantId!, 'funnel_purchase_completed', {
                  contactId,
                  funnelId: meta.funnelId,
                  funnelSlug: meta.funnelSlug,
                  sessionId: meta.sessionId,
                  amount: checkoutAmount,
                  email: funnelContactEmail,
                })
              } catch {}
            }

            // Auto-enroll in courses linked to funnel products
            if (funnelContactEmail) {
              try {
                const funnelOrders = await knex('funnel_orders')
                  .where('session_id', meta.sessionId)
                  .where('status', 'succeeded')
                  .whereNotNull('product_id')
                for (const order of funnelOrders) {
                  const prod = await knex('products').where('id', order.product_id).first()
                  if (prod?.course_ids) {
                    const courseIds = typeof prod.course_ids === 'string' ? JSON.parse(prod.course_ids) : (prod.course_ids || [])
                    for (const cid of courseIds) {
                      const funnelOrgId = String(meta.orgId || orgId)
                      const course = await knex('courses').where('id', cid).where('organization_id', funnelOrgId).where('is_published', true).whereNull('deleted_at').first()
                      if (!course) continue
                      const funnelTenantId = String(meta.tenantId || tenantId || course.tenant_id)
                      const existingEnroll = await knex('course_enrollments')
                        .where('tenant_id', funnelTenantId).where('organization_id', funnelOrgId)
                        .where('course_id', cid).where('student_email', funnelContactEmail.toLowerCase()).where('status', 'active').first()
                      if (existingEnroll) continue
                      // No created_at: course_enrollments has no such column, and
                      // writing one made every funnel enrollment fail silently.
                      const funnelEnrollmentId = require('crypto').randomUUID()
                      const enrolled = await knex('course_enrollments').insert({
                        id: funnelEnrollmentId,
                        tenant_id: funnelTenantId,
                        organization_id: funnelOrgId,
                        course_id: cid,
                        student_name: meta.customerName || funnelContactEmail.split('@')[0],
                        student_email: funnelContactEmail.toLowerCase(),
                        contact_id: contactId || null,
                        status: 'active',
                        enrolled_at: new Date(),
                      }).then(() => true).catch((e: unknown) => { console.error('[stripe.webhook] funnel course enrollment failed:', e); return false })
                      if (!enrolled) continue
                      await dispatchCourseEnrolledSafely(knex, {
                        organizationId: funnelOrgId,
                        tenantId: funnelTenantId,
                        enrollmentId: funnelEnrollmentId,
                        courseId: cid,
                        contactId: contactId || null,
                        courseTitle: course.title ?? null,
                        paid: true,
                      })
                    }
                  }
                }
              } catch {}
            }

            console.log(`[stripe.webhook] Funnel checkout completed: session=${meta.sessionId}, amount=$${checkoutAmount}`)
          }
        } catch (funnelErr) {
          console.error('[stripe.webhook] funnel checkout processing failed:', funnelErr)
        }
      }

      // ── Auto-enroll in courses linked to products ──
      if (meta.productId && orgId && customerEmail) {
        try {
          const product = await knex('products').where('id', meta.productId).where('organization_id', orgId).first()
          if (product?.course_ids) {
            const courseIds = typeof product.course_ids === 'string' ? JSON.parse(product.course_ids) : (product.course_ids || [])
            for (const cid of courseIds) {
              const course = await knex('courses').where('id', cid).where('organization_id', orgId).where('is_published', true).whereNull('deleted_at').first()
              if (!course) continue
              const bundleTenantId = String(tenantId || course.tenant_id)
              const existingEnroll = await knex('course_enrollments')
                .where('tenant_id', bundleTenantId).where('organization_id', orgId)
                .where('course_id', cid).where('student_email', customerEmail.trim().toLowerCase()).where('status', 'active').first()
              if (existingEnroll) continue
              const bundleEnrollmentId = require('crypto').randomUUID()
              const enrolled = await knex('course_enrollments').insert(paidEnrollmentRow({
                enrollmentId: bundleEnrollmentId,
                tenantId: bundleTenantId,
                organizationId: orgId,
                courseId: cid,
                studentName: session.customer_details?.name || customerEmail,
                studentEmail: customerEmail,
                paymentRecordId,
              })).then(() => true).catch(e => { console.error('[stripe.webhook] product course enrollment failed:', e); return false })
              if (!enrolled) continue
              if (resolvedContactId) {
                await knex('course_enrollments').where('id', bundleEnrollmentId).where('organization_id', orgId).update({ contact_id: resolvedContactId }).catch(() => {})
              }
              const bundleEmail = await sendEnrollmentEmailOnce(knex, {
                enrollmentId: bundleEnrollmentId,
                tenantId: bundleTenantId,
                organizationId: orgId,
                studentEmail: customerEmail,
                courseTitle: String(course.title || 'your course'),
                contactId: resolvedContactId,
              }, { send: sendEmailByPurpose }).catch((err: unknown) => ({ sent: false as const, reason: 'send_failed' as const, error: err instanceof Error ? err.message : String(err) }))
              if (!bundleEmail.sent && bundleEmail.reason !== 'already_sent') {
                console.warn('[stripe.webhook] product course enrollment email not sent:', bundleEmail.reason, bundleEmail.error || '')
              }
              await dispatchCourseEnrolledSafely(knex, {
                organizationId: orgId,
                tenantId: bundleTenantId,
                enrollmentId: bundleEnrollmentId,
                courseId: cid,
                contactId: resolvedContactId,
                courseTitle: course.title ?? null,
                paid: true,
              })
              console.log(`[stripe.webhook] Auto-enrolled ${customerEmail} in course ${course.title} via product purchase`)
            }
          }
        } catch (prodErr) {
          console.error('[stripe.webhook] product course enrollment failed:', prodErr)
        }
      }

      if (landingCheckoutId) {
        await completeLandingPageCheckout(knex, landingCheckoutId, { paymentRecordId, contactId: resolvedContactId })
        releaseLandingClaim = null
      }

      console.log(`[stripe.webhook] Payment completed: $${(session.amount_total || 0) / 100} from ${session.customer_email} (account: ${connectedAccountId || 'platform'})`)
    }

    return NextResponse.json({ received: true })
  } catch (error) {
    console.error('[stripe.webhook]', error)
    if (releaseLandingClaim) {
      await releaseLandingClaim().catch((releaseErr: unknown) => console.error('[stripe.webhook] landing-page claim release failed:', releaseErr))
    }
    return NextResponse.json({ error: 'Webhook error' }, { status: 400 })
  }
}
