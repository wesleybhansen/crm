var insertMock: jest.Mock

jest.mock('server-only', () => ({}))

jest.mock('../core-client', () => {
  insertMock = jest.fn().mockResolvedValue({ error: null })

  return {
    findPrimaryOrgIdForUser: jest.fn(),
    getNoliCoreClient: jest.fn(() => ({
      from: jest.fn((table: string) => {
        if (table === 'model_catalog') {
          return {
            select: jest.fn(() => ({
              eq: jest.fn().mockResolvedValue({ data: [], error: null }),
            })),
          }
        }

        if (table === 'ai_usage') return { insert: insertMock }
        throw new Error(`Unexpected table: ${table}`)
      }),
    })),
  }
})

import { logCrmAiUsage } from '../ai-usage'

describe('logCrmAiUsage cost attribution', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      NOLI_CORE_SUPABASE_URL: 'https://noli-core.example.test',
      NOLI_CORE_SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    }
    insertMock.mockClear()
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it('retains sub-cent precision when converting embedding cost to credits', async () => {
    await logCrmAiUsage({
      noliUserId: 'user-1',
      noliOrgId: 'org-1',
      model: 'text-embedding-3-small',
      tokensIn: 1_000,
      tokensOut: 0,
    })

    expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({
      cost_cents: 1,
      credits_consumed: 5,
    }))
  })

  it('keeps the existing credit conversion for an exact whole-cent cost', async () => {
    await logCrmAiUsage({
      noliUserId: 'user-1',
      noliOrgId: 'org-1',
      model: 'text-embedding-3-small',
      tokensIn: 500_000,
      tokensOut: 0,
    })

    expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({
      cost_cents: 1,
      credits_consumed: 2_500,
    }))
  })
})
