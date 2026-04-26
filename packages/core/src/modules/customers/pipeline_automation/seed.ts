import type { Knex } from 'knex'

/**
 * Default pipeline_automation rules created on tenant init and via the
 * existing-tenant backfill. Person-target only in Phase 1 — no per-org
 * lookup of pipeline/stage IDs needed at seed time. Users can add deal-target
 * custom rules from the settings UI once they know which pipeline/stage to
 * point at.
 */
export type DefaultRuleSeed = {
  name: string
  triggerKey: string
  filters: Record<string, unknown>
  targetEntity: 'person'
  targetAction: 'set_lifecycle'
  targetLifecycleStage: string
  allowBackward: boolean
}

export const DEFAULT_RULES: DefaultRuleSeed[] = [
  {
    name: 'Form submission → Lead',
    triggerKey: 'form_submitted',
    filters: {},
    targetEntity: 'person',
    targetAction: 'set_lifecycle',
    targetLifecycleStage: 'Lead',
    allowBackward: false,
  },
  {
    name: 'Payment received → Customer',
    triggerKey: 'payment_captured',
    filters: {},
    targetEntity: 'person',
    targetAction: 'set_lifecycle',
    targetLifecycleStage: 'Customer',
    allowBackward: false,
  },
  {
    name: 'Sequence completed → Engaged',
    triggerKey: 'sequence_completed',
    filters: {},
    targetEntity: 'person',
    targetAction: 'set_lifecycle',
    targetLifecycleStage: 'Engaged',
    allowBackward: false,
  },
  {
    name: 'Engagement score ≥ 50 → Hot Lead',
    triggerKey: 'engagement_threshold',
    filters: { scoreMin: 50 },
    targetEntity: 'person',
    targetAction: 'set_lifecycle',
    targetLifecycleStage: 'Hot Lead',
    allowBackward: false,
  },
]

/**
 * Insert the default rules for an org if it has no rules yet (idempotent).
 * Returns true if rules were inserted, false if the org already had rules.
 */
export async function seedDefaultRulesForOrg(
  knex: Knex,
  args: { organizationId: string; tenantId: string },
): Promise<boolean> {
  const existing = await knex('customer_pipeline_automation_rules')
    .where('organization_id', args.organizationId)
    .where('tenant_id', args.tenantId)
    .first('id')
  if (existing) return false

  const rows = DEFAULT_RULES.map((rule) => ({
    organization_id: args.organizationId,
    tenant_id: args.tenantId,
    name: rule.name,
    trigger_key: rule.triggerKey,
    filters: JSON.stringify(rule.filters),
    target_entity: rule.targetEntity,
    target_pipeline_id: null,
    target_stage_id: null,
    target_lifecycle_stage: rule.targetLifecycleStage,
    target_action: rule.targetAction,
    allow_backward: rule.allowBackward,
    is_active: true,
    created_at: new Date(),
    updated_at: new Date(),
  }))

  await knex('customer_pipeline_automation_rules').insert(rows)
  return true
}
