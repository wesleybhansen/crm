jest.mock('@open-mercato/shared/lib/encryption/decryptRows', () => ({
  ...jest.requireActual('@open-mercato/shared/lib/encryption/decryptRows'),
  decryptRowFields: jest.fn(async (_em: unknown, _key: string, rows: unknown[]) => rows),
}))
jest.mock('@open-mercato/shared/lib/encryption/secretColumns', () => ({
  openSecretForTenant: jest.fn(async () => 'business-twilio-token'),
}))
jest.mock('@/lib/inbox-conversation', () => ({ upsertInboxConversation: jest.fn(async () => undefined) }))

import { createFakeDb } from '../../../../lib/__tests__/support/fake-db'
import {
  SMS_OPTED_OUT_CODE,
  classifySmsKeyword,
  clearSmsOptOut,
  findContactSmsOptOut,
  findSmsOptOut,
  isTwilioUnsubscribedError,
  normalizeSmsNumber,
  recordSmsOptOut,
  smsOptedOutReason,
} from '../sms-opt-outs'
import { sendSmsReply } from '../send-sms-reply'

/**
 * Text-message opt-outs per business (sms_opt_outs): the keyword rules, the
 * store (record, clear, find) and its business isolation, and the Customer
 * Service / inbox reply sender refusing an opted-out number. No real text is
 * sent: Twilio is a mocked fetch, and every number is a 555 test number.
 */

const A = { organizationId: 'org-a', tenantId: 'ten-a' }
const B = { organizationId: 'org-b', tenantId: 'ten-b' }
const NUMBER = '+13105550142'
const UNIQUE = { sms_opt_outs: [['organization_id', 'tenant_id', 'phone_number']] }

function world(extra: Record<string, Array<Record<string, unknown>>> = {}) {
  return createFakeDb({ sms_opt_outs: [], sms_messages: [], contact_timeline_events: [], ...extra }, UNIQUE)
}

describe('classifySmsKeyword', () => {
  it.each(['STOP', 'stop', ' Stop. ', 'STOPALL', 'Stop all', 'UNSUBSCRIBE', 'cancel', 'End', 'QUIT', 'OPTOUT', 'opt-out', 'Revoke!'])(
    'treats %p as an opt-out',
    (body) => {
      expect(classifySmsKeyword(body)).toMatchObject({ kind: 'opt_out' })
    },
  )

  it.each(['START', 'start', 'Unstop', 'YES', 'yes!'])('treats %p as an opt-in', (body) => {
    expect(classifySmsKeyword(body)).toMatchObject({ kind: 'opt_in' })
  })

  it.each(['stop by at 5?', 'Can you stop the listing?', 'endless thanks', 'Yes please send it', 'HELP', ''])(
    'leaves an ordinary message alone: %p',
    (body) => {
      expect(classifySmsKeyword(body)).toBeNull()
    },
  )

  it("follows Twilio's OptOutType when present", () => {
    expect(classifySmsKeyword('arrêt', 'STOP')).toEqual({ kind: 'opt_out', keyword: 'ARRÊT' })
    expect(classifySmsKeyword('whatever', 'START')).toMatchObject({ kind: 'opt_in' })
    expect(classifySmsKeyword('HELP', 'HELP')).toBeNull()
  })
})

describe('numbers and Twilio errors', () => {
  it('normalizes to E.164 and rejects junk', () => {
    expect(normalizeSmsNumber('(310) 555-0142')).toBe(NUMBER)
    expect(normalizeSmsNumber('13105550142')).toBe(NUMBER)
    expect(normalizeSmsNumber('+1 310 555 0142')).toBe(NUMBER)
    expect(normalizeSmsNumber('abc')).toBeNull()
    expect(normalizeSmsNumber(null)).toBeNull()
  })

  it('recognizes error 21610 (unsubscribed recipient) only', () => {
    expect(isTwilioUnsubscribedError({ code: 21610, message: 'Attempt to send to unsubscribed recipient' })).toBe(true)
    expect(isTwilioUnsubscribedError({ code: '21610' })).toBe(true)
    expect(isTwilioUnsubscribedError({ code: 21211 })).toBe(false)
    expect(isTwilioUnsubscribedError(null)).toBe(false)
  })
})

describe('the opt-out store', () => {
  it('records a STOP for one business and number, and START clears it (history kept)', async () => {
    const knex = world()
    const at = new Date('2026-09-26T18:00:00Z')
    await expect(recordSmsOptOut(knex as never, A, { phone: '(310) 555-0142', source: 'reply', keyword: 'STOP', at })).resolves.toBe(true)
    const found = await findSmsOptOut(knex as never, A, [NUMBER])
    expect(found).toMatchObject({ phoneNumber: NUMBER, source: 'reply', keyword: 'STOP' })
    expect(found!.optedOutAt.toISOString()).toBe(at.toISOString())
    expect(smsOptedOutReason(found!)).toBe(
      'Not sent: this person opted out of your texts on Sep 26, 2026 (they replied STOP). They can text START to your number to opt back in.',
    )

    // A second STOP keeps the first date.
    await expect(recordSmsOptOut(knex as never, A, { phone: NUMBER, source: 'reply', keyword: 'STOP', at: new Date('2026-09-27T00:00:00Z') })).resolves.toBe(false)
    expect(knex.db.tables.sms_opt_outs).toHaveLength(1)

    await expect(clearSmsOptOut(knex as never, A, { phone: NUMBER })).resolves.toBe(true)
    await expect(findSmsOptOut(knex as never, A, [NUMBER])).resolves.toBeNull()
    expect(knex.db.tables.sms_opt_outs[0]).toMatchObject({ phone_number: NUMBER, opted_in_at: expect.any(Date) })
    await expect(clearSmsOptOut(knex as never, A, { phone: NUMBER })).resolves.toBe(false)

    // STOP again re-opens the same row with the new date.
    const again = new Date('2026-10-01T12:00:00Z')
    await expect(recordSmsOptOut(knex as never, A, { phone: NUMBER, source: 'reply', keyword: 'QUIT', at: again })).resolves.toBe(true)
    expect(knex.db.tables.sms_opt_outs).toHaveLength(1)
    expect((await findSmsOptOut(knex as never, A, [NUMBER]))!.optedOutAt.toISOString()).toBe(again.toISOString())
  })

  it("isolates businesses: one business's opt-out never blocks or clears another's", async () => {
    const knex = world()
    await recordSmsOptOut(knex as never, A, { phone: NUMBER, source: 'reply', keyword: 'STOP' })
    await expect(findSmsOptOut(knex as never, B, [NUMBER])).resolves.toBeNull()
    // Same organization id under another tenant is another business too.
    await expect(findSmsOptOut(knex as never, { organizationId: A.organizationId, tenantId: 'ten-other' }, [NUMBER])).resolves.toBeNull()
    await expect(clearSmsOptOut(knex as never, B, { phone: NUMBER })).resolves.toBe(false)
    await expect(findSmsOptOut(knex as never, A, [NUMBER])).resolves.not.toBeNull()
  })

  it('refuses to run without an organization and tenant', async () => {
    const knex = world()
    await expect(findSmsOptOut(knex as never, { organizationId: 'org-a', tenantId: '' }, [NUMBER])).rejects.toThrow(/required/)
    await expect(recordSmsOptOut(knex as never, { organizationId: '', tenantId: 'ten-a' }, { phone: NUMBER, source: 'reply' })).rejects.toThrow(/required/)
  })

  it("finds a contact's opt-out by the contact's current number, in the contact's business only", async () => {
    const knex = world({
      customer_entities: [
        { id: 'c-1', organization_id: A.organizationId, tenant_id: A.tenantId, primary_phone: '310-555-0142', deleted_at: null },
        { id: 'c-2', organization_id: B.organizationId, tenant_id: B.tenantId, primary_phone: '310-555-0142', deleted_at: null },
      ],
    })
    await recordSmsOptOut(knex as never, A, { phone: NUMBER, source: 'reply', keyword: 'STOP' })
    await expect(findContactSmsOptOut(knex as never, A, 'c-1')).resolves.toMatchObject({ optOut: { phoneNumber: NUMBER } })
    await expect(findContactSmsOptOut(knex as never, B, 'c-2')).resolves.toMatchObject({ optOut: null })
    // Another business's contact id is not readable from A.
    await expect(findContactSmsOptOut(knex as never, A, 'c-2')).resolves.toEqual({ optOut: null, phone: null })
  })
})

describe('Customer Service / inbox reply sender (sendSmsReply)', () => {
  const realFetch = global.fetch
  afterEach(() => { global.fetch = realFetch })

  function csWorld() {
    return world({
      customer_service_settings: [{ organization_id: A.organizationId, tenant_id: A.tenantId, cs_sms_number: '+13105550100' }],
      twilio_connections: [{ id: 'tw-a', organization_id: A.organizationId, tenant_id: A.tenantId, is_active: true, account_sid: 'AC_a', auth_token: 'sealed', phone_number: '+13105550100' }],
    })
  }

  it('refuses an opted-out number before Twilio is called, with a plain reason (automatic replies, approvals, the Texts tab)', async () => {
    const fetchSpy = jest.fn()
    global.fetch = fetchSpy as never
    const knex = csWorld()
    await recordSmsOptOut(knex as never, A, { phone: NUMBER, source: 'reply', keyword: 'STOP', at: new Date('2026-09-26T18:00:00Z') })
    const r = await sendSmsReply(knex as never, A.organizationId, A.tenantId, { to: '(310) 555-0142', body: 'Thanks, see you at 5', contactId: 'c-1' })
    expect(r).toMatchObject({ ok: false, code: SMS_OPTED_OUT_CODE, status: 409, optedOutAt: '2026-09-26T18:00:00.000Z' })
    expect(r.error).toMatch(/opted out of your texts on Sep 26, 2026/)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(knex.db.tables.sms_messages).toHaveLength(0)
  })

  it("still sends for a business whose customer did not opt out (another business's STOP does not count)", async () => {
    global.fetch = jest.fn().mockResolvedValue({ json: async () => ({ sid: 'SM1' }) }) as never
    const knex = csWorld()
    await recordSmsOptOut(knex as never, B, { phone: NUMBER, source: 'reply', keyword: 'STOP' })
    const r = await sendSmsReply(knex as never, A.organizationId, A.tenantId, { to: NUMBER, body: 'Thanks!' })
    expect(r).toMatchObject({ ok: true, twilioSid: 'SM1' })
  })

  it('records Twilio error 21610 as an opt-out and refuses the same way', async () => {
    global.fetch = jest.fn().mockResolvedValue({ json: async () => ({ code: 21610, message: 'Attempt to send to unsubscribed recipient', status: 400 }) }) as never
    const knex = csWorld()
    const r = await sendSmsReply(knex as never, A.organizationId, A.tenantId, { to: NUMBER, body: 'Thanks!', contactId: 'c-1' })
    expect(r).toMatchObject({ ok: false, code: SMS_OPTED_OUT_CODE, status: 409 })
    expect(knex.db.tables.sms_opt_outs).toEqual([
      expect.objectContaining({ organization_id: A.organizationId, tenant_id: A.tenantId, phone_number: NUMBER, source: 'carrier', contact_id: 'c-1', opted_in_at: null }),
    ])
    // The next send is refused before Twilio.
    const fetchSpy = jest.fn()
    global.fetch = fetchSpy as never
    await expect(sendSmsReply(knex as never, A.organizationId, A.tenantId, { to: NUMBER, body: 'Hello?' })).resolves.toMatchObject({ code: SMS_OPTED_OUT_CODE })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('sends nothing when the opt-out list cannot be read', async () => {
    const fetchSpy = jest.fn()
    global.fetch = fetchSpy as never
    const knex = csWorld()
    const broken: any = (table: string) => {
      if (table === 'sms_opt_outs') throw new Error('relation "sms_opt_outs" does not exist')
      return knex(table)
    }
    const r = await sendSmsReply(broken, A.organizationId, A.tenantId, { to: NUMBER, body: 'Thanks!' })
    expect(r).toMatchObject({ ok: false, status: 503 })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
