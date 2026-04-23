import { dispatchFromInternalEvent, type ResolverContext } from '../lib/subscriberHelper'

export const metadata = {
  event: 'customers.deal.stage_changed',
  persistent: true,
  id: 'webhooks:deal-stage-changed',
}

export default async function handle(payload: any, ctx: ResolverContext) {
  // Always fire the generic stage-changed webhook.
  await dispatchFromInternalEvent('deal.stage_changed', payload, ctx)

  // Won/lost aren't separate internal events yet — detect from the
  // incoming stage/status and fan out the more specific webhook events
  // so subscribers can filter on them directly.
  const newStage = String(payload?.stage ?? payload?.newStage ?? '').toLowerCase()
  const status = String(payload?.status ?? '').toLowerCase()
  if (newStage === 'won' || status === 'won' || newStage === 'closed won') {
    await dispatchFromInternalEvent('deal.won', payload, ctx)
  } else if (newStage === 'lost' || status === 'lost' || newStage === 'closed lost') {
    await dispatchFromInternalEvent('deal.lost', payload, ctx)
  }
}
