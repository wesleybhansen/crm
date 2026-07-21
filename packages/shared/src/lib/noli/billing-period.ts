export const LIVE_NOLI_SUBSCRIPTION_STATUSES = [
  'active',
  'trialing',
  'past_due',
  'unpaid',
] as const;

export type NoliBillingSubscription = {
  id: string;
  status: string | null;
  current_period_start: string | null;
  updated_at: string | null;
};

const LIVE_STATUS_SET: ReadonlySet<string> = new Set(LIVE_NOLI_SUBSCRIPTION_STATUSES);

function timestampFor(value: string | null): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function resolveAllowanceBillingPeriod<T extends NoliBillingSubscription>(
  subscriptions: readonly T[] | null | undefined,
  now: Date = new Date(),
): { subscription: T | null; periodStart: Date } {
  let selected: T | null = null;
  let selectedPeriod = Number.NEGATIVE_INFINITY;
  let selectedUpdatedAt = Number.NEGATIVE_INFINITY;

  for (const subscription of subscriptions ?? []) {
    if (!subscription.status || !LIVE_STATUS_SET.has(subscription.status)) continue;
    const period = timestampFor(subscription.current_period_start);
    if (period === null) continue;
    const updatedAt = timestampFor(subscription.updated_at) ?? Number.NEGATIVE_INFINITY;

    const isNewerPeriod = period > selectedPeriod;
    const isNewerUpdate = period === selectedPeriod && updatedAt > selectedUpdatedAt;
    const isHigherId =
      period === selectedPeriod &&
      updatedAt === selectedUpdatedAt &&
      subscription.id.localeCompare(selected?.id ?? '') > 0;

    if (!isNewerPeriod && !isNewerUpdate && !isHigherId) continue;
    selected = subscription;
    selectedPeriod = period;
    selectedUpdatedAt = updatedAt;
  }

  if (selected) return { subscription: selected, periodStart: new Date(selectedPeriod) };

  const fallbackNow = Number.isNaN(now.getTime()) ? new Date() : now;
  return {
    subscription: null,
    periodStart: new Date(Date.UTC(fallbackNow.getUTCFullYear(), fallbackNow.getUTCMonth(), 1)),
  };
}
