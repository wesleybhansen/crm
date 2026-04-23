import { dispatchFromInternalEvent, type ResolverContext } from '../lib/subscriberHelper'

export const metadata = {
  event: 'customers.task.created',
  persistent: true,
  id: 'webhooks:task-created',
}

export default async function handle(payload: any, ctx: ResolverContext) {
  await dispatchFromInternalEvent('task.created', payload, ctx)
}
