import type { EntityManager } from '@mikro-orm/postgresql'
import { BusinessRule } from '@open-mercato/core/modules/business_rules/data/entities'

export type WorkflowSeedOperation = {
  kind: 'workflow' | 'rules'
  fileName: string
}

const independentWorkflowSeedPlan: readonly WorkflowSeedOperation[] = [
  { kind: 'workflow', fileName: 'simple-approval-definition.json' },
]

const ruleBackedWorkflowSeedPlan: readonly WorkflowSeedOperation[] = [
  { kind: 'workflow', fileName: 'checkout-demo-definition.json' },
  { kind: 'rules', fileName: 'guard-rules-example.json' },
  { kind: 'workflow', fileName: 'sales-pipeline-definition.json' },
  ...independentWorkflowSeedPlan,
  { kind: 'rules', fileName: 'order-approval-guard-rules.json' },
  { kind: 'workflow', fileName: 'order-approval-definition.json' },
]

export function selectExampleWorkflowSeedPlan(em: EntityManager): readonly WorkflowSeedOperation[] {
  return em.getMetadata().find(BusinessRule)
    ? ruleBackedWorkflowSeedPlan
    : independentWorkflowSeedPlan
}
