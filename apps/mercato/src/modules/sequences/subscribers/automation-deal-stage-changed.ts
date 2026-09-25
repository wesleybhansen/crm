import type { EntityManager } from '@mikro-orm/postgresql'
import { dispatchAutomationTrigger, eventTimeKey, loadDealContext } from '../lib/automation-dispatch'

/** A deal moved to another pipeline stage: run `stage_change` rules and deal-stage sequences, once per move. */
export const metadata = {
  event: 'customers.deal.stage_changed',
  persistent: true,
  id: 'sequences:automation-deal-stage-changed',
}

type Payload = {
  id?: string
  organizationId?: string
  tenantId?: string
  stage?: string | null
  previousStage?: string | null
  status?: string | null
  changedAt?: string
}

export default async function handler(payload: Payload, ctx: { resolve: <T = unknown>(name: string) => T }) {
  if (!payload?.id || !payload.organizationId || !payload.tenantId) return
  if ((payload.stage ?? null) === (payload.previousStage ?? null)) return
  try {
    const knex = ctx.resolve<EntityManager>('em').getKnex()
    const scope = { organizationId: payload.organizationId, tenantId: payload.tenantId }
    const deal = await loadDealContext(knex, scope, payload.id)
    if (!deal) return
    const toStage = payload.stage ?? deal.pipelineStage
    await dispatchAutomationTrigger(knex, {
      ...scope,
      triggerType: 'stage_change',
      eventKey: `deal:${payload.id}:${payload.previousStage ?? ''}->${toStage ?? ''}:${eventTimeKey(payload.changedAt)}`,
      context: {
        dealId: deal.dealId,
        contactId: deal.contactId,
        pipelineId: deal.pipelineId,
        fromStage: payload.previousStage ?? null,
        toStage,
        stage: toStage,
        status: payload.status ?? deal.status,
        reference: deal.reference,
        amount: deal.amount,
      },
      sequenceTrigger: { type: 'deal_stage_changed', stage: toStage },
    })
  } catch (err) {
    console.error('[sequences.automation-deal-stage-changed] dispatch failed', { dealId: payload.id, err })
  }
}
