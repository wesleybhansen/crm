jest.mock('@open-mercato/shared/lib/encryption/decryptRows', () => ({
  ...jest.requireActual('@open-mercato/shared/lib/encryption/decryptRows'),
  decryptRowFields: jest.fn(async (_em: unknown, _key: string, rows: unknown[]) => rows),
}))
jest.mock('../template-vars', () => ({
  ...jest.requireActual('../template-vars'),
  buildSenderContext: jest.fn(async () => ({ first_name: 'Cecilia', business_name: 'Agraz Homes', review_url: 'https://g.page/r/review' })),
  recordReviewRequest: jest.fn(async () => undefined),
}))
jest.mock('../../../email/lib/email-router', () => ({
  sendEmailByPurpose: jest.fn(async () => ({ ok: false, error: 'email is not sent in tests' })),
}))
jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(async () => ({ resolve: () => ({}) })),
}))
jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn(async () => ({ primaryEmail: 'dana@example.com', displayName: 'Dana Buyer' })),
}))

import { createFakeDb } from '../../../../lib/__tests__/support/fake-db'
import { executeAutomationRules, processScheduledSteps, runAutomationRuleNow, summarizeAutomationRun } from '../automation-execute'
import { dispatchContactCreated } from '../automation-dispatch'
import { checkSequenceTriggers } from '../../services/sequence-triggers'
import contactCreated from '../../subscribers/automation-contact-created'

/*
 * The five automation bugs a docs review found (2026-09-29), each proven
 * against the real executor on an in-memory database:
 *  1. a trigger set to one specific tag never fired (id vs slug);
 *  2. "Contact created" never fired for a contact added by hand;
 *  3. builder conditions were ignored;
 *  4. steps after a Wait never ran;
 *  5. Test with dry run off ran nothing.
 */

const ORG = 'org-1'
const TENANT = 'ten-1'
const CONTACT = 'contact-1'
const PROFILE = 'profile-1'
const TAG_ID = '3f0c2a1e-7b7d-4a52-9d51-6c1f0f8e2b11'
const scope = { organizationId: ORG, tenantId: TENANT }

type RuleSpec = {
  trigger_type: string
  action_type?: string
  action_config?: Record<string, unknown>
  trigger_config?: Record<string, unknown>
  conditions?: unknown[]
  steps?: unknown[]
  is_active?: boolean
  tenant_id?: string
}

function world(rules: RuleSpec[], extra: Record<string, Array<Record<string, unknown>>> = {}) {
  const knex = createFakeDb(
    {
      automation_rules: rules.map((r, i) => ({
        id: `rule-${i + 1}`,
        name: `Rule ${i + 1}`,
        organization_id: ORG,
        tenant_id: r.tenant_id ?? TENANT,
        is_active: r.is_active ?? true,
        status: r.is_active === false ? 'paused' : 'active',
        trigger_type: r.trigger_type,
        trigger_config: JSON.stringify(r.trigger_config ?? {}),
        action_type: r.action_type ?? 'create_task',
        action_config: JSON.stringify(r.action_config ?? {}),
        conditions: r.conditions ? JSON.stringify(r.conditions) : null,
        steps: r.steps ? JSON.stringify(r.steps) : null,
      })),
      automation_rule_logs: [],
      automation_trigger_dispatches: [],
      automation_scheduled_steps: [],
      tasks: [],
      customer_people: [{ id: PROFILE, entity_id: CONTACT, organization_id: ORG, tenant_id: TENANT }],
      customer_entities: [{
        id: CONTACT, organization_id: ORG, tenant_id: TENANT, kind: 'person', display_name: 'Dana Buyer',
        primary_email: 'dana@example.com', primary_phone: null, source: 'manual', lifecycle_stage: 'prospect', deleted_at: null,
      }],
      customer_tags: [{ id: TAG_ID, organization_id: ORG, tenant_id: TENANT, slug: 'vip-client', label: 'VIP Client' }],
      customer_tag_assignments: [{ id: 'cta-1', organization_id: ORG, tenant_id: TENANT, entity_id: CONTACT, tag_id: TAG_ID }],
      sequences: [],
      sequence_enrollments: [],
      sequence_steps: [],
      sequence_step_executions: [],
      contact_timeline_events: [],
      ...extra,
    },
    { automation_trigger_dispatches: [['organization_id', 'trigger_type', 'event_key']] },
  )
  const ctx = { resolve: <T,>() => ({ getKnex: () => knex }) as T }
  return { knex, ctx }
}

function logs(knex: ReturnType<typeof world>['knex']) {
  return knex.db.tables.automation_rule_logs.map((l) => ({ ...l, action_result: JSON.parse(String(l.action_result)) }))
}

// What POST /api/crm-contact-tags passes when it assigns the VIP tag.
const tagAdded = { contactId: CONTACT, tagId: TAG_ID, tagSlug: 'vip-client', tagName: 'VIP Client' }

describe('1. a trigger set to one specific tag', () => {
  it('fires an automation whose tag was picked in the builder (saved by id)', async () => {
    const { knex } = world([
      { trigger_type: 'tag_added', trigger_config: { tagSlug: TAG_ID }, action_config: { taskTitle: 'Call the VIP' } },
      { trigger_type: 'tag_added', trigger_config: { tagSlug: '0b7d1f7c-0000-4000-8000-000000000000' }, action_config: { taskTitle: 'Other tag' } },
    ])
    await executeAutomationRules(knex, ORG, TENANT, 'tag_added', tagAdded)
    expect(knex.db.tables.tasks.map((t) => t.title)).toEqual(['Call the VIP'])
  })

  it('enrolls the contact in a sequence whose tag was picked in the editor (saved by id)', async () => {
    const { knex } = world([], {
      sequences: [
        { id: 'seq-vip', organization_id: ORG, tenant_id: TENANT, trigger_type: 'tag_added', status: 'active', deleted_at: null, name: 'VIP welcome', trigger_config: JSON.stringify({ tagSlug: TAG_ID }) },
        { id: 'seq-recipe', organization_id: ORG, tenant_id: TENANT, trigger_type: 'tag_added', status: 'active', deleted_at: null, name: 'Recipe', trigger_config: JSON.stringify({ tagSlug: 'vip-client' }) },
        { id: 'seq-other', organization_id: ORG, tenant_id: TENANT, trigger_type: 'tag_added', status: 'active', deleted_at: null, name: 'Other', trigger_config: JSON.stringify({ tagSlug: 'new-lead' }) },
      ],
      sequence_steps: [
        { id: 'st-1', sequence_id: 'seq-vip', step_order: 1, step_type: 'email', config: '{}' },
        { id: 'st-2', sequence_id: 'seq-recipe', step_order: 1, step_type: 'email', config: '{}' },
      ],
    })
    await checkSequenceTriggers(knex, ORG, TENANT, 'tag_added', tagAdded)
    expect(knex.db.tables.sequence_enrollments.map((e) => e.sequence_id).sort()).toEqual(['seq-recipe', 'seq-vip'])
  })
})

describe('2. "Contact created" for a contact added by hand', () => {
  it('the customers.person.created subscriber runs contact_created rules and sequences once', async () => {
    const { knex, ctx } = world(
      [
        { trigger_type: 'contact_created', action_config: { taskTitle: 'Welcome call' } },
        { trigger_type: 'contact_created', trigger_config: { source: 'manual' }, action_config: { taskTitle: 'Manual only' } },
        { trigger_type: 'contact_created', trigger_config: { source: 'form' }, action_config: { taskTitle: 'Forms only' } },
      ],
      {
        sequences: [{ id: 'seq-new', organization_id: ORG, tenant_id: TENANT, trigger_type: 'contact_created', status: 'active', deleted_at: null, name: 'New contact', trigger_config: null }],
        sequence_steps: [{ id: 'st-1', sequence_id: 'seq-new', step_order: 1, step_type: 'email', config: '{}' }],
      },
    )
    // The create command emits the person PROFILE id.
    const payload = { id: PROFILE, organizationId: ORG, tenantId: TENANT }
    await contactCreated(payload, ctx)
    await contactCreated(payload, ctx)
    expect(knex.db.tables.tasks.map((t) => t.title).sort()).toEqual(['Manual only', 'Welcome call'])
    expect(knex.db.tables.tasks.every((t) => t.contact_id === CONTACT)).toBe(true)
    expect(knex.db.tables.sequence_enrollments).toHaveLength(1)
    expect(knex.db.tables.sequence_enrollments[0]).toMatchObject({ sequence_id: 'seq-new', contact_id: CONTACT })

    // The import / form paths claim the same key: never a second welcome.
    await dispatchContactCreated(knex, { ...scope, contactId: CONTACT, source: 'import' })
    expect(knex.db.tables.tasks).toHaveLength(2)
  })

  it('ignores a person from another tenant', async () => {
    const { knex, ctx } = world([{ trigger_type: 'contact_created', action_config: { taskTitle: 'Welcome call' } }])
    await contactCreated({ id: PROFILE, organizationId: ORG, tenantId: 'ten-2' }, ctx)
    expect(knex.db.tables.tasks).toHaveLength(0)
  })
})

describe('3. builder conditions', () => {
  it('"Lifecycle Stage equals customer" skips a prospect (it used to run for everyone)', async () => {
    const { knex } = world([
      { trigger_type: 'tag_added', action_config: { taskTitle: 'Customers only' }, conditions: [{ field: 'lifecycle_stage', operator: 'equals', value: 'customer' }] },
      { trigger_type: 'tag_added', action_config: { taskTitle: 'Has an email' }, conditions: [{ field: 'primary_email', operator: 'is_set' }] },
    ])
    await executeAutomationRules(knex, ORG, TENANT, 'tag_added', tagAdded)
    expect(knex.db.tables.tasks.map((t) => t.title)).toEqual(['Has an email'])
    const skipped = logs(knex).find((l) => l.rule_id === 'rule-1')
    expect(skipped).toMatchObject({ status: 'skipped' })
    expect(skipped!.action_result.reason).toBe('lifecycle_stage equals customer failed (got: prospect)')

    knex.db.tables.customer_entities[0]!.lifecycle_stage = 'customer'
    await executeAutomationRules(knex, ORG, TENANT, 'tag_added', tagAdded)
    expect(knex.db.tables.tasks.map((t) => t.title)).toEqual(['Has an email', 'Customers only', 'Has an email'])
  })

  it('an operator the runner does not know skips the rule and logs why', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const { knex } = world([
      { trigger_type: 'tag_added', action_config: { taskTitle: 'Never' }, conditions: [{ field: 'source', operator: 'sounds_like', value: 'web' }] },
    ])
    await executeAutomationRules(knex, ORG, TENANT, 'tag_added', tagAdded)
    expect(knex.db.tables.tasks).toHaveLength(0)
    expect(logs(knex)[0]).toMatchObject({ status: 'skipped', action_result: { reason: 'Unknown condition operator "sounds_like"' } })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('never runs another tenant’s rules', async () => {
    const { knex } = world([{ trigger_type: 'tag_added', action_config: { taskTitle: 'x' }, tenant_id: 'ten-2' }])
    await executeAutomationRules(knex, ORG, TENANT, 'tag_added', tagAdded)
    expect(knex.db.tables.tasks).toHaveLength(0)
  })
})

describe('4. steps after a Wait', () => {
  const steps = [
    { type: 'action', actionType: 'create_task', actionConfig: { taskTitle: 'Step one' } },
    { type: 'delay', delayMinutes: 60 },
    { type: 'action', actionType: 'create_task', actionConfig: { taskTitle: 'Step three' } },
  ]

  it('parks the rest and the scheduler runs it when due', async () => {
    const { knex } = world([{ trigger_type: 'tag_added', steps }])
    await executeAutomationRules(knex, ORG, TENANT, 'tag_added', tagAdded)
    expect(knex.db.tables.tasks.map((t) => t.title)).toEqual(['Step one'])
    const [parked] = knex.db.tables.automation_scheduled_steps
    expect(parked).toMatchObject({ organization_id: ORG, tenant_id: TENANT, rule_id: 'rule-1', contact_id: CONTACT, current_step: 2, status: 'pending' })
    expect((parked!.execute_at as Date).getTime()).toBeGreaterThan(Date.now() + 59 * 60_000)

    // Not due yet: nothing runs.
    expect(await processScheduledSteps(knex)).toEqual({ processed: 0, total: 0 })

    parked!.execute_at = new Date(Date.now() - 1000)
    expect(await processScheduledSteps(knex)).toEqual({ processed: 1, total: 1 })
    expect(knex.db.tables.tasks.map((t) => t.title)).toEqual(['Step one', 'Step three'])
    expect(parked!.status).toBe('completed')
    expect(await processScheduledSteps(knex)).toEqual({ processed: 0, total: 0 })
  })

  it('skips the rest when the rule was paused meanwhile', async () => {
    const { knex } = world([{ trigger_type: 'tag_added', steps }])
    await executeAutomationRules(knex, ORG, TENANT, 'tag_added', tagAdded)
    knex.db.tables.automation_rules[0]!.is_active = false
    knex.db.tables.automation_scheduled_steps[0]!.execute_at = new Date(Date.now() - 1000)
    await processScheduledSteps(knex)
    expect(knex.db.tables.tasks.map((t) => t.title)).toEqual(['Step one'])
    expect(knex.db.tables.automation_scheduled_steps[0]!.status).toBe('skipped')
  })

  it('a Wait that cannot be parked fails that rule only, and the others still run', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {})
    const { knex } = world([
      { trigger_type: 'tag_added', steps },
      { trigger_type: 'tag_added', action_config: { taskTitle: 'Second rule' } },
    ])
    // The production database had no automation_scheduled_steps table.
    const realKnex = knex
    const broken: any = (table: string) => {
      if (table === 'automation_scheduled_steps') throw new Error('relation "automation_scheduled_steps" does not exist')
      return realKnex(table)
    }
    broken.raw = realKnex.raw
    await executeAutomationRules(broken, ORG, TENANT, 'tag_added', tagAdded)
    expect(knex.db.tables.tasks.map((t) => t.title)).toEqual(['Step one', 'Second rule'])
    expect(logs(knex).some((l) => l.rule_id === 'rule-1' && l.status === 'failed')).toBe(true)
    err.mockRestore()
  })
})

describe('5. Test with dry run off', () => {
  it('really runs the rule for the contact and reports each step', async () => {
    const { knex } = world([{
      trigger_type: 'tag_added',
      steps: [
        { type: 'action', actionType: 'create_task', actionConfig: { taskTitle: 'Test task' } },
        { type: 'action', actionType: 'send_email', actionConfig: { subject: 'Hi', body: 'Hello' } },
        { type: 'delay', delayMinutes: 1440 },
        { type: 'action', actionType: 'create_task', actionConfig: { taskTitle: 'Later' } },
      ],
    }])
    const rule = knex.db.tables.automation_rules[0]
    const runs = await runAutomationRuleNow(knex, scope, rule, { contactId: CONTACT, triggerType: 'tag_added', _testExecution: true })
    expect(knex.db.tables.tasks.map((t) => t.title)).toEqual(['Test task'])
    expect(runs.map((r) => [r.index, r.status])).toEqual([[0, 'executed'], [1, 'failed'], [2, 'scheduled']])
    expect(knex.db.tables.automation_scheduled_steps).toHaveLength(1)
    // A send that did not happen is 'failed' in the run history, not 'executed'.
    expect(logs(knex).find((l) => l.action_result.detail?.startsWith('Email failed'))).toMatchObject({ status: 'failed' })

    const summary = summarizeAutomationRun(runs)
    expect(summary.executed).toBe(false)
    expect(summary.message).toContain('1 action done, 1 failed (Email failed: email is not sent in tests)')
    expect(summary.message).toContain('The steps after the wait are scheduled for')
  })

  it('a clean run says so', () => {
    expect(summarizeAutomationRun([{ index: 0, type: 'action', actionType: 'create_task', status: 'executed', detail: 'Task created' }]))
      .toEqual({ executed: true, message: 'Ran for real: 1 action done.' })
  })
})
