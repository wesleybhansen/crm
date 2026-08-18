export const SIGNAL_KINDS = [
  'hiring_activity',
  'funding_event',
  'firmographic_match',
  'technology_usage',
  'local_business_listing',
  'social_engagement',
] as const

export type SignalKind = (typeof SIGNAL_KINDS)[number]

export function isSignalKind(value: unknown): value is SignalKind {
  return typeof value === 'string' && SIGNAL_KINDS.includes(value as SignalKind)
}

// Conservative fallback for legacy imported plays. New lead-magnet reports
// supply signal_kind explicitly; unknown prose stays null and therefore fails
// planning closed instead of being mistaken for a provider capability key.
export function classifySignalKind(signal: string | null | undefined): SignalKind | null {
  const value = (signal ?? '').toLowerCase()
  if (/\b(hiring|job opening|job posting|recruiting|headcount)\b/.test(value)) {
    return 'hiring_activity'
  }
  if (/\b(funding|funded|raised|series [a-f]|venture round)\b/.test(value)) {
    return 'funding_event'
  }
  if (/\b(technology|tech stack|uses? .+ software|installed|integration)\b/.test(value)) {
    return 'technology_usage'
  }
  if (/\b(local|nearby|maps?|location|regional business)\b/.test(value)) {
    return 'local_business_listing'
  }
  if (/\b(liked|commented|reposted|engaged|follows?|social)\b/.test(value)) {
    return 'social_engagement'
  }
  if (/\b(industry|employee|company size|revenue|firmographic|job title|role)\b/.test(value)) {
    return 'firmographic_match'
  }
  return null
}
