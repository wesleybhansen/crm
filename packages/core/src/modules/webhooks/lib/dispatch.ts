/**
 * Outbound webhook dispatch. Signs with HMAC-SHA256 when a secret is
 * configured, retries up to 3 times with 5s backoff, logs every attempt
 * to `webhook_deliveries`. Fire-and-forget: the caller is not blocked.
 *
 * Moved from apps/mercato/src/modules/customers/api/webhooks/dispatch.ts
 * in SPEC-062 Phase 1. Old path still re-exports this for BC.
 */

import crypto from 'crypto'
import type { Knex } from 'knex'

const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 5000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function deliverWebhook(
  knex: Knex,
  subscription: { id: string; target_url: string; secret: string | null },
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const body = JSON.stringify({
    event,
    data: payload,
    timestamp: new Date().toISOString(),
  })

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'LaunchCRM-Webhooks/1',
    'X-Webhook-Event': event,
  }

  if (subscription.secret) {
    const signature = crypto
      .createHmac('sha256', subscription.secret)
      .update(body)
      .digest('hex')
    headers['X-Webhook-Signature'] = `sha256=${signature}`
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const deliveryId = crypto.randomUUID()
    headers['X-Webhook-Delivery'] = deliveryId
    try {
      const response = await fetch(subscription.target_url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10000),
      })

      const responseBody = await response.text().catch(() => '')

      if (response.ok) {
        await knex('webhook_deliveries').insert({
          id: deliveryId,
          subscription_id: subscription.id,
          event,
          payload: JSON.stringify(payload),
          status_code: response.status,
          response_body: responseBody.slice(0, 2000),
          attempt,
          delivered_at: new Date(),
          created_at: new Date(),
        })
        return
      }

      await knex('webhook_deliveries').insert({
        id: deliveryId,
        subscription_id: subscription.id,
        event,
        payload: JSON.stringify(payload),
        status_code: response.status,
        response_body: responseBody.slice(0, 2000),
        attempt,
        failed_at: new Date(),
        created_at: new Date(),
      })

      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      await knex('webhook_deliveries').insert({
        id: deliveryId,
        subscription_id: subscription.id,
        event,
        payload: JSON.stringify(payload),
        status_code: null,
        response_body: errorMessage.slice(0, 2000),
        attempt,
        failed_at: new Date(),
        created_at: new Date(),
      }).catch(() => {})

      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS)
    }
  }
}

/**
 * Dispatch a domain event to every active webhook subscription that
 * listens to `event` in the given organization. Fire-and-forget per
 * subscription so one slow target can't delay others.
 */
export async function dispatchWebhook(
  knex: Knex,
  orgId: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const subscriptions = await knex('webhook_subscriptions')
      .where('organization_id', orgId)
      .where('event', event)
      .where('is_active', true)

    for (const subscription of subscriptions) {
      deliverWebhook(knex, subscription, event, payload).catch((err) => {
        console.error(`[webhook.dispatch] delivery failed for subscription ${subscription.id}`, err)
      })
    }
  } catch (error) {
    console.error('[webhook.dispatch] failed to query subscriptions', error)
  }
}

/**
 * Synchronous single-attempt delivery for the "Send Test" button.
 * Returns the raw response info so the UI can show it inline without
 * polling the delivery log.
 */
export async function sendTestDelivery(
  knex: Knex,
  subscription: { id: string; target_url: string; secret: string | null },
  event: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; status: number | null; body: string; error?: string }> {
  const body = JSON.stringify({ event, data: payload, timestamp: new Date().toISOString() })
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'LaunchCRM-Webhooks/1',
    'X-Webhook-Event': event,
    'X-Webhook-Delivery': crypto.randomUUID(),
  }
  if (subscription.secret) {
    const signature = crypto.createHmac('sha256', subscription.secret).update(body).digest('hex')
    headers['X-Webhook-Signature'] = `sha256=${signature}`
  }
  try {
    const response = await fetch(subscription.target_url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) })
    const responseBody = (await response.text().catch(() => '')).slice(0, 2000)
    await knex('webhook_deliveries').insert({
      id: headers['X-Webhook-Delivery'],
      subscription_id: subscription.id,
      event,
      payload: JSON.stringify(payload),
      status_code: response.status,
      response_body: responseBody,
      attempt: 1,
      delivered_at: response.ok ? new Date() : null,
      failed_at: response.ok ? null : new Date(),
      created_at: new Date(),
    }).catch(() => {})
    return { ok: response.ok, status: response.status, body: responseBody }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    await knex('webhook_deliveries').insert({
      id: headers['X-Webhook-Delivery'],
      subscription_id: subscription.id,
      event,
      payload: JSON.stringify(payload),
      status_code: null,
      response_body: message.slice(0, 2000),
      attempt: 1,
      failed_at: new Date(),
      created_at: new Date(),
    }).catch(() => {})
    return { ok: false, status: null, body: '', error: message }
  }
}
