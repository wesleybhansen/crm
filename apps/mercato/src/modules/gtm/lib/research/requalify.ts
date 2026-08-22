import type { CandidateEvidence, CandidateIdentity } from '../adapters/types'
import {
  GtmAuditEvent,
  GtmCandidate,
  GtmEvidence,
  type GtmResearchRun,
} from '../../data/entities'
import {
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
  const candidates = await em.find(GtmCandidate, scope)
  const candidateIds = candidates.map((row) => row.id)
  const [evidenceRows, manualAudits] = candidateIds.length > 0
    ? await Promise.all([
      em.find(GtmEvidence, {
        organizationId: run.organizationId,
        tenantId: run.tenantId,
        candidateId: { $in: candidateIds },
        deletedAt: null,
      }),
      em.find(GtmAuditEvent, {
        organizationId: run.organizationId,
        tenantId: run.tenantId,
        action: 'gtm.candidate.review_override',
        objectType: 'gtm_candidate',
        objectId: { $in: candidateIds },
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
    && candidates.every((row) =>
      manuallyReviewed.has(row.id) || row.qualificationVersion === FIT_SCORER_VERSION,
    )
  if (alreadyCurrent) {
    const current = summarizeFitResults(candidates.map((candidate): FitResult => ({
      fitScore: Number(candidate.fitScore ?? 0),
      verdict: candidate.fitStatus === 'accepted'
        ? 'accepted'
        : candidate.fitStatus === 'review' ? 'review' : 'rejected',
      reason: candidate.rejectReason ?? 'meets_fit_rules',
      version: FIT_SCORER_VERSION,
      breakdown: { identity: 0, account: 0, persona: 0, geography: 0, evidence: 0 },
      unknowns: [],
      contradictions: [],
    })))
    return {
      scorerVersion: FIT_SCORER_VERSION,
      alreadyCurrent: true,
      candidates: candidates.length,
      rescored: 0,
      manualOverridesPreserved: manuallyReviewed.size,
      ...current,
    }
  }

  const fitResults: FitResult[] = []
  let rescored = 0
  await em.transactional(async (tem) => {
    for (const candidate of candidates) {
      if (manuallyReviewed.has(candidate.id)) {
        fitResults.push({
          fitScore: Number(candidate.fitScore ?? 0),
          verdict: candidate.fitStatus === 'accepted' ? 'accepted' : 'rejected',
          reason: candidate.rejectReason ?? 'manual_review_accepted',
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
      const identity = providerLocation && !candidate.identity.provider_location
        ? { ...candidate.identity, provider_location: providerLocation }
        : candidate.identity
      const fit = scorer.score({
        entity_kind: candidate.entityKind === 'person' ? 'person' : 'company',
        identity: identity as CandidateIdentity,
      }, play, usableEvidence)
      candidate.identity = identity
      candidate.fitStatus = fit.verdict
      candidate.fitScore = String(fit.fitScore)
      candidate.rejectReason = fit.verdict === 'accepted' ? null : fit.reason
      candidate.qualification = {
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
      candidate.qualificationVersion = fit.version
      tem.persist(candidate)
      fitResults.push(fit)
      rescored += 1
    }

    const distribution = summarizeFitResults(fitResults)
    const result: RequalifyResearchRunResult = {
      scorerVersion: FIT_SCORER_VERSION,
      alreadyCurrent: false,
      candidates: candidates.length,
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
    alreadyCurrent: false,
    candidates: candidates.length,
    rescored,
    manualOverridesPreserved: manuallyReviewed.size,
    ...distribution,
  }
}
