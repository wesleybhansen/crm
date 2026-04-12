import type { EntityManager } from '@mikro-orm/postgresql'
import { dispatchWebhook } from '../../customers/api/webhooks/dispatch'

/**
 * Listens for deal stage changes and dispatches outbound webhooks.
 * Used by AMS (Blog-Ops) to track pipeline progression.
 */
export const metadata = {
  event: 'customers.deal.stage_changed',
  persistent: false,
  id: 'integrations_api:deal-stage-webhook',
}

export default async function handler(
  payload: {
    id: string
    organizationId: string
    tenantId: string
    title: string
    stage: string | null
    status: string
  },
  ctx: { resolve: <T = any>(name: string) => T },
) {
  const em = ctx.resolve<EntityManager>('em')
  const knex = em.getKnex()

  await dispatchWebhook(knex, payload.organizationId, 'deal.stage_changed', {
    id: payload.id,
    name: payload.title,
    stage: payload.stage,
    status: payload.status,
  })
}
