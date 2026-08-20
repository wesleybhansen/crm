import type { Candidate, CandidateIdentity, ContactPoint } from '../types'

/*
 * Apify actor registry: our capability kinds -> a marketplace actor id, an
 * input builder, and an output normalizer.
 *
 * WHY this indirection exists: marketplace actor supply degrades. Actors get
 * renamed, deprecated, rate-limited, or quietly stop returning a field. That
 * is the documented Origami failure mode (their permanent "LinkedIn upstream
 * provider issues" banner). Swapping an actor must therefore be a one-line
 * change: replace the default id (or set the env override) and, if the payload
 * shape differs, extend the alias list in the normalizer. Nothing outside this
 * file knows an actor id.
 *
 * VERIFICATION STATE (see
 * `Software Strategy/gtm-apify-verified-contract-2026-07-24.md`):
 * - `harvestapi/linkedin-post-comments`: input schema AND output shape
 *   LIVE-VERIFIED 2026-07-24.
 * - `harvestapi/linkedin-post-reactions`: input schema LIVE-VERIFIED; output
 *   shape STILL UNVERIFIED (the probe post had no reactions, so a 201 with an
 *   empty array was all we saw). Its normalizer keeps defensive aliases.
 * - `apidojo/tweet-scraper` (X): input AND output STILL UNVERIFIED.
 * Pricing lives in APIFY_MEASURED_USD below, in DOLLARS (measured 2026-07-24,
 * not yet reconciled against an invoice).
 */

export type ApifyCapabilityKind =
  | 'linkedin_post_search'
  | 'linkedin_post_reactions'
  | 'linkedin_post_comments'
  | 'x_post_engagers'

export const APIFY_CAPABILITY_KINDS: ApifyCapabilityKind[] = [
  'linkedin_post_search',
  'linkedin_post_reactions',
  'linkedin_post_comments',
  'x_post_engagers',
]

/*
 * DISCOVERY vs SCRAPE.
 *
 * The three original kinds all scrape engagement on a post URL the caller
 * already has, which made the product unusable on its own promise: the
 * customer had to go and find LinkedIn post URLs by hand before anything
 * happened. `linkedin_post_search` is the missing first step - topic +
 * recency -> matching posts -> the people who engaged with them - and it is
 * the only kind whose plan query is a SEARCH, not a URL.
 */
export function isSearchCapability(kind: ApifyCapabilityKind): boolean {
  return kind === 'linkedin_post_search'
}

export type ApifyActorConfig = {
  kind: ApifyCapabilityKind
  // default actor id, overridable per deployment without a code change
  defaultActorId: string
  // documented alternative if the default degrades; NOT used automatically,
  // because silently switching provider supply hides a real failure
  fallbackActorId: string
  envVar: string
  // hostnames the source post URL must belong to (fail closed on anything else)
  allowedHosts: string[]
}

/*
 * Actor ids VERIFIED to exist and accept our input for both LinkedIn rows;
 * per-result price measured but not yet invoice-confirmed (background in
 * `Software Strategy/gtm-data-sources-origami-map-2026-07-24.md`).
 */
export const APIFY_ACTORS: Record<ApifyCapabilityKind, ApifyActorConfig> = {
  linkedin_post_search: {
    kind: 'linkedin_post_search',
    // id, input schema, output shape and cost all LIVE-MEASURED 2026-07-25
    // (two capped probes; see gtm-apify-verified-contract-2026-07-24.md).
    defaultActorId: 'harvestapi/linkedin-post-search',
    // VERIFY-ON-FIRST-RUN (documented fallback, not auto-selected)
    fallbackActorId: 'datadoping/linkedin-posts-search-scraper',
    envVar: 'GTM_APIFY_ACTOR_LINKEDIN_POST_SEARCH',
    // Posts are DISCOVERED here rather than supplied, so allowedHosts is not a
    // gate on an input url; it is the allowlist a discovered post url must
    // satisfy before we are willing to store it as evidence source_url.
    allowedHosts: ['linkedin.com'],
  },
  linkedin_post_reactions: {
    kind: 'linkedin_post_reactions',
    // id + input schema VERIFIED 2026-07-24
    defaultActorId: 'harvestapi/linkedin-post-reactions',
    // VERIFY-ON-FIRST-RUN (documented fallback, not auto-selected)
    fallbackActorId: 'apimaestro/linkedin-post-comments-replies-engagements-scraper-no-cookies',
    envVar: 'GTM_APIFY_ACTOR_LINKEDIN_POST_REACTIONS',
    allowedHosts: ['linkedin.com'],
  },
  linkedin_post_comments: {
    kind: 'linkedin_post_comments',
    // id + input schema + output shape VERIFIED 2026-07-24
    defaultActorId: 'harvestapi/linkedin-post-comments',
    // VERIFY-ON-FIRST-RUN (documented fallback, not auto-selected)
    fallbackActorId: 'apimaestro/linkedin-profile-comments',
    envVar: 'GTM_APIFY_ACTOR_LINKEDIN_POST_COMMENTS',
    allowedHosts: ['linkedin.com'],
  },
  x_post_engagers: {
    kind: 'x_post_engagers',
    // VERIFY-ON-FIRST-RUN (apidojo/kaito-class pay-per-result tweet scraper)
    defaultActorId: 'apidojo/tweet-scraper',
    // VERIFY-ON-FIRST-RUN (documented fallback, not auto-selected)
    fallbackActorId: 'kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest',
    envVar: 'GTM_APIFY_ACTOR_X_POST_ENGAGERS',
    allowedHosts: ['x.com', 'twitter.com'],
  },
}

/*
 * PROVIDER COST, IN USD. USD is the natural unit here: it is what Apify
 * invoices, what their per-1k pricing quotes, and what their per-event pricing
 * quotes. Noli credits are derived from these with creditsFromUsd
 * (lib/credits/markup.ts), never hand-copied from another vendor's rate card.
 *
 * Every figure below was LIVE-MEASURED or read off the actor's own pricing
 * schema on 2026-07-24. RE-CHECK AGAINST A REAL INVOICE before customer use:
 * marketplace pricing changes without notice.
 */
export const APIFY_MEASURED_USD = {
  // ~$0.003 per returned engagement result (LinkedIn comments/reactions, X)
  sourcing_per_result: 0.003,
  /*
   * Post SEARCH bills per POST RETURNED, not per engager. LIVE-MEASURED
   * 2026-07-25: 3 posts settled at $0.00605 and 30 posts at $0.06005, both
   * exactly `posts * 0.002 + 0.00005` actor-start. In the 30-post run the 27
   * engager profiles it also returned added nothing, so nested engagement
   * looks free - ONE observation, so treat it as provisional and reconcile
   * against a real invoice before relying on it.
   */
  post_search_per_post: 0.002,
  // profile detail without an email lookup ("main" profile mode territory)
  profile_without_email: 0.004,
  // full-profile-with-email event on the reactions actor
  profile_with_email: 0.01,
} as const

// ---------------------------------------------------------------------------
// ENRICHMENT actor: profile + email (SPEC-066 section 11.1, enrich layer)
// ---------------------------------------------------------------------------

/*
 * Step 2 of the verified pipeline: the sourcing actors hand us a LinkedIn
 * profile URL with no company and no email; this actor turns that URL into a
 * full profile plus an email SEARCH.
 *
 * VERIFIED 2026-07-24 (`gtm-apify-verified-contract-2026-07-24.md`, section
 * "THE FULL PIPELINE IS VERIFIED"): actor id, the `queries` input, the
 * profileScraperMode label strings, and the output key set.
 */
export type ApifyEnrichActorConfig = {
  defaultActorId: string
  // documented alternative if the default degrades; NOT auto-selected, because
  // silently switching provider supply hides a real failure
  fallbackActorId: string
  envVar: string
  // hostnames an input profile URL must belong to (fail closed on anything else)
  allowedHosts: string[]
}

export const APIFY_ENRICH_ACTOR: ApifyEnrichActorConfig = {
  // id + input schema + output key set VERIFIED 2026-07-24
  defaultActorId: 'harvestapi/linkedin-profile-scraper',
  // VERIFY-ON-FIRST-RUN (documented fallback, not auto-selected)
  fallbackActorId: 'apimaestro/linkedin-profile-detail',
  envVar: 'GTM_APIFY_ACTOR_LINKEDIN_PROFILE_ENRICH',
  allowedHosts: ['linkedin.com'],
}

export function resolveEnrichActorId(env: ApifyEnv): string {
  const override = (env[APIFY_ENRICH_ACTOR.envVar] ?? '').trim()
  return override || APIFY_ENRICH_ACTOR.defaultActorId
}

/*
 * profileScraperMode on THIS actor is NOT the ["short","main"] enum the
 * sourcing actors use. Its enum members are the FULL LABEL STRINGS below,
 * verbatim, price included. Sending anything else is HTTP 400 invalid-input.
 *
 * VERIFIED values and their per-profile cost:
 *   "Profile details no email ($4 per 1k)"        -> $0.004 / profile
 *   "Profile details + email search ($10 per 1k)" -> $0.01  / profile
 */
export const APIFY_PROFILE_ENRICH_MODES = {
  without_email: 'Profile details no email ($4 per 1k)',
  with_email: 'Profile details + email search ($10 per 1k)',
} as const

export type ApifyProfileEnrichMode =
  (typeof APIFY_PROFILE_ENRICH_MODES)[keyof typeof APIFY_PROFILE_ENRICH_MODES]

export function profileEnrichMode(withEmail: boolean): ApifyProfileEnrichMode {
  return withEmail
    ? APIFY_PROFILE_ENRICH_MODES.with_email
    : APIFY_PROFILE_ENRICH_MODES.without_email
}

/*
 * The actor accepts `queries`, `urls`, `publicIdentifiers` and `profileIds`
 * (all verified as accepted inputs). `queries` is what we send, because it is
 * what takes the LinkedIn profile URL the sourcing step produced.
 *
 * We deliberately send NOTHING else in the body. `maxItems` is a verified
 * ENDPOINT query parameter (the client appends it), but it is not a verified
 * body key for this actor, so it is not invented here.
 */
export function buildProfileEnrichInput(args: {
  profileUrl: string
  withEmail: boolean
}): Record<string, unknown> {
  return {
    queries: [args.profileUrl],
    profileScraperMode: profileEnrichMode(args.withEmail),
  }
}

export type ApifyEnv = Record<string, string | undefined>

export function isApifyCapabilityKind(value: string): value is ApifyCapabilityKind {
  return (APIFY_CAPABILITY_KINDS as string[]).includes(value)
}

// One-line swap point: env override wins, default otherwise.
export function resolveActorId(kind: ApifyCapabilityKind, env: ApifyEnv): string {
  const config = APIFY_ACTORS[kind]
  const override = (env[config.envVar] ?? '').trim()
  return override || config.defaultActorId
}

// ---------------------------------------------------------------------------
// Source post URL handling (fail closed: no URL, no run)
// ---------------------------------------------------------------------------

const URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+/i

export type PostUrlResult =
  | { ok: true; url: string }
  | { ok: false; reason: string }

/*
 * The plan query carries the source post URL. We extract the FIRST url and
 * check its host against the capability's allow list, so a LinkedIn actor can
 * never be pointed at an arbitrary host by a crafted query.
 */
export function extractPostUrl(kind: ApifyCapabilityKind, query: string): PostUrlResult {
  const match = URL_PATTERN.exec(query ?? '')
  if (!match) return { ok: false, reason: 'missing_post_url: the plan query contains no source post URL' }
  let parsed: URL
  try {
    parsed = new URL(match[0])
  } catch {
    return { ok: false, reason: 'invalid_post_url: the plan query URL could not be parsed' }
  }
  const host = parsed.hostname.toLowerCase()
  const allowed = APIFY_ACTORS[kind].allowedHosts.some(
    (entry) => host === entry || host.endsWith(`.${entry}`),
  )
  if (!allowed) {
    return {
      ok: false,
      reason: `invalid_post_url: host ${host} is not valid for ${kind}`,
    }
  }
  return { ok: true, url: parsed.toString() }
}

// ---------------------------------------------------------------------------
// Input builders
// ---------------------------------------------------------------------------

/*
 * Both harvestapi actors expose `profileScraperMode` as an enum whose members
 * are exactly ["short","main"], LOWERCASE. A capitalized 'Short' is rejected
 * with HTTP 400 `invalid-input` (this was the adapter's original bug).
 *
 * Cost, straight from the actor's own schema titles: `short` carries NO charge
 * for profile details; `main` costs $0.002 per profile. We default to `short`
 * and only ever move to `main` when a plan justifies paying for profile depth.
 */
export const APIFY_PROFILE_SCRAPER_MODES = ['short', 'main'] as const
export type ApifyProfileScraperMode = (typeof APIFY_PROFILE_SCRAPER_MODES)[number]
export const APIFY_DEFAULT_PROFILE_SCRAPER_MODE: ApifyProfileScraperMode = 'short'

export function normalizeProfileScraperMode(value: unknown): ApifyProfileScraperMode {
  const lowered = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return (APIFY_PROFILE_SCRAPER_MODES as readonly string[]).includes(lowered)
    ? (lowered as ApifyProfileScraperMode)
    : APIFY_DEFAULT_PROFILE_SCRAPER_MODE
}

// ---------------------------------------------------------------------------
// Search-query parsing (linkedin_post_search only)
// ---------------------------------------------------------------------------

/* VERIFIED enum from the actor's own input schema, 2026-07-25. */
export const APIFY_POSTED_LIMITS = [
  'any',
  '1h',
  '24h',
  'week',
  'month',
  '3months',
  '6months',
  'year',
] as const
export type ApifyPostedLimit = (typeof APIFY_POSTED_LIMITS)[number]

const DEFAULT_POSTED_LIMIT: ApifyPostedLimit = 'month'
const MAX_KEYWORD_CHARS = 200

export type SearchQuery = {
  keywords: string
  postedLimit: ApifyPostedLimit
  sortBy: 'relevance' | 'date'
}

export type SearchQueryResult = { ok: true; search: SearchQuery } | { ok: false; reason: string }

/*
 * Maps an Audience Play's free-text `recency_window` onto the actor's
 * postedLimit enum. This is the join that makes a generated play directly
 * executable instead of prose a human has to translate: the lead magnet
 * already emits "in the last 30 days" / "last 90 days" on every play.
 *
 * Unrecognised text falls back to the default rather than guessing a wider
 * window - widening recency silently would change who gets contacted.
 */
export function postedLimitFromRecencyWindow(text: string | null | undefined): ApifyPostedLimit {
  const raw = (text ?? '').toLowerCase()
  if (!raw.trim()) return DEFAULT_POSTED_LIMIT
  // NOTE the optional plural on every unit: "last 6 months" must not fall
  // through to the default, which would silently NARROW a six-month window to
  // one month and quietly change who gets contacted.
  if (/\b(24\s*h|1\s*day|today|last day)\b/.test(raw)) return '24h'
  if (/\b(1\s*h|hours?)\b/.test(raw)) return '1h'
  if (/\b(7\s*days?|weeks?)\b/.test(raw)) return 'week'
  // Longer windows are checked before the plain "30 days" / "month" case, so
  // "6 months" is not swallowed by the bare "month" pattern.
  if (/\b(180|6\s*months?|half a year)\b/.test(raw)) return '6months'
  if (/\b(365|12\s*months?|1\s*year|years?)\b/.test(raw)) return 'year'
  if (/\b(90|3\s*months?|quarter)\b/.test(raw)) return '3months'
  if (/\b(30|months?)\b/.test(raw)) return 'month'
  return DEFAULT_POSTED_LIMIT
}

function isPostedLimit(value: string): value is ApifyPostedLimit {
  return (APIFY_POSTED_LIMITS as readonly string[]).includes(value)
}

/*
 * The plan query for a search capability is free text, optionally carrying
 * `recency:<enum>` and `sort:<relevance|date>` control tokens. Anything left
 * over is the keyword string, which goes to LinkedIn's own search bar syntax.
 *
 * Fails closed on an empty keyword string: running a post search with no
 * keywords would return an arbitrary slice of LinkedIn and bill us per post
 * for it.
 */
export function extractSearchQuery(query: string): SearchQueryResult {
  const raw = (query ?? '').trim()
  if (!raw) return { ok: false, reason: 'missing_search_query: no keywords supplied' }

  let postedLimit: ApifyPostedLimit = DEFAULT_POSTED_LIMIT
  let sortBy: 'relevance' | 'date' = 'relevance'
  const keywordParts: string[] = []

  for (const token of raw.split(/\s+/)) {
    const recency = /^recency:(.+)$/i.exec(token)
    if (recency) {
      const value = recency[1].toLowerCase()
      if (!isPostedLimit(value)) {
        return {
          ok: false,
          reason: `invalid_recency: '${value}' is not one of ${APIFY_POSTED_LIMITS.join('|')}`,
        }
      }
      postedLimit = value
      continue
    }
    const sort = /^sort:(.+)$/i.exec(token)
    if (sort) {
      const value = sort[1].toLowerCase()
      if (value !== 'relevance' && value !== 'date') {
        return { ok: false, reason: `invalid_sort: '${value}' is not relevance|date` }
      }
      sortBy = value
      continue
    }
    keywordParts.push(token)
  }

  const keywords = keywordParts.join(' ').trim().slice(0, MAX_KEYWORD_CHARS)
  if (!keywords) {
    return { ok: false, reason: 'missing_search_query: control tokens only, no keywords' }
  }
  return { ok: true, search: { keywords, postedLimit, sortBy } }
}

export function buildActorInput(
  kind: ApifyCapabilityKind,
  args: {
    postUrl?: string
    search?: SearchQuery
    maxItems: number
    profileScraperMode?: string
  },
): Record<string, unknown> {
  const maxItems = Math.max(1, Math.floor(args.maxItems))
  const profileScraperMode = normalizeProfileScraperMode(args.profileScraperMode)
  if (kind === 'linkedin_post_search') {
    const search = args.search
    if (!search) throw new Error('linkedin_post_search requires a parsed search query')
    /*
     * VERIFIED input keys (default build schema, 2026-07-25): searchQueries,
     * maxPosts, postedLimit, sortBy, scrapeComments/maxComments,
     * scrapeReactions/maxReactions, and the lowercase short|main profile modes.
     *
     * sortBy is 'relevance' ON PURPOSE. 'date' returns the newest and
     * therefore least-engaged posts - the live probe came back with three
     * posts carrying zero comments between them, i.e. nothing to source. Use
     * 'date' only when recency itself is the signal.
     *
     * maxPosts is sent but is NOT a cap: the probe asked for 3 and was
     * returned and billed 30. The real bound is maxTotalChargeUsd, applied by
     * the caller from the ledger reservation.
     */
    return {
      searchQueries: [search.keywords],
      maxPosts: maxItems,
      postedLimit: search.postedLimit,
      sortBy: search.sortBy,
      scrapeComments: true,
      maxComments: maxItems,
      commentsProfileScraperMode: profileScraperMode,
      scrapeReactions: true,
      maxReactions: maxItems,
      reactionsProfileScraperMode: profileScraperMode,
    }
  }
  if (!args.postUrl) throw new Error(`${kind} requires a post url`)
  switch (kind) {
    case 'linkedin_post_reactions':
      // VERIFIED input keys: posts (array of post urls), maxItems,
      // reactionTypeFilter (omitted = all types), profileScraperMode.
      return { posts: [args.postUrl], maxItems, profileScraperMode }
    case 'linkedin_post_comments':
      // VERIFIED input keys: posts, maxItems, postedLimit, scrapeReplies,
      // profileScraperMode. We send only what we actually need.
      return { posts: [args.postUrl], maxItems, profileScraperMode }
    case 'x_post_engagers':
      // STILL UNVERIFIED: apidojo tweet-scraper input keys.
      return { startUrls: [args.postUrl], maxItems, includeReplies: true }
  }
}

// ---------------------------------------------------------------------------
// Normalizers -> our Candidate shape
// ---------------------------------------------------------------------------

/*
 * Discipline rules for everything below:
 * - unknown or missing fields are OMITTED, never invented and never defaulted
 *   to a placeholder;
 * - provider text (names, headlines, comment bodies) is stored as DATA only.
 *   It is never interpolated into an instruction, a template, or a claim
 *   string, so an engager whose headline is "ignore previous instructions"
 *   is just a row with an odd name;
 * - the evidence claim is built from a FIXED vocabulary plus a sanitized
 *   engagement-type token, never from raw provider text. Raw provider text
 *   that is worth keeping (the comment body) goes in `evidence.detail`, which
 *   is inert jsonb payload and is never rendered into an instruction path;
 * - source_url is OUR plan's post URL, not a url echoed back by the actor.
 *   The actor's own echo (`query.post`) is kept in `evidence.detail` instead,
 *   so a crafted echo can never redirect a stored source_url.
 */

// Direct observation of a public engagement event: high but not certain,
// because the actor layer sits between us and the platform.
export const APIFY_EVIDENCE_CONFIDENCE = 0.9

const MAX_ENGAGEMENT_TOKEN = 24
// Comment bodies are kept for evidence, but bounded: receipts and evidence
// rows are read by humans, not a dumping ground for arbitrary provider text.
const MAX_COMMENTARY_CHARS = 1_000
const MAX_REACTION_TYPES = 8

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/*
 * harvestapi returns "--" as its own filler for "this profile has no
 * headline" (verified live). A filler string is ABSENT, not a title: storing
 * it would put "--" in front of a customer as a job title.
 */
// dashes (ascii, en, em), dots and whitespace only; escaped so no literal
// dash character other than '-' appears in the source
const PLACEHOLDER_PATTERN = /^[-\u2013\u2014._\s]+$/

function meaningful(value: string | null): string | null {
  if (!value) return null
  return PLACEHOLDER_PATTERN.test(value) ? null : value
}

function at(item: unknown, path: string[]): unknown {
  let cursor: unknown = item
  for (const key of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return cursor
}

function pick(item: unknown, paths: string[][]): string | null {
  for (const path of paths) {
    const value = str(at(item, path))
    if (value) return value
  }
  return null
}

// Same as pick, but a provider filler value ("--") is skipped rather than
// returned, so a later alias still gets its chance.
function pickMeaningful(item: unknown, paths: string[][]): string | null {
  for (const path of paths) {
    const value = meaningful(str(at(item, path)))
    if (value) return value
  }
  return null
}

function pickUrl(item: unknown, paths: string[][]): string | null {
  const raw = pick(item, paths)
  if (!raw) return null
  // Only http(s) urls are stored; anything else is dropped rather than kept
  // as an unverified string.
  return /^https?:\/\//i.test(raw) ? raw : null
}

function joinName(item: unknown, firstPaths: string[][], lastPaths: string[][]): string | null {
  const first = pick(item, firstPaths)
  const last = pick(item, lastPaths)
  const joined = [first, last].filter(Boolean).join(' ').trim()
  return joined ? joined : null
}

/*
 * Sanitize a provider-supplied engagement type into a short uppercase token.
 * This is the ONLY provider string that reaches a claim, and it is stripped
 * to [A-Z_] and length-capped first.
 */
export function normalizeEngagementType(raw: unknown, fallback: string): string {
  const value = str(raw)
  if (!value) return fallback
  const token = value.toUpperCase().replace(/[^A-Z_]/g, '')
  if (!token) return fallback
  return token.slice(0, MAX_ENGAGEMENT_TOKEN)
}

/*
 * Reaction types observed on the item, sanitized to short uppercase tokens.
 * VERIFIED location on the comments actor: engagement.reactions[].type
 * (e.g. EMPATHY). These are reactions ON the comment, so they are evidence
 * detail, not the engagement kind itself.
 */
function reactionTypes(item: unknown): string[] {
  const raw = at(item, ['engagement', 'reactions'])
  if (!Array.isArray(raw)) return []
  const seen: string[] = []
  for (const entry of raw) {
    const declared = str(at(entry, ['type']))
    if (!declared) continue
    const token = normalizeEngagementType(declared, '')
    if (token && !seen.includes(token)) seen.push(token)
    if (seen.length >= MAX_REACTION_TYPES) break
  }
  return seen
}

/*
 * observed_at is WHEN THE ENGAGEMENT HAPPENED when the actor tells us
 * (verified fields: createdAtTimestamp epoch ms, createdAt), and only falls
 * back to our own attempt time when it does not. An unparseable value falls
 * back rather than being coerced.
 */
function itemObservedAt(item: unknown, fallback: string): string {
  const epoch = at(item, ['createdAtTimestamp'])
  if (typeof epoch === 'number' && Number.isFinite(epoch) && epoch > 0) {
    const fromEpoch = new Date(epoch)
    if (!Number.isNaN(fromEpoch.getTime())) return fromEpoch.toISOString()
  }
  const raw = str(at(item, ['createdAt']))
  if (raw) {
    const parsed = new Date(raw)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }
  return fallback
}

function buildIdentity(parts: {
  name: string
  title: string | null
  company: string | null
  profileUrl: string | null
}): CandidateIdentity {
  const identity: CandidateIdentity = { name: parts.name }
  // omitted, never invented
  if (parts.title) identity.title = parts.title
  if (parts.company) identity.company = parts.company
  if (parts.profileUrl) identity.urls = [parts.profileUrl]
  return identity
}

export type NormalizeContext = {
  // Absent for linkedin_post_search: posts are discovered, not supplied, so
  // each candidate anchors to the post it was actually found on.
  postUrl?: string
  observedAt: string
}

/*
 * Validate a post url the ACTOR gave us, before we are willing to store it as
 * evidence source_url.
 *
 * Every other capability anchors evidence to the caller's own plan url, which
 * is why the discipline note above says a provider echo must never become a
 * source_url. Discovery has no such url to anchor to, so the host allowlist
 * does that job instead: a discovered post that is not on linkedin.com is
 * dropped rather than trusted.
 */
export function discoveredPostUrl(kind: ApifyCapabilityKind, raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  const host = parsed.hostname.toLowerCase()
  const allowed = APIFY_ACTORS[kind].allowedHosts.some(
    (entry) => host === entry || host.endsWith(`.${entry}`),
  )
  return allowed ? parsed.toString() : null
}

export type NormalizeResult = {
  candidates: Candidate[]
  // items the actor returned that could not become a candidate (no usable
  // name). Surfaced on the receipt: we never fabricate a name to keep a row.
  dropped: number
  // post-search only: duplicate CHILD rows the actor emits alongside the posts
  // (see normalizePostSearch). Skipped deliberately, so they must not be
  // counted as `dropped` - that would read as 18 failures on a healthy run.
  skippedChildRows?: number
}

/*
 * VERIFIED (comments actor): the person is nested under `actor`, with
 * `actor.name` as ONE full-name field (there is no firstName/lastName split),
 * `actor.linkedinUrl`, and `actor.position` for the headline. The verified
 * names come FIRST in every list below.
 *
 * The remaining aliases exist for the reactions actor, whose output shape is
 * STILL UNVERIFIED (see the header note), and for a marketplace actor swap.
 */
const LINKEDIN_NAME_PATHS: string[][] = [
  ['actor', 'name'],
  ['reactor', 'name'],
  ['author', 'name'],
  ['profile', 'fullName'],
  ['profile', 'name'],
  ['fullName'],
  ['name'],
]

// UNVERIFIED alias set: the verified comments actor has no first/last split.
// Retained only so an actor swap that does split names still normalizes.
const LINKEDIN_FIRST_PATHS: string[][] = [
  ['actor', 'firstName'],
  ['reactor', 'firstName'],
  ['author', 'firstName'],
  ['firstName'],
]

const LINKEDIN_LAST_PATHS: string[][] = [
  ['actor', 'lastName'],
  ['reactor', 'lastName'],
  ['author', 'lastName'],
  ['lastName'],
]

const LINKEDIN_TITLE_PATHS: string[][] = [
  ['actor', 'position'],
  ['actor', 'headline'],
  ['reactor', 'headline'],
  ['reactor', 'position'],
  ['author', 'headline'],
  ['profile', 'headline'],
  ['headline'],
  ['position'],
  ['occupation'],
]

/*
 * COMPANY IS NOT RETURNED by the verified comments actor in `short` mode:
 * there is no company field at all, so the comments path never consults this
 * list and company stays undefined. Company must come from a later enrichment
 * step, or possibly from `main` mode at $0.002/profile (UNTESTED).
 *
 * The list below is used only by the UNVERIFIED reactions path.
 */
const LINKEDIN_COMPANY_PATHS: string[][] = [
  ['actor', 'companyName'],
  ['actor', 'company', 'name'],
  ['reactor', 'companyName'],
  ['author', 'companyName'],
  ['currentCompany', 'name'],
  ['companyName'],
  ['company', 'name'],
]

const LINKEDIN_PROFILE_URL_PATHS: string[][] = [
  ['actor', 'linkedinUrl'],
  ['actor', 'profileUrl'],
  ['actor', 'url'],
  ['reactor', 'linkedinUrl'],
  ['reactor', 'profileUrl'],
  ['author', 'linkedinUrl'],
  ['author', 'profileUrl'],
  ['profile', 'url'],
  ['profileUrl'],
  ['linkedinUrl'],
  ['authorProfileUrl'],
]

const X_NAME_PATHS: string[][] = [
  ['author', 'name'],
  ['user', 'name'],
  ['author', 'userName'],
  ['user', 'screen_name'],
  ['screenName'],
  ['name'],
]

const X_PROFILE_URL_PATHS: string[][] = [
  ['author', 'url'],
  ['author', 'profileUrl'],
  ['user', 'url'],
  ['profileUrl'],
]

const X_ENGAGEMENT_PATHS: string[][] = [['engagementType'], ['type']]

function linkedinCandidate(
  item: unknown,
  ctx: NormalizeContext,
  opts: {
    engagementKind: 'comment' | 'reaction'
    engagementType: string
    claimPrefix: string
    // false for the verified comments actor: it returns no company field
    allowCompany: boolean
  },
): Candidate | null {
  const name = pick(item, LINKEDIN_NAME_PATHS) ?? joinName(item, LINKEDIN_FIRST_PATHS, LINKEDIN_LAST_PATHS)
  // No usable name = no candidate. We never synthesize one.
  if (!name) return null

  const detail: Record<string, unknown> = { engagement_kind: opts.engagementKind }
  const reactions = reactionTypes(item)
  if (reactions.length > 0) detail.reaction_types = reactions
  // The comment body, kept as INERT data for evidence. It is bounded and never
  // reaches a claim, a template, or any instruction path.
  const commentary = str(at(item, ['commentary']))
  if (commentary) detail.commentary = commentary.slice(0, MAX_COMMENTARY_CHARS)
  const createdAt = str(at(item, ['createdAt']))
  if (createdAt) detail.created_at = createdAt
  // The actor's echo of the post we asked for. Recorded for reconciliation
  // only; source_url below stays OUR host-checked plan URL.
  const queryPost = str(at(item, ['query', 'post']))
  if (queryPost) detail.query_post = queryPost

  return {
    entity_kind: 'person',
    identity: buildIdentity({
      name,
      // "--" and friends are treated as absent, not as a real title
      title: pickMeaningful(item, LINKEDIN_TITLE_PATHS),
      company: opts.allowCompany ? pick(item, LINKEDIN_COMPANY_PATHS) : null,
      profileUrl: pickUrl(item, LINKEDIN_PROFILE_URL_PATHS),
    }),
    evidence: [
      {
        // fixed vocabulary + sanitized token; no raw provider text
        claim: `${opts.claimPrefix} (${opts.engagementType})`,
        source_url: ctx.postUrl ?? null,
        observed_at: itemObservedAt(item, ctx.observedAt),
        confidence: APIFY_EVIDENCE_CONFIDENCE,
        detail,
      },
    ],
  }
}

function xEngagementType(item: unknown): string {
  const declared = pick(item, X_ENGAGEMENT_PATHS)
  if (declared) return normalizeEngagementType(declared, 'ENGAGEMENT')
  const record = (item ?? {}) as Record<string, unknown>
  if (record.isReply === true || str(record.inReplyToId) || str(at(item, ['inReplyToUser', 'id']))) {
    return 'REPLY'
  }
  if (record.isRetweet === true || record.retweeted_tweet != null || record.retweetedTweet != null) {
    return 'RETWEET'
  }
  if (record.isQuote === true || record.quoted_tweet != null || record.quotedTweet != null) {
    return 'QUOTE'
  }
  return 'ENGAGEMENT'
}

/*
 * Post search returns POSTS, each carrying nested `comments[]` and
 * `reactions[]`, so one returned item yields many candidates instead of one.
 *
 * Within a single post the same person is deduped by name: someone who both
 * reacted to and commented on one post is one candidate, not two. Across
 * posts we keep both rows - repeat engagement on different posts is real
 * signal, and the research layer dedupes identities downstream. Note the
 * provider makes URL-keyed dedupe unreliable here anyway: commenters come back
 * with vanity urls (/in/jane-smith) while reactors come back with obfuscated
 * ones (/in/ACoAA...), so the same person has two different urls.
 */
function normalizePostSearch(items: unknown[], ctx: NormalizeContext): NormalizeResult {
  const candidates: Candidate[] = []
  let dropped = 0
  let skippedChildRows = 0
  for (const post of items) {
    /*
     * The dataset is HETEROGENEOUS, and not in the way the item count suggests.
     * Verified against the live payload 2026-07-25: a "30 item" run was really
     *   3 post rows (nested comments[] + reactions[])
     * + 9 flat COMMENT rows (`actor` + `commentary` + `type:'comment'`)
     * + 18 flat REACTION rows (`actor` + `postId` + `reactionType`)
     * and every one of those 27 flat rows duplicated an engager already nested
     * under one of the 3 posts. None was unique.
     *
     * The discriminator is the ARRAYS, not the url: flat comment rows carry a
     * linkedinUrl of their own (a ?commentUrn deep link), so keying on url
     * presence would misread them as posts and anchor evidence to a comment
     * permalink. A true post always carries comments/reactions arrays - a
     * zero-engagement post carries them empty, verified in probe 1 - so
     * "has an actor but no arrays" identifies a child row exactly.
     *
     * Skip them rather than letting them fall into `dropped`: the nested copy
     * is the one that keeps a real post anchor for evidence, and counting 27
     * duplicates as drops would report a healthy run as almost total failure
     * and bury a genuine normalizer regression in the noise.
     */
    const isChildRow =
      at(post, ['actor']) != null &&
      !Array.isArray(at(post, ['comments'])) &&
      !Array.isArray(at(post, ['reactions']))
    if (isChildRow) {
      skippedChildRows += 1
      continue
    }
    const postUrl = discoveredPostUrl('linkedin_post_search', at(post, ['linkedinUrl'])) ?? ctx.postUrl
    if (!postUrl) {
      // No trustworthy anchor for the evidence: drop rather than store a
      // claim we cannot point at.
      dropped += 1
      continue
    }
    const postCtx: NormalizeContext = { postUrl, observedAt: ctx.observedAt }
    const seen = new Set<string>()
    const push = (candidate: Candidate | null) => {
      if (!candidate) {
        dropped += 1
        return
      }
      const key = (candidate.identity?.name ?? '').trim().toLowerCase()
      if (key && seen.has(key)) return
      if (key) seen.add(key)
      candidates.push(candidate)
    }

    const comments = at(post, ['comments'])
    if (Array.isArray(comments)) {
      for (const row of comments) {
        push(
          linkedinCandidate(row, postCtx, {
            engagementKind: 'comment',
            engagementType: 'COMMENT',
            claimPrefix: 'Commented on a LinkedIn post matching the audience search',
            allowCompany: false,
          }),
        )
      }
    }
    const reactions = at(post, ['reactions'])
    if (Array.isArray(reactions)) {
      for (const row of reactions) {
        push(
          linkedinCandidate(row, postCtx, {
            engagementKind: 'reaction',
            engagementType: normalizeEngagementType(
              at(row, ['type']) ?? at(row, ['reactionType']) ?? at(row, ['reaction']),
              'REACTION',
            ),
            claimPrefix: 'Reacted to a LinkedIn post matching the audience search',
            allowCompany: true,
          }),
        )
      }
    }
  }
  return { candidates, dropped, skippedChildRows }
}

export function normalizeItems(
  kind: ApifyCapabilityKind,
  items: unknown[],
  ctx: NormalizeContext,
): NormalizeResult {
  if (kind === 'linkedin_post_search') return normalizePostSearch(items, ctx)
  const candidates: Candidate[] = []
  let dropped = 0
  for (const item of items) {
    let candidate: Candidate | null = null
    if (kind === 'linkedin_post_reactions') {
      // STILL UNVERIFIED shape: the reactions actor returned an empty array on
      // the live probe, so these aliases (and the company mapping) remain
      // defensive guesses until a post with reactions is run.
      const type = normalizeEngagementType(
        at(item, ['type']) ?? at(item, ['reactionType']) ?? at(item, ['reaction']),
        'REACTION',
      )
      candidate = linkedinCandidate(item, ctx, {
        engagementKind: 'reaction',
        engagementType: type,
        claimPrefix: 'Reacted to the source LinkedIn post',
        allowCompany: true,
      })
    } else if (kind === 'linkedin_post_comments') {
      // VERIFIED shape. The comment BODY is deliberately not stored in the
      // claim: it is third-party free text and belongs nowhere near an
      // instruction path. It is carried on evidence.detail as inert data.
      candidate = linkedinCandidate(item, ctx, {
        engagementKind: 'comment',
        engagementType: 'COMMENT',
        claimPrefix: 'Commented on the source LinkedIn post',
        // no company field exists in `short` mode: never invent one
        allowCompany: false,
      })
    } else {
      const name = pick(item, X_NAME_PATHS)
      if (name) {
        candidate = {
          entity_kind: 'person',
          identity: buildIdentity({
            name,
            title: null,
            company: null,
            profileUrl: pickUrl(item, X_PROFILE_URL_PATHS),
          }),
          evidence: [
            {
              claim: `Engaged with the source X post (${xEngagementType(item)})`,
              source_url: ctx.postUrl ?? null,
              observed_at: ctx.observedAt,
              confidence: APIFY_EVIDENCE_CONFIDENCE,
            },
          ],
        }
      }
    }
    if (candidate) candidates.push(candidate)
    else dropped += 1
  }
  return { candidates, dropped }
}

// ---------------------------------------------------------------------------
// Enrichment: input profile URL handling (fail closed: no LinkedIn URL, no run)
// ---------------------------------------------------------------------------

export type ProfileUrlResult =
  | { ok: true; url: string }
  | { ok: false; reason: string }

/*
 * The candidate identity carries the profile URLs the SOURCING step captured.
 * We pick the first one that is a LinkedIn PROFILE url and refuse everything
 * else, so a crafted candidate url can never aim the profile actor at another
 * host (or at a feed post) and spend the customer's money there.
 *
 * Checks, all of them fail-closed:
 * - http(s) only
 * - host must be linkedin.com or a subdomain of it
 * - path must be a profile path ('/in/' or the legacy '/pub/'), never a feed,
 *   company, or search url
 */
export function extractProfileUrl(urls: unknown): ProfileUrlResult {
  const list = Array.isArray(urls) ? urls : []
  if (list.length === 0) {
    return { ok: false, reason: 'missing_profile_url: the candidate carries no profile URL' }
  }
  let sawUrl = false
  for (const entry of list) {
    const raw = str(entry)
    if (!raw || !/^https?:\/\//i.test(raw)) continue
    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      continue
    }
    sawUrl = true
    const host = parsed.hostname.toLowerCase()
    const allowed = APIFY_ENRICH_ACTOR.allowedHosts.some(
      (entryHost) => host === entryHost || host.endsWith(`.${entryHost}`),
    )
    if (!allowed) continue
    if (!/\/(in|pub)\//i.test(parsed.pathname)) continue
    return { ok: true, url: parsed.toString() }
  }
  return {
    ok: false,
    reason: sawUrl
      ? 'invalid_profile_url: no LinkedIn profile URL among the candidate URLs'
      : 'missing_profile_url: the candidate carries no usable profile URL',
  }
}

// ---------------------------------------------------------------------------
// Enrichment normalizer -> our ContactPoint shape
// ---------------------------------------------------------------------------

/*
 * VERIFIED output keys (live probe 2026-07-24): id, publicIdentifier,
 * linkedinUrl, firstName, lastName, emails, companyWebsites, headline,
 * location, currentPosition, experience, education, skills, connectionsCount,
 * followerCount, about.
 *
 * `emails` is an ARRAY and is `[]` when no address was found. The ELEMENT shape
 * was not captured (the verified run found none), so both a bare string and an
 * object carrying the address are accepted below and anything else is dropped.
 *
 * COMPANY LEGITIMATELY COMES FROM HERE. The sourcing actor returns no company
 * at all, so `currentPosition` / `experience` / `companyWebsites` are the first
 * place a company name or domain honestly exists. Their ELEMENT shapes are not
 * individually verified, so the readers below try a small alias set and omit
 * the field when nothing matches. Nothing is invented and nothing is defaulted.
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/

const COMPANY_NAME_KEYS = ['companyName', 'company', 'organizationName', 'organization', 'name']
const POSITION_TITLE_KEYS = ['position', 'title', 'jobTitle', 'role']
const COMPANY_URL_KEYS = ['url', 'website', 'domain', 'link', 'companyWebsite']

function firstOf(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value
}

// Reads the first meaningful string among `keys` on an object-ish value.
// Placeholder fillers ("--", dots, whitespace) count as ABSENT, reusing the
// same filter the sourcing normalizer uses.
function readKey(value: unknown, keys: string[]): string | null {
  if (value === null || typeof value !== 'object') return null
  for (const key of keys) {
    const found = meaningful(str((value as Record<string, unknown>)[key]))
    if (found) return found
  }
  return null
}

function readEmail(entry: unknown): string | null {
  const direct = meaningful(str(entry))
  if (direct) return EMAIL_PATTERN.test(direct) ? direct.toLowerCase() : null
  const nested = readKey(entry, ['email', 'value', 'address', 'emailAddress'])
  if (!nested) return null
  return EMAIL_PATTERN.test(nested) ? nested.toLowerCase() : null
}

export type ApifyProfileNormalization = {
  // the first usable address, or null when `emails` was empty (the verified
  // no-hit shape) or carried nothing parseable
  email: string | null
  // how many parseable addresses the actor returned (0 = the not_found case)
  emailsFound: number
  /*
   * Business facts about the person, keys OMITTED when the actor did not return
   * them. This is what fills the company gap the sourcing step leaves.
   */
  profile: Record<string, unknown>
}

export function normalizeProfileItem(item: unknown): ApifyProfileNormalization {
  const rawEmails = at(item, ['emails'])
  const emails: string[] = []
  if (Array.isArray(rawEmails)) {
    for (const entry of rawEmails) {
      const email = readEmail(entry)
      if (email && !emails.includes(email)) emails.push(email)
    }
  }

  const current = firstOf(at(item, ['currentPosition']))
  const experience = firstOf(at(item, ['experience']))
  const company = readKey(current, COMPANY_NAME_KEYS) ?? readKey(experience, COMPANY_NAME_KEYS)
  // Job title only from a position record. The verified `headline` field is a
  // self-written strapline, not a title, so it is kept as its own key and never
  // promoted into `title`.
  const title = readKey(current, POSITION_TITLE_KEYS) ?? readKey(experience, POSITION_TITLE_KEYS)

  const websites = at(item, ['companyWebsites'])
  let companyDomain: string | null = null
  let validEmailServer: boolean | null = null
  if (Array.isArray(websites)) {
    for (const entry of websites) {
      const url = meaningful(str(entry)) ?? readKey(entry, COMPANY_URL_KEYS)
      if (!url) continue
      companyDomain = url
      const flag = entry !== null && typeof entry === 'object'
        ? (entry as Record<string, unknown>).validEmailServer
        : undefined
      // upstream domain validation, recorded only when the actor stated it
      if (typeof flag === 'boolean') validEmailServer = flag
      break
    }
  }

  const profile: Record<string, unknown> = {}
  const publicIdentifier = meaningful(str(at(item, ['publicIdentifier'])))
  if (publicIdentifier) profile.public_identifier = publicIdentifier
  const linkedinUrl = meaningful(str(at(item, ['linkedinUrl'])))
  if (linkedinUrl && /^https?:\/\//i.test(linkedinUrl)) profile.linkedin_url = linkedinUrl
  const name = [
    meaningful(str(at(item, ['firstName']))),
    meaningful(str(at(item, ['lastName']))),
  ]
    .filter(Boolean)
    .join(' ')
    .trim()
  if (name) profile.name = name
  const headline = meaningful(str(at(item, ['headline'])))
  if (headline) profile.headline = headline
  const location = meaningful(str(at(item, ['location'])))
  if (location) profile.location = location
  if (company) profile.company = company
  if (title) profile.title = title
  if (companyDomain) profile.company_domain = companyDomain
  if (validEmailServer !== null) profile.valid_email_server = validEmailServer

  return { email: emails[0] ?? null, emailsFound: emails.length, profile }
}

/*
 * Build the email ContactPoint for a normalized profile, or null when the
 * actor found no address.
 *
 * verification_state is 'found', NEVER 'verified'. Apify's email SEARCH is a
 * lookup, not an independent mailbox verification; promoting it to 'verified'
 * would let unverified addresses skip our verify layer, which is the only
 * thing entitled to set that state.
 */
export function profileContactPoint(
  normalized: ApifyProfileNormalization,
  provenance: Record<string, unknown>,
): ContactPoint | null {
  if (!normalized.email) return null
  return {
    channel: 'email',
    value: normalized.email,
    provenance: {
      ...provenance,
      ...normalized.profile,
      verification_state: 'found',
    },
  }
}
