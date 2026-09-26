/** @jest-environment node */
const mockSendViaESP = jest.fn()

jest.mock('../routing-service', () => ({
  ...jest.requireActual('../routing-service'),
  getProviderForPurpose: jest.fn(async () => ({
    type: 'esp',
    provider: 'resend',
    fromName: null,
    fromAddress: 'owner@customer.test',
    espConnection: { provider: 'resend', api_key: 'test-key' },
  })),
}))
jest.mock('../esp-service', () => ({
  sendViaESP: (...args: unknown[]) => mockSendViaESP(...args),
}))

import { createFakeDb } from '../../../../lib/__tests__/support/fake-db'
import { getProviderForPurpose } from '../routing-service'
import { sendEmailByPurpose, UNSUBSCRIBE_CHECK_FAILED_CODE } from '../email-router'
import { EMAIL_PURPOSES, type EmailPurpose } from '../routing-service'
import { isUnsubscribeGatedPurpose, UNSUBSCRIBED_CODE, UNSUBSCRIBED_SEND_REASON } from '../unsubscribes'

/**
 * The definitive send-time gate (2026-09-26): sendEmailByPurpose refuses a
 * 'marketing' or 'automations' email to a person who unsubscribed from this
 * business, whatever path built it (sequences, automation emails and surveys,
 * review requests, event broadcasts, campaigns). Transactional purposes
 * (course sign-in links, booking confirmations, invoices and receipts, form
 * and event confirmations) still send: an unsubscribe from marketing never
 * blocks what the person needs.
 */

const ORG = 'org-1'
const TENANT = 'ten-1'
const OTHER_ORG = 'org-2'
const OTHER_TENANT = 'ten-2'

function world() {
  return createFakeDb({
    customer_entities: [
      { id: 'c-dana', organization_id: ORG, tenant_id: TENANT },
      { id: 'c-lee', organization_id: ORG, tenant_id: TENANT },
    ],
    contact_timeline_events: [],
    email_unsubscribes: [
      { id: 'u-1', organization_id: ORG, tenant_id: TENANT, email: 'Dana@Example.test', contact_id: 'c-dana' },
      { id: 'u-2', organization_id: OTHER_ORG, tenant_id: OTHER_TENANT, email: 'lee@example.test', contact_id: null },
    ],
  })
}

const params = (to: string, contactId?: string) => ({ to, subject: 'Hello', htmlBody: '<p>Hi</p>', ...(contactId ? { contactId } : {}) })

beforeEach(() => {
  jest.clearAllMocks()
  mockSendViaESP.mockResolvedValue({ messageId: 'esp-1' })
})

describe('which purposes the unsubscribe gate covers', () => {
  it('marketing and automations only; everything else is transactional', () => {
    const gated = EMAIL_PURPOSES.filter((p) => isUnsubscribeGatedPurpose(p))
    expect(gated).toEqual(['marketing', 'automations'])
  })
})

describe('sendEmailByPurpose: unsubscribe gate', () => {
  it.each(['marketing', 'automations'] as EmailPurpose[])('%s: refuses an unsubscribed contact, sends nothing, notes it on the timeline', async (purpose) => {
    const knex = world()
    const res = await sendEmailByPurpose(knex as never, ORG, TENANT, purpose, params('dana@example.test', 'c-dana'))
    expect(res).toEqual({ ok: false, code: UNSUBSCRIBED_CODE, error: UNSUBSCRIBED_SEND_REASON })
    expect(mockSendViaESP).not.toHaveBeenCalled()
    const timeline = knex.db.tables.contact_timeline_events as Array<Record<string, any>>
    expect(timeline.map((e) => [e.contact_id, e.event_type, e.description, e.organization_id, e.tenant_id]))
      .toEqual([['c-dana', 'email_not_sent', UNSUBSCRIBED_SEND_REASON, ORG, TENANT]])
  })

  it('matches by address too, in any case, with no contact id', async () => {
    const knex = world()
    const res = await sendEmailByPurpose(knex as never, ORG, TENANT, 'marketing', params('DANA@example.TEST'))
    expect(res.code).toBe(UNSUBSCRIBED_CODE)
    expect(mockSendViaESP).not.toHaveBeenCalled()
  })

  it.each(['transactional', 'invoices', 'inbox'] as EmailPurpose[])('%s: still sends to the same unsubscribed person', async (purpose) => {
    const knex = world()
    const res = await sendEmailByPurpose(knex as never, ORG, TENANT, purpose, params('dana@example.test', 'c-dana'))
    expect(res).toMatchObject({ ok: true, sentVia: 'esp:resend' })
    expect(mockSendViaESP).toHaveBeenCalledTimes(1)
  })

  it('another business’s unsubscribe does not stop this business’s marketing email', async () => {
    const knex = world()
    const res = await sendEmailByPurpose(knex as never, ORG, TENANT, 'marketing', params('lee@example.test', 'c-lee'))
    expect(res.ok).toBe(true)
    expect(mockSendViaESP).toHaveBeenCalledTimes(1)
  })

  it('the gate runs before the sender is resolved, so it holds whatever the business’s email setup', async () => {
    const knex = world()
    const res = await sendEmailByPurpose(knex as never, ORG, TENANT, 'automations', params('dana@example.test', 'c-dana'))
    expect(res.code).toBe(UNSUBSCRIBED_CODE)
    expect(getProviderForPurpose).not.toHaveBeenCalled()
  })

  it('if the unsubscribe list cannot be read, a marketing email is not sent; a transactional one is', async () => {
    const base = world()
    const knex = ((table: string) => {
      if (table === 'email_unsubscribes') throw new Error('connection reset')
      return base(table)
    }) as never
    jest.spyOn(console, 'error').mockImplementation(() => {})
    const refused = await sendEmailByPurpose(knex, ORG, TENANT, 'marketing', params('lee@example.test', 'c-lee'))
    expect(refused).toMatchObject({ ok: false, code: UNSUBSCRIBE_CHECK_FAILED_CODE })
    expect(mockSendViaESP).not.toHaveBeenCalled()
    const receipt = await sendEmailByPurpose(knex, ORG, TENANT, 'invoices', params('lee@example.test', 'c-lee'))
    expect(receipt.ok).toBe(true)
    jest.restoreAllMocks()
  })
})
