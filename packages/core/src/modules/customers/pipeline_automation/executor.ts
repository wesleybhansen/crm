import type { Knex } from 'knex'
import type { EntityType, ActionType } from './triggers'

export type PipelineAutomationRunOutcome =
  | 'applied'
  | 'skipped_backward'
  | 'skipped_idempotent'
  | 'skipped_filter'
  | 'failed'

export type ExecutorContext = {
  knex: Knex
  organizationId: string
  tenantId: string
  bus?: { emitEvent?: (id: string, payload: any, opts?: any) => Promise<void> } | null
}

export type ApplyResult = {
  outcome: PipelineAutomationRunOutcome
  fromStage: string | null
  toStage: string | null
  error?: string | null
}

const IDEMPOTENCY_WINDOW_HOURS = 24

export async function isIdempotentDuplicate(
  knex: Knex,
  ruleId: string,
  entityId: string,
  triggerEventId: string,
): Promise<boolean> {
  if (!triggerEventId) return false
  const cutoff = new Date(Date.now() - IDEMPOTENCY_WINDOW_HOURS * 60 * 60 * 1000)
  const existing = await knex('customer_pipeline_automation_runs')
    .where('rule_id', ruleId)
    .where('entity_id', entityId)
    .where('trigger_event_id', triggerEventId)
    .where('ran_at', '>=', cutoff)
    .first('id')
  return !!existing
}

export async function recordRun(
  knex: Knex,
  args: {
    ruleId: string
    organizationId: string
    tenantId: string
    triggerEventId: string
    triggerEventKey: string
    entityType: EntityType
    entityId: string
    fromStage: string | null
    toStage: string | null
    outcome: PipelineAutomationRunOutcome
    error?: string | null
  },
): Promise<void> {
  await knex('customer_pipeline_automation_runs').insert({
    organization_id: args.organizationId,
    tenant_id: args.tenantId,
    rule_id: args.ruleId,
    trigger_event_id: args.triggerEventId,
    trigger_event_key: args.triggerEventKey,
    entity_type: args.entityType,
    entity_id: args.entityId,
    from_stage: args.fromStage,
    to_stage: args.toStage,
    outcome: args.outcome,
    error: args.error ?? null,
    ran_at: new Date(),
  })
}

export async function applyDealAction(
  ctx: ExecutorContext,
  args: {
    dealId: string
    targetAction: ActionType
    targetPipelineId: string | null
    targetStageId: string | null
    allowBackward: boolean
  },
): Promise<ApplyResult> {
  const deal = await ctx.knex('customer_deals')
    .where('id', args.dealId)
    .where('organization_id', ctx.organizationId)
    .where('tenant_id', ctx.tenantId)
    .whereNull('deleted_at')
    .first('id', 'pipeline_id', 'pipeline_stage_id', 'pipeline_stage', 'title')
  if (!deal) {
    return { outcome: 'failed', fromStage: null, toStage: null, error: 'deal not found' }
  }

  let nextStageId: string | null = null
  let nextPipelineId: string | null = deal.pipeline_id ?? args.targetPipelineId ?? null

  if (args.targetAction === 'set_stage') {
    if (!args.targetStageId) {
      return { outcome: 'failed', fromStage: deal.pipeline_stage_id ?? null, toStage: null, error: 'target stage missing' }
    }
    nextStageId = args.targetStageId
    if (args.targetPipelineId) nextPipelineId = args.targetPipelineId
  } else if (args.targetAction === 'advance_one') {
    if (!deal.pipeline_id) {
      return { outcome: 'failed', fromStage: null, toStage: null, error: 'deal has no pipeline' }
    }
    const currentOrderRow = deal.pipeline_stage_id
      ? await ctx.knex('customer_pipeline_stages')
          .where('id', deal.pipeline_stage_id)
          .first('position')
      : null
    const currentOrder = currentOrderRow?.position ?? -1
    const next = await ctx.knex('customer_pipeline_stages')
      .where('pipeline_id', deal.pipeline_id)
      .where('organization_id', ctx.organizationId)
      .where('tenant_id', ctx.tenantId)
      .where('position', '>', currentOrder)
      .orderBy('position', 'asc')
      .first('id', 'name', 'position')
    if (!next) {
      return { outcome: 'applied', fromStage: deal.pipeline_stage_id ?? null, toStage: deal.pipeline_stage_id ?? null }
    }
    nextStageId = next.id
  } else {
    return { outcome: 'failed', fromStage: deal.pipeline_stage_id ?? null, toStage: null, error: 'invalid action for deal' }
  }

  if (!args.allowBackward && deal.pipeline_stage_id && nextStageId && nextStageId !== deal.pipeline_stage_id) {
    const [current, target] = await Promise.all([
      ctx.knex('customer_pipeline_stages').where('id', deal.pipeline_stage_id).first('position'),
      ctx.knex('customer_pipeline_stages').where('id', nextStageId).first('position', 'pipeline_id'),
    ])
    if (target?.pipeline_id === deal.pipeline_id && current && target && Number(target.position) <= Number(current.position)) {
      return { outcome: 'skipped_backward', fromStage: deal.pipeline_stage_id, toStage: nextStageId }
    }
  }

  if (deal.pipeline_stage_id === nextStageId && (!args.targetPipelineId || nextPipelineId === deal.pipeline_id)) {
    return { outcome: 'applied', fromStage: deal.pipeline_stage_id, toStage: deal.pipeline_stage_id }
  }

  const stageRow = nextStageId
    ? await ctx.knex('customer_pipeline_stages').where('id', nextStageId).first('name')
    : null

  await ctx.knex('customer_deals')
    .where('id', args.dealId)
    .where('organization_id', ctx.organizationId)
    .where('tenant_id', ctx.tenantId)
    .update({
      pipeline_stage_id: nextStageId,
      pipeline_id: nextPipelineId,
      pipeline_stage: stageRow?.name ?? null,
      updated_at: new Date(),
    })

  if (ctx.bus?.emitEvent) {
    await ctx.bus.emitEvent('customers.deal.stage_changed', {
      id: args.dealId,
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      title: deal.title,
      stage: stageRow?.name ?? null,
      previousStage: deal.pipeline_stage,
    }, { persistent: true }).catch(() => {})
    await ctx.bus.emitEvent('customers.deal.auto_advanced', {
      id: args.dealId,
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      previousStageId: deal.pipeline_stage_id,
      stageId: nextStageId,
      stage: stageRow?.name ?? null,
    }, { persistent: true }).catch(() => {})
  }

  return { outcome: 'applied', fromStage: deal.pipeline_stage_id ?? null, toStage: nextStageId }
}

export async function applyPersonAction(
  ctx: ExecutorContext,
  args: {
    personId: string
    targetLifecycleStage: string | null
    allowBackward: boolean
  },
): Promise<ApplyResult> {
  if (!args.targetLifecycleStage) {
    return { outcome: 'failed', fromStage: null, toStage: null, error: 'target lifecycle stage missing' }
  }

  const person = await ctx.knex('customer_entities')
    .where('id', args.personId)
    .where('organization_id', ctx.organizationId)
    .where('tenant_id', ctx.tenantId)
    .where('kind', 'person')
    .whereNull('deleted_at')
    .first('id', 'lifecycle_stage')
  if (!person) {
    return { outcome: 'failed', fromStage: null, toStage: null, error: 'person not found' }
  }

  const currentStage = person.lifecycle_stage ?? null
  if (currentStage === args.targetLifecycleStage) {
    return { outcome: 'applied', fromStage: currentStage, toStage: currentStage }
  }

  await ctx.knex('customer_entities')
    .where('id', args.personId)
    .where('organization_id', ctx.organizationId)
    .where('tenant_id', ctx.tenantId)
    .update({
      lifecycle_stage: args.targetLifecycleStage,
      updated_at: new Date(),
    })

  if (ctx.bus?.emitEvent) {
    await ctx.bus.emitEvent('customers.person.stage_changed', {
      id: args.personId,
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      stage: args.targetLifecycleStage,
      previousStage: currentStage,
    }, { persistent: true }).catch(() => {})
    await ctx.bus.emitEvent('customers.person.auto_advanced', {
      id: args.personId,
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      previousLifecycleStage: currentStage,
      lifecycleStage: args.targetLifecycleStage,
    }, { persistent: true }).catch(() => {})
  }

  return { outcome: 'applied', fromStage: currentStage, toStage: args.targetLifecycleStage }
}
