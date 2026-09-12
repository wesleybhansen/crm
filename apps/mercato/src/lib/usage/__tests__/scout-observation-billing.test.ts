jest.mock('server-only', () => ({}))
jest.mock('@open-mercato/shared/lib/di/container', () => ({ createRequestContainer: jest.fn() }))
jest.mock('@open-mercato/core/modules/directory/data/entities', () => ({ Organization: class Organization {} }))
jest.mock('@open-mercato/shared/lib/noli/core-client', () => ({ getNoliCoreClient: jest.fn(), findPrimaryOrgIdForUser: jest.fn() }))

import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getNoliCoreClient } from '@open-mercato/shared/lib/noli/core-client'
import { meterCustomersAi, meterCustomersAiStrict } from '../meter'
import { observeScoutUsage } from '@/modules/customers/lib/scout-usage-observation'

const originalEnv = process.env
const insert = jest.fn()
const upsert = jest.fn()
const findOne = jest.fn()
const from = jest.fn()
const catalog = jest.fn()
const writeModes = [
  { name: 'best-effort', meter: meterCustomersAi, writer: insert, idempotencyKey: undefined },
  { name: 'strict', meter: meterCustomersAiStrict, writer: upsert, idempotencyKey: 'scout:fixture-operation' },
] as const

describe('Scout observations through the native wrapper and billing logger', () => {
  beforeEach(() => {
    process.env = { ...originalEnv, NOLI_CORE_SUPABASE_URL: 'https://unused.example.test', NOLI_CORE_SUPABASE_SERVICE_ROLE_KEY: 'synthetic-test-key' }
    insert.mockReset().mockResolvedValue({ error: null })
    upsert.mockReset().mockResolvedValue({ error: null })
    findOne.mockReset().mockResolvedValue({ noliOrgId: 'noli-org-fixture' })
    catalog.mockReset().mockResolvedValue({ data: [], error: null })
    from.mockReset().mockImplementation((table: string) => {
      if (table === 'ai_usage') return { insert, upsert }
      if (table === 'model_catalog') return { select: () => ({ eq: catalog }) }
      throw new Error(`Unexpected database table: ${table}`)
    })
    jest.mocked(getNoliCoreClient).mockReturnValue({ from } as never)
    jest.mocked(createRequestContainer).mockResolvedValue({ resolve: () => ({ findOne }) } as never)
  })

  afterAll(() => { process.env = originalEnv })

  describe.each(writeModes)('$name', ({ meter, writer, idempotencyKey }) => {
    it.each([false, true])('preserves every billing field and query count for BYO=%p across cache observations', async (byoKey) => {
      const base = { noliUserId: 'noli-user-fixture', model: 'gpt-4o-mini', tokensIn: 10000, tokensOut: 100, feature: 'scout-assistant', byoKey, idempotencyKey }
      for (const cached of [undefined, 0, 5000, 10000, 10001, -1, '5000']) {
        writer.mockClear()
        from.mockClear()
        findOne.mockClear()
        await meter({ orgId: 'crm-org-fixture' }, base)
        const baseline = writer.mock.calls[0]
        const baselineFrom = [...from.mock.calls]
        const baselineFind = [...findOne.mock.calls]
        writer.mockClear()
        from.mockClear()
        findOne.mockClear()
        const observation = observeScoutUsage('openai', { prompt_tokens: 10000, prompt_tokens_details: { cached_tokens: cached }, completion_tokens: 100, completion_tokens_details: { reasoning_tokens: 50 }, total_tokens: 10100 })
        await meter({ orgId: 'crm-org-fixture' }, { ...base, metadata: { scout_usage_observation: observation } })
        expect(writer).toHaveBeenCalledTimes(1)
        const candidate = writer.mock.calls[0]
        expect(candidate[0].metadata.scout_usage_observation).toEqual(observation)
        const { scout_usage_observation: removed, ...legacyMetadata } = candidate[0].metadata
        expect(removed).toBeDefined()
        expect([{ ...candidate[0], metadata: legacyMetadata }, ...candidate.slice(1)]).toEqual(baseline)
        expect(from.mock.calls).toEqual(baselineFrom)
        expect(findOne.mock.calls).toEqual(baselineFind)
        expect(candidate[0]).not.toHaveProperty('cachedTokensIn')
      }
    })
  })

  it('still isolates a best-effort write failure and rejects a strict write failure', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      insert.mockResolvedValue({ error: { message: 'synthetic outage' } })
      upsert.mockResolvedValue({ error: { message: 'synthetic outage' } })
      const args = { noliUserId: 'noli-user-fixture', model: 'gpt-4o-mini', tokensIn: 10, tokensOut: 1, metadata: { scout_usage_observation: observeScoutUsage('openai', undefined) } }
      await expect(meterCustomersAi({ orgId: 'crm-org-fixture' }, args)).resolves.toBeUndefined()
      await expect(meterCustomersAiStrict({ orgId: 'crm-org-fixture' }, { ...args, idempotencyKey: 'scout:failure' })).rejects.toMatchObject({ code: 'metering_write_failed' })
      expect(insert).toHaveBeenCalledTimes(1)
      expect(upsert).toHaveBeenCalledTimes(1)
    } finally { errorSpy.mockRestore() }
  })
})
