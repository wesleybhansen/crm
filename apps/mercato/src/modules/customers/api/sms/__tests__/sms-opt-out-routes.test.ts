import crypto from 'crypto'
import { createFakeDb } from '../../../../../lib/__tests__/support/fake-db'

/**
 * The Twilio inbound webhook records text opt-outs per business, only for a
 * correctly signed request (HMAC-SHA1 with THAT business's auth token), and
 * the inbox send route blocks a text to a number that opted out. No real
 * text is sent (Twilio is a mocked fetch), the tokens are test strings, and
 * every number is a 555 test number.
 */

const mockState: { knex: any; auth: Record<string, unknown> | null } = { knex: null, auth: null }

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: async () => ({ resolve: (key: string) => (key === 'em' ? { getKnex: () => mockState.knex } : null) }),
}))
jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromCookies: async () => mockState.auth,
  getAuthFromRequest: async () => mockState.auth,
}))
// Each business's sealed token opens to its own test token.
jest.mock('@open-mercato/shared/lib/encryption/secretColumns', () => ({
  openSecretForTenant: jest.fn(async (_em: unknown, _tenantId: unknown, stored: unknown) => (stored ? `token-for-${String(stored)}` : null)),
}))
jest.mock('@open-mercato/shared/lib/encryption/decryptRows', () => ({
  ...jest.requireActual('@open-mercato/shared/lib/encryption/decryptRows'),
  decryptRowFields: jest.fn(async (_em: unknown, _key: string, rows: unknown[]) => rows),
}))
jest.mock('@/modules/customers/lib/dedup', () => ({
  findContactByPhone: jest.fn(async (_knex: unknown, orgId: string) => ({
    existing: orgId === 'org-a' ? { id: 'contact-a', display_name: 'Dana Buyer', primary_email: null } : null,
  })),
}))
jest.mock('@/lib/inbox-conversation', () => ({ upsertInboxConversation: jest.fn(async () => undefined) }))

import { POST as webhookPost } from '../webhook/route'
import { POST as smsPost } from '../route'
import { GET as optOutGet } from '../opt-out/route'
import { findSmsOptOut, recordSmsOptOut } from '@/modules/customers/lib/sms-opt-outs'

const APP_URL = 'https://crm.example.test'
const WEBHOOK_PATH = '/api/sms/webhook'
const CUSTOMER = '+13105550142'
const A_NUMBER = '+13105550100'
const B_NUMBER = '+13105550200'
const A = { organizationId: 'org-a', tenantId: 'ten-a' }
const B = { organizationId: 'org-b', tenantId: 'ten-b' }

function world() {
  return createFakeDb(
    {
      twilio_connections: [
        { id: 'tw-a', organization_id: A.organizationId, tenant_id: A.tenantId, is_active: true, account_sid: 'AC_a', auth_token: 'sealed-a', phone_number: A_NUMBER },
        { id: 'tw-b', organization_id: B.organizationId, tenant_id: B.tenantId, is_active: true, account_sid: 'AC_b', auth_token: 'sealed-b', phone_number: B_NUMBER },
      ],
      customer_service_settings: [{ organization_id: A.organizationId, tenant_id: A.tenantId, enabled: true, cs_sms_number: A_NUMBER }],
      inbox_conversations: [{ id: 'conv-a', organization_id: A.organizationId, contact_id: 'contact-a', cs_drafted_at: new Date('2026-09-25T00:00:00Z') }],
      customer_entities: [{ id: 'contact-a', organization_id: A.organizationId, tenant_id: A.tenantId, primary_phone: '(310) 555-0142', deleted_at: null }],
      sms_opt_outs: [],
      sms_messages: [],
      contact_timeline_events: [],
    },
    { sms_opt_outs: [['organization_id', 'tenant_id', 'phone_number']] },
  )
}

function sign(token: string, params: Record<string, string>): string {
  const suffix = Object.keys(params).sort().map((k) => k + params[k]).join('')
  return crypto.createHmac('sha1', token).update(Buffer.from(APP_URL + WEBHOOK_PATH + suffix, 'utf-8')).digest('base64')
}

let sidCounter = 0
function inbound(to: string, body: string, opts: { token?: string | null; signature?: string; extra?: Record<string, string> } = {}) {
  const params: Record<string, string> = { From: CUSTOMER, To: to, Body: body, MessageSid: `SMtest${++sidCounter}`, ...(opts.extra ?? {}) }
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
  const signature = opts.signature ?? (opts.token ? sign(opts.token, params) : undefined)
  if (signature) headers['x-twilio-signature'] = signature
  return new Request(APP_URL + WEBHOOK_PATH, { method: 'POST', headers, body: new URLSearchParams(params).toString() })
}

const realAppUrl = process.env.APP_URL
const realFetch = global.fetch
beforeEach(() => {
  process.env.APP_URL = APP_URL
  mockState.knex = world()
  mockState.auth = null
  jest.spyOn(console, 'log').mockImplementation(() => undefined)
  jest.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  process.env.APP_URL = realAppUrl
  global.fetch = realFetch
  jest.restoreAllMocks()
})

describe('Twilio inbound webhook: opt-outs', () => {
  it("records STOP for the business that owns the number, on a request signed with that business's token", async () => {
    const res = await webhookPost(inbound(A_NUMBER, 'STOP', { token: 'token-for-sealed-a' }))
    expect(res.status).toBe(200)
    const rows = mockState.knex.db.tables.sms_opt_outs
    expect(rows).toEqual([
      expect.objectContaining({ organization_id: A.organizationId, tenant_id: A.tenantId, phone_number: CUSTOMER, contact_id: 'contact-a', source: 'reply', keyword: 'STOP', opted_in_at: null }),
    ])
    // The contact's timeline says so.
    expect(mockState.knex.db.tables.contact_timeline_events).toEqual([
      expect.objectContaining({ organization_id: A.organizationId, contact_id: 'contact-a', event_type: 'sms_opted_out' }),
    ])
    // A STOP is never routed to the Customer Service drafter.
    expect(mockState.knex.db.tables.inbox_conversations[0].cs_drafted_at).not.toBeNull()
    // The message itself is still kept on the thread.
    expect(mockState.knex.db.tables.sms_messages).toHaveLength(1)
  })

  it("honors Twilio's OptOutType parameter", async () => {
    await webhookPost(inbound(A_NUMBER, 'Arrêt', { token: 'token-for-sealed-a', extra: { OptOutType: 'STOP' } }))
    await expect(findSmsOptOut(mockState.knex, A, [CUSTOMER])).resolves.not.toBeNull()
  })

  it('START clears the opt-out (and only for that business)', async () => {
    await recordSmsOptOut(mockState.knex, A, { phone: CUSTOMER, source: 'reply', keyword: 'STOP' })
    await recordSmsOptOut(mockState.knex, B, { phone: CUSTOMER, source: 'reply', keyword: 'STOP' })
    const res = await webhookPost(inbound(A_NUMBER, 'start', { token: 'token-for-sealed-a' }))
    expect(res.status).toBe(200)
    await expect(findSmsOptOut(mockState.knex, A, [CUSTOMER])).resolves.toBeNull()
    await expect(findSmsOptOut(mockState.knex, B, [CUSTOMER])).resolves.not.toBeNull()
    expect(mockState.knex.db.tables.contact_timeline_events).toEqual([expect.objectContaining({ event_type: 'sms_opted_in' })])
  })

  it('rejects a bad signature: 403 and nothing recorded or stored', async () => {
    const res = await webhookPost(inbound(A_NUMBER, 'STOP', { signature: 'not-a-real-signature=' }))
    expect(res.status).toBe(403)
    expect(mockState.knex.db.tables.sms_opt_outs).toHaveLength(0)
    expect(mockState.knex.db.tables.sms_messages).toHaveLength(0)
  })

  it("rejects a request signed with another business's token", async () => {
    const res = await webhookPost(inbound(A_NUMBER, 'STOP', { token: 'token-for-sealed-b' }))
    expect(res.status).toBe(403)
    expect(mockState.knex.db.tables.sms_opt_outs).toHaveLength(0)
  })

  it('rejects an unsigned request and one to a number no business owns', async () => {
    expect((await webhookPost(inbound(A_NUMBER, 'STOP'))).status).toBe(403)
    expect((await webhookPost(inbound('+13105550999', 'STOP', { token: 'token-for-sealed-a' }))).status).toBe(403)
    expect(mockState.knex.db.tables.sms_opt_outs).toHaveLength(0)
  })

  it("keeps businesses apart: a STOP to business B's number opts out of B only", async () => {
    await webhookPost(inbound(B_NUMBER, 'STOP', { token: 'token-for-sealed-b' }))
    await expect(findSmsOptOut(mockState.knex, B, [CUSTOMER])).resolves.not.toBeNull()
    await expect(findSmsOptOut(mockState.knex, A, [CUSTOMER])).resolves.toBeNull()
  })

  it('an ordinary text records nothing', async () => {
    await webhookPost(inbound(A_NUMBER, 'Can you stop by at 5?', { token: 'token-for-sealed-a' }))
    expect(mockState.knex.db.tables.sms_opt_outs).toHaveLength(0)
    // ...and a support text still goes to the Customer Service drafter.
    expect(mockState.knex.db.tables.inbox_conversations[0].cs_drafted_at).toBeNull()
  })
})

describe('inbox send route (a text typed by a person)', () => {
  function post(body: Record<string, unknown>) {
    return new Request(`${APP_URL}/api/sms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  }

  it('blocks a text to a number that opted out, with the reason, and never calls Twilio', async () => {
    mockState.auth = { orgId: A.organizationId, tenantId: A.tenantId }
    await recordSmsOptOut(mockState.knex, A, { phone: CUSTOMER, source: 'reply', keyword: 'STOP', at: new Date('2026-09-26T18:00:00Z') })
    const fetchSpy = jest.fn()
    global.fetch = fetchSpy as never
    const res = await smsPost(post({ to: '(310) 555-0142', message: 'Following up', contactId: 'contact-a' }))
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json).toMatchObject({ ok: false, code: 'sms_opted_out', optedOutAt: '2026-09-26T18:00:00.000Z' })
    expect(json.error).toMatch(/opted out of your texts on Sep 26, 2026/)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(mockState.knex.db.tables.sms_messages).toHaveLength(0)
  })

  it("is not blocked by another business's opt-out", async () => {
    mockState.auth = { orgId: A.organizationId, tenantId: A.tenantId }
    await recordSmsOptOut(mockState.knex, B, { phone: CUSTOMER, source: 'reply', keyword: 'STOP' })
    global.fetch = jest.fn().mockResolvedValue({ json: async () => ({ sid: 'SM1' }) }) as never
    const res = await smsPost(post({ to: CUSTOMER, message: 'Hi', contactId: 'contact-a' }))
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ status: 'sent' })
  })

  it('records Twilio 21610 as an opt-out and says so', async () => {
    mockState.auth = { orgId: A.organizationId, tenantId: A.tenantId }
    global.fetch = jest.fn().mockResolvedValue({ json: async () => ({ code: 21610, message: 'Attempt to send to unsubscribed recipient' }) }) as never
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const res = await smsPost(post({ to: CUSTOMER, message: 'Hi', contactId: 'contact-a' }))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ ok: false, code: 'sms_opted_out' })
    expect(mockState.knex.db.tables.sms_opt_outs).toEqual([
      expect.objectContaining({ organization_id: A.organizationId, tenant_id: A.tenantId, phone_number: CUSTOMER, source: 'carrier' }),
    ])
  })
})

describe('opt-out status for the contact record', () => {
  it("answers for the caller's business only, without echoing the number", async () => {
    await recordSmsOptOut(mockState.knex, A, { phone: CUSTOMER, source: 'reply', keyword: 'STOP', at: new Date('2026-09-26T18:00:00Z') })
    mockState.auth = { orgId: A.organizationId, tenantId: A.tenantId }
    const res = await optOutGet(new Request(`${APP_URL}/api/sms/opt-out?contactId=contact-a`))
    const json = await res.json()
    expect(json).toEqual({ ok: true, data: { optedOut: true, optedOutAt: '2026-09-26T18:00:00.000Z', source: 'reply', keyword: 'STOP' } })
    expect(JSON.stringify(json)).not.toContain('555')

    mockState.auth = { orgId: B.organizationId, tenantId: B.tenantId }
    const other = await optOutGet(new Request(`${APP_URL}/api/sms/opt-out?contactId=contact-a`))
    expect(await other.json()).toEqual({ ok: true, data: { optedOut: false } })
  })
})
