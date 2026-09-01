import crypto from 'crypto'
import type { Candidate, CandidateEvidence } from '../adapters/types'

export const APIFY_REDDIT_URL_HYDRATION_ADAPTER_ID = 'apify-reddit-url-hydration'
export const REDDIT_URL_HYDRATION_SELECTOR_VERSION = 'canonical-reddit-thread-url-v1'
export const REDDIT_URL_HYDRATION_CONTRACT_VERSION = 'reddit-url-hydration-v1'
export const REDDIT_URL_HYDRATION_ROWS_PER_URL = 2
export const REDDIT_URL_HYDRATION_MAX_URLS = 10

const REDDIT_HOSTS = new Set([
  'reddit.com',
  'www.reddit.com',
  'old.reddit.com',
  'new.reddit.com',
  'np.reddit.com',
  'redd.it',
  'www.redd.it',
])

function normalizedPostId(value: string): string | null {
  const normalized = value.trim().toLowerCase().replace(/^t3_/, '')
  return /^[a-z0-9]{5,12}$/.test(normalized) ? normalized : null
}

/**
 * Canonicalizes only public Reddit post destinations. Comment permalinks,
 * old/new/mobile hosts, share links, and slug variants collapse onto the same
 * immutable post URL. Profiles, subreddit roots, search pages, and arbitrary
 * Reddit URLs are rejected.
 */
export function canonicalRedditThreadUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !REDDIT_HOSTS.has(url.hostname.toLowerCase())) return null
    const host = url.hostname.toLowerCase().replace(/^www\./, '')
    const segments = url.pathname.split('/').filter(Boolean)
    if (host === 'redd.it') {
      const postId = normalizedPostId(segments[0] ?? '')
      return postId ? `https://www.reddit.com/comments/${postId}/` : null
    }
    const commentsIndex = segments.findIndex((segment) => segment.toLowerCase() === 'comments')
    if (commentsIndex < 0) return null
    const postId = normalizedPostId(segments[commentsIndex + 1] ?? '')
    if (!postId) return null
    const subreddit =
      commentsIndex >= 2 && segments[commentsIndex - 2]?.toLowerCase() === 'r'
        ? segments[commentsIndex - 1]?.replace(/[^a-z0-9_]/gi, '')
        : null
    return subreddit
      ? `https://www.reddit.com/r/${subreddit}/comments/${postId}/`
      : `https://www.reddit.com/comments/${postId}/`
  } catch {
    return null
  }
}

export function redditThreadPostId(value: unknown): string | null {
  const canonical = canonicalRedditThreadUrl(value)
  return canonical?.match(/\/comments\/([a-z0-9]+)\/$/i)?.[1]?.toLowerCase() ?? null
}

export function redditThreadSubreddit(value: unknown): string | null {
  const canonical = canonicalRedditThreadUrl(value)
  return canonical?.match(/^https:\/\/www\.reddit\.com\/r\/([^/]+)\/comments\//i)?.[1] ?? null
}

export function redditUrlSetHash(urls: string[]): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([...urls].sort()))
    .digest('hex')
}

function candidateUrls(candidate: Candidate): string[] {
  return Array.isArray(candidate.identity.urls)
    ? candidate.identity.urls.filter((value): value is string => typeof value === 'string')
    : []
}

/**
 * Selects a deterministic, source-bounded URL set from one paid discovery
 * batch. A frozen site:reddit.com/r/<subreddit> scope may hydrate only that
 * same returned subreddit; an unrelated Reddit result cannot hitchhike into
 * the child provider operation.
 */
export function selectRedditHydrationTargets(
  candidates: Candidate[],
  frozenSiteScope: unknown,
  maxUrls: number,
): string[] {
  if (typeof frozenSiteScope !== 'string') return []
  const scope = frozenSiteScope.trim().match(/^(?:www\.)?reddit\.com\/r\/([a-z0-9_]+)\/?$/i)
  if (!scope) return []
  const scopedSubreddit = scope[1]!.toLowerCase()
  const cap = Math.max(0, Math.min(REDDIT_URL_HYDRATION_MAX_URLS, Math.floor(maxUrls)))
  const selected = new Set<string>()
  for (const candidate of candidates) {
    if (candidate.entity_kind !== 'opportunity') continue
    for (const value of candidateUrls(candidate)) {
      const canonical = canonicalRedditThreadUrl(value)
      const subreddit = redditThreadSubreddit(canonical)?.toLowerCase()
      if (canonical && subreddit === scopedSubreddit) selected.add(canonical)
    }
  }
  return [...selected].sort().slice(0, cap)
}

function evidenceConfidence(evidence: CandidateEvidence[]): number {
  return evidence.reduce((best, row) => Math.max(best, Number(row.confidence) || 0), 0)
}

function distinctEvidence(rows: CandidateEvidence[]): CandidateEvidence[] {
  const seen = new Set<string>()
  return rows.filter((row) => {
    const key = JSON.stringify([row.claim, row.source_url, row.observed_at, row.detail ?? null])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Folds the actor's bounded post/comment rows into at most one opportunity per
 * requested destination. The strongest returned row supplies the current
 * identity while every source observation remains independently attributable.
 */
export function mergeRedditHydrationCandidates(
  candidates: Candidate[],
  requestedUrls: string[],
): Candidate[] {
  const byPostId = new Map<string, Candidate[]>()
  for (const candidate of candidates) {
    const sourceUrl = candidateUrls(candidate).find((value) => redditThreadPostId(value) != null)
    const postId = redditThreadPostId(sourceUrl)
    if (!postId) continue
    const rows = byPostId.get(postId) ?? []
    rows.push(candidate)
    byPostId.set(postId, rows)
  }

  const merged: Candidate[] = []
  for (const requestedUrl of requestedUrls) {
    const postId = redditThreadPostId(requestedUrl)
    const rows = postId ? byPostId.get(postId) ?? [] : []
    if (rows.length === 0) continue
    const strongest = [...rows].sort(
      (left, right) => evidenceConfidence(right.evidence) - evidenceConfidence(left.evidence),
    )[0]!
    const urls = new Set<string>([requestedUrl])
    const people = new Map<string, NonNullable<Candidate['identity']['people_to_follow']>[number]>()
    let engagement = Number(strongest.identity.engagement_count) || 0
    for (const row of rows) {
      for (const url of candidateUrls(row)) urls.add(url)
      for (const person of row.identity.people_to_follow ?? []) {
        const key = `${person.name.toLowerCase()}|${person.profile_url ?? ''}`
        people.set(key, person)
      }
      engagement = Math.max(engagement, Number(row.identity.engagement_count) || 0)
    }
    merged.push({
      entity_kind: 'opportunity',
      identity: {
        ...strongest.identity,
        urls: [...urls],
        engagement_count: engagement || null,
        people_to_follow: [...people.values()],
      },
      evidence: distinctEvidence(rows.flatMap((row) => row.evidence)),
    })
  }
  return merged
}

/** Replaces only the exact discovery destinations that the child operation hydrated. */
export function fuseRedditHydrationCandidates(
  discovered: Candidate[],
  hydrated: Candidate[],
): Candidate[] {
  const byPostId = new Map<string, Candidate>()
  for (const candidate of hydrated) {
    const postId = candidateUrls(candidate).map(redditThreadPostId).find(Boolean)
    if (postId) byPostId.set(postId, candidate)
  }
  return discovered.map((candidate) => {
    const postId = candidateUrls(candidate).map(redditThreadPostId).find(Boolean)
    const replacement = postId ? byPostId.get(postId) : null
    if (!replacement) return candidate
    return {
      entity_kind: 'opportunity',
      identity: {
        ...candidate.identity,
        ...replacement.identity,
        urls: [...new Set([...candidateUrls(candidate), ...candidateUrls(replacement)])],
        destination_validation_status:
          candidate.identity.destination_validation_status
          ?? replacement.identity.destination_validation_status
          ?? null,
        destination_validated_at:
          candidate.identity.destination_validated_at
          ?? replacement.identity.destination_validated_at
          ?? null,
        destination_http_status:
          candidate.identity.destination_http_status
          ?? replacement.identity.destination_http_status
          ?? null,
      },
      evidence: distinctEvidence([...candidate.evidence, ...replacement.evidence]),
    }
  })
}
