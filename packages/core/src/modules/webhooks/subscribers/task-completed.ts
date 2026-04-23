import { dispatchFromInternalEvent, type ResolverContext } from '../lib/subscriberHelper'

export const metadata = {
  event: 'customers.task.completed',
  persistent: true,
  id: 'webhooks:task-completed',
}

export default async function handle(payload: any, ctx: ResolverContext) {
  await dispatchFromInternalEvent('task.completed', payload, ctx)
}
