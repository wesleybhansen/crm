import type { EntityManager } from '@mikro-orm/postgresql'
import { drainOutboundEvents, enqueueDealClosed } from '../lib/outbound-events'

/**
 * A deal just closed: record it in the outbox for the marketing app, then try
 * to deliver it right away without waiting. The insert is the only awaited
 * work, so the deal update is never held up by AMS; retries come from the
 * outbox drain (POST /api/internal/outbound-events/drain on the box cron).
 */
export const metadata = {
  event: 'customers.deal.closed',
  persistent: true,
  id: 'integrations_api:deal-closed-ams',
}

type DealClosedPayload = {
  id?: string
  organizationId?: string
  tenantId?: string
  closedAt?: string
}

function parseClosedAt(value: unknown): Date {
  const date = typeof value === 'string' ? new Date(value) : null
  return date && Number.isFinite(date.getTime()) ? date : new Date()
}

export default async function handler(
  payload: DealClosedPayload,
  ctx: { resolve: <T = unknown>(name: string) => T },
) {
  if (!payload?.id || !payload.organizationId || !payload.tenantId) return
  try {
    const knex = ctx.resolve<EntityManager>('em').getKnex()
    const { inserted } = await enqueueDealClosed(knex, {
      organizationId: payload.organizationId,
      tenantId: payload.tenantId,
      dealId: payload.id,
      closedAt: parseClosedAt(payload.closedAt),
    })
    if (inserted) {
      void drainOutboundEvents(knex, { organizationId: payload.organizationId, limit: 3 }).catch((err) => {
        console.error('[integrations_api.deal-closed-ams] immediate delivery failed', err)
      })
    }
  } catch (err) {
    console.error('[integrations_api.deal-closed-ams] could not record the closed deal', { dealId: payload.id, err })
  }
}
