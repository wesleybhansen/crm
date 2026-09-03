/*
 * Shared helpers for first-party public-post opportunity sources (official
 * xAI X Search, official Meta Threads keyword search).
 *
 * These mirror the bounded, source-shaped projection the Apify public-social
 * adapters produce so downstream qualification (fit-v7, destination checks,
 * canonical URL dedupe, realtor returned-content filters) treats every public
 * post source identically regardless of provider. Pure functions only.
 */

import type { Candidate, CandidateIdentity, SourceSearchPlan } from './types'
import { SENSITIVE_TARGETING } from './apify/public-social-opportunity-source'
import {
  assessRealtorOpportunitySuitability,
  classifyOpportunityIntent,
  demonstratedOpportunityLocation,
  sensitiveConsumerOpportunityReasons,
  type DemonstratedOpportunityIntent,
} from '../research/opportunity-quality'

export { SENSITIVE_TARGETING }

export const SOCIAL_RETURNED_CONTENT_FILTER_VERSION = 'realtor-public-post-v2'
export const PUBLIC_POST_MAX_WINDOW_DAYS = 30

export type ReturnedContentAssessment = { matches: boolean; reasons: string[] }

export function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function boundedText(value: unknown, max = 500): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/\s+/g, ' ')
  return normalized ? Array.from(normalized).slice(0, max).join('') : null
}

export function nonNegativeInteger(value: unknown): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

export function sourcePublishedAt(value: unknown): string | null {
  if (value == null || (typeof value === 'string' && !value.trim())) return null
  const numeric = Number(value)
  // Meta returns offsets without a colon ("+0000"); normalize to ISO 8601.
  const iso = String(value ?? '').trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2')
  const date = Number.isFinite(numeric)
    ? new Date(numeric > 10_000_000_000 ? numeric : numeric * 1_000)
    : new Date(iso)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

/** A publication time inside the bounded public window, else null. */
export function freshPublicPostTimestamp(
  value: unknown,
  attemptedAt: string,
  windowDays = PUBLIC_POST_MAX_WINDOW_DAYS,
): string | null {
  const publishedAt = sourcePublishedAt(value)
  if (!publishedAt) return null
  const published = new Date(publishedAt).getTime()
  const attempted = new Date(attemptedAt).getTime()
  if (!Number.isFinite(published) || !Number.isFinite(attempted)) return null
  // Allow a small clock skew forward; anything older than the window is stale.
  if (published > attempted + 5 * 60_000) return null
  if (published < attempted - windowDays * 86_400_000) return null
  return publishedAt
}

export function activityLevel(count: number): NonNullable<CandidateIdentity['activity_level']> {
  if (count >= 25) return 'high'
  if (count >= 5) return 'medium'
  if (count > 0) return 'low'
  return 'unknown'
}

export function requestedOpportunityIntent(plan: SourceSearchPlan): DemonstratedOpportunityIntent {
  const value = plan.provider_query?.opportunity_intent_lane
  return value === 'buyer_intent'
    || value === 'seller_intent'
    || value === 'local_audience'
    || value === 'mixed_intent'
    ? value
    : null
}

export function locationText(plan: SourceSearchPlan): string | null {
  const values = plan.provider_query?.locations
  if (!Array.isArray(values)) return boundedText(plan.geography, 180)
  return (
    boundedText(values.find((value) => typeof value === 'string' && value.trim()), 180)
    ?? boundedText(plan.geography, 180)
  )
}

export function sourceKeywords(plan: SourceSearchPlan): string | null {
  const values = plan.provider_query?.source_search_keywords
  if (!Array.isArray(values)) return null
  return values.find((value): value is string => typeof value === 'string' && Boolean(value.trim())) ?? null
}

/** The frozen lane query; throws on an empty or sensitive query so the
 *  adapter refuses before any provider contact. */
export function queryText(plan: SourceSearchPlan, max: number): string {
  const query =
    boundedText(plan.provider_query?.search_query, max)
    ?? boundedText(sourceKeywords(plan), max)
    ?? boundedText(plan.query, max)
    ?? ''
  if (!query) throw new TypeError('a bounded public opportunity query is required')
  if (SENSITIVE_TARGETING.test(query)) {
    throw new TypeError('sensitive consumer demand research is blocked')
  }
  return query
}

export function windowDays(plan: SourceSearchPlan): number {
  const explicit = Number(plan.provider_query?.social_window_days)
  if (Number.isInteger(explicit) && explicit >= 1) {
    return Math.min(PUBLIC_POST_MAX_WINDOW_DAYS, explicit)
  }
  const raw = boundedText(
    plan.provider_query?.recency_window ?? plan.provider_query?.recency ?? plan.provider_query?.posted_limit,
    80,
  )?.toLowerCase() ?? 'month'
  const numeric = raw.match(/\b(\d{1,3})\s*days?\b/)
  if (numeric) return Math.max(1, Math.min(PUBLIC_POST_MAX_WINDOW_DAYS, Number(numeric[1])))
  if (/hour|today|24h|day/.test(raw)) return 1
  if (/week|7d/.test(raw)) return 7
  return PUBLIC_POST_MAX_WINDOW_DAYS
}

export function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10)
}

/** True when the returned post text trips either consumer-safety screen. */
export function unsafePublicContent(content: string): boolean {
  return SENSITIVE_TARGETING.test(content) || sensitiveConsumerOpportunityReasons(content).length > 0
}

export function publicOpportunityIdentity(args: {
  name: string
  platform: string
  content: string
  sourceUrl: string
  requestedLocation: string | null
  locationEvidence: string
  engagement: number
  people?: CandidateIdentity['people_to_follow']
}): CandidateIdentity {
  const demonstratedIntent = classifyOpportunityIntent(args.content)
  const demonstratedLocation = demonstratedOpportunityLocation(args.locationEvidence, args.requestedLocation)
  return {
    name: args.name,
    opportunity_kind: 'post',
    platform: args.platform,
    intent_kind: demonstratedIntent.kind,
    audience_description: args.content,
    activity_level: activityLevel(args.engagement),
    engagement_count: args.engagement,
    access_type: 'public',
    location: demonstratedLocation,
    provider_location: args.requestedLocation,
    urls: [args.sourceUrl],
    participation_rules: `Review the current ${args.platform} community and thread rules. Use only public context and do not automate contact or posting.`,
    participation_rules_status: 'unverified',
    recommended_action:
      'Read the full public conversation and contribute one useful response manually when it is relevant and permitted.',
    message_angle:
      'Answer the specific buyer or seller question with practical local information before mentioning your services.',
    people_to_follow: args.people,
  }
}

export function postDisplayName(content: string): string {
  return content.length > 110 ? `${content.slice(0, 107).trimEnd()}...` : content
}

/**
 * Realtor returned-content gate shared with the Apify public-post adapters:
 * the returned post itself must prove the requested market and the requested
 * intent lane. Plans without the frozen filter version pass through unchanged
 * (generic consumer plays are qualified downstream by fit-v7).
 */
export function assessSocialReturnedContent(
  candidate: Candidate,
  plan: SourceSearchPlan,
): ReturnedContentAssessment {
  const version = plan.provider_query?.social_returned_content_filter_version
  if (version == null) return { matches: true, reasons: [] }
  if (version !== SOCIAL_RETURNED_CONTENT_FILTER_VERSION) {
    return { matches: false, reasons: ['unsupported_returned_content_filter'] }
  }
  const expected = plan.provider_query?.social_filter_required_intent
  if (
    expected !== 'buyer_intent'
    && expected !== 'seller_intent'
    && expected !== 'mixed_intent'
    && expected !== 'local_audience'
  ) return { matches: false, reasons: ['unsupported_intent_lane'] }
  const content = [candidate.identity.name, candidate.identity.audience_description]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
  const requestedLocation = locationText(plan)
  const locationMatches = Boolean(
    requestedLocation
    && (
      candidate.identity.location === requestedLocation
      || demonstratedOpportunityLocation(content, requestedLocation)
    ),
  )
  if (plan.provider_query?.social_filter_require_location !== false && !locationMatches) {
    return { matches: false, reasons: ['missing_returned_location_evidence'] }
  }
  const sourceUrl = candidate.identity.urls?.find((value) => typeof value === 'string') ?? null
  const suitability = assessRealtorOpportunitySuitability(content, expected, sourceUrl, 'post')
  return {
    matches: suitability.relevant,
    reasons: suitability.relevant ? [] : suitability.reasons,
  }
}

export function returnedContentReasonCounts(
  assessments: Array<{ assessment: ReturnedContentAssessment }>,
): Record<string, number> {
  const counts = new Map<string, number>()
  for (const { assessment } of assessments) {
    if (assessment.matches) continue
    for (const reason of assessment.reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1)
  }
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)))
}

export function millidollarUnits(usd: number, unitUsd = 0.001): number {
  return Math.round((usd / unitUsd) * 1_000_000_000) / 1_000_000_000
}
