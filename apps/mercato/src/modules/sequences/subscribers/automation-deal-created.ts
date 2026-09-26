import type { EntityManager } from '@mikro-orm/postgresql'
import { dispatchAutomationTrigger, loadDealContext } from '../lib/automation-dispatch'

/**
 * A deal was created (New Deal on a contact, the pipeline board, the deals
 * API, the AI assistant): run the org's `deal_created` automation rules, once
 * per deal. The create command links the deal's contact before it emits, so
 * the rule sees the contact. Undoing a delete re-emits the event for the same
 * deal; its key is already claimed, so nothing runs twice.
 */
export const metadata = {
  event: 'customers.deal.created',
  persistent: true,
  id: 'sequences:automation-deal-created',
}

type Payload = { id?: string; organizationId?: string | null; tenantId?: string | null }

export default async function handler(payload: Payload, ctx: { resolve: <T = unknown>(name: string) => T }) {
  if (!payload?.id || !payload.organizationId || !payload.tenantId) return
  try {
    const knex = ctx.resolve<EntityManager>('em').getKnex()
    const scope = { organizationId: payload.organizationId, tenantId: payload.tenantId }
    const deal = await loadDealContext(knex, scope, payload.id)
    if (!deal) return
    await dispatchAutomationTrigger(knex, {
      ...scope,
      triggerType: 'deal_created',
      eventKey: `deal:${payload.id}`,
      context: {
        dealId: deal.dealId,
        contactId: deal.contactId,
        pipelineId: deal.pipelineId,
        stage: deal.pipelineStage,
        toStage: deal.pipelineStage,
        status: deal.status,
        reference: deal.reference,
        amount: deal.amount,
      },
    })
  } catch (err) {
    console.error('[sequences.automation-deal-created] dispatch failed', { dealId: payload.id, err })
  }
}
