export const APIFY_LINKEDIN_ENGAGER_ADAPTER_ID = 'apify-linkedin-commenter-leads'
export const APIFY_LINKEDIN_REACTOR_ADAPTER_ID = 'apify-linkedin-reactor-leads'
export const LINKEDIN_ENGAGER_QUERY_CONTRACT_VERSION = 'linkedin-engagement-topic-v2'

export type LinkedInEngagementKind = 'comment' | 'reaction'

export type LinkedInEngagerQueryContract = {
  query: string
  topics: string[]
  engagementKind: LinkedInEngagementKind
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim().replace(/\s+/g, ' '))
        .filter(Boolean),
    ),
  ]
}

export function linkedinEngagerQueryContract(
  providerQuery: Record<string, unknown> | null | undefined,
): { ok: true; value: LinkedInEngagerQueryContract } | { ok: false; reason: string } {
  if (providerQuery?.linkedin_engagement_query_contract_version !== LINKEDIN_ENGAGER_QUERY_CONTRACT_VERSION) {
    return { ok: false, reason: 'missing frozen LinkedIn engagement query contract' }
  }
  const query = typeof providerQuery.search_query === 'string'
    ? providerQuery.search_query.trim().replace(/\s+/g, ' ')
    : ''
  if (!query) return { ok: false, reason: 'missing source-specific LinkedIn post search query' }
  // The shared parser intentionally caps provider keywords at 200 characters,
  // below LinkedIn's current 500-character maximum. Refuse rather than silently
  // truncate a frozen query and change what the customer approved.
  if (query.length > 200) return { ok: false, reason: 'LinkedIn post search query exceeds 200 characters' }
  const booleanOperators = query.match(/\b(?:AND|OR|NOT)\b/g)?.length ?? 0
  if (booleanOperators > 5) return { ok: false, reason: 'LinkedIn post search query exceeds five boolean operators' }
  const topics = strings(providerQuery.engagement_topics).slice(0, 5)
  if (topics.length === 0) return { ok: false, reason: 'missing returned-content engagement topics' }
  if (topics.some((topic) => topic.length > 120)) {
    return { ok: false, reason: 'LinkedIn engagement topic exceeds 120 characters' }
  }
  const engagementKind = providerQuery.engagement_kind
  if (engagementKind !== 'comment' && engagementKind !== 'reaction') {
    return { ok: false, reason: 'missing frozen LinkedIn engagement kind' }
  }
  return { ok: true, value: { query, topics, engagementKind } }
}
