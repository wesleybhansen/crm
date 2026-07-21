export type AllowanceQueryResult = { data: unknown; error: unknown };

export type AllowanceQueryName = 'members' | 'subscriptions' | 'usage' | 'overrides';

export function successfulAllowanceQuery(data: unknown): AllowanceQueryResult {
  return { data, error: null };
}

export function createAllowanceTestClient() {
  const results: Record<AllowanceQueryName, AllowanceQueryResult> = {
    members: successfulAllowanceQuery([{ user_id: 'member-1' }]),
    subscriptions: successfulAllowanceQuery([{
      id: 'subscription-1',
      seats: 1,
      token_boosts: 0,
      status: 'active',
      billing_interval: 'month',
      current_period_start: '2026-07-15T12:00:00.000Z',
      updated_at: '2026-07-15T12:00:00.000Z',
    }]),
    usage: successfulAllowanceQuery([{ credits_consumed: 50_000_000 }]),
    overrides: successfulAllowanceQuery([]),
  };

  const membersEq = jest.fn(async () => results.members);
  const subscriptionsIn = jest.fn(async () => results.subscriptions);
  const usageGte = jest.fn(async () => results.usage);
  const overridesIn = jest.fn(async () => results.overrides);
  const from = jest.fn((table: string) => {
    if (table === 'organization_members') {
      return {
        select: jest.fn(() => ({ eq: membersEq })),
      };
    }
    if (table === 'subscriptions') {
      return {
        select: jest.fn(() => ({
          eq: jest.fn(() => ({ in: subscriptionsIn })),
        })),
      };
    }
    if (table === 'ai_usage') {
      return {
        select: jest.fn(() => ({
          eq: jest.fn(() => ({
            eq: jest.fn(() => ({ gte: usageGte })),
          })),
        })),
      };
    }
    if (table === 'user_cap_overrides') {
      return {
        select: jest.fn(() => ({ in: overridesIn })),
      };
    }
    throw new Error(`Unexpected allowance table: ${table}`);
  });

  return {
    client: { from },
    results,
    mocks: {
      from,
      membersEq,
      subscriptionsIn,
      usageGte,
      overridesIn,
    },
  };
}
