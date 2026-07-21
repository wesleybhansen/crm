jest.mock('server-only', () => ({}));
jest.mock('../core-client', () => ({
  getNoliCoreClient: jest.fn(),
  resolveOrgByoKeys: jest.fn(),
}));

import { checkOrgAiAllowance } from '../allowance';
import { getNoliCoreClient, resolveOrgByoKeys } from '../core-client';
import {
  createAllowanceTestClient,
  successfulAllowanceQuery,
  type AllowanceQueryName,
} from './allowance-test-client';

const getNoliCoreClientMock = jest.mocked(getNoliCoreClient);
const resolveOrgByoKeysMock = jest.mocked(resolveOrgByoKeys);

describe('checkOrgAiAllowance', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-21T18:00:00.000Z'));
    process.env = {
      ...originalEnv,
      NOLI_CORE_SUPABASE_URL: 'https://noli-core.example.test',
      NOLI_CORE_SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    };
    getNoliCoreClientMock.mockReset();
    resolveOrgByoKeysMock.mockReset().mockResolvedValue({});
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('queries annual-plan usage from the latest monthly UTC anniversary', async () => {
    const fixture = createAllowanceTestClient();
    fixture.results.subscriptions = successfulAllowanceQuery([{
      id: 'annual-subscription',
      seats: 1,
      token_boosts: 0,
      status: 'active',
      billing_interval: 'year',
      current_period_start: '2026-01-31T10:00:00.000Z',
      updated_at: '2026-01-31T10:00:00.000Z',
    }]);
    fixture.results.usage = successfulAllowanceQuery([]);
    getNoliCoreClientMock.mockReturnValue(fixture.client as never);

    await expect(checkOrgAiAllowance('noli-org-1')).resolves.toEqual({ allowed: true });

    expect(fixture.mocks.usageGte).toHaveBeenCalledWith('ts', '2026-06-30T10:00:00.000Z');
  });

  it('rejects a future period while retaining the paid seat count', async () => {
    const fixture = createAllowanceTestClient();
    fixture.results.subscriptions = successfulAllowanceQuery([{
      id: 'future-subscription',
      seats: 2,
      token_boosts: 0,
      status: 'active',
      billing_interval: 'month',
      current_period_start: '2026-07-22T10:00:00.000Z',
      updated_at: '2026-07-21T10:00:00.000Z',
    }]);
    fixture.results.usage = successfulAllowanceQuery([{ credits_consumed: 15_000_000 }]);
    getNoliCoreClientMock.mockReturnValue(fixture.client as never);

    await expect(checkOrgAiAllowance('noli-org-1')).resolves.toEqual({ allowed: true });

    expect(fixture.mocks.usageGte).toHaveBeenCalledWith('ts', '2026-07-01T00:00:00.000Z');
    expect(resolveOrgByoKeysMock).not.toHaveBeenCalled();
  });

  it('uses paid seats and boosts with the UTC-month fallback for an invalid period', async () => {
    const fixture = createAllowanceTestClient();
    fixture.results.subscriptions = successfulAllowanceQuery([{
      id: 'invalid-period-subscription',
      seats: 2,
      token_boosts: 1,
      status: 'past_due',
      billing_interval: 'month',
      current_period_start: '2026-07-15T12:00:00.000',
      updated_at: '2026-07-20T12:00:00.000Z',
    }]);
    fixture.results.usage = successfulAllowanceQuery([{ credits_consumed: 25_000_000 }]);
    getNoliCoreClientMock.mockReturnValue(fixture.client as never);

    await expect(checkOrgAiAllowance('noli-org-1')).resolves.toEqual({ allowed: true });

    expect(fixture.mocks.usageGte).toHaveBeenCalledWith('ts', '2026-07-01T00:00:00.000Z');
    expect(resolveOrgByoKeysMock).not.toHaveBeenCalled();
  });

  it.each<AllowanceQueryName>(['members', 'subscriptions', 'usage', 'overrides'])(
    'fails open immediately when the %s read resolves with an error',
    async (queryName) => {
      const fixture = createAllowanceTestClient();
      fixture.results[queryName] = { data: null, error: { message: `${queryName} unavailable` } };
      getNoliCoreClientMock.mockReturnValue(fixture.client as never);

      await expect(checkOrgAiAllowance('noli-org-1')).resolves.toEqual({ allowed: true });

      expect(resolveOrgByoKeysMock).not.toHaveBeenCalled();
      if (queryName === 'members' || queryName === 'subscriptions') {
        expect(fixture.mocks.usageGte).not.toHaveBeenCalled();
        expect(fixture.mocks.overridesIn).not.toHaveBeenCalled();
      } else if (queryName === 'usage') {
        expect(fixture.mocks.overridesIn).not.toHaveBeenCalled();
      }
    },
  );
});
