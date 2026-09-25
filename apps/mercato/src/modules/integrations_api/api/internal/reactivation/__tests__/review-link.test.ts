/** @jest-environment node */

const mockFindNoliUserById = jest.fn()
const mockResolveClerkUserToAuthContext = jest.fn()
const mockCreateRequestContainer = jest.fn()
const mockSendReply = jest.fn()
const mockAllowance = jest.fn()

jest.mock('@open-mercato/shared/lib/noli/core-client', () => ({
  findNoliUserById: (...args: unknown[]) => mockFindNoliUserById(...args),
}))
jest.mock('@open-mercato/shared/lib/auth/clerk', () => ({
  resolveClerkUserToAuthContext: (...args: unknown[]) => mockResolveClerkUserToAuthContext(...args),
}))
jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: (...args: unknown[]) => mockCreateRequestContainer(...args),
}))
jest.mock('@open-mercato/shared/lib/encryption/decryptRows', () => ({
  CONTACT_ENTITY_KEY: 'contact',
  decryptRowFields: jest.fn(async () => undefined),
}))
jest.mock('@open-mercato/shared/lib/encryption/aes', () => ({ isEncryptedEnvelope: () => false }))
jest.mock('@/modules/customers/lib/send-reply', () => ({
  sendReply: (...args: unknown[]) => mockSendReply(...args),
}))
jest.mock('@/lib/usage/allowance', () => ({
  checkCustomersAiAllowance: (...args: unknown[]) => mockAllowance(...args),
}))
jest.mock('@/lib/usage/meter', () => ({ meterCustomersAi: jest.fn() }))

import { POST } from '../route'

const secret = 'test-internal-service-secret'
const initiativeId = '55555555-5555-4555-8555-555555555555'
const originalEnv = process.env
const originalFetch = global.fetch

type Row = Record<string, any>

/** Chainable knex stand-in: builder calls return the chain; awaiting the chain
 *  (or select/limit) yields the table's rows; first/update/insert are recorded. */
function createKnex(rows: Record<string, Row[]>, firsts: Record<string, unknown> = {}) {
  const updates: Array<{ table: string; data: Row }> = []
  const inserts: Array<{ table: string; data: Row }> = []
  const knex: any = (name: string) => {
    const table = name.split(' as ')[0]
    const chain: any = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void, reject: (e: unknown) => void) => Promise.resolve(rows[table] ?? []).then(resolve, reject)
        }
        if (prop === 'first') return async () => (table in firsts ? firsts[table] : { n: 0 })
        if (prop === 'update') return async (data: Row) => { updates.push({ table, data }); return 1 }
        if (prop === 'insert') return async (data: Row) => { inserts.push({ table, data }) }
        return () => chain
      },
    })
    return chain
  }
  knex.raw = (sql: string, bindings?: unknown[]) => ({ sql, bindings })
  knex.transaction = async (fn: (trx: any) => Promise<void>) => fn(knex)
  return { knex, updates, inserts }
}

function request(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/internal/reactivation', {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ noliUserId: 'n', initiativeId, ...body }),
  })
}

function useKnex(k: ReturnType<typeof createKnex>) {
  mockCreateRequestContainer.mockResolvedValue({ resolve: () => ({ getKnex: () => k.knex }) })
}

const CONTACT = { id: 'c-1', display_name: 'Christian Diaz', primary_email: 'christian@example.test', lifecycle_stage: 'past_client' }

function geminiReturns(draft: { subject: string; body: string }) {
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(draft) }] } }], usageMetadata: {} }),
  })) as unknown as typeof fetch
}

beforeEach(() => {
  process.env = { ...originalEnv, NOLI_INTERNAL_SERVICE_SECRET: secret, GOOGLE_GENERATIVE_AI_API_KEY: 'k' }
  jest.clearAllMocks()
  mockFindNoliUserById.mockResolvedValue({ clerk_user_id: 'user_clerk' })
  mockResolveClerkUserToAuthContext.mockResolvedValue({ userId: 'u', orgId: 'org', tenantId: 'tenant' })
  mockAllowance.mockResolvedValue({ allowed: true })
  mockSendReply.mockResolvedValue({ ok: true })
})
afterAll(() => {
  process.env = originalEnv
  global.fetch = originalFetch
})

const LINK = 'https://g.page/r/CabcAcmeRealty/review'

function geminiPrompt(): string {
  const call = (global.fetch as jest.Mock).mock.calls[0]
  return JSON.parse(call[1].body).contents[0].parts[0].text
}

function inserted(k: ReturnType<typeof createKnex>, table: string): Row {
  return k.inserts.find((i) => i.table === table)!.data
}

describe('review_request drafts carry the business review link', () => {
  it('includes the saved review link in the note and says so', async () => {
    geminiReturns({ subject: 'A small favor', body: `Hi Christian,\n\nThank you for trusting us with your move. Would you share a short review?\n${LINK}\n\nAcme Realty` })
    const k = createKnex({ customer_entities: [{ ...CONTACT }] }, { business_profiles: { business_name: 'Acme Realty', review_url: LINK, review_platform: 'google' } })
    useKnex(k)
    const res = await POST(request({ op: 'draft', kind: 'review_request' }))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.created).toHaveLength(1)
    expect(json.review_link).toEqual({ included: true, notice: null })
    expect(geminiPrompt()).toContain(LINK)
    const payload = JSON.parse(inserted(k, 'inbox_proposal_actions').payload)
    expect(payload.body).toContain(LINK)
    expect(payload.reviewLink).toBe(LINK)
    expect(payload.context).not.toMatch(/Reputation page/)
    expect(JSON.parse(inserted(k, 'inbox_proposal_actions').metadata).review_link).toEqual({ included: true, notice: null })
  })

  it('adds the saved link when the model forgot it', async () => {
    geminiReturns({ subject: 'A small favor', body: 'Hi Christian,\n\nWould you share a short review of working with us?\n\nAcme Realty' })
    const k = createKnex({ customer_entities: [{ ...CONTACT }] }, { business_profiles: { business_name: 'Acme Realty', review_url: LINK } })
    useKnex(k)
    await POST(request({ op: 'draft', kind: 'review_request' }))
    const payload = JSON.parse(inserted(k, 'inbox_proposal_actions').payload)
    expect(payload.body).toBe(`Hi Christian,\n\nWould you share a short review of working with us?\n\nIf you are open to it, here is the link: ${LINK}\n\nAcme Realty`)
  })

  it('with no saved link: no link in the note, and the approval card says where to add one', async () => {
    // even if the model makes one up, it never reaches the note
    geminiReturns({ subject: 'A small favor', body: 'Hi Christian,\n\nThank you for working with us. Would you leave a review at https://g.page/r/made-up/review? It helps a lot.\n\nAcme Realty' })
    const k = createKnex({ customer_entities: [{ ...CONTACT }] }, { business_profiles: { business_name: 'Acme Realty', review_url: null } })
    useKnex(k)
    const json = await (await POST(request({ op: 'draft', kind: 'review_request' }))).json()
    expect(json.created).toHaveLength(1)
    expect(json.review_link.included).toBe(false)
    expect(json.review_link.notice).toMatch(/Add your Google review link on the Reputation page/)
    expect(geminiPrompt()).toMatch(/Do not include any link/)
    expect(geminiPrompt()).not.toMatch(/https?:\/\//)
    const payload = JSON.parse(inserted(k, 'inbox_proposal_actions').payload)
    expect(payload.body).not.toMatch(/https?:|www\./)
    expect(payload.body).toContain('It helps a lot.')
    expect(payload.reviewLink).toBeNull()
    expect(payload.context).toMatch(/Add your Google review link on the Reputation page/)
    expect(inserted(k, 'inbox_proposals').summary).toMatch(/Add your Google review link on the Reputation page/)
  })

  it('treats a missing business profile the same as a missing link', async () => {
    geminiReturns({ subject: 'A small favor', body: 'Hi Christian,\n\nWould you share a short review?\n\nAcme Realty' })
    const k = createKnex({ customer_entities: [{ ...CONTACT }] }, { business_profiles: null })
    useKnex(k)
    const json = await (await POST(request({ op: 'draft', kind: 'review_request' }))).json()
    expect(json.review_link.included).toBe(false)
    expect(json.review_link.notice).toMatch(/Reputation page/)
  })

  it('still runs the fair-housing screen on a note that carries the link', async () => {
    geminiReturns({ subject: 'A small favor', body: `Hi Christian,\n\nYour home is perfect for families. Would you review us?\n${LINK}\n\nAcme Realty` })
    const k = createKnex({ customer_entities: [{ ...CONTACT }] }, { business_profiles: { business_name: 'Acme Realty', review_url: LINK } })
    useKnex(k)
    const json = await (await POST(request({ op: 'draft', kind: 'review_request' }))).json()
    expect(json.flagged).toHaveLength(1)
    expect(json.flagged[0].reason).toBe('fair_housing')
    expect(JSON.parse(inserted(k, 'inbox_proposal_actions').metadata).fair_housing.blocked).toBe(true)
  })

  it('check-ins do not carry a review link or the notice', async () => {
    geminiReturns({ subject: 'Thinking of you', body: 'Hi Christian, I hope all is well. Acme Realty' })
    const k = createKnex({ customer_entities: [{ ...CONTACT }] }, { business_profiles: { business_name: 'Acme Realty', review_url: LINK } })
    useKnex(k)
    const json = await (await POST(request({ op: 'draft', kind: 'check_in' }))).json()
    expect(json.review_link).toBeUndefined()
    expect(geminiPrompt()).not.toContain(LINK)
    const payload = JSON.parse(inserted(k, 'inbox_proposal_actions').payload)
    expect(payload).not.toHaveProperty('reviewLink')
    expect(payload.body).not.toContain(LINK)
  })
})
