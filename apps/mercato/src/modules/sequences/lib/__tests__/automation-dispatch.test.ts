jest.mock('@open-mercato/shared/lib/encryption/decryptRows', () => ({
  ...jest.requireActual('@open-mercato/shared/lib/encryption/decryptRows'),
  decryptRowFields: jest.fn(async (_em: unknown, _key: string, rows: unknown[]) => rows),
}))
jest.mock('@open-mercato/shared/lib/encryption/secretColumns', () => ({
  openSecretForTenant: jest.fn(async () => 'business-twilio-token'),
}))
jest.mock('../template-vars', () => ({
  ...jest.requireActual('../template-vars'),
  buildSenderContext: jest.fn(async () => ({ first_name: 'Cecilia', business_name: 'Agraz Homes', review_url: 'https://g.page/r/review' })),
  recordReviewRequest: jest.fn(async () => undefined),
}))
jest.mock('../../../email/lib/email-router', () => ({
  sendEmailByPurpose: jest.fn(async () => ({ ok: false, error: 'email is not sent in tests' })),
}))

import { createFakeDb } from '../../../../lib/__tests__/support/fake-db'
import { dispatchAutomationTrigger } from '../automation-dispatch'
import dealClosed from '../../subscribers/automation-deal-closed'
import dealStageChanged from '../../subscribers/automation-deal-stage-changed'
import personStageChanged from '../../subscribers/automation-person-stage-changed'
import invoicePaid from '../../subscribers/automation-invoice-paid'
import bookingCreated from '../../subscribers/automation-booking-created'

const ORG = 'org-1'
const TENANT = 'ten-1'
const DEAL = 'deal-1'
const CONTACT = 'contact-1'

type Rule = { trigger_type: string; action_type: string; action_config?: Record<string, unknown>; trigger_config?: Record<string, unknown>; conditions?: unknown[] }

function world(rules: Rule[], extra: Record<string, Array<Record<string, unknown>>> = {}) {
  const knex = createFakeDb(
    {
      automation_rules: rules.map((r, i) => ({
        id: `rule-${i + 1}`,
        organization_id: ORG,
        tenant_id: TENANT,
        is_active: true,
        trigger_config: JSON.stringify(r.trigger_config ?? {}),
        action_config: JSON.stringify(r.action_config ?? {}),
        conditions: r.conditions ? JSON.stringify(r.conditions) : null,
        steps: null,
        trigger_type: r.trigger_type,
        action_type: r.action_type,
      })),
      automation_rule_logs: [],
      automation_trigger_dispatches: [],
      tasks: [],
      customer_deals: [{ id: DEAL, organization_id: ORG, tenant_id: TENANT, title: '12 Ocean Ave', pipeline_id: 'p-1', pipeline_stage: 'Closed', status: 'open', value_amount: '1250000', deleted_at: null }],
      customer_deal_people: [{ id: 'link-1', deal_id: DEAL, person_entity_id: CONTACT, created_at: new Date('2026-09-01') }],
      customer_entities: [{ id: CONTACT, organization_id: ORG, tenant_id: TENANT, display_name: 'Dana Buyer', primary_phone: '(310) 555-0142', deleted_at: null }],
      invoices: [{ id: 'inv-1', organization_id: ORG, tenant_id: TENANT, contact_id: CONTACT, invoice_number: 'INV-0007', total: '450.00' }],
      bookings: [{ id: 'bk-1', organization_id: ORG, tenant_id: TENANT, contact_id: CONTACT, booking_page_id: 'bp-1', start_time: new Date('2026-10-01T17:00:00Z') }],
      sequences: [],
      sequence_enrollments: [],
      sequence_steps: [],
      sequence_step_executions: [],
      twilio_connections: [],
      sms_messages: [],
      inbox_conversations: [],
      contact_timeline_events: [],
      ...extra,
    },
    { automation_trigger_dispatches: [['organization_id', 'trigger_type', 'event_key']] },
  )
  const ctx = { resolve: <T,>() => ({ getKnex: () => knex }) as T }
  return { knex, ctx }
}

const scope = { organizationId: ORG, tenantId: TENANT }

describe('automation triggers fire once per event', () => {
  it('deal won: a "review request at closing" rule runs once per win, never twice for one event', async () => {
    const { knex, ctx } = world([
      { trigger_type: 'deal_won', action_type: 'create_task', action_config: { taskTitle: 'Ask for a review' }, conditions: [{ field: 'stage', operator: 'eq', value: 'won' }] },
    ])
    const payload = { id: DEAL, ...scope, closedAt: '2026-09-28T17:00:00.000Z', stage: 'Closed', status: 'open' }
    // The same event twice: the in-process delivery, then the queued copy (or a retry).
    await dealClosed(payload, ctx)
    await dealClosed(payload, ctx)

    expect(knex.db.tables.tasks).toHaveLength(1)
    expect(knex.db.tables.tasks[0]).toMatchObject({ title: 'Ask for a review', contact_id: CONTACT, deal_id: DEAL, organization_id: ORG })
    expect(knex.db.tables.automation_rule_logs).toHaveLength(1)
    expect(knex.db.tables.automation_rule_logs[0]).toMatchObject({ rule_id: 'rule-1', status: 'executed', contact_id: CONTACT })
  })

  it('deal won: reopened and won again fires again (each win is its own closedAt)', async () => {
    const { knex, ctx } = world([
      { trigger_type: 'deal_won', action_type: 'create_task', action_config: { taskTitle: 'Ask for a review' } },
    ])
    const firstWin = { id: DEAL, ...scope, closedAt: '2026-09-28T17:00:00.000Z', stage: 'Closed', status: 'win' }
    const reWin = { ...firstWin, closedAt: '2026-10-04T09:30:00.000Z' }
    await dealClosed(firstWin, ctx)
    await dealClosed(reWin, ctx)
    await dealClosed(reWin, ctx)
    await dealClosed(firstWin, ctx)

    expect(knex.db.tables.tasks).toHaveLength(2)
    expect(knex.db.tables.automation_trigger_dispatches.map((row: { event_key: string }) => row.event_key)).toEqual([
      `deal:${DEAL}:won:2026-09-28T17:00:00.000Z`,
      `deal:${DEAL}:won:2026-10-04T09:30:00.000Z`,
    ])
  })

  it('deal stage change: fires once per move, matches the target stage, ignores replays', async () => {
    const { knex, ctx } = world([
      { trigger_type: 'stage_change', action_type: 'create_task', trigger_config: { toStage: 'showing scheduled' }, action_config: { taskTitle: 'Prep the showing' } },
    ])
    const move = { id: DEAL, ...scope, stage: 'Showing Scheduled', previousStage: 'New Lead', changedAt: '2026-09-28T17:00:00.000Z' }
    await dealStageChanged(move, ctx)
    await dealStageChanged(move, ctx)
    expect(knex.db.tables.tasks).toHaveLength(1)

    await dealStageChanged({ ...move, stage: 'Offer', previousStage: 'Showing Scheduled', changedAt: '2026-09-28T18:00:00.000Z' }, ctx)
    expect(knex.db.tables.tasks).toHaveLength(1)

    await dealStageChanged({ ...move, changedAt: '2026-09-30T17:00:00.000Z' }, ctx)
    expect(knex.db.tables.tasks).toHaveLength(2)
  })

  it('journey board stage change runs stage_change rules configured by stage name', async () => {
    const { knex, ctx } = world([
      { trigger_type: 'stage_change', action_type: 'create_task', trigger_config: { stage: 'Closed' }, action_config: { taskTitle: 'Send closing gift' } },
    ])
    const move = { id: CONTACT, ...scope, stage: 'Closed', previousStage: 'Under Contract', changedAt: '2026-09-28T17:00:00.000Z' }
    await personStageChanged(move, ctx)
    await personStageChanged(move, ctx)
    expect(knex.db.tables.tasks).toHaveLength(1)
    expect(knex.db.tables.tasks[0]).toMatchObject({ title: 'Send closing gift', contact_id: CONTACT })
  })

  it('invoice paid: runs the rule and enrolls invoice_paid sequences once per invoice', async () => {
    const { knex, ctx } = world(
      [{ trigger_type: 'invoice_paid', action_type: 'create_task', action_config: { taskTitle: 'Thank them' } }],
      {
        sequences: [{ id: 'seq-1', organization_id: ORG, tenant_id: TENANT, trigger_type: 'invoice_paid', status: 'active', deleted_at: null, name: 'Post-Purchase Thank You', trigger_config: null }],
        sequence_steps: [{ id: 'step-1', sequence_id: 'seq-1', step_order: 1, step_type: 'email', config: '{}' }],
      },
    )
    const payload = { id: 'inv-1', ...scope, paidAt: '2026-09-28T17:00:00.000Z' }
    await invoicePaid(payload, ctx)
    await invoicePaid(payload, ctx)
    expect(knex.db.tables.tasks).toHaveLength(1)
    expect(knex.db.tables.sequence_enrollments).toHaveLength(1)
    expect(knex.db.tables.sequence_enrollments[0]).toMatchObject({ sequence_id: 'seq-1', contact_id: CONTACT, status: 'active' })
  })

  it('booking created: runs the rule once per booking', async () => {
    const { knex, ctx } = world([{ trigger_type: 'booking_created', action_type: 'create_task', action_config: { taskTitle: 'Confirm the visit' } }])
    const payload = { id: 'bk-1', ...scope, createdAt: '2026-09-28T17:00:00.000Z' }
    await bookingCreated(payload, ctx)
    await bookingCreated(payload, ctx)
    expect(knex.db.tables.tasks).toHaveLength(1)
  })

  it('never runs another org’s rules', async () => {
    const { knex } = world([{ trigger_type: 'invoice_paid', action_type: 'create_task', action_config: { taskTitle: 'x' } }])
    knex.db.tables.automation_rules[0]!.organization_id = 'org-2'
    await dispatchAutomationTrigger(knex as never, { ...scope, triggerType: 'invoice_paid', eventKey: 'invoice:inv-1', context: { contactId: CONTACT } })
    expect(knex.db.tables.tasks).toHaveLength(0)
  })
})

describe('Send SMS automation action', () => {
  const realFetch = global.fetch
  afterEach(() => {
    global.fetch = realFetch
  })

  it('is skipped, with the reason in the run history, when no Twilio account is connected', async () => {
    const fetchSpy = jest.fn()
    global.fetch = fetchSpy as never
    const { knex, ctx } = world([{ trigger_type: 'booking_created', action_type: 'send_sms', action_config: { message: 'See you soon, {{firstName}}!' } }])
    await bookingCreated({ id: 'bk-1', ...scope }, ctx)
    expect(fetchSpy).not.toHaveBeenCalled()
    const [log] = knex.db.tables.automation_rule_logs
    expect(log).toMatchObject({ rule_id: 'rule-1', status: 'skipped' })
    expect(JSON.parse(String(log!.action_result)).detail).toMatch(/no Twilio account is connected/)
    expect(knex.db.tables.sms_messages).toHaveLength(0)
  })

  it('texts the contact from the business’s own Twilio number', async () => {
    const fetchSpy = jest.fn().mockResolvedValue({ json: async () => ({ sid: 'SM123' }) })
    global.fetch = fetchSpy as never
    const { knex, ctx } = world(
      [{ trigger_type: 'booking_created', action_type: 'send_sms', action_config: { message: 'Hi {{contact.first_name}}, see you soon. {{sender.business_name}}' } }],
      { twilio_connections: [{ id: 'tw-1', organization_id: ORG, tenant_id: TENANT, is_active: true, account_sid: 'AC_business', auth_token: 'sealed', phone_number: '+13105550100' }] },
    )
    await bookingCreated({ id: 'bk-1', ...scope }, ctx)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC_business/Messages.json')
    const form = new URLSearchParams(String(init.body))
    expect(form.get('From')).toBe('+13105550100')
    expect(form.get('To')).toBe('+13105550142')
    expect(form.get('Body')).toBe('Hi Dana, see you soon. Agraz Homes')
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('AC_business:business-twilio-token').toString('base64')}`)
    expect(knex.db.tables.sms_messages[0]).toMatchObject({ status: 'sent', from_number: '+13105550100', to_number: '+13105550142', contact_id: CONTACT })
    const [log] = knex.db.tables.automation_rule_logs
    expect(log).toMatchObject({ status: 'executed' })
    expect(JSON.parse(String(log!.action_result))).toMatchObject({ success: true })
  })
})
