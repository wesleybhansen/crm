
import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { trackEngagement } from '@/modules/customers/lib/engagement-score'
import { dispatchWebhook } from '@/modules/customers/api/webhooks/dispatch'

export const metadata = { POST: { requireAuth: false } }

/* Verify a Resend (Svix) webhook signature: HMAC-SHA256 over
 * `${svix-id}.${svix-timestamp}.${rawBody}`, keyed by the base64 secret (after
 * the `whsec_` prefix), with a ±5min tolerance. Inline (no svix dependency). */
function verifyResendSignature(secret: string, headers: Headers, payload: string): boolean {
  const id = headers.get('svix-id')
  const timestamp = headers.get('svix-timestamp')
  const sigHeader = headers.get('svix-signature')
  if (!id || !timestamp || !sigHeader) return false
  const ts = Number(timestamp)
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false
  const rawKey = secret.startsWith('whsec_') ? secret.slice(6) : secret
  let keyBytes: Buffer
  try { keyBytes = Buffer.from(rawKey, 'base64') } catch { return false }
  const expected = crypto.createHmac('sha256', keyBytes).update(`${id}.${timestamp}.${payload}`).digest('base64')
  const expectedBuf = Buffer.from(expected)
  for (const part of sigHeader.split(' ')) {
    const sig = part.split(',')[1]
    if (!sig) continue
    const sigBuf = Buffer.from(sig)
    if (sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf)) return true
  }
  return false
}

/**
 * Resend webhook handler for email delivery events.
 * Handles: email.bounced, email.complained, email.delivered
 * Set up in Resend dashboard: Settings → Webhooks → Add endpoint → your-domain/api/email/webhook
 */
export async function POST(req: Request) {
  try {
    const rawBody = await req.text()
    const secret = process.env.RESEND_WEBHOOK_SECRET
    if (!secret) {
      console.error('[email.webhook] RESEND_WEBHOOK_SECRET not set — rejecting')
      return NextResponse.json({ ok: false, error: 'Webhook not configured' }, { status: 401 })
    }
    if (!verifyResendSignature(secret, req.headers, rawBody)) {
      return NextResponse.json({ ok: false, error: 'Invalid signature' }, { status: 401 })
    }
    const body = JSON.parse(rawBody)
    const { type, data } = body

    if (!type || !data) {
      return NextResponse.json({ ok: false, error: 'Invalid webhook payload' }, { status: 400 })
    }

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const email = data.to?.[0] || data.email

    if (type === 'email.bounced') {
      const bounceType = data.bounce?.type // 'hard' or 'soft'
      console.log(`[email.webhook] Bounce (${bounceType}): ${email}`)

      if (bounceType === 'hard') {
        // Hard bounce: suppress contact (never email again)
        await knex('customer_entities')
          .where('primary_email', email)
          .update({ email_status: 'hard_bounced', updated_at: new Date() })

        // Also add to unsubscribe list
        const contacts = await knex('customer_entities').where('primary_email', email)
        for (const contact of contacts) {
          const existing = await knex('email_unsubscribes')
            .where('email', email)
            .where('organization_id', contact.organization_id)
            .first()
          if (!existing) {
            await knex('email_unsubscribes').insert({
              id: require('crypto').randomUUID(),
              tenant_id: contact.tenant_id,
              organization_id: contact.organization_id,
              email,
              contact_id: contact.id,
              reason: 'hard_bounce',
              created_at: new Date(),
            })
          }
        }
      } else {
        // Soft bounce: mark but don't suppress yet
        await knex('customer_entities')
          .where('primary_email', email)
          .whereNot('email_status', 'hard_bounced')
          .update({ email_status: 'soft_bounced', updated_at: new Date() })
      }

      // Update the specific message status
      if (data.email_id) {
        await knex('email_messages')
          .where('resend_id', data.email_id)
          .update({ status: 'bounced' })
      }

      // Dispatch webhook to external subscribers (e.g., AMS)
      const contacts = await knex('customer_entities').where('primary_email', email).select('organization_id')
      const orgIds = [...new Set(contacts.map((c: { organization_id: string }) => c.organization_id))]
      for (const orgId of orgIds) {
        dispatchWebhook(knex, orgId, 'email.bounced', {
          emailId: data.email_id || null,
          contactEmail: email,
          reason: bounceType || 'unknown',
        }).catch(() => {})
      }
    }

    if (type === 'email.complained') {
      console.log(`[email.webhook] Spam complaint: ${email}`)

      // Auto-unsubscribe the contact
      const contacts = await knex('customer_entities').where('primary_email', email)
      for (const contact of contacts) {
        await knex('customer_entities')
          .where('id', contact.id)
          .update({ email_status: 'complained', updated_at: new Date() })

        const existing = await knex('email_unsubscribes')
          .where('email', email)
          .where('organization_id', contact.organization_id)
          .first()
        if (!existing) {
          await knex('email_unsubscribes').insert({
            id: require('crypto').randomUUID(),
            tenant_id: contact.tenant_id,
            organization_id: contact.organization_id,
            email,
            contact_id: contact.id,
            reason: 'spam_complaint',
            created_at: new Date(),
          })
        }

        // Track negative engagement
        trackEngagement(knex, contact.organization_id, contact.tenant_id, contact.id, 'email_unsubscribed').catch(() => {})
      }
    }

    if (type === 'email.delivered') {
      if (data.email_id) {
        await knex('email_messages')
          .where('resend_id', data.email_id)
          .whereIn('status', ['queued', 'sent'])
          .update({ status: 'delivered' })
      }
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[email.webhook]', error)
    return NextResponse.json({ ok: false, error: 'Webhook processing failed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Email', summary: 'Email delivery webhook',
  methods: { POST: { summary: 'Handle Resend delivery events (bounce, complaint, delivered)', tags: ['Email'] } },
}
