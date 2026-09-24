/** @jest-environment node */

const mockCreateRequestContainer = jest.fn()
const mockGetAuth = jest.fn()
const mockHasSendingSetup = jest.fn()
const mockSend = jest.fn()

const writes: Array<{ table: string; kind: string }> = []

function createKnex() {
  return (table: string) => {
    const q: any = {
      where: jest.fn(() => q),
      first: jest.fn(async () => (table === 'email_campaigns'
        ? { id: 'blast-1', organization_id: 'org-1', status: 'draft', subject: 'Hi', body_html: '<body></body>' }
        : undefined)),
      update: jest.fn(async () => { writes.push({ table, kind: 'update' }); return 1 }),
      insert: jest.fn(async () => { writes.push({ table, kind: 'insert' }) }),
    }
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
  hasSendingSetup: (...args: unknown[]) => mockHasSendingSetup(...args),
}))
jest.mock('@/modules/email/lib/email-router', () => ({
  sendEmailByPurpose: (...args: unknown[]) => mockSend(...args),
}))

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
    mockHasSendingSetup.mockResolvedValue(false)
    const res = await POST(new Request('https://crm.example.test/api/email/campaigns-send?id=blast-1', { method: 'POST' }))
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({
      ok: false,
      code: 'email_not_connected',
      error: 'Connect an email account in Settings before sending; nothing will be sent until then.',
    })
    expect(mockHasSendingSetup).toHaveBeenCalledWith(expect.anything(), 'org-1', 'marketing')
    expect(mockSend).not.toHaveBeenCalled()
    expect(writes).toHaveLength(0)
  })
})
