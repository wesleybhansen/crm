import {
  LIVE_NOLI_SUBSCRIPTION_STATUSES,
  resolveAllowanceBillingPeriod,
  type NoliBillingSubscription,
} from '../billing-period';

type TestSubscription = NoliBillingSubscription & {
  seats: number;
  token_boosts: number;
};

const now = new Date('2026-07-21T18:00:00.000Z');

describe('resolveAllowanceBillingPeriod', () => {
  it('uses the newest valid live subscription period instead of the UTC calendar month', () => {
    const subscriptions: TestSubscription[] = [
      {
        id: 'older-active',
        status: 'active',
        current_period_start: '2026-06-15T12:00:00.000Z',
        updated_at: '2026-06-15T12:00:00.000Z',
        seats: 2,
        token_boosts: 0,
      },
      {
        id: 'current-past-due',
        status: 'past_due',
        current_period_start: '2026-07-15T12:00:00.000Z',
        updated_at: '2026-07-20T12:00:00.000Z',
        seats: 4,
        token_boosts: 1,
      },
      {
        id: 'canceled-newer',
        status: 'canceled',
        current_period_start: '2026-07-20T12:00:00.000Z',
        updated_at: '2026-07-20T12:00:00.000Z',
        seats: 20,
        token_boosts: 20,
      },
    ];

    const result = resolveAllowanceBillingPeriod(subscriptions, now);

    expect(result.periodStart.toISOString()).toBe('2026-07-15T12:00:00.000Z');
    expect(result.subscription).toMatchObject({ id: 'current-past-due', seats: 4, token_boosts: 1 });
  });

  it.each(LIVE_NOLI_SUBSCRIPTION_STATUSES)('treats %s as a live Noli subscription status', (status) => {
    const result = resolveAllowanceBillingPeriod([
      {
        id: status,
        status,
        current_period_start: '2026-07-12T00:00:00.000Z',
        updated_at: '2026-07-12T00:00:00.000Z',
      },
    ], now);

    expect(result.subscription?.id).toBe(status);
  });

  it('breaks equal-period ties by update time and then id', () => {
    const result = resolveAllowanceBillingPeriod([
      {
        id: 'a',
        status: 'active',
        current_period_start: '2026-07-15T00:00:00.000Z',
        updated_at: '2026-07-20T00:00:00.000Z',
      },
      {
        id: 'b',
        status: 'trialing',
        current_period_start: '2026-07-15T00:00:00.000Z',
        updated_at: '2026-07-20T00:00:00.000Z',
      },
    ], now);

    expect(result.subscription?.id).toBe('b');
  });

  it('falls back to the UTC month start when no live subscription has a valid period', () => {
    const result = resolveAllowanceBillingPeriod([
      {
        id: 'invalid-active',
        status: 'active',
        current_period_start: 'not-a-date',
        updated_at: '2026-07-20T00:00:00.000Z',
      },
      {
        id: 'missing-trial',
        status: 'trialing',
        current_period_start: null,
        updated_at: '2026-07-20T00:00:00.000Z',
      },
      {
        id: 'valid-canceled',
        status: 'canceled',
        current_period_start: '2026-07-19T00:00:00.000Z',
        updated_at: '2026-07-20T00:00:00.000Z',
      },
    ], now);

    expect(result.subscription).toBeNull();
    expect(result.periodStart.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });
});
