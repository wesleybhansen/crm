import { dispatchFromInternalEvent, type ResolverContext } from '../lib/subscriberHelper'

export const metadata = {
  event: 'customers.person.updated',
  persistent: true,
  id: 'webhooks:contact-updated',
}

export default async function handle(payload: any, ctx: ResolverContext) {
  await dispatchFromInternalEvent('contact.updated', payload, ctx)
}
