export const LIVE_NOLI_SUBSCRIPTION_STATUSES = [
  'active',
  'trialing',
  'past_due',
  'unpaid',
] as const;

export type NoliBillingSubscription = {
  id: string;
  status: string | null;
  billing_interval: string | null;
  current_period_start: string | null;
  updated_at: string | null;
};

const LIVE_STATUS_SET: ReadonlySet<string> = new Set(LIVE_NOLI_SUBSCRIPTION_STATUSES);
const TIMESTAMP_WITH_TIMEZONE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/i;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, monthIndex: number): number {
  if (monthIndex === 1) return isLeapYear(year) ? 29 : 28;
  return [3, 5, 8, 10].includes(monthIndex) ? 30 : 31;
}

function validPeriodTimestamp(value: string | null, nowTimestamp: number): number | null {
  if (!value) return null;
  const match = TIMESTAMP_WITH_TIMEZONE.exec(value);
  if (!match) return null;

  const [, yearValue, monthValue, dayValue, hourValue, minuteValue, secondValue = '0', , zone] = match;
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  const hour = Number(hourValue);
  const minute = Number(minuteValue);
  const second = Number(secondValue);
  const zoneHour = zone.toUpperCase() === 'Z' ? 0 : Number(zone.slice(1, 3));
  const zoneMinute = zone.toUpperCase() === 'Z' ? 0 : Number(zone.slice(4, 6));

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month - 1) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    zoneHour > 23 ||
    zoneMinute > 59
  ) {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= nowTimestamp ? timestamp : null;
}

function sortableTimestamp(value: string | null): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function isPreferredSubscription<T extends NoliBillingSubscription>(
  candidate: T,
  candidatePrimaryTimestamp: number,
  candidateUpdatedAt: number,
  selected: T | null,
  selectedPrimaryTimestamp: number,
  selectedUpdatedAt: number,
): boolean {
  if (!selected) return true;
  if (candidatePrimaryTimestamp !== selectedPrimaryTimestamp) {
    return candidatePrimaryTimestamp > selectedPrimaryTimestamp;
  }

  if (candidateUpdatedAt !== selectedUpdatedAt) return candidateUpdatedAt > selectedUpdatedAt;
  return candidate.id.localeCompare(selected.id) > 0;
}

function monthlyUtcAnniversaryAtOrBefore(periodStart: Date, now: Date): Date {
  const anniversaryForMonth = (year: number, monthIndex: number): Date => {
    const normalizedYear = year + Math.floor(monthIndex / 12);
    const normalizedMonth = ((monthIndex % 12) + 12) % 12;
    const day = Math.min(periodStart.getUTCDate(), daysInMonth(normalizedYear, normalizedMonth));
    return new Date(Date.UTC(
      normalizedYear,
      normalizedMonth,
      day,
      periodStart.getUTCHours(),
      periodStart.getUTCMinutes(),
      periodStart.getUTCSeconds(),
      periodStart.getUTCMilliseconds(),
    ));
  };

  let anniversary = anniversaryForMonth(now.getUTCFullYear(), now.getUTCMonth());
  if (anniversary.getTime() > now.getTime()) {
    anniversary = anniversaryForMonth(now.getUTCFullYear(), now.getUTCMonth() - 1);
  }
  return anniversary;
}

export function resolveAllowanceBillingPeriod<T extends NoliBillingSubscription>(
  subscriptions: readonly T[] | null | undefined,
  now: Date = new Date(),
): { subscription: T | null; periodStart: Date } {
  const effectiveNow = Number.isFinite(now.getTime()) ? now : new Date();
  const nowTimestamp = effectiveNow.getTime();
  let selectedWithPeriod: T | null = null;
  let selectedPeriod = Number.NEGATIVE_INFINITY;
  let selectedPeriodUpdatedAt = Number.NEGATIVE_INFINITY;
  let selectedLive: T | null = null;
  let selectedLiveUpdatedAt = Number.NEGATIVE_INFINITY;

  for (const subscription of subscriptions ?? []) {
    if (!subscription.status || !LIVE_STATUS_SET.has(subscription.status)) continue;

    const updatedAt = sortableTimestamp(subscription.updated_at);
    if (isPreferredSubscription(
      subscription,
      updatedAt,
      updatedAt,
      selectedLive,
      selectedLiveUpdatedAt,
      selectedLiveUpdatedAt,
    )) {
      selectedLive = subscription;
      selectedLiveUpdatedAt = updatedAt;
    }

    const period = validPeriodTimestamp(subscription.current_period_start, nowTimestamp);
    if (period === null) continue;
    if (!isPreferredSubscription(
      subscription,
      period,
      updatedAt,
      selectedWithPeriod,
      selectedPeriod,
      selectedPeriodUpdatedAt,
    )) {
      continue;
    }
    selectedWithPeriod = subscription;
    selectedPeriod = period;
    selectedPeriodUpdatedAt = updatedAt;
  }

  if (selectedWithPeriod) {
    const periodStart = new Date(selectedPeriod);
    return {
      subscription: selectedWithPeriod,
      periodStart: selectedWithPeriod.billing_interval === 'year'
        ? monthlyUtcAnniversaryAtOrBefore(periodStart, effectiveNow)
        : periodStart,
    };
  }

  return {
    subscription: selectedLive,
    periodStart: new Date(Date.UTC(effectiveNow.getUTCFullYear(), effectiveNow.getUTCMonth(), 1)),
  };
}
