jest.mock('server-only', () => ({}))
jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(),
}))
jest.mock('@open-mercato/core/modules/directory/data/entities', () => ({
  Organization: class Organization {},
}))
jest.mock('@open-mercato/shared/lib/noli/core-client', () => ({
  getNoliCoreClient: jest.fn(),
  resolveOrgByoKeys: jest.fn(),
}))

import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getNoliCoreClient, resolveOrgByoKeys } from '@open-mercato/shared/lib/noli/core-client'
import {
  createAllowanceTestClient,
  successfulAllowanceQuery,
  type AllowanceQueryName,
} from '@open-mercato/shared/lib/noli/__tests__/allowance-test-client'
import { checkCustomersAiAllowance } from '../allowance'

const createRequestContainerMock = jest.mocked(createRequestContainer)
const getNoliCoreClientMock = jest.mocked(getNoliCoreClient)
const resolveOrgByoKeysMock = jest.mocked(resolveOrgByoKeys)
const findOneMock = jest.fn()

describe('checkCustomersAiAllowance', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-07-21T18:00:00.000Z'))
    findOneMock.mockReset().mockResolvedValue({ noliOrgId: 'noli-org-1' })
    createRequestContainerMock.mockReset().mockResolvedValue({
      resolve: () => ({ findOne: findOneMock }),
    } as never)
    getNoliCoreClientMock.mockReset()
    resolveOrgByoKeysMock.mockReset().mockResolvedValue({})
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('queries annual-plan usage from the latest monthly UTC anniversary', async () => {
    const fixture = createAllowanceTestClient()
    fixture.results.subscriptions = successfulAllowanceQuery([{
      id: 'annual-subscription',
      seats: 1,
      token_boosts: 0,
      status: 'active',
      billing_interval: 'year',
      current_period_start: '2026-01-31T10:00:00.000Z',
      updated_at: '2026-01-31T10:00:00.000Z',
    }])
    fixture.results.usage = successfulAllowanceQuery([])
    getNoliCoreClientMock.mockReturnValue(fixture.client as never)

    await expect(checkCustomersAiAllowance({ orgId: 'crm-org-1' })).resolves.toEqual({ allowed: true })

    expect(fixture.mocks.usageGte).toHaveBeenCalledWith('ts', '2026-06-30T10:00:00.000Z')
  })

  it('rejects a future period while retaining the paid seat count', async () => {
    const fixture = createAllowanceTestClient()
    fixture.results.subscriptions = successfulAllowanceQuery([{
      id: 'future-subscription',
      seats: 2,
      token_boosts: 0,
      status: 'active',
      billing_interval: 'month',
      current_period_start: '2026-07-22T10:00:00.000Z',
      updated_at: '2026-07-21T10:00:00.000Z',
    }])
    fixture.results.usage = successfulAllowanceQuery([{ credits_consumed: 15_000_000 }])
    getNoliCoreClientMock.mockReturnValue(fixture.client as never)

    await expect(checkCustomersAiAllowance({ orgId: 'crm-org-1' })).resolves.toEqual({ allowed: true })

    expect(fixture.mocks.usageGte).toHaveBeenCalledWith('ts', '2026-07-01T00:00:00.000Z')
    expect(resolveOrgByoKeysMock).not.toHaveBeenCalled()
  })

  it('uses paid seats and boosts with the UTC-month fallback for an invalid period', async () => {
    const fixture = createAllowanceTestClient()
    fixture.results.subscriptions = successfulAllowanceQuery([{
      id: 'invalid-period-subscription',
      seats: 2,
      token_boosts: 1,
      status: 'past_due',
      billing_interval: 'month',
      current_period_start: '2026-07-15T12:00:00.000',
      updated_at: '2026-07-20T12:00:00.000Z',
    }])
    fixture.results.usage = successfulAllowanceQuery([{ credits_consumed: 25_000_000 }])
    getNoliCoreClientMock.mockReturnValue(fixture.client as never)

    await expect(checkCustomersAiAllowance({ orgId: 'crm-org-1' })).resolves.toEqual({ allowed: true })

    expect(fixture.mocks.usageGte).toHaveBeenCalledWith('ts', '2026-07-01T00:00:00.000Z')
    expect(resolveOrgByoKeysMock).not.toHaveBeenCalled()
  })

  it.each<AllowanceQueryName>(['members', 'subscriptions', 'usage', 'overrides'])(
    'fails open immediately when the %s read resolves with an error',
    async (queryName) => {
      const fixture = createAllowanceTestClient()
      fixture.results[queryName] = { data: null, error: { message: `${queryName} unavailable` } }
      getNoliCoreClientMock.mockReturnValue(fixture.client as never)

      await expect(checkCustomersAiAllowance({ orgId: 'crm-org-1' })).resolves.toEqual({ allowed: true })

      expect(resolveOrgByoKeysMock).not.toHaveBeenCalled()
      if (queryName === 'members' || queryName === 'subscriptions') {
        expect(fixture.mocks.usageGte).not.toHaveBeenCalled()
        expect(fixture.mocks.overridesIn).not.toHaveBeenCalled()
      } else if (queryName === 'usage') {
        expect(fixture.mocks.overridesIn).not.toHaveBeenCalled()
      }
    },
  )
})
