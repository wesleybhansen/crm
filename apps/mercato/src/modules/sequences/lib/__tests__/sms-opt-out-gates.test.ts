jest.mock('@open-mercato/shared/lib/encryption/decryptRows', () => ({
  ...jest.requireActual('@open-mercato/shared/lib/encryption/decryptRows'),
  decryptRowFields: jest.fn(async (_em: unknown, _key: string, rows: unknown[]) => rows),
}))
jest.mock('@open-mercato/shared/lib/encryption/secretColumns', () => ({
  openSecretForTenant: jest.fn(async () => 'business-twilio-token'),
}))
jest.mock('../template-vars', () => ({
  ...jest.requireActual('../template-vars'),
  buildSenderContext: jest.fn(async () => ({ first_name: 'Cecilia', business_name: 'Agraz Homes', review_url: null })),
  recordReviewRequest: jest.fn(async () => undefined),
}))

import { createFakeDb } from '../../../../lib/__tests__/support/fake-db'
import { sendAutomationSms } from '../automation-sms'
import { runSequenceSmsStep } from '../sms-step'
import { recordSmsOptOut, SMS_OPTED_OUT_STOP_REASON } from '../../../customers/lib/sms-opt-outs'

/**
 * Business-initiated texts honor text opt-outs (sms_opt_outs): the automation
 * "Send SMS" action and the sequence SMS step refuse an opted-out number
 * before Twilio is called, with a plain reason; the sequence stops for that
 * person and is never retried; Twilio's 21610 is recorded as an opt-out.
 * No real text is sent: Twilio is a mocked fetch, every number a 555 number.
 */

const ORG = 'org-1'
const TENANT = 'ten-1'
const CONTACT = 'contact-1'
const NUMBER = '+13105550142'
const scope = { organizationId: ORG, tenantId: TENANT }
const twilio = { id: 'tw-1', organization_id: ORG, tenant_id: TENANT, is_active: true, account_sid: 'AC_business', auth_token: 'sealed', phone_number: '+13105550100' }

function world() {
  return createFakeDb(
    {
      customer_entities: [{ id: CONTACT, organization_id: ORG, tenant_id: TENANT, display_name: 'Dana Buyer', primary_phone: '(310) 555-0142', deleted_at: null }],
      twilio_connections: [twilio],
      sms_opt_outs: [],
      sms_messages: [],
      inbox_conversations: [],
      contact_timeline_events: [],
      sequence_enrollments: [{ id: 'enr-1', organization_id: ORG, tenant_id: TENANT, status: 'active', paused_at: null }],
      sequence_step_executions: [{ id: 'exec-1', enrollment_id: 'enr-1', status: 'processing', result: null }],
    },
    { sms_opt_outs: [['organization_id', 'tenant_id', 'phone_number']] },
  )
}

const stepInput = { executionId: 'exec-1', enrollmentId: 'enr-1', organizationId: ORG, tenantId: TENANT, contactId: CONTACT, message: 'Hi {{firstName}}, the open house is Sunday.' }

describe('automation "Send SMS" action', () => {
  const realFetch = global.fetch
  afterEach(() => { global.fetch = realFetch })

  it('refuses a contact who replied STOP, before Twilio, with the reason on the run', async () => {
    const fetchSpy = jest.fn()
    global.fetch = fetchSpy as never
    const knex = world()
    await recordSmsOptOut(knex as never, scope, { phone: NUMBER, source: 'reply', keyword: 'STOP', at: new Date('2026-09-26T18:00:00Z') })
    const result = await sendAutomationSms(knex as never, scope, { contactId: CONTACT, message: 'Hi {{firstName}}' })
    expect(result).toMatchObject({ success: false, skipped: true, optedOut: true })
    expect(result.detail).toMatch(/^Not sent: this person opted out of your texts on Sep 26, 2026/)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(knex.db.tables.sms_messages).toHaveLength(0)
  })

  it("is not blocked by another business's opt-out for the same number", async () => {
    const fetchSpy = jest.fn().mockResolvedValue({ json: async () => ({ sid: 'SM9' }) })
    global.fetch = fetchSpy as never
    const knex = world()
    await recordSmsOptOut(knex as never, { organizationId: 'org-2', tenantId: 'ten-2' }, { phone: NUMBER, source: 'reply', keyword: 'STOP' })
    await expect(sendAutomationSms(knex as never, scope, { contactId: CONTACT, message: 'Hi' })).resolves.toMatchObject({ success: true })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('records Twilio error 21610 as an opt-out for this business, and the next run is refused before Twilio', async () => {
    global.fetch = jest.fn().mockResolvedValue({ json: async () => ({ code: 21610, message: 'Attempt to send to unsubscribed recipient' }) }) as never
    const knex = world()
    const first = await sendAutomationSms(knex as never, scope, { contactId: CONTACT, message: 'Hi' })
    expect(first).toMatchObject({ success: false, skipped: true, optedOut: true })
    expect(first.detail).toMatch(/Twilio reported it/)
    expect(knex.db.tables.sms_opt_outs).toEqual([
      expect.objectContaining({ organization_id: ORG, tenant_id: TENANT, phone_number: NUMBER, source: 'carrier', contact_id: CONTACT, opted_in_at: null }),
    ])
    expect(knex.db.tables.sms_messages[0]).toMatchObject({ status: 'failed' })

    const fetchSpy = jest.fn()
    global.fetch = fetchSpy as never
    await expect(sendAutomationSms(knex as never, scope, { contactId: CONTACT, message: 'Hi again' })).resolves.toMatchObject({ optedOut: true })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('sends nothing when the opt-out list cannot be read', async () => {
    const fetchSpy = jest.fn()
    global.fetch = fetchSpy as never
    const knex = world()
    const broken: any = (table: string) => {
      if (table === 'sms_opt_outs') throw new Error('relation "sms_opt_outs" does not exist')
      return knex(table)
    }
    await expect(sendAutomationSms(broken, scope, { contactId: CONTACT, message: 'Hi' })).resolves.toMatchObject({ success: false, checkFailed: true })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('sequence SMS step', () => {
  const realFetch = global.fetch
  afterEach(() => { global.fetch = realFetch })

  it('stops the sequence for a person who opted out: step skipped with the reason, enrollment opted_out, nothing sent', async () => {
    const fetchSpy = jest.fn()
    global.fetch = fetchSpy as never
    const knex = world()
    await recordSmsOptOut(knex as never, scope, { phone: NUMBER, source: 'reply', keyword: 'STOP' })
    await expect(runSequenceSmsStep(knex as never, stepInput)).resolves.toBe('opted_out')
    expect(fetchSpy).not.toHaveBeenCalled()
    const [exec] = knex.db.tables.sequence_step_executions
    expect(exec).toMatchObject({ status: 'skipped' })
    expect(JSON.parse(String(exec!.result))).toMatchObject({ skipped: true, sms_opted_out: true, reason: SMS_OPTED_OUT_STOP_REASON })
    // Stopped: the processor only picks up 'scheduled' steps of 'active' enrollments, so it is never retried.
    expect(knex.db.tables.sequence_enrollments[0]).toMatchObject({ status: 'opted_out', paused_at: expect.any(Date) })
  })

  it('stops the sequence when Twilio answers 21610', async () => {
    global.fetch = jest.fn().mockResolvedValue({ json: async () => ({ code: 21610, message: 'Attempt to send to unsubscribed recipient' }) }) as never
    const knex = world()
    await expect(runSequenceSmsStep(knex as never, stepInput)).resolves.toBe('opted_out')
    expect(knex.db.tables.sequence_enrollments[0]).toMatchObject({ status: 'opted_out' })
    expect(knex.db.tables.sms_opt_outs).toHaveLength(1)
  })

  it("never stops another business's enrollment", async () => {
    global.fetch = jest.fn() as never
    const knex = world()
    knex.db.tables.sequence_enrollments.push({ id: 'enr-other', organization_id: 'org-2', tenant_id: 'ten-2', status: 'active', paused_at: null })
    await recordSmsOptOut(knex as never, scope, { phone: NUMBER, source: 'reply', keyword: 'STOP' })
    await runSequenceSmsStep(knex as never, { ...stepInput, enrollmentId: 'enr-other' })
    expect(knex.db.tables.sequence_enrollments.find((e: any) => e.id === 'enr-other')).toMatchObject({ status: 'active' })
  })

  it('waits (scheduled again, nothing sent) when the opt-out list cannot be read', async () => {
    const fetchSpy = jest.fn()
    global.fetch = fetchSpy as never
    const knex = world()
    const broken: any = (table: string) => {
      if (table === 'sms_opt_outs') throw new Error('connection reset')
      return knex(table)
    }
    const now = new Date('2026-09-26T18:00:00Z')
    await expect(runSequenceSmsStep(broken, stepInput, { now: () => now })).resolves.toBe('waiting')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(knex.db.tables.sequence_step_executions[0]).toMatchObject({ status: 'scheduled', scheduled_for: new Date(now.getTime() + 15 * 60 * 1000) })
    expect(knex.db.tables.sequence_enrollments[0]).toMatchObject({ status: 'active' })
  })
})
