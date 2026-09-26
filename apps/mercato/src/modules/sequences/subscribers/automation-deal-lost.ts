import type { EntityManager } from '@mikro-orm/postgresql'
import { dealLostEventKey, dispatchAutomationTrigger, loadDealContext } from '../lib/automation-dispatch'

/**
 * A deal was marked lost (a lost status, or a move into a Lost stage): run the
 * org's `deal_lost` automation rules, once per loss. Lost, reopened and lost
 * again fires again; a replayed or retried event never does.
 */
export const metadata = {
  event: 'customers.deal.lost',
  persistent: true,
  id: 'sequences:automation-deal-lost',
}

type Payload = { id?: string; organizationId?: string; tenantId?: string; lostAt?: string; stage?: string | null; status?: string | null }

export default async function handler(payload: Payload, ctx: { resolve: <T = unknown>(name: string) => T }) {
  if (!payload?.id || !payload.organizationId || !payload.tenantId) return
  try {
    const knex = ctx.resolve<EntityManager>('em').getKnex()
    const scope = { organizationId: payload.organizationId, tenantId: payload.tenantId }
    const deal = await loadDealContext(knex, scope, payload.id)
    if (!deal) return
    await dispatchAutomationTrigger(knex, {
      ...scope,
      triggerType: 'deal_lost',
      eventKey: dealLostEventKey(payload.id, payload.lostAt),
      context: {
        dealId: deal.dealId,
        contactId: deal.contactId,
        pipelineId: deal.pipelineId,
        stage: 'lost',
        toStage: payload.stage ?? deal.pipelineStage,
        status: payload.status ?? deal.status,
        reference: deal.reference,
        amount: deal.amount,
        lostAt: payload.lostAt ?? null,
      },
    })
  } catch (err) {
    console.error('[sequences.automation-deal-lost] dispatch failed', { dealId: payload.id, err })
  }
}
