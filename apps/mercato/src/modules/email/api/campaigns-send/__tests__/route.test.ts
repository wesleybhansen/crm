/** @jest-environment node */

const mockCreateRequestContainer = jest.fn()
const mockGetAuth = jest.fn()
const mockResolveSender = jest.fn()
const mockSend = jest.fn()

const writes: Array<{ table: string; kind: string; payload?: Record<string, any> }> = []

function createKnex() {
  return (table: string) => {
    const q: any = {
      where: jest.fn(() => q),
      whereNull: jest.fn(() => q),
      whereNotNull: jest.fn(() => q),
      whereIn: jest.fn(() => q),
      first: jest.fn(async () => (table === 'email_campaigns'
        ? { id: 'blast-1', organization_id: 'org-1', status: 'draft', subject: 'Hi', body_html: '<body></body>', name: 'Blast' }
        : undefined)),
      select: jest.fn(async () => (table === 'customer_entities'
        ? [{ id: 'contact-1', primary_email: 'lead@example.test', display_name: 'Lead Person' }]
        : [])),
      update: jest.fn(async (payload: Record<string, any>) => { writes.push({ table, kind: 'update', payload }); return 1 }),
      insert: jest.fn(async (payload: Record<string, any>) => { writes.push({ table, kind: 'insert', payload }) }),
    }
    q.insert = jest.fn((payload: Record<string, any>) => {
      writes.push({ table, kind: 'insert', payload })
      const p: any = Promise.resolve()
      return p
    })
    return q
  }
}

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: (...args: unknown[]) => mockCreateRequestContainer(...args),
}))
jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromCookies: (...args: unknown[]) => mockGetAuth(...args),
}))
jest.mock('../../../lib/routing-service', () => ({
  ...jest.requireActual('../../../lib/routing-service'),
  resolveSenderAddress: (...args: unknown[]) => mockResolveSender(...args),
}))
jest.mock('@/modules/email/lib/email-router', () => ({
  sendEmailByPurpose: (...args: unknown[]) => mockSend(...args),
}))

jest.mock('@/lib/email-token', () => ({ signEmailToken: () => 'signed-token' }))
jest.mock('@open-mercato/shared/lib/encryption/decryptRows', () => ({
  decryptRowFields: async (_em: unknown, _key: string, rows: unknown[]) => rows,
  CONTACT_ENTITY_KEY: 'customers:customer_entity',
}))
jest.mock('@/lib/timeline', () => ({ logTimelineEvent: async () => undefined }))

import { POST } from '../route'

beforeEach(() => {
  jest.clearAllMocks()
  writes.length = 0
  mockGetAuth.mockResolvedValue({ orgId: 'org-1', tenantId: 'tenant-1', sub: 'user-1' })
  mockCreateRequestContainer.mockResolvedValue({
    resolve: (name: string) => {
      if (name === 'em') return { getKnex: () => createKnex() }
      throw new Error(`unexpected resolve: ${name}`)
    },
  })
})

describe('POST /api/email/campaigns-send sending pre-check', () => {
  it('refuses before claiming when the org has no sending setup: nothing sent, nothing written', async () => {
    mockResolveSender.mockResolvedValue(null)
    const res = await POST(new Request('https://crm.example.test/api/email/campaigns-send?id=blast-1', { method: 'POST' }))
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({
      ok: false,
      code: 'email_not_connected',
      error: 'Connect an email account in Settings before sending; nothing will be sent until then.',
    })
    expect(mockResolveSender).toHaveBeenCalledWith(expect.anything(), 'org-1', 'marketing')
    expect(mockSend).not.toHaveBeenCalled()
    expect(writes).toHaveLength(0)
  })
})

describe('POST /api/email/campaigns-send message records', () => {
  it("records each message from the org's real sender, never Noli's EMAIL_FROM, and marks it sent", async () => {
    const original = process.env.EMAIL_FROM
    process.env.EMAIL_FROM = 'Noli <hello@noliai.com>'
    mockResolveSender.mockResolvedValue('owner@customer.test')
    mockSend.mockResolvedValue({ ok: true, fromAddress: 'owner@customer.test', messageId: 'm-1' })
    const res = await POST(new Request('https://crm.example.test/api/email/campaigns-send?id=blast-1', { method: 'POST' }))
    expect(res.status).toBe(200)
    const inserted = writes.find((w) => w.table === 'email_messages' && w.kind === 'insert')!
    expect(inserted.payload!.from_address).toBe('owner@customer.test')
    const updated = writes.find((w) => w.table === 'email_messages' && w.kind === 'update')!
    expect(updated.payload).toMatchObject({ status: 'sent', from_address: 'owner@customer.test' })
    expect(JSON.stringify(writes)).not.toContain('noliai.com')
    if (original === undefined) delete process.env.EMAIL_FROM
    else process.env.EMAIL_FROM = original
  })
})
