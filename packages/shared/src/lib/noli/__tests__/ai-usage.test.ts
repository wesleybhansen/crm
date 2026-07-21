var insertMock: jest.Mock
var organizationMembersMock: jest.Mock

jest.mock('server-only', () => ({}))

jest.mock('../core-client', () => {
  insertMock = jest.fn().mockResolvedValue({ error: null })
  organizationMembersMock = jest.fn().mockResolvedValue({ data: [], error: null })

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
        if (table === 'organization_members') {
          return {
            select: jest.fn(() => ({
              eq: jest.fn(() => ({ order: organizationMembersMock })),
            })),
          }
        }
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
    organizationMembersMock.mockReset().mockResolvedValue({ data: [], error: null })
  })

  afterEach(() => {
    jest.useRealTimers()
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

  it('retries an unresolved owner after the short negative-cache window expires', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-07-21T18:00:00.000Z'))
    organizationMembersMock
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({
        data: [{ user_id: 'owner-after-provisioning', role: 'owner' }],
        error: null,
      })

    const event = {
      noliOrgId: 'org-negative-cache-retry',
      model: 'gpt-5-mini',
      tokensIn: 1_000,
      tokensOut: 100,
    }

    await logCrmAiUsage(event)
    expect(organizationMembersMock).toHaveBeenCalledTimes(1)
    expect(insertMock).not.toHaveBeenCalled()

    jest.advanceTimersByTime(29_999)
    await logCrmAiUsage(event)
    expect(organizationMembersMock).toHaveBeenCalledTimes(1)
    expect(insertMock).not.toHaveBeenCalled()

    jest.advanceTimersByTime(1)
    await logCrmAiUsage(event)
    expect(organizationMembersMock).toHaveBeenCalledTimes(2)
    expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({
      user_id: 'owner-after-provisioning',
      organization_id: 'org-negative-cache-retry',
    }))
  })

  it('retries owner resolution immediately after a returned query error', async () => {
    organizationMembersMock
      .mockResolvedValueOnce({ data: null, error: { message: 'temporary read failure' } })
      .mockResolvedValueOnce({
        data: [{ user_id: 'owner-after-returned-error', role: 'owner' }],
        error: null,
      })

    const event = {
      noliOrgId: 'org-returned-error-retry',
      model: 'gpt-5-mini',
      tokensIn: 1_000,
      tokensOut: 100,
    }

    await logCrmAiUsage(event)
    await logCrmAiUsage(event)

    expect(organizationMembersMock).toHaveBeenCalledTimes(2)
    expect(insertMock).toHaveBeenCalledTimes(1)
    expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({
      user_id: 'owner-after-returned-error',
      organization_id: 'org-returned-error-retry',
    }))
  })

  it('retries owner resolution immediately after a thrown query failure', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    organizationMembersMock
      .mockRejectedValueOnce(new Error('temporary transport failure'))
      .mockResolvedValueOnce({
        data: [{ user_id: 'owner-after-thrown-error', role: 'owner' }],
        error: null,
      })

    const event = {
      noliOrgId: 'org-thrown-error-retry',
      model: 'gpt-5-mini',
      tokensIn: 1_000,
      tokensOut: 100,
    }

    await logCrmAiUsage(event)
    await logCrmAiUsage(event)

    expect(organizationMembersMock).toHaveBeenCalledTimes(2)
    expect(insertMock).toHaveBeenCalledTimes(1)
    expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({
      user_id: 'owner-after-thrown-error',
      organization_id: 'org-thrown-error-retry',
    }))
    expect(consoleError).toHaveBeenCalledWith(
      '[crm ai_usage] resolveOwnerUserId failed',
      expect.any(Error),
    )
    consoleError.mockRestore()
  })
})
