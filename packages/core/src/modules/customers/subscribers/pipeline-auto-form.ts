import { dispatchEvent } from '../pipeline_automation/dispatcher'

export const metadata = {
  event: 'landing_pages.form.submitted',
  persistent: true,
  id: 'customers:pipeline-auto-form',
}

export default async function handle(payload: any, ctx: any): Promise<void> {
  await dispatchEvent({
    eventId: 'landing_pages.form.submitted',
    payload,
    triggerEventId: payload?.eventId ?? null,
    ctx,
  })
}
