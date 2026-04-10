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
  }

  if (subscription.secret) {
    const signature = crypto
      .createHmac('sha256', subscription.secret)
      .update(body)
      .digest('hex')
    headers['X-Webhook-Signature'] = signature
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const deliveryId = crypto.randomUUID()
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

      // Non-2xx response
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

      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_DELAY_MS)
      }
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

      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_DELAY_MS)
      }
    }
  }
}

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
      // Fire and forget each delivery — don't block the caller
      deliverWebhook(knex, subscription, event, payload).catch((err) => {
        console.error(`[webhook.dispatch] delivery failed for subscription ${subscription.id}`, err)
      })
    }
  } catch (error) {
    console.error('[webhook.dispatch] failed to query subscriptions', error)
  }
}
