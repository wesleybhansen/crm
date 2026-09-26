import type { EntityManager } from '@mikro-orm/postgresql'
import { drainOutboundEvents, enqueueJourneyClosed, isJourneyClosing, type PersonStageChangedPayload } from '../lib/outbound-events'

/**
 * The Customer Journey board's closing: a contact moved (by hand on the board,
 * or by a pipeline automation) into a closed/won stage such as "Closed" or
 * "Sold". Realtors default to this board, so the marketing app gets the same
 * deal-closed event a deal would send (contract: Software Strategy/
 * deal-closed-contract.md, journey case), keyed journey-closed:<contactId>:
 * <stage key>. Moves into a lost stage, out of a closed stage, or between two
 * closed stages send nothing. Delivery and retries work exactly as for deals
 * (lib/outbound-events.ts).
 */
export const metadata = {
  event: 'customers.person.stage_changed',
  persistent: true,
  id: 'integrations_api:journey-closed-ams',
}

function parseChangedAt(value: unknown): Date {
  const date = typeof value === 'string' ? new Date(value) : null
  return date && Number.isFinite(date.getTime()) ? date : new Date()
}

export default async function handler(
  payload: PersonStageChangedPayload,
  ctx: { resolve: <T = unknown>(name: string) => T },
) {
  if (!payload?.id || !payload.organizationId || !payload.tenantId) return
  if (!isJourneyClosing(payload)) return
  try {
    const knex = ctx.resolve<EntityManager>('em').getKnex()
    const { inserted } = await enqueueJourneyClosed(knex, {
      organizationId: payload.organizationId,
      tenantId: payload.tenantId,
      contactId: payload.id,
      stage: String(payload.stage),
      closedAt: parseChangedAt(payload.changedAt),
    })
    if (inserted) {
      void drainOutboundEvents(knex, { organizationId: payload.organizationId, limit: 3 }).catch((err) => {
        console.error('[integrations_api.journey-closed-ams] immediate delivery failed', err)
      })
    }
  } catch (err) {
    console.error('[integrations_api.journey-closed-ams] could not record the journey closing', { contactId: payload.id, err })
  }
}
