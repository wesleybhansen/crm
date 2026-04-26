import type { Knex } from 'knex'
import type { EntityManager } from '@mikro-orm/postgresql'
import { TRIGGERS_BY_EVENT_ID, type TriggerKey, type EntityType } from './triggers'
import { applyDealAction, applyPersonAction, isIdempotentDuplicate, recordRun } from './executor'

export type DispatcherContext = {
  resolve: <T = unknown>(name: string) => T
}

type RuleRow = {
  id: string
  organization_id: string
  tenant_id: string
  trigger_key: TriggerKey
  filters: Record<string, unknown> | string | null
  target_entity: EntityType
  target_pipeline_id: string | null
  target_stage_id: string | null
  target_lifecycle_stage: string | null
  target_action: 'set_stage' | 'advance_one' | 'set_lifecycle'
  allow_backward: boolean
}

function parseFilters(raw: RuleRow['filters']): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return {} }
  }
  return raw
}

/**
 * Dispatch a single domain event through the pipeline_automation rules engine.
 * Called from the per-event subscribers (one wrapper per supported trigger).
 */
export async function dispatchEvent(args: {
  eventId: string
  payload: Record<string, any>
  triggerEventId: string | null
  ctx: DispatcherContext
}): Promise<void> {
  const trigger = TRIGGERS_BY_EVENT_ID[args.eventId]
  if (!trigger) return

  const orgId: string | null = args.payload?.organizationId ?? null
  const tenantId: string | null = args.payload?.tenantId ?? null
  if (!orgId || !tenantId) return

  let knex: Knex
  let bus: any
  try {
    const em = args.ctx.resolve<EntityManager>('em')
    knex = em.getKnex()
    try { bus = args.ctx.resolve<any>('eventBus') } catch { bus = null }
  } catch (err) {
    console.error('[pipeline_automation.dispatcher] container resolve failed:', err)
    return
  }

  const rules: RuleRow[] = await knex('customer_pipeline_automation_rules')
    .where('organization_id', orgId)
    .where('tenant_id', tenantId)
    .where('trigger_key', trigger.key)
    .where('is_active', true)
    .whereNull('deleted_at')
    .select('id', 'organization_id', 'tenant_id', 'trigger_key', 'filters',
      'target_entity', 'target_pipeline_id', 'target_stage_id', 'target_lifecycle_stage',
      'target_action', 'allow_backward')

  if (!rules.length) return

  const triggerEventId = args.triggerEventId || `evt:${trigger.key}:${orgId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`

  for (const rule of rules) {
    let filters: Record<string, unknown>
    try {
      filters = parseFilters(rule.filters)
    } catch (err) {
      filters = {}
    }

    let filterMatch = false
    try {
      filterMatch = await trigger.matchesFilters(filters as any, args.payload, { knex })
    } catch (err) {
      console.error('[pipeline_automation.dispatcher] filter eval failed:', err)
      continue
    }

    if (!filterMatch) {
      continue
    }

    const targetEntity = rule.target_entity
    if (!trigger.supportedEntities.includes(targetEntity)) {
      continue
    }

    let entityId: string | null
    try {
      entityId = await trigger.resolveTargets(args.payload, targetEntity, { knex, organizationId: orgId, tenantId })
    } catch (err) {
      console.error('[pipeline_automation.dispatcher] target resolve failed:', err)
      continue
    }

    if (!entityId) continue

    if (await isIdempotentDuplicate(knex, rule.id, entityId, triggerEventId)) {
      await recordRun(knex, {
        ruleId: rule.id,
        organizationId: orgId,
        tenantId,
        triggerEventId,
        triggerEventKey: trigger.key,
        entityType: targetEntity,
        entityId,
        fromStage: null,
        toStage: null,
        outcome: 'skipped_idempotent',
      })
      continue
    }

    try {
      const result = targetEntity === 'deal'
        ? await applyDealAction(
            { knex, organizationId: orgId, tenantId, bus },
            {
              dealId: entityId,
              targetAction: rule.target_action,
              targetPipelineId: rule.target_pipeline_id,
              targetStageId: rule.target_stage_id,
              allowBackward: rule.allow_backward,
            },
          )
        : await applyPersonAction(
            { knex, organizationId: orgId, tenantId, bus },
            {
              personId: entityId,
              targetLifecycleStage: rule.target_lifecycle_stage,
              allowBackward: rule.allow_backward,
            },
          )

      await recordRun(knex, {
        ruleId: rule.id,
        organizationId: orgId,
        tenantId,
        triggerEventId,
        triggerEventKey: trigger.key,
        entityType: targetEntity,
        entityId,
        fromStage: result.fromStage,
        toStage: result.toStage,
        outcome: result.outcome,
        error: result.error ?? null,
      })
    } catch (err) {
      console.error('[pipeline_automation.dispatcher] apply failed:', err)
      await recordRun(knex, {
        ruleId: rule.id,
        organizationId: orgId,
        tenantId,
        triggerEventId,
        triggerEventKey: trigger.key,
        entityType: targetEntity,
        entityId,
        fromStage: null,
        toStage: null,
        outcome: 'failed',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
