export type CosMetricsProjection = {
  openDeals: number
  totalDeals: number
  totalContacts: number
}

type CountRow = Record<string, unknown> | null | undefined

function readCount(row: CountRow, key: string): number {
  const value = row?.[key]
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error('cos_metrics_unavailable')
  }
  if (typeof value === 'string' && !/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error('cos_metrics_unavailable')
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('cos_metrics_unavailable')
  }
  return parsed
}

/** Strictly project the only fields the Chief of Staff fast path may receive. */
export function projectCosMetrics(deals: CountRow, contacts: CountRow): CosMetricsProjection {
  const totalDeals = readCount(deals, 'total_deals')
  const openDeals = readCount(deals, 'open_deals')
  const totalContacts = readCount(contacts, 'total_contacts')
  if (openDeals > totalDeals) throw new Error('cos_metrics_unavailable')
  return { openDeals, totalDeals, totalContacts }
}
