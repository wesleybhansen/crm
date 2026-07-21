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
  it('uses the newest valid live monthly subscription period instead of the UTC calendar month', () => {
    const subscriptions: TestSubscription[] = [
      {
        id: 'older-active',
        status: 'active',
        billing_interval: 'month',
        current_period_start: '2026-06-15T12:00:00.000Z',
        updated_at: '2026-06-15T12:00:00.000Z',
        seats: 2,
        token_boosts: 0,
      },
      {
        id: 'current-past-due',
        status: 'past_due',
        billing_interval: 'month',
        current_period_start: '2026-07-15T12:00:00.000Z',
        updated_at: '2026-07-20T12:00:00.000Z',
        seats: 4,
        token_boosts: 1,
      },
      {
        id: 'canceled-newer',
        status: 'canceled',
        billing_interval: 'month',
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
        billing_interval: 'month',
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
        billing_interval: 'month',
        current_period_start: '2026-07-15T00:00:00.000Z',
        updated_at: '2026-07-20T00:00:00.000Z',
      },
      {
        id: 'b',
        status: 'trialing',
        billing_interval: 'month',
        current_period_start: '2026-07-15T00:00:00.000Z',
        updated_at: '2026-07-20T00:00:00.000Z',
      },
    ], now);

    expect(result.subscription?.id).toBe('b');
  });

  it('resets annual plans at the latest monthly UTC anniversary without month-end drift', () => {
    const subscription = {
      id: 'annual',
      status: 'active',
      billing_interval: 'year',
      current_period_start: '2024-01-31T10:15:30.000Z',
      updated_at: '2024-01-31T10:15:30.000Z',
    };

    expect(resolveAllowanceBillingPeriod(
      [subscription],
      new Date('2024-03-15T00:00:00.000Z'),
    ).periodStart.toISOString()).toBe('2024-02-29T10:15:30.000Z');
    expect(resolveAllowanceBillingPeriod(
      [subscription],
      new Date('2024-04-15T00:00:00.000Z'),
    ).periodStart.toISOString()).toBe('2024-03-31T10:15:30.000Z');
  });

  it('rejects future, timezone-less, and calendar-invalid period starts', () => {
    const result = resolveAllowanceBillingPeriod([
      {
        id: 'valid',
        status: 'active',
        billing_interval: 'month',
        current_period_start: '2026-07-10T00:00:00.000Z',
        updated_at: '2026-07-10T00:00:00.000Z',
      },
      {
        id: 'future',
        status: 'active',
        billing_interval: 'month',
        current_period_start: '2026-07-22T00:00:00.000Z',
        updated_at: '2026-07-22T00:00:00.000Z',
      },
      {
        id: 'timezone-less',
        status: 'active',
        billing_interval: 'month',
        current_period_start: '2026-07-20T00:00:00.000',
        updated_at: '2026-07-20T00:00:00.000Z',
      },
      {
        id: 'invalid-calendar-date',
        status: 'active',
        billing_interval: 'month',
        current_period_start: '2026-06-31T00:00:00.000Z',
        updated_at: '2026-07-21T00:00:00.000Z',
      },
    ], now);

    expect(result.subscription?.id).toBe('valid');
    expect(result.periodStart.toISOString()).toBe('2026-07-10T00:00:00.000Z');
  });

  it('retains a deterministic live subscription for paid seats and boosts when every period is unusable', () => {
    const result = resolveAllowanceBillingPeriod([
      {
        id: 'invalid-active',
        status: 'active',
        billing_interval: 'month',
        current_period_start: 'not-a-date',
        updated_at: '2026-07-20T00:00:00.000Z',
      },
      {
        id: 'missing-trial',
        status: 'trialing',
        billing_interval: 'month',
        current_period_start: null,
        updated_at: '2026-07-20T00:00:00.000Z',
      },
      {
        id: 'valid-canceled',
        status: 'canceled',
        billing_interval: 'month',
        current_period_start: '2026-07-19T00:00:00.000Z',
        updated_at: '2026-07-21T00:00:00.000Z',
      },
    ], now);

    expect(result.subscription?.id).toBe('missing-trial');
    expect(result.periodStart.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });
});
