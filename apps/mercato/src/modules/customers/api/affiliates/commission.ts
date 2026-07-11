// Shared commission computation for affiliate conversions.
//
// Campaigns can define commission TIERS (affiliate_campaigns.tiers jsonb):
// an array of { name, minConversions, commissionRate }. At conversion time we
// pick the highest tier whose minConversions <= the affiliate's
// total_conversions BEFORE this conversion, and use its commissionRate as a
// PERCENTAGE of the sale. If the campaign has no tiers (or none matches),
// we fall back to the affiliate's own commission_rate / commission_type.

export type CampaignTier = {
  name: string
  minConversions: number
  commissionRate: number
}

type AffiliateLike = {
  commission_rate: number | string
  commission_type: string | null
  total_conversions?: number | string | null
}

type CampaignLike = {
  tiers?: unknown
} | null | undefined

// Parse the raw jsonb column value into a clean, sorted tier list.
export function parseTiers(raw: unknown): CampaignTier[] {
  let value = raw
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return [] }
  }
  if (!Array.isArray(value)) return []
  const tiers: CampaignTier[] = []
  for (const t of value) {
    if (!t || typeof t !== 'object') continue
    const name = typeof (t as any).name === 'string' ? (t as any).name : ''
    const minConversions = Number((t as any).minConversions)
    const commissionRate = Number((t as any).commissionRate)
    if (!Number.isFinite(minConversions) || minConversions < 0) continue
    if (!Number.isFinite(commissionRate) || commissionRate <= 0) continue
    tiers.push({ name, minConversions: Math.floor(minConversions), commissionRate })
  }
  // Sort ascending so the last match is the highest qualifying tier.
  tiers.sort((a, b) => a.minConversions - b.minConversions)
  return tiers
}

// Highest tier whose threshold the affiliate has already met, or null.
export function pickTier(tiers: CampaignTier[], priorConversions: number): CampaignTier | null {
  let match: CampaignTier | null = null
  for (const t of tiers) {
    if (t.minConversions <= priorConversions) match = t
  }
  return match
}

export function computeCommission(
  saleAmount: number,
  affiliate: AffiliateLike,
  campaign: CampaignLike,
): { amount: number; tier: CampaignTier | null } {
  const priorConversions = Number(affiliate.total_conversions) || 0
  const tiers = parseTiers(campaign?.tiers)
  const tier = pickTier(tiers, priorConversions)
  if (tier) {
    return { amount: (saleAmount * tier.commissionRate) / 100, tier }
  }
  const amount = affiliate.commission_type === 'percentage'
    ? (saleAmount * Number(affiliate.commission_rate)) / 100
    : Number(affiliate.commission_rate)
  return { amount, tier: null }
}
