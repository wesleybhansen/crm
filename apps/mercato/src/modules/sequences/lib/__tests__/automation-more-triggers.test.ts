jest.mock('@open-mercato/shared/lib/encryption/decryptRows', () => ({
  ...jest.requireActual('@open-mercato/shared/lib/encryption/decryptRows'),
  decryptRowFields: jest.fn(async (_em: unknown, _key: string, rows: unknown[]) => rows),
}))
jest.mock('../../../email/lib/email-router', () => ({
  sendEmailByPurpose: jest.fn(async () => ({ ok: false, error: 'email is not sent in tests' })),
}))

import { createFakeDb } from '../../../../lib/__tests__/support/fake-db'
import { dispatchCourseEnrolled } from '../automation-dispatch'
import { dispatchOverdueInvoices, OVERDUE_LOOKBACK_DAYS } from '../invoice-overdue'
import dealCreated from '../../subscribers/automation-deal-created'
import dealLost from '../../subscribers/automation-deal-lost'
import contactUpdated from '../../subscribers/automation-contact-updated'
import companyCreated from '../../subscribers/automation-company-created'

/**
 * The six builder triggers that never fired: Deal Created, Deal Lost, Contact
 * Updated, Company Created, Invoice Overdue and Course Enrolled. Each now
 * runs its rules once per real event through the same exactly-once ledger
 * (automation_trigger_dispatches) as deal won / invoice paid.
 */

const ORG = 'org-1'
const TENANT = 'ten-1'
const OTHER_ORG = 'org-2'
const OTHER_TENANT = 'ten-2'
const DEAL = 'deal-1'
const CONTACT = 'contact-1'
const PERSON_PROFILE = 'person-profile-1'
const COMPANY = 'company-1'
const COMPANY_PROFILE = 'company-profile-1'
const DAY = 24 * 60 * 60 * 1000

type Rule = { trigger_type: string; action_config?: Record<string, unknown>; trigger_config?: Record<string, unknown>; organization_id?: string; tenant_id?: string; is_active?: boolean }

function world(rules: Rule[], extra: Record<string, Array<Record<string, unknown>>> = {}) {
  const knex = createFakeDb(
    {
      automation_rules: rules.map((r, i) => ({
        id: `rule-${i + 1}`,
        organization_id: r.organization_id ?? ORG,
        tenant_id: r.tenant_id ?? TENANT,
        is_active: r.is_active ?? true,
        trigger_config: JSON.stringify(r.trigger_config ?? {}),
        action_config: JSON.stringify(r.action_config ?? { taskTitle: `task for rule-${i + 1}` }),
        conditions: null,
        steps: null,
        trigger_type: r.trigger_type,
        action_type: 'create_task',
      })),
      automation_rule_logs: [],
      automation_trigger_dispatches: [],
      tasks: [],
      customer_deals: [
        { id: DEAL, organization_id: ORG, tenant_id: TENANT, title: '12 Ocean Ave', pipeline_id: 'p-1', pipeline_stage: 'New Lead', status: 'open', value_amount: '900000', deleted_at: null },
      ],
      customer_deal_people: [{ id: 'link-1', deal_id: DEAL, person_entity_id: CONTACT, created_at: new Date('2026-09-01') }],
      customer_entities: [
        { id: CONTACT, kind: 'person', organization_id: ORG, tenant_id: TENANT, display_name: 'Dana Buyer', source: 'referral', updated_at: new Date('2026-09-30T10:00:00Z'), deleted_at: null },
        { id: COMPANY, kind: 'company', organization_id: ORG, tenant_id: TENANT, display_name: 'Acme Escrow', source: 'manual', updated_at: new Date('2026-09-30T10:00:00Z'), deleted_at: null },
      ],
      customer_people: [{ id: PERSON_PROFILE, entity_id: CONTACT, organization_id: ORG, tenant_id: TENANT }],
      customer_companies: [{ id: COMPANY_PROFILE, entity_id: COMPANY, organization_id: ORG, tenant_id: TENANT }],
      invoices: [],
      sequences: [],
      sequence_enrollments: [],
      sequence_steps: [],
      sequence_step_executions: [],
      ...extra,
    },
    { automation_trigger_dispatches: [['organization_id', 'trigger_type', 'event_key']] },
  )
  const ctx = { resolve: <T,>() => ({ getKnex: () => knex }) as T }
  return { knex, ctx }
}

const scope = { organizationId: ORG, tenantId: TENANT }
const tasks = (knex: ReturnType<typeof world>['knex']) => knex.db.tables.tasks as Array<Record<string, unknown>>

describe('Deal Created', () => {
  it('runs once per deal, with the deal and its contact, on both deliveries of the event', async () => {
    const { knex, ctx } = world([{ trigger_type: 'deal_created' }, { trigger_type: 'deal_won' }])
    const payload = { id: DEAL, ...scope }
    await dealCreated(payload, ctx)
    await dealCreated(payload, ctx)
    expect(tasks(knex)).toHaveLength(1)
    expect(tasks(knex)[0]).toMatchObject({ title: 'task for rule-1', deal_id: DEAL, contact_id: CONTACT, organization_id: ORG })
  })

  it('honours a pipeline filter and ignores another organization’s deal', async () => {
    const { knex, ctx } = world([{ trigger_type: 'deal_created', trigger_config: { pipelineId: 'p-other' } }])
    await dealCreated({ id: DEAL, ...scope }, ctx)
    await dealCreated({ id: DEAL, organizationId: OTHER_ORG, tenantId: OTHER_TENANT }, ctx)
    expect(tasks(knex)).toHaveLength(0)
  })
})

describe('Deal Lost', () => {
  it('runs once per loss; lost again after a reopen runs again', async () => {
    const { knex, ctx } = world([{ trigger_type: 'deal_lost' }, { trigger_type: 'deal_won' }])
    const loss = { id: DEAL, ...scope, lostAt: '2026-09-30T16:00:00.000Z', stage: 'Lost', status: 'lost' }
    await dealLost(loss, ctx)
    await dealLost(loss, ctx)
    expect(tasks(knex)).toHaveLength(1)
    expect(tasks(knex)[0]).toMatchObject({ title: 'task for rule-1', deal_id: DEAL, contact_id: CONTACT })

    await dealLost({ ...loss, lostAt: '2026-10-08T12:00:00.000Z' }, ctx)
    expect(tasks(knex)).toHaveLength(2)
  })
})

describe('Contact Updated', () => {
  it('runs once per save: both deliveries of one save share its eventId', async () => {
    const { knex, ctx } = world([{ trigger_type: 'contact_updated' }])
    const save = { id: PERSON_PROFILE, ...scope, eventId: 'evt-1' }
    await contactUpdated(save, ctx)
    await contactUpdated(save, ctx)
    expect(tasks(knex)).toHaveLength(1)
    expect(tasks(knex)[0]).toMatchObject({ contact_id: CONTACT })

    await contactUpdated({ ...save, eventId: 'evt-2' }, ctx)
    expect(tasks(knex)).toHaveLength(2)
  })

  it('honours the source filter and never runs for a company or another org', async () => {
    const { knex, ctx } = world([{ trigger_type: 'contact_updated', trigger_config: { source: 'website' } }, { trigger_type: 'contact_updated', trigger_config: { source: 'referral' } }])
    await contactUpdated({ id: PERSON_PROFILE, ...scope, eventId: 'evt-1' }, ctx)
    await contactUpdated({ id: COMPANY, ...scope, eventId: 'evt-2' }, ctx)
    await contactUpdated({ id: PERSON_PROFILE, organizationId: OTHER_ORG, tenantId: OTHER_TENANT, eventId: 'evt-3' }, ctx)
    expect(tasks(knex)).toHaveLength(1)
    expect(tasks(knex)[0]).toMatchObject({ title: 'task for rule-2' })
  })

  it('falls back to the contact’s updated_at when an event has no eventId', async () => {
    const { knex, ctx } = world([{ trigger_type: 'contact_updated' }])
    await contactUpdated({ id: CONTACT, ...scope }, ctx)
    await contactUpdated({ id: CONTACT, ...scope }, ctx)
    expect(tasks(knex)).toHaveLength(1)
  })
})

describe('Company Created', () => {
  it('runs once per company, with the company as the rule’s contact', async () => {
    const { knex, ctx } = world([{ trigger_type: 'company_created' }, { trigger_type: 'contact_created' }])
    await companyCreated({ id: COMPANY_PROFILE, ...scope }, ctx)
    await companyCreated({ id: COMPANY_PROFILE, ...scope }, ctx)
    await companyCreated({ id: COMPANY, ...scope }, ctx)
    expect(tasks(knex)).toHaveLength(1)
    expect(tasks(knex)[0]).toMatchObject({ title: 'task for rule-1', contact_id: COMPANY })
  })

  it('does not treat a person as a company', async () => {
    const { knex, ctx } = world([{ trigger_type: 'company_created' }])
    await companyCreated({ id: CONTACT, ...scope }, ctx)
    expect(tasks(knex)).toHaveLength(0)
  })
})

describe('Course Enrolled', () => {
  it('runs rules and course sequences once per enrollment, filtered by course', async () => {
    const { knex } = world(
      [{ trigger_type: 'course_enrolled' }, { trigger_type: 'course_enrolled', trigger_config: { courseId: 'course-other' } }],
      {
        sequences: [
          { id: 'seq-1', organization_id: ORG, tenant_id: TENANT, trigger_type: 'course_enrolled', status: 'active', deleted_at: null, name: 'Welcome students', trigger_config: JSON.stringify({ courseId: 'course-1' }) },
          { id: 'seq-2', organization_id: ORG, tenant_id: TENANT, trigger_type: 'course_enrolled', status: 'active', deleted_at: null, name: 'Other course', trigger_config: JSON.stringify({ courseId: 'course-other' }) },
        ],
      },
    )
    const enrollment = { ...scope, enrollmentId: 'enr-1', courseId: 'course-1', contactId: CONTACT, courseTitle: 'Listing Photos 101', paid: true }
    await expect(dispatchCourseEnrolled(knex as any, enrollment)).resolves.toEqual({ dispatched: true })
    await expect(dispatchCourseEnrolled(knex as any, enrollment)).resolves.toEqual({ dispatched: false })

    expect(tasks(knex)).toHaveLength(1)
    expect(tasks(knex)[0]).toMatchObject({ title: 'task for rule-1', contact_id: CONTACT })
    expect(knex.db.tables.sequence_enrollments).toHaveLength(1)
    expect(knex.db.tables.sequence_enrollments[0]).toMatchObject({ sequence_id: 'seq-1', contact_id: CONTACT, organization_id: ORG })
  })
})

describe('Invoice Overdue', () => {
  const now = new Date('2026-10-10T15:00:00.000Z')
  const dueDaysAgo = (days: number) => new Date(Date.UTC(2026, 9, 10 - days))
  const invoice = (id: string, due: Date, overrides: Record<string, unknown> = {}) => ({
    id, organization_id: ORG, tenant_id: TENANT, contact_id: CONTACT, invoice_number: id.toUpperCase(), total: '450.00', status: 'sent', due_date: due, deleted_at: null, ...overrides,
  })

  it('fires once per invoice the day after it is due, never on its due day, never twice', async () => {
    const { knex } = world([{ trigger_type: 'invoice_overdue' }], {
      invoices: [
        invoice('inv-due-today', dueDaysAgo(0)),
        invoice('inv-yesterday', dueDaysAgo(1)),
        invoice('inv-paid', dueDaysAgo(2), { status: 'paid' }),
        invoice('inv-draft', dueDaysAgo(2), { status: 'draft' }),
        invoice('inv-deleted', dueDaysAgo(2), { deleted_at: new Date() }),
        invoice('inv-other-org', dueDaysAgo(2), { organization_id: OTHER_ORG, tenant_id: OTHER_TENANT }),
        invoice('inv-ancient', dueDaysAgo(90)),
      ],
    })
    const first = await dispatchOverdueInvoices(knex as any, scope, { now })
    expect(first).toMatchObject({ rules: 1, thresholds: [1], candidates: 1, dispatched: 1 })
    expect(tasks(knex)).toHaveLength(1)
    expect(tasks(knex)[0]).toMatchObject({ contact_id: CONTACT, organization_id: ORG })

    expect(knex.db.tables.automation_trigger_dispatches.map((row: { event_key: string }) => row.event_key))
      .toEqual(['invoice:inv-yesterday:due:2026-10-09:after:1d'])

    // The cron runs again ten minutes later: nothing new.
    await dispatchOverdueInvoices(knex as any, scope, { now: new Date(now.getTime() + 10 * 60 * 1000) })
    expect(tasks(knex)).toHaveLength(1)

    // Tomorrow the invoice due today is overdue: it fires once; yesterday's does not repeat.
    await dispatchOverdueInvoices(knex as any, scope, { now: new Date(now.getTime() + DAY) })
    await dispatchOverdueInvoices(knex as any, scope, { now: new Date(now.getTime() + DAY + 10 * 60 * 1000) })
    expect(tasks(knex)).toHaveLength(2)
    expect(knex.db.tables.automation_trigger_dispatches.map((row: { event_key: string }) => row.event_key)).toEqual([
      'invoice:inv-yesterday:due:2026-10-09:after:1d',
      'invoice:inv-due-today:due:2026-10-10:after:1d',
    ])
  })

  it('a rule with "Days overdue" waits for its own threshold, and each rule runs once', async () => {
    const { knex } = world(
      [{ trigger_type: 'invoice_overdue' }, { trigger_type: 'invoice_overdue', trigger_config: { daysOverdue: 7 } }],
      { invoices: [invoice('inv-1', dueDaysAgo(1))] },
    )
    for (let day = 0; day <= 9; day++) {
      await dispatchOverdueInvoices(knex as any, scope, { now: new Date(now.getTime() + day * DAY) })
    }
    expect(tasks(knex).map((t) => t.title)).toEqual(['task for rule-1', 'task for rule-2'])
    expect(knex.db.tables.automation_rule_logs).toHaveLength(2)
  })

  it(`skips invoices that went overdue more than ${OVERDUE_LOOKBACK_DAYS} days ago, and does nothing without a rule`, async () => {
    const { knex } = world([], { invoices: [invoice('inv-1', dueDaysAgo(1))] })
    await expect(dispatchOverdueInvoices(knex as any, scope, { now })).resolves.toMatchObject({ rules: 0, dispatched: 0 })

    const late = world([{ trigger_type: 'invoice_overdue' }], { invoices: [invoice('inv-2', dueDaysAgo(2 + OVERDUE_LOOKBACK_DAYS))] })
    await expect(dispatchOverdueInvoices(late.knex as any, scope, { now })).resolves.toMatchObject({ candidates: 0, dispatched: 0 })
  })

  it('dry run counts without dispatching', async () => {
    const { knex } = world([{ trigger_type: 'invoice_overdue' }], { invoices: [invoice('inv-1', dueDaysAgo(1))] })
    await expect(dispatchOverdueInvoices(knex as any, scope, { now, dryRun: true })).resolves.toMatchObject({ candidates: 1, dispatched: 0, dryRun: true })
    expect(tasks(knex)).toHaveLength(0)
    expect(knex.db.tables.automation_trigger_dispatches).toHaveLength(0)
  })
})
