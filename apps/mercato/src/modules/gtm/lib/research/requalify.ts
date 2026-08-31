import type { CandidateEvidence, CandidateIdentity } from '../adapters/types'
import {
  GtmAuditEvent,
  GtmCandidate,
  GtmCandidateMatch,
  GtmEvidence,
  type GtmResearchRun,
} from '../../data/entities'
import {
  FIT_SCORER_REVISION,
  FIT_SCORER_VERSION,
  ruleBasedFitScorer,
  summarizeFitResults,
  type FitPlayInput,
  type FitResult,
  type FitScorer,
} from './qualify'

export interface RequalifyEm {
  transactional<T>(cb: (tem: RequalifyEm) => Promise<T>): Promise<T>
  find<T extends object>(
    entityClass: new () => T,
    where: Record<string, unknown>,
  ): Promise<T[]>
  persist(entity: object): unknown
  flush(): Promise<void>
}

export type RequalifyResearchRunResult = {
  scorerVersion: typeof FIT_SCORER_VERSION
  scorerRevision: typeof FIT_SCORER_REVISION
  alreadyCurrent: boolean
  candidates: number
  rescored: number
  manualOverridesPreserved: number
  accepted: number
  review: number
  rejected: number
  byReason: Record<string, number>
}

function frozenPlay(run: GtmResearchRun): FitPlayInput | null {
  const snapshot = run.inputSnapshot
  if (!snapshot || typeof snapshot !== 'object') return null
  const raw = snapshot.play
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const play = raw as Record<string, unknown>
  return {
    entityUnit: typeof play.entity_unit === 'string' ? play.entity_unit : null,
    geography: typeof play.geography === 'string' ? play.geography : null,
    audience: typeof play.audience === 'string' ? play.audience : null,
    signal: typeof play.signal === 'string' ? play.signal : null,
    recencyWindow: typeof play.recency_window === 'string' ? play.recency_window : null,
    providerQuery: play.provider_query && typeof play.provider_query === 'object' && !Array.isArray(play.provider_query)
      ? play.provider_query as Record<string, unknown>
      : null,
    // The original run claim is the closest durable approximation of the
    // execution scorer's clock. Replays must never use the wall clock, which
    // would make otherwise identical evidence age differently on each call.
    referenceTime: run.startedAt ?? run.createdAt,
  }
}

function candidateEvidence(row: GtmEvidence): CandidateEvidence {
  const providerRef = row.providerRef ?? {}
  const detail = providerRef.detail
  return {
    claim: row.claim,
    source_url: row.sourceUrl ?? null,
    observed_at: row.observedAt?.toISOString() ?? '',
    confidence: Number(row.confidence ?? 0),
    ...(detail && typeof detail === 'object' && !Array.isArray(detail)
      ? { detail: detail as Record<string, unknown> }
      : {}),
  }
}

function dataForSeoTarget(
  evidence: GtmEvidence[],
  play: FitPlayInput,
): string | null {
  const hasMapsEvidence = evidence.some((row) => row.providerRef?.provider === 'dataforseo-google-maps')
  return hasMapsEvidence && typeof play.geography === 'string' && play.geography.trim()
    ? play.geography.trim()
    : null
}

const LEGACY_TARGETING_LOCATION_ADAPTERS = new Set([
  'apify-reddit-demand-opportunities',
  'apify-reddit-thread-demand-opportunities',
  'apify-x-demand-opportunities',
  'apify-threads-demand-opportunities',
  'apify-instagram-demand-opportunities',
  'apify-tiktok-demand-opportunities',
  'dataforseo-organic-demand-opportunities',
  'dataforseo-events-demand-opportunities',
])

function locationIdentity(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(?:united states(?: of america)?|usa|us)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function frozenTargetLocations(play: FitPlayInput): string[] {
  const providerLocations = play.providerQuery?.locations
  return [
    ...(typeof play.geography === 'string' ? [play.geography] : []),
    ...(Array.isArray(providerLocations)
      ? providerLocations.filter((value): value is string => typeof value === 'string')
      : typeof providerLocations === 'string' ? [providerLocations] : []),
  ].map((value) => value.trim()).filter(Boolean)
}

/**
 * The first paid realtor benchmark was stored before social/organic adapters
 * separated provider targeting from returned evidence. Those adapter versions
 * copied the requested market into identity.location for every row. Replays
 * must demote that legacy value to provider_location before fit-v7 scores it;
 * otherwise requalification would preserve the exact geography false-positive
 * the corrected adapters prevent on new runs.
 */
function demoteLegacyTargetingLocation(args: {
  identity: CandidateIdentity
  entityKind: string
  evidence: GtmEvidence[]
  play: FitPlayInput
  priorScorerRevision: unknown
}): CandidateIdentity {
  if (args.entityKind !== 'opportunity' || args.priorScorerRevision === FIT_SCORER_REVISION) {
    return args.identity
  }
  const provider = args.evidence.find((row) =>
    LEGACY_TARGETING_LOCATION_ADAPTERS.has(String(row.providerRef?.provider ?? '')),
  )?.providerRef?.provider
  if (!provider) return args.identity
  const location = typeof args.identity.location === 'string' ? args.identity.location.trim() : ''
  if (!location) return args.identity
  const normalized = locationIdentity(location)
  const matchesTarget = frozenTargetLocations(args.play)
    .some((target) => locationIdentity(target) === normalized)
  if (!matchesTarget) return args.identity
  return {
    ...args.identity,
    location: null,
    provider_location: args.identity.provider_location ?? location,
  }
}

function executionWithDistribution(
  run: GtmResearchRun,
  result: RequalifyResearchRunResult,
): Record<string, unknown> {
  const providerPlan = (run.providerPlan ?? {}) as Record<string, unknown>
  const execution = providerPlan.execution && typeof providerPlan.execution === 'object'
    ? providerPlan.execution as Record<string, unknown>
    : {}
  const funnel = execution.funnel && typeof execution.funnel === 'object'
    ? execution.funnel as Record<string, unknown>
    : {}
  return {
    ...providerPlan,
    execution: {
      ...execution,
      funnel: {
        ...funnel,
        accepted: result.accepted,
        review: result.review,
        rejected: result.rejected,
        acceptance_rate: result.candidates > 0 ? result.accepted / result.candidates : 0,
        target_met: Number(funnel.target_accepted ?? 0) > 0
          ? result.accepted >= Number(funnel.target_accepted)
          : false,
        by_reason: result.byReason,
      },
      requalification: {
        scorer_version: result.scorerVersion,
        scorer_revision: result.scorerRevision,
        candidates: result.candidates,
        rescored: result.rescored,
        manual_overrides_preserved: result.manualOverridesPreserved,
      },
    },
  }
}

/**
 * Deterministically rescore already-stored provider output. This operation
 * performs no provider or billing calls and preserves every human review
 * override. It exists so a scorer correction can repair a paid run without
 * paying for or duplicating the source request.
 */
export async function requalifyResearchRun(input: {
  em: RequalifyEm
  run: GtmResearchRun
  actorUserId: string
  requestId?: string | null
  scorer?: FitScorer
}): Promise<RequalifyResearchRunResult> {
  const { em, run } = input
  const scorer = input.scorer ?? ruleBasedFitScorer
  const play = frozenPlay(run)
  if (!play) throw new Error('research_run_missing_frozen_play')

  const scope = {
    organizationId: run.organizationId,
    tenantId: run.tenantId,
    researchRunId: run.id,
    deletedAt: null,
  }
  const matches = await em.find(GtmCandidateMatch, scope)
  const legacyCandidates = matches.length === 0 ? await em.find(GtmCandidate, scope) : []
  const candidateIds = matches.length > 0
    ? [...new Set(matches.map((row) => row.candidateId))]
    : legacyCandidates.map((row) => row.id)
  const matchedCandidates = candidateIds.length > 0 && matches.length > 0
    ? await em.find(GtmCandidate, {
        organizationId: run.organizationId,
        tenantId: run.tenantId,
        id: { $in: candidateIds },
        deletedAt: null,
      })
    : []
  const candidatesById = new Map(matchedCandidates.map((row) => [row.id, row]))
  const targets = matches.length > 0
    ? matches
        .map((match) => ({ match, candidate: candidatesById.get(match.candidateId) }))
        .filter((row): row is { match: GtmCandidateMatch; candidate: GtmCandidate } => Boolean(row.candidate))
    : legacyCandidates.map((candidate) => ({ match: null, candidate }))
  const reviewObjectIds = matches.length > 0
    ? matches.map((row) => row.id)
    : candidateIds
  const [evidenceRows, manualAudits] = candidateIds.length > 0
    ? await Promise.all([
      em.find(GtmEvidence, {
        organizationId: run.organizationId,
        tenantId: run.tenantId,
        candidateId: { $in: candidateIds },
        ...(matches.length > 0 ? { researchRunId: run.id } : {}),
        deletedAt: null,
      }),
      em.find(GtmAuditEvent, {
        organizationId: run.organizationId,
        tenantId: run.tenantId,
        action: matches.length > 0
          ? 'gtm.candidate_match.review_override'
          : 'gtm.candidate.review_override',
        objectType: matches.length > 0 ? 'gtm_candidate_match' : 'gtm_candidate',
        objectId: { $in: reviewObjectIds },
      }),
    ])
    : [[], []]
  const manuallyReviewed = new Set(manualAudits.map((row) => row.objectId))
  const evidenceByCandidate = new Map<string, GtmEvidence[]>()
  for (const row of evidenceRows) {
    const list = evidenceByCandidate.get(row.candidateId) ?? []
    list.push(row)
    evidenceByCandidate.set(row.candidateId, list)
  }

  const providerPlan = (run.providerPlan ?? {}) as Record<string, unknown>
  const execution = providerPlan.execution && typeof providerPlan.execution === 'object'
    ? providerPlan.execution as Record<string, unknown>
    : {}
  const priorRequalification = execution.requalification
    && typeof execution.requalification === 'object'
    ? execution.requalification as Record<string, unknown>
    : {}
  const alreadyCurrent = priorRequalification.scorer_version === FIT_SCORER_VERSION
    && priorRequalification.scorer_revision === FIT_SCORER_REVISION
    && targets.every(({ candidate, match }) =>
      manuallyReviewed.has(match?.id ?? candidate.id)
      || (match?.qualificationVersion ?? candidate.qualificationVersion) === FIT_SCORER_VERSION,
    )
  if (alreadyCurrent) {
    const current = summarizeFitResults(targets.map(({ candidate, match }): FitResult => ({
      fitScore: Number(match?.fitScore ?? candidate.fitScore ?? 0),
      verdict: (match?.fitStatus ?? candidate.fitStatus) === 'accepted'
        ? 'accepted'
        : (match?.fitStatus ?? candidate.fitStatus) === 'review' ? 'review' : 'rejected',
      reason: (match?.rejectReason ?? candidate.rejectReason) ?? 'meets_fit_rules',
      version: FIT_SCORER_VERSION,
      breakdown: { identity: 0, account: 0, persona: 0, geography: 0, evidence: 0 },
      unknowns: [],
      contradictions: [],
    })))
    return {
      scorerVersion: FIT_SCORER_VERSION,
      scorerRevision: FIT_SCORER_REVISION,
      alreadyCurrent: true,
      candidates: targets.length,
      rescored: 0,
      manualOverridesPreserved: manuallyReviewed.size,
      ...current,
    }
  }

  const fitResults: FitResult[] = []
  let rescored = 0
  await em.transactional(async (tem) => {
    for (const { candidate, match } of targets) {
      const targetId = match?.id ?? candidate.id
      const targetFitStatus = match?.fitStatus ?? candidate.fitStatus
      const targetFitScore = match?.fitScore ?? candidate.fitScore
      const targetRejectReason = match?.rejectReason ?? candidate.rejectReason
      if (manuallyReviewed.has(targetId)) {
        fitResults.push({
          fitScore: Number(targetFitScore ?? 0),
          verdict: targetFitStatus === 'accepted' ? 'accepted' : 'rejected',
          reason: targetRejectReason ?? 'manual_review_accepted',
          version: FIT_SCORER_VERSION,
          breakdown: { identity: 0, account: 0, persona: 0, geography: 0, evidence: 0 },
          unknowns: [],
          contradictions: [],
        })
        continue
      }
      const storedEvidence = evidenceByCandidate.get(candidate.id) ?? []
      const usableEvidence = storedEvidence
        .filter((row) => row.qualityStatus !== 'invalid')
        .map(candidateEvidence)
      const providerLocation = dataForSeoTarget(storedEvidence, play)
      const priorQualification = (match?.qualification ?? candidate.qualification) as Record<string, unknown> | null
      const baseIdentity = providerLocation && !candidate.identity.provider_location
        ? { ...candidate.identity, provider_location: providerLocation }
        : candidate.identity
      const identity = demoteLegacyTargetingLocation({
        identity: baseIdentity as CandidateIdentity,
        entityKind: candidate.entityKind,
        evidence: storedEvidence,
        play,
        priorScorerRevision: priorQualification?.scorer_revision,
      })
      const entityKind =
        candidate.entityKind === 'person'
        || candidate.entityKind === 'company'
        || candidate.entityKind === 'opportunity'
          ? candidate.entityKind
          : 'company'
      const fit = scorer.score({
        entity_kind: entityKind,
        identity: identity as CandidateIdentity,
      }, play, usableEvidence)
      candidate.identity = identity
      const qualification = {
        scorer_revision: FIT_SCORER_REVISION,
        reason: fit.reason,
        breakdown: fit.breakdown,
        unknowns: fit.unknowns,
        contradictions: fit.contradictions,
        profile: fit.profile ?? null,
        criteria: fit.criteria ?? [],
        evidence_issues: storedEvidence.flatMap((row) =>
          Array.isArray(row.qualityIssues) ? row.qualityIssues : [],
        ),
      }
      if (match) {
        match.fitStatus = fit.verdict
        match.fitScore = String(fit.fitScore)
        match.rejectReason = fit.verdict === 'accepted' ? null : fit.reason
        match.qualification = qualification
        match.qualificationVersion = fit.version
        tem.persist(match)
        tem.persist(candidate)
      } else {
        candidate.fitStatus = fit.verdict
        candidate.fitScore = String(fit.fitScore)
        candidate.rejectReason = fit.verdict === 'accepted' ? null : fit.reason
        candidate.qualification = qualification
        candidate.qualificationVersion = fit.version
        tem.persist(candidate)
      }
      fitResults.push(fit)
      rescored += 1
    }

    const distribution = summarizeFitResults(fitResults)
    const result: RequalifyResearchRunResult = {
      scorerVersion: FIT_SCORER_VERSION,
      scorerRevision: FIT_SCORER_REVISION,
      alreadyCurrent: false,
      candidates: targets.length,
      rescored,
      manualOverridesPreserved: manuallyReviewed.size,
      ...distribution,
    }
    run.providerPlan = executionWithDistribution(run, result)
    tem.persist(run)
    const audit = new GtmAuditEvent()
    Object.assign(audit, {
      organizationId: run.organizationId,
      tenantId: run.tenantId,
      actor: 'user_id',
      actorUserId: input.actorUserId,
      action: 'gtm.research_run.requalified',
      objectType: 'gtm_research_run',
      objectId: run.id,
      requestId: input.requestId ?? null,
      metadata: {
        scorer_version: result.scorerVersion,
        scorer_revision: result.scorerRevision,
        candidates: result.candidates,
        rescored: result.rescored,
        manual_overrides_preserved: result.manualOverridesPreserved,
        accepted: result.accepted,
        review: result.review,
        rejected: result.rejected,
        by_reason: result.byReason,
      },
    })
    tem.persist(audit)
    await tem.flush()
  })

  const distribution = summarizeFitResults(fitResults)
  return {
    scorerVersion: FIT_SCORER_VERSION,
    scorerRevision: FIT_SCORER_REVISION,
    alreadyCurrent: false,
    candidates: targets.length,
    rescored,
    manualOverridesPreserved: manuallyReviewed.size,
    ...distribution,
  }
}
