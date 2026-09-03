import crypto from 'crypto'
import { UniqueConstraintViolationException } from '@mikro-orm/core'
import {
  GtmCandidate,
  GtmCandidateMatch,
  GtmCandidateRelation,
  GtmEvidence,
  GtmProviderOperation,
  GtmResearchRun,
} from '../../data/entities'
import type {
  DecisionMakerAdapter,
  DecisionMakerObservation,
} from '../adapters/apify/company-employees'
import { candidateDedupeKey, type ResearchEm } from '../research/execute'
import type { GtmCreditLedger, GtmSettleOutcome } from '../credits/ledger'
import type { GtmReserveResultWithEcho } from '../credits/noli-core-ledger'
import {
  creditsForUnits,
  defaultMarkupMultiplier,
  providerSpendCapUsd,
} from '../credits/markup'
import type { DecisionMakerPlan } from './plan'
import { qualifyDecisionMaker } from './qualify'

export interface DecisionMakerEm extends ResearchEm {
  find<T extends object>(
    entityClass: new () => T,
    where: Record<string, unknown>,
    options?: { orderBy?: Record<string, 'asc' | 'desc'>; limit?: number },
  ): Promise<T[]>
}

export type DecisionMakerExecutionResult = {
  outcome: 'ok' | 'partial' | 'no_result' | 'error' | 'ambiguous' | 'replayed'
  operation_id: string | null
  ledger_status: string | null
  charged_credits: number
  reconciliation_required: boolean
  people_created: number
  people_reused: number
  matches_created: number
  relations_created: number
  evidence_created: number
  accepted: number
  review: number
  rejected: number
  rows_dropped: number
  error: string | null
}

function emptyResult(
  values: Partial<DecisionMakerExecutionResult> = {},
): DecisionMakerExecutionResult {
  return {
    outcome: 'error',
    operation_id: null,
    ledger_status: null,
    charged_credits: 0,
    reconciliation_required: false,
    people_created: 0,
    people_reused: 0,
    matches_created: 0,
    relations_created: 0,
    evidence_created: 0,
    accepted: 0,
    review: 0,
    rejected: 0,
    rows_dropped: 0,
    error: null,
    ...values,
  }
}

function normalizedCompanyUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (!/^(?:www\.)?linkedin\.com$/i.test(url.hostname)) return null
    return `${url.hostname.toLowerCase().replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '').toLowerCase()}`
  } catch {
    return null
  }
}

function observedAt(observation: DecisionMakerObservation, fallback: Date): Date {
  const value = observation.candidate.evidence[0]?.observed_at
  const parsed = value ? new Date(value) : fallback
  return Number.isNaN(parsed.getTime()) ? fallback : parsed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

const PAID_LEDGER_STATUSES = new Set(['charged', 'partially_charged'])
const UNRESOLVED_LEDGER_STATUSES = new Set(['provider_started', 'reconciliation_required'])

/*
 * The provider's observations are retained in the shadow receipt BEFORE
 * settle (see executeDecisionMakerPlan) so a crash or lost settle response
 * after the canonical charge never loses paid profiles. This reads them back
 * with a structural check; anything malformed is treated as "nothing
 * retained" rather than materialised.
 */
export function retainedDecisionMakerObservations(
  receipt: Record<string, unknown> | null | undefined,
): DecisionMakerObservation[] | null {
  const observation = receipt?.gtm_observation
  if (!isRecord(observation) || !('retained_data' in observation)) return null
  const data = observation.retained_data
  if (!Array.isArray(data)) return null
  return data.filter((row): row is DecisionMakerObservation =>
    isRecord(row)
    && typeof row.parent_company_url === 'string'
    && typeof row.current_title === 'string'
    && isRecord(row.candidate)
    && isRecord(row.candidate.identity)
    && Array.isArray(row.candidate.evidence),
  )
}

export async function executeDecisionMakerPlan(args: {
  em: DecisionMakerEm
  ledger: GtmCreditLedger
  adapter: DecisionMakerAdapter
  run: GtmResearchRun
  plan: DecisionMakerPlan
  noliOrgId: string
  noliUserId: string
  now?: () => Date
  markupMultiplier?: number
}): Promise<DecisionMakerExecutionResult> {
  const { em, ledger, adapter, run, plan, noliOrgId, noliUserId } = args
  const now = args.now ?? (() => new Date())
  const markup = args.markupMultiplier ?? defaultMarkupMultiplier()
  if (!plan.available || plan.maximum_credits <= 0 || plan.companies.length === 0) {
    return emptyResult({ error: 'decision-maker plan is not executable' })
  }
  if (
    plan.run_id !== run.id
    || plan.play_id !== run.playId
    || plan.workspace_id !== run.workspaceId
    || plan.adapter_id !== adapter.descriptor.adapter_id
  ) {
    return emptyResult({ error: 'decision-maker plan scope does not match the research run' })
  }

  const idempotencyKey = `decision-makers:${run.id}:${plan.plan_hash}`
  const reserved: GtmReserveResultWithEcho = await ledger.reserve({
    orgId: noliOrgId,
    userId: noliUserId,
    kind: 'source_search',
    provider: plan.adapter_id,
    estimatedCredits: plan.maximum_credits,
    idempotencyKey,
    unitCostSnapshot: {
      unit: plan.billable_unit,
      provider_units: plan.provider_units,
      quoted_credits_per_unit: plan.quoted_credits_per_unit,
      markup_multiplier: markup,
      price_version: plan.price_version,
      terms_version: plan.terms_version,
    },
    fingerprint: {
      operation_kind: 'decision_maker_resolution',
      plan_hash: plan.plan_hash,
      research_run_id: run.id,
      play_id: run.playId,
      workspace_id: run.workspaceId,
      company_candidate_ids: plan.companies.map((company) => company.candidate_id),
      company_match_ids: plan.companies.map((company) => company.match_id),
      company_linkedin_urls: plan.companies.map((company) => company.linkedin_url),
      company_domains: plan.companies.map((company) => company.domain ?? null),
      job_titles: plan.job_titles,
      max_profiles: plan.max_profiles,
      descriptor_hash: plan.descriptor_hash,
    },
  })
  const operationId = reserved.operationId
  // The ledger's own reserved_credits echo, when present, bounds the provider
  // spend cap and the settle amount; the local quote alone never does.
  const reservedEcho = Number.isSafeInteger(reserved.reservedCredits) && (reserved.reservedCredits as number) >= 0
    ? (reserved.reservedCredits as number)
    : undefined
  const ceiling = reservedEcho !== undefined
    ? Math.min(plan.maximum_credits, reservedEcho)
    : plan.maximum_credits
  let shadow = await em.findOne(GtmProviderOperation, {
    noliCoreOperationId: operationId,
    organizationId: run.organizationId,
    tenantId: run.tenantId,
  })
  if (!shadow) {
    try {
      shadow = await em.transactional(async (tem) => {
        const row = tem.create(GtmProviderOperation, {
          id: crypto.randomUUID(),
          organizationId: run.organizationId,
          tenantId: run.tenantId,
          noliCoreOperationId: operationId,
          researchRunId: run.id,
          kind: 'decision_maker_resolution',
          provider: plan.adapter_id,
          localStatusMirror: reserved.status,
          requestedAt: now(),
        })
        tem.persist(row)
        await tem.flush()
        return row
      })
    } catch (error) {
      if (!(error instanceof UniqueConstraintViolationException)) throw error
      shadow = await em.findOne(GtmProviderOperation, {
        noliCoreOperationId: operationId,
        organizationId: run.organizationId,
        tenantId: run.tenantId,
      })
      if (!shadow) throw error
    }
  }

  if (reserved.status !== 'reserved') {
    // Replay of a confirmed plan. When the earlier attempt PAID for the
    // profiles but crashed (or lost the settle response) before writing them,
    // the observations it retained in the shadow receipt are materialised
    // now, idempotently; the customer never re-buys them and the idempotency
    // key never blocks recovery.
    const replay = emptyResult({
      outcome: 'replayed',
      operation_id: operationId,
      ledger_status: reserved.status,
      reconciliation_required: UNRESOLVED_LEDGER_STATUSES.has(reserved.status),
      error: UNRESOLVED_LEDGER_STATUSES.has(reserved.status)
        ? 'existing provider operation requires reconciliation'
        : null,
    })
    if (PAID_LEDGER_STATUSES.has(reserved.status)) {
      const retained = retainedDecisionMakerObservations(shadow.receipt)
      if (retained) {
        // The canonical ledger is settled; bring the shadow mirror with it
        // if the earlier attempt died between settle and mirror.
        if (shadow.localStatusMirror !== reserved.status || !shadow.settledAt) {
          await em.transactional(async (tem) => {
            shadow.localStatusMirror = reserved.status
            shadow.settledAt = shadow.settledAt ?? now()
            const observation = isRecord(shadow.receipt?.gtm_observation) ? shadow.receipt.gtm_observation : {}
            shadow.receipt = {
              ...(shadow.receipt ?? {}),
              gtm_observation: {
                ...observation,
                settlement_pending: false,
                canonical_status: reserved.status,
                settlement_error: null,
              },
            }
            tem.persist(shadow)
            await tem.flush()
          })
        }
        await materializeObservations({
          em, run, plan, adapter, shadow, operationId, observations: retained, observed: now(), now, summary: replay,
        })
      }
    }
    // A replay reports the relations this operation holds in total (fresh
    // plus previously written), so the caller sees the operation's yield.
    const relations = await em.find(GtmCandidateRelation, {
      organizationId: run.organizationId,
      tenantId: run.tenantId,
      providerOperationId: shadow.id,
      deletedAt: null,
    }, { limit: 100 })
    replay.relations_created = relations.length
    return replay
  }

  let started
  try {
    started = await ledger.start(operationId)
  } catch (error) {
    // Unknown start outcome: try to hand the escrow back. release is legal
    // only from reserved, so if start actually landed the release is refused
    // and the operation stays provider_started for reconciliation.
    try {
      const released = await ledger.release(operationId)
      await em.transactional(async (tem) => {
        shadow.localStatusMirror = released
        tem.persist(shadow)
        await tem.flush()
      })
    } catch {
      // shadow stays at its reserved mirror
    }
    throw error
  }
  await em.transactional(async (tem) => {
    shadow.localStatusMirror = started.status
    tem.persist(shadow)
    await tem.flush()
  })
  if (!started.startedNow) {
    return emptyResult({
      outcome: 'ambiguous',
      operation_id: operationId,
      ledger_status: started.status,
      reconciliation_required: true,
      error: 'provider start is already owned by another execution',
    })
  }

  const result = await adapter.resolve({
    signal_kind: 'company_decision_maker',
    entity_unit: 'people',
    geography: 'US',
    companies: plan.companies,
    job_titles: plan.job_titles,
    max_profiles: plan.max_profiles,
    max_charge_usd: providerSpendCapUsd(ceiling, markup),
  })
  const receipt = result.receipt ?? null
  const observed = now()
  let chargedCredits = 0
  let intendedAction: GtmSettleOutcome | 'mark_ambiguous'
  let ambiguityReason: string | null = null
  if (result.status === 'ok' || result.status === 'partial' || result.status === 'no_result') {
    if (result.cost_units == null) {
      // A result that cannot state its cost is not definitive; charging zero
      // would be a local guess at the provider's bill.
      intendedAction = 'mark_ambiguous'
      ambiguityReason = `provider ${result.status} omitted cost_units`
    } else {
      chargedCredits = Math.min(
        creditsForUnits(result.cost_units, plan.quoted_credits_per_unit, markup),
        ceiling,
      )
      intendedAction = result.status === 'partial' ? 'partially_charged' : 'charged'
    }
  } else if (result.status === 'ambiguous') {
    intendedAction = 'mark_ambiguous'
  } else if (result.cost_units != null && result.cost_units > 0) {
    // A definitive provider error that still reports a charge is charged.
    chargedCredits = Math.min(
      creditsForUnits(result.cost_units, plan.quoted_credits_per_unit, markup),
      ceiling,
    )
    intendedAction = 'charged'
  } else {
    intendedAction = 'refunded'
  }
  const treatAsAmbiguous = intendedAction === 'mark_ambiguous'

  const observedReceipt = {
    ...(receipt ?? {}),
    decision_maker_plan: {
      schema_version: plan.schema_version,
      plan_hash: plan.plan_hash,
      attempt: plan.attempt,
      company_candidate_ids: plan.companies.map((company) => company.candidate_id),
      job_titles: plan.job_titles,
      max_profiles: plan.max_profiles,
    },
    gtm_observation: {
      schema_version: 'gtm-provider-outcome-v2',
      observed_at: observed.toISOString(),
      adapter_status: result.status,
      intended_ledger_action: intendedAction,
      intended_charged_credits: chargedCredits,
      provider_error: result.error ?? ambiguityReason ?? null,
      output_count: Array.isArray(result.data) ? result.data.length : 0,
      settlement_pending: true,
      // Retained BEFORE settle, in the same transaction as the pending
      // observation: a crash after the canonical charge must not lose what
      // was paid for (the replay path above materialises it).
      ...(!treatAsAmbiguous && Array.isArray(result.data) ? { retained_data: result.data } : {}),
    },
  }
  await em.transactional(async (tem) => {
    shadow.receipt = observedReceipt
    tem.persist(shadow)
    await tem.flush()
  })

  let ledgerStatus = shadow.localStatusMirror ?? 'provider_started'
  const expectedStatus = treatAsAmbiguous ? 'reconciliation_required' : intendedAction
  try {
    if (intendedAction === 'mark_ambiguous') {
      ledgerStatus = await ledger.markAmbiguous(operationId, {
        error: result.error ?? ambiguityReason ?? 'ambiguous provider outcome',
        receipt,
      })
    } else {
      ledgerStatus = await ledger.settle(operationId, intendedAction, chargedCredits, receipt)
    }
    if (ledgerStatus !== expectedStatus) {
      // Settled only when the canonical ledger echoes the intended outcome;
      // any other state is parked for reconciliation, never treated as done.
      throw new Error(`canonical status ${ledgerStatus} does not match intended ${expectedStatus}`)
    }
  } catch (error) {
    const settlementError = error instanceof Error
      ? `${error.name}: ${error.message}`.slice(0, 500)
      : 'unknown canonical ledger error'
    await em.transactional(async (tem) => {
      shadow.receipt = {
        ...observedReceipt,
        gtm_observation: {
          ...observedReceipt.gtm_observation,
          settlement_pending: true,
          canonical_status: ledgerStatus,
          settlement_error: settlementError,
        },
      }
      tem.persist(shadow)
      await tem.flush()
    })
    return emptyResult({
      outcome: 'ambiguous',
      operation_id: operationId,
      ledger_status: ledgerStatus,
      reconciliation_required: true,
      error: 'canonical ledger outcome unresolved after provider response',
    })
  }

  await em.transactional(async (tem) => {
    shadow.localStatusMirror = ledgerStatus
    shadow.receipt = {
      ...observedReceipt,
      gtm_observation: {
        ...observedReceipt.gtm_observation,
        settlement_pending: false,
        canonical_status: ledgerStatus,
        settlement_error: null,
      },
    }
    if (!treatAsAmbiguous) shadow.settledAt = now()
    tem.persist(shadow)
    await tem.flush()
  })

  if (treatAsAmbiguous) {
    return emptyResult({
      outcome: 'ambiguous',
      operation_id: operationId,
      ledger_status: ledgerStatus,
      reconciliation_required: true,
      error: result.error ?? ambiguityReason ?? 'ambiguous provider outcome',
    })
  }
  if (result.status === 'error') {
    return emptyResult({
      outcome: 'error',
      operation_id: operationId,
      ledger_status: ledgerStatus,
      error: result.error ?? 'provider error',
    })
  }
  if (result.status === 'no_result') {
    return emptyResult({
      outcome: 'no_result',
      operation_id: operationId,
      ledger_status: ledgerStatus,
      charged_credits: chargedCredits,
    })
  }

  const summary = emptyResult({
    outcome: result.status,
    operation_id: operationId,
    ledger_status: ledgerStatus,
    charged_credits: chargedCredits,
  })
  await materializeObservations({
    em, run, plan, adapter, shadow, operationId, observations: result.data ?? [], observed, now, summary,
  })
  return summary
}

/*
 * Writes people, contextual matches, relations, and evidence for one
 * operation's observations. Idempotent: a person that already exists is
 * reused (dedupe key), and a relation that already exists for this run and
 * parent/child pair is counted as reused rather than rewritten, so the same
 * retained observations can be materialised again after a crash.
 */
async function materializeObservations(args: {
  em: DecisionMakerEm
  run: GtmResearchRun
  plan: DecisionMakerPlan
  adapter: DecisionMakerAdapter
  shadow: GtmProviderOperation
  operationId: string
  observations: DecisionMakerObservation[]
  observed: Date
  now: () => Date
  summary: DecisionMakerExecutionResult
}): Promise<void> {
  const { em, run, plan, adapter, shadow, operationId, observed, now, summary } = args
  const companyByUrl = new Map(
    plan.companies.map((company) => [normalizedCompanyUrl(company.linkedin_url), company]),
  )
  for (const observation of args.observations) {
    const company = companyByUrl.get(normalizedCompanyUrl(observation.parent_company_url))
    if (!company) {
      summary.rows_dropped += 1
      continue
    }
    const [parentCandidate, parentMatch] = await Promise.all([
      em.findOne(GtmCandidate, {
        id: company.candidate_id,
        organizationId: run.organizationId,
        tenantId: run.tenantId,
        workspaceId: run.workspaceId,
        entityKind: 'company',
        deletedAt: null,
      }),
      em.findOne(GtmCandidateMatch, {
        id: company.match_id,
        candidateId: company.candidate_id,
        organizationId: run.organizationId,
        tenantId: run.tenantId,
        researchRunId: run.id,
        playId: run.playId,
        fitStatus: 'accepted',
        deletedAt: null,
      }),
    ])
    if (!parentCandidate || !parentMatch) {
      summary.rows_dropped += 1
      continue
    }

    const candidate = observation.candidate
    const qualification = qualifyDecisionMaker(observation.current_title, plan.job_titles)
    const dedupeKey = candidateDedupeKey(candidate)
    let child = await em.findOne(GtmCandidate, {
      organizationId: run.organizationId,
      tenantId: run.tenantId,
      workspaceId: run.workspaceId,
      dedupeKey,
      deletedAt: null,
    })
    let childCreated = false
    if (!child) {
      child = em.create(GtmCandidate, {
        id: crypto.randomUUID(),
        organizationId: run.organizationId,
        tenantId: run.tenantId,
        researchRunId: run.id,
        workspaceId: run.workspaceId,
        entityKind: 'person',
        identity: candidate.identity as Record<string, unknown>,
        dedupeKey,
        fitStatus: qualification.verdict,
        fitScore: String(qualification.score),
        rejectReason: qualification.verdict === 'accepted' ? null : qualification.reason,
        qualityStatus: 'strong',
        qualityScore: '0.900',
        qualification: {
          ...qualification,
          parent_company_candidate_id: parentCandidate.id,
          parent_company_match_id: parentMatch.id,
        },
        qualificationVersion: qualification.version,
        retentionExpiresAt: new Date(now().getTime() + 90 * 24 * 60 * 60 * 1000),
      })
      try {
        await em.transactional(async (tem) => {
          tem.persist(child as GtmCandidate)
          await tem.flush()
        })
        childCreated = true
      } catch (error) {
        if (!(error instanceof UniqueConstraintViolationException)) throw error
        child = await em.findOne(GtmCandidate, {
          organizationId: run.organizationId,
          tenantId: run.tenantId,
          workspaceId: run.workspaceId,
          dedupeKey,
          deletedAt: null,
        })
        if (!child) throw error
      }
    }

    const existingRelation = await em.findOne(GtmCandidateRelation, {
      organizationId: run.organizationId,
      tenantId: run.tenantId,
      researchRunId: run.id,
      parentCandidateId: parentCandidate.id,
      childCandidateId: child.id,
      relationshipKind: 'current_employee',
      deletedAt: null,
    })
    if (existingRelation) {
      summary.people_reused += 1
      continue
    }
    const existingMatch = await em.findOne(GtmCandidateMatch, {
      organizationId: run.organizationId,
      tenantId: run.tenantId,
      researchRunId: run.id,
      candidateId: child.id,
      deletedAt: null,
    })
    const evidenceDate = observedAt(observation, observed)
    await em.transactional(async (tem) => {
      if (!existingMatch) {
        const match = tem.create(GtmCandidateMatch, {
          organizationId: run.organizationId,
          tenantId: run.tenantId,
          workspaceId: run.workspaceId,
          playId: run.playId,
          researchRunId: run.id,
          candidateId: child!.id,
          providerOperationId: shadow.id,
          fitStatus: qualification.verdict,
          fitScore: String(qualification.score),
          rejectReason: qualification.verdict === 'accepted' ? null : qualification.reason,
          qualityStatus: 'strong',
          qualityScore: '0.900',
          qualification: {
            ...qualification,
            parent_company_candidate_id: parentCandidate.id,
            parent_company_match_id: parentMatch.id,
          },
          qualificationVersion: qualification.version,
        })
        tem.persist(match)
      }
      const relation = tem.create(GtmCandidateRelation, {
        organizationId: run.organizationId,
        tenantId: run.tenantId,
        workspaceId: run.workspaceId,
        playId: run.playId,
        researchRunId: run.id,
        parentMatchId: parentMatch.id,
        parentCandidateId: parentCandidate.id,
        childCandidateId: child!.id,
        providerOperationId: shadow.id,
        relationshipKind: 'current_employee',
        observedTitle: observation.current_title,
        confidence: '0.900',
        observedAt: evidenceDate,
      })
      tem.persist(relation)
      for (const evidence of candidate.evidence) {
        const evidenceRow = tem.create(GtmEvidence, {
          organizationId: run.organizationId,
          tenantId: run.tenantId,
          candidateId: child!.id,
          researchRunId: run.id,
          claim: evidence.claim,
          sourceUrl: evidence.source_url,
          providerRef: {
            provider: plan.adapter_id,
            operation_id: operationId,
            plan_hash: plan.plan_hash,
            ...(evidence.detail ?? {}),
          },
          observedAt: evidenceDate,
          retrievedAt: now(),
          confidence: String(evidence.confidence),
          license: adapter.descriptor.constraints.license,
          qualityStatus: 'strong',
          qualityIssues: [],
          evidenceType: 'provider_observation',
        })
        tem.persist(evidenceRow)
      }
      await tem.flush()
    })
    if (childCreated) summary.people_created += 1
    else summary.people_reused += 1
    if (!existingMatch) summary.matches_created += 1
    summary.relations_created += 1
    summary.evidence_created += candidate.evidence.length
    summary[qualification.verdict] += 1
  }
}
