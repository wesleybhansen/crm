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
}

export type ShortlistPool = { viable: number; accepted: number; review: number; contactable: number }

export type ShortlistResult = { pool: ShortlistPool; shortlist: ShortlistEntry[]; scan_capped: boolean }

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
  const empty: ShortlistResult = { pool: { viable: 0, accepted: 0, review: 0, contactable: 0 }, shortlist: [], scan_capped: false }
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

  type Scored = { entry: Omit<ShortlistEntry, 'rank'>; key: string; ruleFit: number }
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
    const rows = (evidenceByCandidate.get(candidate.id) ?? [])
      .filter((row) => row.researchRunId === match.researchRunId || !row.researchRunId)
      .filter((row) => row.qualityStatus !== 'invalid')
      .sort((a, b) => (b.observedAt?.getTime() ?? 0) - (a.observedAt?.getTime() ?? 0))
      .slice(0, EVIDENCE_PER_ROW)
    scored.push({
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
        confidence,
        score,
        why: whyOf(match),
        evidence: rows.map((row) => ({ claim: row.claim, source_url: row.sourceUrl ?? null })),
        contact,
        location: str(identity.location) ?? ([str(identity.city), str(identity.region)].filter(Boolean).join(', ') || null),
      },
    })
  }

  // Best row per business, then best first; ties broken by accepted, then the
  // rules' own fit score, and only then by name (a name-only tie-break
  // delivered an alphabetical top 20 on a live run of equal scores).
  scored.sort((a, b) => b.entry.score - a.entry.score
    || (a.entry.fit_status === b.entry.fit_status ? 0 : a.entry.fit_status === 'accepted' ? -1 : 1)
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
  return {
    pool,
    shortlist: unique.slice(0, limit).map((row, index) => ({ rank: index + 1, ...row.entry })),
    scan_capped: matches.length >= SHORTLIST_MATCH_SCAN_LIMIT,
  }
}
