import type { EntityManager } from '@mikro-orm/postgresql'
import { BusinessRule } from '@open-mercato/core/modules/business_rules/data/entities'
import { selectExampleWorkflowSeedPlan } from '../seed-plan'

function createEntityManager(hasBusinessRules: boolean): EntityManager {
  return {
    getMetadata: () => ({
      find: (entity: unknown) => (hasBusinessRules && entity === BusinessRule ? {} : undefined),
    }),
  } as unknown as EntityManager
}

describe('selectExampleWorkflowSeedPlan', () => {
  it('selects only the independent example when business rules are disabled', () => {
    expect(selectExampleWorkflowSeedPlan(createEntityManager(false))).toEqual([
      { kind: 'workflow', fileName: 'simple-approval-definition.json' },
    ])
  })

  it('preserves rule-backed examples when business rules are enabled', () => {
    expect(selectExampleWorkflowSeedPlan(createEntityManager(true))).toEqual([
      { kind: 'workflow', fileName: 'checkout-demo-definition.json' },
      { kind: 'rules', fileName: 'guard-rules-example.json' },
      { kind: 'workflow', fileName: 'sales-pipeline-definition.json' },
      { kind: 'workflow', fileName: 'simple-approval-definition.json' },
      { kind: 'rules', fileName: 'order-approval-guard-rules.json' },
      { kind: 'workflow', fileName: 'order-approval-definition.json' },
    ])
  })
})
