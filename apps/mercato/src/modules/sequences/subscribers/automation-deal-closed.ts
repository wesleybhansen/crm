import type { EntityManager } from '@mikro-orm/postgresql'
import { dispatchAutomationTrigger, loadDealContext } from '../lib/automation-dispatch'

/** A deal was won or closed: run the org's `deal_won` automation rules and sequences, once per deal. */
export const metadata = {
  event: 'customers.deal.closed',
  persistent: true,
  id: 'sequences:automation-deal-won',
}

type Payload = { id?: string; organizationId?: string; tenantId?: string; closedAt?: string; stage?: string | null; status?: string | null }

export default async function handler(payload: Payload, ctx: { resolve: <T = unknown>(name: string) => T }) {
  if (!payload?.id || !payload.organizationId || !payload.tenantId) return
  try {
    const knex = ctx.resolve<EntityManager>('em').getKnex()
    const scope = { organizationId: payload.organizationId, tenantId: payload.tenantId }
    const deal = await loadDealContext(knex, scope, payload.id)
    if (!deal) return
    await dispatchAutomationTrigger(knex, {
      ...scope,
      triggerType: 'deal_won',
      eventKey: `deal:${payload.id}`,
      context: {
        dealId: deal.dealId,
        contactId: deal.contactId,
        pipelineId: deal.pipelineId,
        stage: 'won',
        toStage: payload.stage ?? deal.pipelineStage,
        status: payload.status ?? deal.status,
        reference: deal.reference,
        amount: deal.amount,
        closedAt: payload.closedAt ?? null,
      },
      // Sequences whose trigger is "Deal won" enroll the deal's contact.
      sequenceTrigger: { type: 'deal_won' },
    })
  } catch (err) {
    console.error('[sequences.automation-deal-won] dispatch failed', { dealId: payload.id, err })
  }
}
