/** @jest-environment node */

const mockCreateRequestContainer = jest.fn()
const mockGetAuth = jest.fn()
const mockDecrypt = jest.fn()
const selected: unknown[] = []

function createKnex() {
  const knex: any = (table: string) => {
    const q: any = {
      leftJoin: jest.fn(() => q),
      where: jest.fn(() => q),
      whereNull: jest.fn(() => q),
      first: jest.fn(async () => (table === 'sequences' ? { id: 'seq-1', organization_id: 'org-1' } : undefined)),
      select: jest.fn((...cols: unknown[]) => { selected.push(...cols); return q }),
      orderBy: jest.fn(async () => [
        { id: 'enr-1', status: 'active', display_name: 'ciphertext-name', primary_email: 'ciphertext-email', waiting_reason: null },
      ]),
    }
    return q
  }
  knex.raw = jest.fn((sql: string) => ({ sql }))
  return knex
}

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: (...args: unknown[]) => mockCreateRequestContainer(...args),
}))
jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromCookies: (...args: unknown[]) => mockGetAuth(...args),
}))
jest.mock('@open-mercato/shared/lib/encryption/decryptRows', () => ({
  decryptRowFields: (...args: unknown[]) => mockDecrypt(...args),
  CONTACT_ENTITY_KEY: 'customers:customer_entity',
}))

import { GET } from '../route'

beforeEach(() => {
  jest.clearAllMocks()
  selected.length = 0
  mockGetAuth.mockResolvedValue({ orgId: 'org-1', tenantId: 'tenant-1', sub: 'user-1' })
  const em = { getKnex: () => createKnex() }
  mockCreateRequestContainer.mockResolvedValue({ resolve: () => em })
  mockDecrypt.mockImplementation(async (_em: unknown, _key: string, rows: Array<Record<string, unknown>>) => {
    for (const row of rows) { row.display_name = 'Ada Lovelace'; row.primary_email = 'ada@example.test' }
    return rows
  })
})

describe('GET /api/sequences/:id/enrollments', () => {
  it('returns decrypted names under the field names the page reads', async () => {
    const res = await GET(new Request('https://crm.example.test/api/sequences/seq-1/enrollments'), { params: { id: 'seq-1' } })
    const body = await res.json()
    expect(selected).toEqual(expect.arrayContaining(['ce.display_name as display_name', 'ce.primary_email as primary_email']))
    expect(mockDecrypt).toHaveBeenCalledWith(
      expect.anything(), 'customers:customer_entity', expect.any(Array), ['display_name', 'primary_email'], 'tenant-1', 'org-1',
    )
    expect(body.data[0]).toMatchObject({ display_name: 'Ada Lovelace', primary_email: 'ada@example.test' })
  })
})
