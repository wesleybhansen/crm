import {
  GtmCandidate,
  GtmCandidateMatch,
  GtmContactPoint,
  GtmEvidence,
  GtmPlay,
} from '../../data/entities'
import { fitReasonLabel } from './summary'

/*
 * The ranked shortlist behind the Launch Pad's "20 prospects" guarantee.
 *
 * The included first run over-sources across several plays and runs. This
 * reads every row those runs hold AS IT STANDS NOW (after the AI lead check
 * and any requalification, never a funnel snapshot), keeps the ones a member
 * could act on (accepted or review), drops duplicates of the same business
 * found by two lanes, ranks them and returns the top N with their evidence
 * and a contact route.
 *
 * Hard rules applied here: only the caller's own org/tenant rows (the route
 * self-scopes), only accepted/review, never a row carrying a non-US country
 * code (the Launch Pad guarantee is US-only; the rules already reject these
 * for US plays, this is the belt to that braces), and never an email VALUE:
 * `has_email` is a boolean and it is false unless the resolving play is an
 * automated_email play (the same display rule the list op applies).
 *
 * Bounded queries: matches for the runs, then one $in query per table
 * (candidates, evidence, email contact points, plays). No per-row query.
 */

export const SHORTLIST_DEFAULT_LIMIT = 20
export const SHORTLIST_MAX_LIMIT = 50
/** Bounded scan: 50 runs of ~100 rows each. */
export const SHORTLIST_MATCH_SCAN_LIMIT = 5000
const EVIDENCE_PER_ROW = 3

export type ShortlistConfidence = 'high' | 'medium' | 'low'

export type ShortlistEntry = {
  rank: number
  candidate_id: string
  match_id: string
  run_id: string
  play_id: string
  entity_kind: 'company' | 'person' | 'opportunity'
  name: string
  fit_status: 'accepted' | 'review'
  confidence: ShortlistConfidence
  score: number
  why: string | null
  evidence: Array<{ claim: string; source_url: string | null }>
  contact: {
    person_name: string | null
    title: string | null
    website: string | null
    phone: string | null
    profile_url: string | null
    has_email: boolean
  }
  location: string | null
  /** Checked on the prospect's own website against the member's criteria
   *  (verify.ts). Only verified rows carry an earned score and confidence. */
  verified: boolean
  /** Real signals behind this prospect's place among equals, in plain words
   *  (for example "Owner named on their website"). */
  rank_reasons: string[]
  /** Why it sits above the next prospect with the same score, when a signal
   *  separates them; null when the score alone does, or nothing does. */
  rank_note: string | null
  /** True only when a neighbour has exactly the same score and signals, so the
   *  remaining order is alphabetical. */
  tied: boolean
  checks: Array<{ text: string; status: 'pass' | 'fail' | 'unknown'; quote: string | null }>
  phone_source: 'site_and_listing' | 'site' | 'listing_only' | 'listing' | null
}

export type ShortlistPool = { viable: number; accepted: number; review: number; contactable: number }

export type ShortlistResult = {
  pool: ShortlistPool
  shortlist: ShortlistEntry[]
  scan_capped: boolean
  /** Viable rows (within SHORTLIST_VERIFY_SCOPE, by rank) not yet checked on
   *  their website. The Launch Pad delivers only when this is 0. */
  unverified: number
}

/** How many of the best viable rows must be site-checked before delivery:
 *  the whole over-sourced pool the hub asks for, bounded. */
export const SHORTLIST_VERIFY_SCOPE = 80

type StoredVerification = {
  complete?: boolean
  excluded?: boolean
  grade?: number
  summary?: string
  checks?: Array<{ text?: string; status?: string; quote?: string | null; hard?: boolean }>
  ownership?: { status?: string; evidence?: string | null }
  site?: { pages?: string[] }
  contact?: { phone?: string | null; phone_source?: string | null; person_name?: string | null; person_title?: string | null }
}

export function storedVerification(qualification: unknown): StoredVerification | null {
  const v = (qualification as Record<string, unknown> | null)?.verification as StoredVerification | undefined
  return v && v.complete === true ? v : null
}

function confidenceOf(score: number): ShortlistConfidence {
  return score >= 80 ? 'high' : score >= 60 ? 'medium' : 'low'
}

export type ShortlistEm = {
  find<T extends object>(
    entity: new () => T,
    where: Record<string, unknown>,
    options?: { orderBy?: Record<string, 'asc' | 'desc'>; limit?: number },
  ): Promise<T[]>
}

const JUDGE_BONUS: Record<string, number> = { strong: 30, likely: 15, possible: 0 }
const UNCHECKED_BONUS = 5
/* Kept by a lead check that ran before it rated fits (lead-check-v1 rows
 * written before 2026-09-25). The check read the row and kept it, so it is
 * scored as a likely fit rather than as nothing: on the 2026-09-25 live run the
 * three rows the rules had ACCEPTED on exact keywords (Foster Plumbing,
 * Commercial Plumbing Inc, Thrivaire) fell out of the top 20 behind rescued
 * near misses because their unrated keep counted 0. */
const KEPT_UNRATED_BONUS = JUDGE_BONUS.likely

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function httpsUrl(value: unknown): string | null {
  const s = str(value)
  if (!s) return null
  try {
    const url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

/** Normalized company domain, else name + city: the same business found by
 *  two lanes (a Maps listing and a web mention) is one prospect. */
export function shortlistDedupeKey(identity: Record<string, unknown>): string {
  const domain = str(identity.domain)?.toLowerCase().replace(/^www\./, '').replace(/\/.*$/, '')
  if (domain) return `d:${domain}`
  const name = (str(identity.name) ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const city = (str(identity.city) ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  return `n:${name}|${city}`
}

export function isNonUs(identity: Record<string, unknown>): boolean {
  const code = str(identity.country_code)?.toUpperCase()
  return Boolean(code) && code !== 'US' && code !== 'USA'
}

export type RankInput = {
  fitScore: number
  fitStatus: 'accepted' | 'review'
  judgeFit: string | null
  judged: boolean
  namedPerson: boolean
  contactRoute: boolean
}

/** Rank score 0..100 and its confidence band. Pure. */
export function rankScore(input: RankInput): { score: number; confidence: ShortlistConfidence } {
  const rule = Math.max(0, Math.min(100, Number.isFinite(input.fitScore) ? input.fitScore : 0)) * 0.5
  const judge = !input.judged
    ? UNCHECKED_BONUS
    : input.judgeFit == null
      ? KEPT_UNRATED_BONUS
      : JUDGE_BONUS[input.judgeFit] ?? 0
  const raw = rule + judge + (input.fitStatus === 'accepted' ? 10 : 0) + (input.namedPerson ? 10 : 0) + (input.contactRoute ? 5 : 0)
  const score = Math.round(Math.max(0, Math.min(100, raw)))
  return { score, confidence: score >= 80 ? 'high' : score >= 60 ? 'medium' : 'low' }
}

function contactOf(kind: string, identity: Record<string, unknown>, hasEmail: boolean): ShortlistEntry['contact'] {
  const urls = Array.isArray(identity.urls) ? identity.urls.filter((u): u is string => typeof u === 'string') : []
  if (kind === 'person') {
    return {
      person_name: str(identity.name),
      title: str(identity.title),
      website: identity.domain ? httpsUrl(identity.domain) : null,
      phone: null,
      profile_url: httpsUrl(identity.profile_url) ?? httpsUrl(urls[0]),
      has_email: hasEmail,
    }
  }
  if (kind === 'opportunity') {
    return {
      person_name: str(identity.author_name),
      title: null,
      website: null,
      phone: null,
      profile_url: httpsUrl(identity.profile_url),
      has_email: false,
    }
  }
  return {
    person_name: null,
    title: null,
    website: httpsUrl(identity.website) ?? httpsUrl(identity.domain),
    phone: str(identity.phone),
    profile_url: null,
    has_email: hasEmail,
  }
}

function whyOf(match: GtmCandidateMatch): string | null {
  const qualification = (match.qualification ?? {}) as Record<string, unknown>
  const judge = (qualification.judge ?? {}) as Record<string, unknown>
  const note = str(judge.note)
  if (note) return note.slice(0, 160)
  const reason = str(match.rejectReason) ?? str(qualification.reason)
  return reason ? fitReasonLabel(reason).slice(0, 160) : null
}

export async function buildShortlist(
  em: ShortlistEm,
  ctx: { organizationId: string; tenantId: string },
  args: { runIds: string[]; limit?: number },
): Promise<ShortlistResult> {
  const limit = Math.max(1, Math.min(SHORTLIST_MAX_LIMIT, Math.floor(args.limit ?? SHORTLIST_DEFAULT_LIMIT)))
  const scope = { organizationId: ctx.organizationId, tenantId: ctx.tenantId }
  const runIds = [...new Set(args.runIds)]
  const empty: ShortlistResult = { pool: { viable: 0, accepted: 0, review: 0, contactable: 0 }, shortlist: [], scan_capped: false, unverified: 0 }
  if (runIds.length === 0) return empty

  const matches = await em.find(
    GtmCandidateMatch,
    { ...scope, researchRunId: { $in: runIds }, deletedAt: null },
    { orderBy: { createdAt: 'desc', id: 'desc' }, limit: SHORTLIST_MATCH_SCAN_LIMIT },
  )
  // Latest match per candidate across these runs: a later run's verdict
  // (or a requalification) supersedes an earlier one.
  const latest = new Map<string, GtmCandidateMatch>()
  for (const match of matches) if (!latest.has(match.candidateId)) latest.set(match.candidateId, match)
  const live = [...latest.values()].filter((m) => m.fitStatus === 'accepted' || m.fitStatus === 'review')
  if (live.length === 0) return { ...empty, scan_capped: matches.length >= SHORTLIST_MATCH_SCAN_LIMIT }

  const candidateIds = live.map((m) => m.candidateId)
  const playIds = [...new Set(live.map((m) => m.playId))]
  const [candidates, evidence, emailPoints, plays] = await Promise.all([
    em.find(GtmCandidate, { ...scope, id: { $in: candidateIds }, deletedAt: null }),
    em.find(GtmEvidence, { ...scope, candidateId: { $in: candidateIds }, deletedAt: null }),
    em.find(GtmContactPoint, { ...scope, candidateId: { $in: candidateIds }, channel: 'email', deletedAt: null }),
    em.find(GtmPlay, { ...scope, id: { $in: playIds } }),
  ])
  const candidateById = new Map(candidates.map((c) => [c.id, c]))
  const playById = new Map(plays.map((p) => [p.id, p]))
  const emailByCandidate = new Set(emailPoints.map((p) => p.candidateId))
  const evidenceByCandidate = new Map<string, GtmEvidence[]>()
  for (const row of evidence) {
    const list = evidenceByCandidate.get(row.candidateId) ?? []
    list.push(row)
    evidenceByCandidate.set(row.candidateId, list)
  }

  type Scored = { entry: Omit<ShortlistEntry, 'rank'>; key: string; ruleFit: number; signals: TieSignals; rawScore: number; lat: number | null; lng: number | null }
  const scored: Scored[] = []
  for (const match of live) {
    const candidate = candidateById.get(match.candidateId)
    if (!candidate) continue
    const identity = (candidate.identity ?? {}) as Record<string, unknown>
    if (isNonUs(identity)) continue
    const name = str(identity.name)
    if (!name) continue
    const kind = candidate.entityKind === 'person' || candidate.entityKind === 'opportunity' ? candidate.entityKind : 'company'
    const emailVisible = playById.get(match.playId)?.outreachMode === 'automated_email'
    const contact = contactOf(kind, identity, emailVisible && emailByCandidate.has(candidate.id))
    const judge = ((match.qualification ?? {}) as Record<string, unknown>).judge as Record<string, unknown> | undefined
    const fitStatus = match.fitStatus as 'accepted' | 'review'
    const { score, confidence } = rankScore({
      fitScore: Number(match.fitScore ?? 0),
      fitStatus,
      judged: Boolean(judge),
      judgeFit: str(judge?.fit),
      namedPerson: Boolean(contact.person_name),
      contactRoute: Boolean(contact.website || contact.phone || contact.profile_url || contact.has_email),
    })
    const verification = storedVerification(match.qualification)
    const rows = (evidenceByCandidate.get(candidate.id) ?? [])
      .filter((row) => row.researchRunId === match.researchRunId || !row.researchRunId)
      .filter((row) => row.qualityStatus !== 'invalid')
      .sort((a, b) => (b.observedAt?.getTime() ?? 0) - (a.observedAt?.getTime() ?? 0))
      .slice(0, EVIDENCE_PER_ROW)
    const checks = (verification?.checks ?? []).map((c) => ({
      text: str(c.text) ?? '',
      status: (c.status === 'pass' || c.status === 'fail' ? c.status : 'unknown') as 'pass' | 'fail' | 'unknown',
      quote: str(c.quote),
    })).filter((c) => c.text)
    const sitePage = verification?.site?.pages?.[0] ?? contact.website
    const siteEvidence = checks
      .filter((c) => c.status === 'pass' && c.quote)
      .slice(0, 2)
      .map((c) => ({ claim: `${c.text}. Their website: "${c.quote}"`, source_url: sitePage ?? null }))
    const verifiedContact = verification
      ? {
          ...contact,
          phone: str(verification.contact?.phone) ?? contact.phone,
          person_name: contact.person_name ?? str(verification.contact?.person_name),
          title: contact.title ?? str(verification.contact?.person_title),
        }
      : contact
    // A verified row's score is its site-check grade; an unverified row keeps
    // the rule/lead-check score for ORDER only and never an earned label.
    const finalScore = verification ? Math.round(Math.max(0, Math.min(100, Number(verification.grade ?? 0)))) : score
    const hardPasses = checks.filter((c) => c.status === 'pass').length
    const phoneSource = verification?.contact?.phone_source ?? null
    scored.push({
      rawScore: score,
      lat: typeof identity.latitude === 'number' ? identity.latitude : null,
      lng: typeof identity.longitude === 'number' ? identity.longitude : null,
      signals: {
        hardPasses,
        independentStated: verification?.ownership?.status === 'independent' && Boolean(verification.ownership.evidence),
        namedPerson: Boolean(verifiedContact.person_name),
        personName: verifiedContact.person_name ?? null,
        phone: phoneSource === 'site_and_listing' ? 2 : phoneSource === 'site' ? 1 : 0,
        rating: typeof identity.rating === 'number' ? identity.rating : null,
        reviews: typeof identity.review_count === 'number' ? identity.review_count : null,
        distanceKm: null,
        accepted: fitStatus === 'accepted',
        sitePages: Array.isArray(verification?.site?.pages) ? verification!.site!.pages!.length : 0,
      },
      ruleFit: Number(match.fitScore ?? 0) || 0,
      key: shortlistDedupeKey(identity),
      entry: {
        candidate_id: candidate.id,
        match_id: match.id,
        run_id: match.researchRunId,
        play_id: match.playId,
        entity_kind: kind,
        name,
        fit_status: fitStatus,
        confidence: verification ? confidenceOf(finalScore) : 'low',
        score: finalScore,
        why: (verification ? str(verification.summary) : null) ?? whyOf(match),
        evidence: [...siteEvidence, ...rows.map((row) => ({ claim: row.claim, source_url: row.sourceUrl ?? null }))].slice(0, EVIDENCE_PER_ROW),
        contact: verifiedContact,
        location: str(identity.location) ?? ([str(identity.city), str(identity.region)].filter(Boolean).join(', ') || null),
        verified: Boolean(verification),
        rank_reasons: [],
        rank_note: null,
        tied: false,
        checks,
        phone_source: verification
          ? ((verification.contact?.phone_source as ShortlistEntry['phone_source']) ?? null)
          : verifiedContact.phone ? 'listing' : null,
      },
    })
  }

  // Verified rows first (only they have earned a score), then best first.
  // Ties break on what was checked (criteria passed on the site, a named
  // person, a phone the site confirms), then acceptance, then the rules' own
  // fit score, and only then by name: a name-only tie-break delivered an
  // alphabetical "ranked" list on a live run of equal scores.
  // Distance from the middle of the pool: the Maps searches centre on the
  // member's area, so the median of the listings' coordinates is a free,
  // honest stand-in for "close to where you sell". Rows without coordinates
  // simply do not get this signal.
  const lats = scored.map((r) => r.lat).filter((v): v is number => v != null).sort((a, b) => a - b)
  const lngs = scored.map((r) => r.lng).filter((v): v is number => v != null).sort((a, b) => a - b)
  if (lats.length >= 3 && lngs.length >= 3) {
    const mid = { lat: lats[Math.floor(lats.length / 2)], lng: lngs[Math.floor(lngs.length / 2)] }
    for (const row of scored) {
      if (row.lat != null && row.lng != null) row.signals.distanceKm = haversineKm(mid, { lat: row.lat, lng: row.lng })
    }
  }
  scored.sort((a, b) => Number(b.entry.verified) - Number(a.entry.verified)
    || b.entry.score - a.entry.score
    || compareSignals(a.signals, b.signals)
    || b.ruleFit - a.ruleFit
    || a.entry.name.localeCompare(b.entry.name))
  const seen = new Set<string>()
  const unique: Scored[] = []
  for (const row of scored) {
    if (seen.has(row.key)) continue
    seen.add(row.key)
    unique.push(row)
  }
  const pool: ShortlistPool = {
    viable: unique.length,
    accepted: unique.filter((r) => r.entry.fit_status === 'accepted').length,
    review: unique.filter((r) => r.entry.fit_status === 'review').length,
    contactable: unique.filter((r) => {
      const c = r.entry.contact
      return Boolean(c.website || c.phone || c.profile_url || c.has_email)
    }).length,
  }
  const top = unique.slice(0, limit)
  top.forEach((row, index) => {
    row.entry.rank_reasons = reasonsFor(row.signals)
    const next = top[index + 1]
    const prev = top[index - 1]
    const sameAs = (other?: Scored) => Boolean(other) && other!.entry.verified === row.entry.verified && other!.entry.score === row.entry.score
      && compareSignals(row.signals, other!.signals) === 0 && other!.ruleFit === row.ruleFit
    row.entry.tied = sameAs(next) || sameAs(prev)
    row.entry.rank_note = next && next.entry.score === row.entry.score && next.entry.verified === row.entry.verified
      ? firstDifference(row.signals, next.signals)
      : null
  })
  return {
    pool,
    shortlist: top.map((row, index) => ({ rank: index + 1, ...row.entry })),
    scan_capped: matches.length >= SHORTLIST_MATCH_SCAN_LIMIT,
    unverified: unverifiedToCheck(unique.map((row) => ({ matchId: row.entry.match_id, verified: row.entry.verified, rawScore: row.rawScore }))).length,
  }
}

/** The unverified rows the site check should read next, best rule score
 *  first, within the verification scope. Pure. */
export function unverifiedToCheck(rows: Array<{ matchId: string; verified: boolean; rawScore: number }>): string[] {
  return rows
    .filter((row) => !row.verified)
    .sort((a, b) => b.rawScore - a.rawScore)
    .slice(0, Math.max(0, SHORTLIST_VERIFY_SCOPE - rows.filter((row) => row.verified).length))
    .map((row) => row.matchId)
}

/** Match ids to verify next for these runs, best rule score first. */
export async function nextToVerify(
  em: ShortlistEm,
  ctx: { organizationId: string; tenantId: string },
  args: { runIds: string[]; limit: number },
): Promise<string[]> {
  const scope = { organizationId: ctx.organizationId, tenantId: ctx.tenantId }
  const matches = await em.find(
    GtmCandidateMatch,
    { ...scope, researchRunId: { $in: [...new Set(args.runIds)] }, deletedAt: null },
    { orderBy: { createdAt: 'desc', id: 'desc' }, limit: SHORTLIST_MATCH_SCAN_LIMIT },
  )
  const latest = new Map<string, GtmCandidateMatch>()
  for (const match of matches) if (!latest.has(match.candidateId)) latest.set(match.candidateId, match)
  const live = [...latest.values()].filter((m) => m.fitStatus === 'accepted' || m.fitStatus === 'review')
  return unverifiedToCheck(live.map((m) => ({
    matchId: m.id,
    verified: Boolean(storedVerification(m.qualification)),
    rawScore: Number(m.fitScore ?? 0) + (m.fitStatus === 'accepted' ? 10 : 0),
  }))).slice(0, Math.max(0, args.limit))
}

/* ── Tie-breaking on real signals (2026-09-25) ──────────────────────────
 * The live Denver dental run delivered nine prospects at the same grade in
 * A-to-Z order. Among equal scores the order now follows signals the system
 * already holds, with no new paid call: what the site confirmed, a stated
 * independent owner, a named owner or lead, a phone the site confirms, the
 * public Google rating and review count (Maps rows), closeness to the middle
 * of the member's area, then acceptance, then how much of the site was read.
 * Each delivered prospect carries the reasons in plain words, and a tie is
 * reported only when every one of these is equal.
 */
export type TieSignals = {
  hardPasses: number
  independentStated: boolean
  namedPerson: boolean
  personName: string | null
  /** 2 = on the site and the listing, 1 = on the site, 0 = listing only / none. */
  phone: number
  rating: number | null
  reviews: number | null
  distanceKm: number | null
  accepted: boolean
  sitePages: number
}

/** A rating counts as much as the reviews behind it: 4.9 from 8 reviews is
 *  weaker evidence than 4.7 from 400. Bucketed so noise does not reorder. */
export function reputationScore(rating: number | null, reviews: number | null): number {
  if (rating == null || reviews == null || reviews <= 0) return 0
  return Math.round(rating * Math.log10(reviews + 1) * 2) / 2
}

/** Distance in 5 km bands (closer first); unknown distance sorts last. */
function distanceBand(km: number | null): number {
  return km == null ? Number.POSITIVE_INFINITY : Math.floor(km / 5)
}

type Key = { value: (s: TieSignals) => number; reason: (s: TieSignals) => string | null }
const KEYS: Key[] = [
  { value: (s) => s.hardPasses, reason: (s) => (s.hardPasses > 0 ? `Confirmed ${s.hardPasses} of your requirements on their website` : null) },
  { value: (s) => Number(s.independentStated), reason: (s) => (s.independentStated ? 'Independent ownership stated on their website' : null) },
  { value: (s) => Number(s.namedPerson), reason: (s) => (s.namedPerson ? `Owner or lead named on their website${s.personName ? ` (${s.personName})` : ''}` : null) },
  { value: (s) => s.phone, reason: (s) => (s.phone === 2 ? 'Phone number confirmed on their website' : s.phone === 1 ? 'Phone number taken from their website' : null) },
  { value: (s) => reputationScore(s.rating, s.reviews), reason: (s) => (reputationScore(s.rating, s.reviews) > 0 ? `${s.rating} stars from ${s.reviews} Google reviews` : null) },
  { value: (s) => -distanceBand(s.distanceKm), reason: (s) => (s.distanceKm != null && s.distanceKm <= 10 ? 'Close to the middle of your area' : null) },
  { value: (s) => Number(s.accepted), reason: (s) => (s.accepted ? 'Met every rule of the original search' : null) },
  { value: (s) => s.sitePages, reason: (s) => (s.sitePages >= 2 ? 'About or team pages read, not just the home page' : null) },
]

/** Negative when `a` ranks above `b`. Pure. */
export function compareSignals(a: TieSignals, b: TieSignals): number {
  for (const key of KEYS) {
    const d = key.value(b) - key.value(a)
    if (d !== 0 && Number.isFinite(d)) return d
    if (!Number.isFinite(d) && key.value(a) !== key.value(b)) return key.value(a) > key.value(b) ? -1 : 1
  }
  return 0
}

export function reasonsFor(s: TieSignals): string[] {
  return KEYS.map((key) => key.reason(s)).filter((r): r is string => Boolean(r)).slice(0, 6)
}

/** The first signal that puts `a` above `b`, in plain words, or null. */
export function firstDifference(a: TieSignals, b: TieSignals): string | null {
  for (const key of KEYS) {
    const va = key.value(a)
    const vb = key.value(b)
    if (va === vb) continue
    if (va < vb) return null
    const r = key.reason(a)
    return r ? `Ranked above the next prospect because: ${r.charAt(0).toLowerCase()}${r.slice(1)}` : null
  }
  return null
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)))
}
