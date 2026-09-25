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

describe('reactivation drafts pass a fair-housing screen', () => {
  it('a clean note is drafted as usual (the recipient’s own name is not flagged)', async () => {
    geminiReturns({ subject: 'Thinking of you', body: 'Hi Christian, I was thinking of you and hope the house is treating you well. Reply any time. Acme Realty' })
    const k = createKnex({ customer_entities: [{ ...CONTACT }] }, { business_profiles: null })
    useKnex(k)
    const res = await POST(request({ op: 'draft', kind: 'check_in' }))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.created).toHaveLength(1)
    expect(json.flagged).toEqual([])
    const action = k.inserts.find((i) => i.table === 'inbox_proposal_actions')!
    expect(JSON.parse(action.data.metadata).fair_housing).toEqual({ ok: true })
  })

  it('a failing note is recorded with the reason for the owner, marked blocked', async () => {
    geminiReturns({ subject: 'Hello', body: 'Hi Christian, homes in your quiet neighborhood are perfect for families right now. Acme Realty' })
    const k = createKnex({ customer_entities: [{ ...CONTACT }] }, { business_profiles: null })
    useKnex(k)
    const json = await (await POST(request({ op: 'draft', kind: 'check_in' }))).json()
    expect(json.flagged).toHaveLength(1)
    expect(json.flagged[0].reason).toBe('fair_housing')
    expect(json.flagged[0].advisory).toMatch(/perfect for families/)
    // "quiet" describes noise, not who lives there (M9): not a finding.
    expect(json.flagged[0].advisory).not.toMatch(/quiet neighborhood/)
    const action = k.inserts.find((i) => i.table === 'inbox_proposal_actions')!
    const meta = JSON.parse(action.data.metadata)
    expect(meta.fair_housing.blocked).toBe(true)
    expect(JSON.parse(action.data.payload).context).toMatch(/^Held, not sendable/)
    const proposal = k.inserts.find((i) => i.table === 'inbox_proposals')!
    expect(proposal.data.summary).toMatch(/will not be sent/)
  })

  it('approve holds a failing note for the owner to edit, never dismisses or approves it (M9)', async () => {
    const blockedRow = {
      id: 'a-1',
      payload: JSON.stringify({ toName: 'Pat', subject: 'Hi', body: 'Great for families!' }),
      metadata: JSON.stringify({ fair_housing: { ok: false, blocked: true, advisory: 'x' } }),
    }
    const k = createKnex({ inbox_proposal_actions: [blockedRow] })
    useKnex(k)
    const json = await (await POST(request({ op: 'approve' }))).json()
    expect(json.blocked).toEqual([{ actionId: 'a-1', reason: 'fair_housing', advisory: expect.any(String), editable: true }])
    expect(k.updates.find((u) => u.data.status === 'dismissed')).toBeUndefined()
  })

  it('a note flagged at draft time and since edited clean is approved', async () => {
    const edited = {
      id: 'a-5',
      payload: JSON.stringify({ toName: 'Pat', subject: 'Hi', body: 'Congrats on finishing your bachelor\'s degree! Acme Realty' }),
      metadata: JSON.stringify({ fair_housing: { ok: false, blocked: true, advisory: 'old flag' } }),
    }
    const k = createKnex({ inbox_proposal_actions: [edited] })
    useKnex(k)
    const json = await (await POST(request({ op: 'approve' }))).json()
    expect(json.blocked).toEqual([])
    const approval = k.updates.find((u) => u.data.status === 'approved')
    expect(approval).toBeDefined()
  })

  it('send-batch re-screens and refuses a failing note at send time', async () => {
    const approved = {
      id: 'a-2', proposal_id: 'p-2',
      payload: JSON.stringify({ contactId: 'c-1', toName: 'Pat', subject: 'Hi', body: 'Homes in this exclusive community, no kids, are moving fast.' }),
      metadata: JSON.stringify({}),
    }
    const k = createKnex(
      { inbox_proposal_actions: [approved], email_unsubscribes: [], gtm_suppressions: [] },
      { customer_entities: { id: 'c-1', display_name: 'Pat', primary_email: 'pat@example.test' }, email_messages: undefined },
    )
    useKnex(k)
    const json = await (await POST(request({ op: 'send-batch', dailyCap: 5 }))).json()
    expect(json.refused).toEqual([{ actionId: 'a-2', contactId: 'c-1', reason: 'fair_housing' }])
    expect(mockSendReply).not.toHaveBeenCalled()
  })

  it('send-batch still sends a clean approved note', async () => {
    const approved = {
      id: 'a-3', proposal_id: 'p-3',
      payload: JSON.stringify({ contactId: 'c-1', toName: 'Pat', subject: 'Hi', body: 'Thinking of you. Acme Realty' }),
      metadata: JSON.stringify({ fair_housing: { ok: true } }),
    }
    const k = createKnex(
      { inbox_proposal_actions: [approved], email_unsubscribes: [], gtm_suppressions: [] },
      { customer_entities: { id: 'c-1', display_name: 'Pat', primary_email: 'pat@example.test' }, email_messages: undefined },
    )
    useKnex(k)
    const json = await (await POST(request({ op: 'send-batch', dailyCap: 5 }))).json()
    expect(json.sent).toBe(1)
    expect(mockSendReply).toHaveBeenCalledTimes(1)
  })
})
