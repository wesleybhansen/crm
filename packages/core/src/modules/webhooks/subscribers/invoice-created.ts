import { dispatchFromInternalEvent, type ResolverContext } from '../lib/subscriberHelper'

export const metadata = {
  event: 'sales.invoice.created',
  persistent: true,
  id: 'webhooks:invoice-created',
}

export default async function handle(payload: any, ctx: ResolverContext) {
  await dispatchFromInternalEvent('invoice.created', payload, ctx)
}
