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
import { runSequenceSmsStep } from '../sms-step'

/**
 * The sequence "Send SMS" step used to log a line and mark itself executed
 * without texting anyone. It now sends like the automation action: from the
 * business's own Twilio number, or skipped with the reason on the step.
 * No real text is sent: Twilio is a mocked fetch.
 */

const ORG = 'org-1'
const TENANT = 'ten-1'
const CONTACT = 'contact-1'

function world(twilio: Array<Record<string, unknown>> = []) {
  return createFakeDb({
    customer_entities: [{ id: CONTACT, organization_id: ORG, tenant_id: TENANT, display_name: 'Dana Buyer', primary_phone: '(310) 555-0142', deleted_at: null }],
    twilio_connections: twilio,
    sms_messages: [],
    inbox_conversations: [],
    contact_timeline_events: [],
    sequence_step_executions: [{ id: 'exec-1', status: 'processing', result: null }],
  })
}

const input = { executionId: 'exec-1', organizationId: ORG, tenantId: TENANT, contactId: CONTACT, message: 'Hi {{firstName}}, your showing is confirmed. {{sender.business_name}}' }

describe('sequence Send SMS step', () => {
  const realFetch = global.fetch
  afterEach(() => { global.fetch = realFetch })

  it('is skipped with the reason when no Twilio account is connected (and never uses another tenant’s)', async () => {
    const fetchSpy = jest.fn()
    global.fetch = fetchSpy as never
    const knex = world([{ id: 'tw-other', organization_id: ORG, tenant_id: 'ten-other', is_active: true, account_sid: 'AC_other', auth_token: 'x', phone_number: '+13105550199' }])
    await expect(runSequenceSmsStep(knex as never, input)).resolves.toBe('skipped')
    expect(fetchSpy).not.toHaveBeenCalled()
    const [exec] = knex.db.tables.sequence_step_executions
    expect(exec).toMatchObject({ status: 'skipped' })
    expect(JSON.parse(String(exec!.result))).toMatchObject({ skipped: true, reason: expect.stringMatching(/no Twilio account is connected/) })
    expect(knex.db.tables.sms_messages).toHaveLength(0)
  })

  it('texts the contact from the business’s own Twilio number and marks the step executed', async () => {
    const fetchSpy = jest.fn().mockResolvedValue({ json: async () => ({ sid: 'SM42' }) })
    global.fetch = fetchSpy as never
    const knex = world([{ id: 'tw-1', organization_id: ORG, tenant_id: TENANT, is_active: true, account_sid: 'AC_business', auth_token: 'sealed', phone_number: '+13105550100' }])
    await expect(runSequenceSmsStep(knex as never, input)).resolves.toBe('sent')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC_business/Messages.json')
    const form = new URLSearchParams(String(init.body))
    expect(form.get('From')).toBe('+13105550100')
    expect(form.get('To')).toBe('+13105550142')
    expect(form.get('Body')).toBe('Hi Dana, your showing is confirmed. Agraz Homes')
    expect(knex.db.tables.sequence_step_executions[0]).toMatchObject({ status: 'executed' })
    expect(knex.db.tables.sms_messages[0]).toMatchObject({ status: 'sent', from_number: '+13105550100', contact_id: CONTACT })
  })

  it('fails the step when Twilio refuses the message', async () => {
    global.fetch = jest.fn().mockResolvedValue({ json: async () => ({ message: 'The To number is not a valid mobile number' }) }) as never
    const knex = world([{ id: 'tw-1', organization_id: ORG, tenant_id: TENANT, is_active: true, account_sid: 'AC_business', auth_token: 'sealed', phone_number: '+13105550100' }])
    await expect(runSequenceSmsStep(knex as never, input)).resolves.toBe('failed')
    const [exec] = knex.db.tables.sequence_step_executions
    expect(exec).toMatchObject({ status: 'failed' })
    expect(JSON.parse(String(exec!.result)).error).toMatch(/not a valid mobile number/)
  })

  it('fills {{name}}, the sequence editor’s own token', async () => {
    const fetchSpy = jest.fn().mockResolvedValue({ json: async () => ({ sid: 'SM43' }) })
    global.fetch = fetchSpy as never
    const knex = world([{ id: 'tw-1', organization_id: ORG, tenant_id: TENANT, is_active: true, account_sid: 'AC_business', auth_token: 'sealed', phone_number: '+13105550100' }])
    await runSequenceSmsStep(knex as never, { ...input, message: 'Thanks, {{name}}!' })
    expect(new URLSearchParams(String(fetchSpy.mock.calls[0][1].body)).get('Body')).toBe('Thanks, Dana Buyer!')
  })
})
