import { dispatchEvent } from '../pipeline_automation/dispatcher'

export const metadata = {
  event: 'payment_gateways.payment.captured',
  persistent: true,
  id: 'customers:pipeline-auto-payment',
}

export default async function handle(payload: any, ctx: any): Promise<void> {
  await dispatchEvent({
    eventId: 'payment_gateways.payment.captured',
    payload,
    triggerEventId: payload?.transactionId ?? null,
    ctx,
  })
}
