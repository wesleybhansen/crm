import { GtmCampaign, GtmContactPoint, GtmEvidence, GtmResearchRun } from '../data/entities'

/*
 * Read-side list helpers for the internal GTM routes (SPEC-066 section 5).
 *
 * The hub workspace UI needs workspace-wide lists of campaigns and research
 * runs (it previously tracked created ids browser-locally) plus per-candidate
 * verification/evidence rollups for the People tab. Everything here is
 * self-scoped by organization_id + tenant_id, excludes soft-deleted rows,
 * caps at GTM_LIST_CAP rows, and orders newest first. The enrichment rollup
 * runs exactly one grouped query per table over the page's candidate ids
 * (never one query per candidate).
 */

export const GTM_LIST_CAP = 50

// Narrow EntityManager slice: find with the orderBy/limit options the real
// MikroORM EntityManager accepts; FakeEm mirrors the same semantics in tests.
export interface ListEm {
  find<T extends object>(
    entityClass: new () => T,
    where: Record<string, unknown>,
    options?: { orderBy?: Record<string, 'asc' | 'desc'>; limit?: number },
  ): Promise<T[]>
}

// Identity resolved server-side at the route boundary; never caller-supplied.
export type ListCtx = { organizationId: string; tenantId: string }

function scopedWhere(ctx: ListCtx): Record<string, unknown> {
  return { organizationId: ctx.organizationId, tenantId: ctx.tenantId, deletedAt: null }
}

export async function listCampaigns(
  em: ListEm,
  ctx: ListCtx,
  filters: { workspaceId?: string | null } = {},
): Promise<GtmCampaign[]> {
  const where = scopedWhere(ctx)
  if (filters.workspaceId) where.workspaceId = filters.workspaceId
  return em.find(GtmCampaign, where, { orderBy: { createdAt: 'desc' }, limit: GTM_LIST_CAP })
}

export async function listResearchRuns(
  em: ListEm,
  ctx: ListCtx,
  filters: { workspaceId?: string | null; playId?: string | null } = {},
): Promise<GtmResearchRun[]> {
  const where = scopedWhere(ctx)
  if (filters.workspaceId) where.workspaceId = filters.workspaceId
  if (filters.playId) where.playId = filters.playId
  return em.find(GtmResearchRun, where, { orderBy: { createdAt: 'desc' }, limit: GTM_LIST_CAP })
}

export type CandidateEnrichment = {
  // A GtmContactPoint with channel 'email' and verification_state 'verified'
  // exists for the candidate.
  hasVerifiedEmail: boolean
  // Best customer-actionable state across this candidate's live email rows.
  // This is deliberately not a boolean: `unknown`, `risky`, and
  // `provider_ambiguous` have different next actions in the People table.
  emailVerificationState: CandidateEmailVerificationState | null
  emailContactCount: number
  evidenceCount: number
  // Provenance rollup: where this person's data came from and when it was
  // observed. Surfaced to the customer for transparency and used to answer a
  // data-subject request without an investigation (privacy policy 3.2 promises
  // we record source, observation time, and confidence).
  sources: string[]
  sourcesExtra: number
  firstObservedAt: Date | null
  lastObservedAt: Date | null
  confidence: number | null
}

export type CandidateEmailVerificationState =
  | 'verified'
  | 'found'
  | 'risky'
  | 'catch_all'
  | 'provider_ambiguous'
  | 'unknown'
  | 'not_found'

const EMAIL_STATE_PRIORITY: Record<CandidateEmailVerificationState, number> = {
  verified: 7,
  found: 6,
  risky: 5,
  catch_all: 4,
  provider_ambiguous: 3,
  unknown: 2,
  not_found: 1,
}

function candidateEmailState(value: string): CandidateEmailVerificationState {
  return Object.hasOwn(EMAIL_STATE_PRIORITY, value)
    ? value as CandidateEmailVerificationState
    : 'unknown'
}

// How many distinct source labels are returned inline; the rest are counted.
export const PROVENANCE_SOURCE_LIMIT = 3

/** Human-readable source label for one evidence row: the recording provider if
 *  we have one, else the host of the source URL. Returns null when neither is
 *  present so callers can skip it rather than display a placeholder. */
export function evidenceSourceLabel(row: {
  providerRef?: Record<string, unknown> | null
  sourceUrl?: string | null
}): string | null {
  const ref = row.providerRef
  if (ref) {
    for (const key of ['provider', 'adapter_id', 'adapter', 'source']) {
      const value = ref[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
  }
  const url = typeof row.sourceUrl === 'string' ? row.sourceUrl.trim() : ''
  if (url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '')
    } catch {
      return null
    }
  }
  return null
}

function parseConfidence(raw: string | null | undefined): number | null {
  if (raw == null) return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

/** Per-candidate verification + evidence rollup for one page of candidates.
 *  Two grouped queries total (contact points + evidence), each $in-scoped to
 *  the page's candidate ids and self-scoped to the caller org. Ids with no
 *  matching rows come back as { hasVerifiedEmail: false, evidenceCount: 0 }. */
export async function candidateEnrichment(
  em: ListEm,
  ctx: ListCtx,
  candidateIds: string[],
  options: { researchRunByCandidate?: Map<string, string> } = {},
): Promise<Map<string, CandidateEnrichment>> {
  const rollup = new Map<string, CandidateEnrichment>()
  const seenSources = new Map<string, Set<string>>()
  for (const id of candidateIds) {
    rollup.set(id, {
      hasVerifiedEmail: false,
      emailVerificationState: null,
      emailContactCount: 0,
      evidenceCount: 0,
      sources: [],
      sourcesExtra: 0,
      firstObservedAt: null,
      lastObservedAt: null,
      confidence: null,
    })
    seenSources.set(id, new Set<string>())
  }
  if (candidateIds.length === 0) return rollup

  const scope = { ...scopedWhere(ctx), candidateId: { $in: candidateIds } }
  const [emailPoints, evidence] = await Promise.all([
    em.find(GtmContactPoint, { ...scope, channel: 'email' }),
    em.find(GtmEvidence, scope),
  ])
  for (const point of emailPoints) {
    const entry = rollup.get(point.candidateId)
    if (!entry) continue
    const state = candidateEmailState(point.verificationState)
    entry.emailContactCount += 1
    entry.hasVerifiedEmail ||= state === 'verified'
    if (
      entry.emailVerificationState === null
      || EMAIL_STATE_PRIORITY[state] > EMAIL_STATE_PRIORITY[entry.emailVerificationState]
    ) {
      entry.emailVerificationState = state
    }
  }
  // Provenance is derived from the SAME evidence rows already fetched above,
  // so transparency costs zero additional queries.
  for (const row of evidence) {
    const expectedRun = options.researchRunByCandidate?.get(row.candidateId)
    if (expectedRun && row.researchRunId !== expectedRun) continue
    const entry = rollup.get(row.candidateId)
    if (!entry) continue
    entry.evidenceCount += 1

    const label = evidenceSourceLabel(row)
    if (label) {
      const seen = seenSources.get(row.candidateId)
      if (seen && !seen.has(label)) {
        seen.add(label)
        if (entry.sources.length < PROVENANCE_SOURCE_LIMIT) entry.sources.push(label)
        else entry.sourcesExtra += 1
      }
    }

    const observed = row.observedAt ?? null
    if (observed) {
      if (!entry.firstObservedAt || observed < entry.firstObservedAt) entry.firstObservedAt = observed
      if (!entry.lastObservedAt || observed > entry.lastObservedAt) entry.lastObservedAt = observed
    }

    const confidence = parseConfidence(row.confidence)
    if (confidence !== null && (entry.confidence === null || confidence > entry.confidence)) {
      entry.confidence = confidence
    }
  }
  return rollup
}
