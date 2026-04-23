import { dispatchFromInternalEvent, type ResolverContext } from '../lib/subscriberHelper'

export const metadata = {
  event: 'customers.person.created',
  persistent: true,
  id: 'webhooks:contact-created',
}

export default async function handle(payload: any, ctx: ResolverContext) {
  await dispatchFromInternalEvent('contact.created', payload, ctx)
}
