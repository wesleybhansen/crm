import { createModuleEvents } from '@open-mercato/shared/modules/events'

const events = [
  { id: 'webhooks.subscription.created', label: 'Webhook Subscription Created', entity: 'subscription', category: 'crud' as const },
  { id: 'webhooks.subscription.updated', label: 'Webhook Subscription Updated', entity: 'subscription', category: 'crud' as const },
  { id: 'webhooks.subscription.deleted', label: 'Webhook Subscription Deleted', entity: 'subscription', category: 'crud' as const },
] as const

export const eventsConfig = createModuleEvents({ moduleId: 'webhooks', events })
export const emitWebhooksEvent = eventsConfig.emit
export type WebhooksEventId = typeof events[number]['id']
export default eventsConfig
