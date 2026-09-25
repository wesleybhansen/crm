import type { EntityManager } from '@mikro-orm/postgresql'
import { dispatchAutomationTrigger, eventTimeKey } from '../lib/automation-dispatch'

/**
 * A contact moved to another stage on the Customer Journey board (the pipeline
 * for journey-mode businesses, real estate included): run `stage_change` rules
 * and deal-stage sequences, once per move.
 */
export const metadata = {
  event: 'customers.person.stage_changed',
  persistent: true,
  id: 'sequences:automation-person-stage-changed',
}

type Payload = {
  id?: string
  organizationId?: string
  tenantId?: string
  stage?: string | null
  previousStage?: string | null
  changedAt?: string
}

export default async function handler(payload: Payload, ctx: { resolve: <T = unknown>(name: string) => T }) {
  if (!payload?.id || !payload.organizationId || !payload.tenantId) return
  const toStage = payload.stage ?? null
  if (!toStage || toStage === (payload.previousStage ?? null)) return
  try {
    const knex = ctx.resolve<EntityManager>('em').getKnex()
    await dispatchAutomationTrigger(knex, {
      organizationId: payload.organizationId,
      tenantId: payload.tenantId,
      triggerType: 'stage_change',
      eventKey: `person:${payload.id}:${payload.previousStage ?? ''}->${toStage}:${eventTimeKey(payload.changedAt)}`,
      context: {
        contactId: payload.id,
        fromStage: payload.previousStage ?? null,
        toStage,
        stage: toStage,
      },
      sequenceTrigger: { type: 'deal_stage_changed', stage: toStage },
    })
  } catch (err) {
    console.error('[sequences.automation-person-stage-changed] dispatch failed', { contactId: payload.id, err })
  }
}
