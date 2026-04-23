import { dispatchFromInternalEvent, type ResolverContext } from '../lib/subscriberHelper'

export const metadata = {
  event: 'customers.deal.created',
  persistent: true,
  id: 'webhooks:deal-created',
}

export default async function handle(payload: any, ctx: ResolverContext) {
  await dispatchFromInternalEvent('deal.created', payload, ctx)
}
