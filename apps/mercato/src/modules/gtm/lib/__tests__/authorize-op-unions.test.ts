import { z } from 'zod'
import * as validators from '../../data/validators'
import {
  autoRefillFeatureForOp,
  campaignFeatureForOp,
  candidateFeatureForOp,
  chatFeatureForOp,
  decisionMakerFeatureForOp,
  enrichmentFeatureForOp,
  executionFeatureForOp,
  handoffFeatureForOp,
  inboxFeatureForOp,
  privacyFeatureForOp,
  reconciliationFeatureForOp,
  researchFeatureForOp,
  socialConnectionFeatureForOp,
  strategyFeatureForOp,
  taskFeatureForOp,
  type GtmFeature,
} from '../authorize'

/*
 * Every *FeatureForOp table is checked against the ops its validator actually
 * accepts (review M14): an op added to a validator but not to the read set is
 * caught, and no write op can ever resolve to gtm.view. The read allowlists
 * below are the product contract; anything else is a mutation.
 */

function opsOf(schema: z.ZodType): string[] {
  const def = (schema as unknown as { _zod: { def: Record<string, unknown> } })._zod.def
  if (def.type === 'union') {
    return (def.options as z.ZodType[]).map((option) => {
      const shape = (option as unknown as { _zod: { def: { shape: Record<string, z.ZodType> } } })._zod.def.shape
      const literal = (shape.op as unknown as { _zod: { def: { values: unknown[] } } })._zod.def.values[0]
      return String(literal)
    })
  }
  const shape = def.shape as Record<string, z.ZodType>
  let opDef = (shape.op as unknown as { _zod: { def: Record<string, unknown> } })._zod.def
  while (opDef.innerType) {
    opDef = (opDef.innerType as unknown as { _zod: { def: Record<string, unknown> } })._zod.def
  }
  return Object.values(opDef.entries as Record<string, unknown>).map(String)
}

type Table = {
  name: string
  schema: z.ZodType
  resolve: (op: string) => GtmFeature
  readOps: string[]
  // ops that must resolve to exactly this elevated feature
  elevated?: Record<string, GtmFeature>
}

const TABLES: Table[] = [
  {
    name: 'campaigns',
    schema: validators.gtmCampaignsBodySchema,
    resolve: campaignFeatureForOp,
    readOps: ['list', 'analytics', 'draft-state', 'list-senders', 'status'],
    elevated: { approve: 'gtm.approve' },
  },
  {
    name: 'execution',
    schema: validators.gtmExecutionBodySchema,
    resolve: executionFeatureForOp,
    readOps: ['status', 'cursor-status'],
    elevated: {
      launch: 'gtm.launch',
      tick: 'gtm.launch',
      'clear-mailbox-pause': 'gtm.launch',
      'pause-campaign': 'gtm.launch',
      'stop-campaign': 'gtm.launch',
    },
  },
  {
    name: 'reconciliation',
    schema: validators.gtmReconciliationBodySchema,
    resolve: reconciliationFeatureForOp,
    readOps: ['list', 'history', 'catalog', 'ai-telemetry', 'opportunity-quality'],
    elevated: { apply: 'gtm.approve', 'repair-run-summaries': 'gtm.approve' },
  },
  {
    name: 'candidates',
    schema: validators.gtmCandidatesBodySchema,
    resolve: candidateFeatureForOp,
    readOps: ['list', 'detail'],
  },
  {
    name: 'manual-outreach (borrows the candidate table)',
    schema: validators.gtmManualOutreachBodySchema,
    resolve: candidateFeatureForOp,
    readOps: ['list'],
  },
  {
    name: 'chat',
    schema: validators.gtmChatBodySchema,
    resolve: chatFeatureForOp,
    readOps: ['thread-list', 'messages'],
  },
  {
    name: 'enrich',
    schema: validators.gtmEnrichBodySchema,
    resolve: enrichmentFeatureForOp,
    readOps: ['plan', 'status'],
    elevated: { run: 'gtm.launch' },
  },
  {
    name: 'decision-makers',
    schema: validators.gtmDecisionMakersBodySchema,
    resolve: decisionMakerFeatureForOp,
    readOps: ['plan', 'status'],
    elevated: { run: 'gtm.launch' },
  },
  {
    name: 'inbox',
    schema: validators.gtmInboxBodySchema,
    resolve: inboxFeatureForOp,
    readOps: ['list', 'thread'],
    elevated: { 'approve-draft': 'gtm.launch' },
  },
  {
    name: 'handoff',
    schema: validators.gtmHandoffBodySchema,
    resolve: handoffFeatureForOp,
    readOps: ['assets-list', 'asset-status'],
    elevated: { 'asset-request': 'gtm.approve' },
  },
  {
    name: 'research-runs',
    schema: validators.gtmResearchRunsBodySchema,
    resolve: researchFeatureForOp,
    readOps: ['list', 'plan', 'status'],
    elevated: { execute: 'gtm.launch', 'retention-sweep': 'gtm.launch' },
  },
  {
    name: 'auto-refill',
    schema: validators.gtmAutoRefillBodySchema,
    resolve: autoRefillFeatureForOp,
    readOps: ['plan', 'status'],
    elevated: { activate: 'gtm.launch', pause: 'gtm.launch' },
  },
  {
    name: 'strategy',
    schema: validators.gtmStrategyBodySchema,
    resolve: strategyFeatureForOp,
    readOps: ['icp-list', 'icp-get', 'voice-list', 'voice-get'],
  },
  {
    name: 'tasks',
    schema: validators.gtmTasksBodySchema,
    resolve: taskFeatureForOp,
    readOps: ['list', 'timeline'],
    elevated: { 'override-dependency': 'gtm.launch' },
  },
  {
    name: 'social-connections',
    schema: validators.gtmSocialConnectionsBodySchema,
    resolve: socialConnectionFeatureForOp,
    readOps: ['list'],
  },
  {
    name: 'privacy',
    schema: validators.gtmPrivacyBodySchema,
    resolve: privacyFeatureForOp,
    readOps: ['status', 'list-partial'],
    elevated: {
      'complete-crm-contact-deletion': 'gtm.approve',
      'set-legal-hold': 'gtm.approve',
      'clear-legal-hold': 'gtm.approve',
    },
  },
]

describe('GTM feature tables versus validator op unions', () => {
  describe.each(TABLES)('$name', (table) => {
    it('lists only ops the validator accepts as reads, and never maps a write op to gtm.view', () => {
      const ops = opsOf(table.schema)
      expect(ops.length).toBeGreaterThan(0)
      for (const readOp of table.readOps) expect(ops).toContain(readOp)
      for (const op of ops) {
        const feature = table.resolve(op)
        if (table.readOps.includes(op)) {
          expect({ op, feature }).toEqual({ op, feature: 'gtm.view' })
        } else {
          expect({ op, feature }).not.toEqual({ op, feature: 'gtm.view' })
        }
      }
    })

    it('keeps elevated ops on their elevated feature', () => {
      for (const [op, feature] of Object.entries(table.elevated ?? {})) {
        expect({ op, feature: table.resolve(op) }).toEqual({ op, feature })
      }
    })

    it('treats an unknown op as a mutation', () => {
      expect(table.resolve('definitely-not-an-op')).not.toBe('gtm.view')
    })
  })
})
