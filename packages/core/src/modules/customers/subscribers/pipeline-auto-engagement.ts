import { dispatchEvent } from '../pipeline_automation/dispatcher'

export const metadata = {
  event: 'customers.engagement.score_updated',
  persistent: true,
  id: 'customers:pipeline-auto-engagement',
}

export default async function handle(payload: any, ctx: any): Promise<void> {
  await dispatchEvent({
    eventId: 'customers.engagement.score_updated',
    payload,
    // Score updates don't have a stable per-event id; combine contact + score
    // for a deterministic fingerprint that still allows the same threshold
    // crossing to fire once per contact-score pair.
    triggerEventId: payload?.contactId && payload?.score !== undefined
      ? `engagement:${payload.contactId}:${payload.score}`
      : null,
    ctx,
  })
}
