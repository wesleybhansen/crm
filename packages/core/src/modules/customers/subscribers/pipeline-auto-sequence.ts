import { dispatchEvent } from '../pipeline_automation/dispatcher'

export const metadata = {
  event: 'sequences.sequence.completed',
  persistent: true,
  id: 'customers:pipeline-auto-sequence',
}

export default async function handle(payload: any, ctx: any): Promise<void> {
  await dispatchEvent({
    eventId: 'sequences.sequence.completed',
    payload,
    triggerEventId: payload?.sequenceRunId ?? null,
    ctx,
  })
}
