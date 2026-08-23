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
  const reserved = await ledger.reserve({
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
    const relations = await em.find(GtmCandidateRelation, {
      organizationId: run.organizationId,
      tenantId: run.tenantId,
      providerOperationId: shadow.id,
      deletedAt: null,
    }, { limit: 100 })
    return emptyResult({
      outcome: 'replayed',
      operation_id: operationId,
      ledger_status: reserved.status,
      reconciliation_required:
        reserved.status === 'provider_started' || reserved.status === 'reconciliation_required',
      relations_created: relations.length,
      error: reserved.status === 'provider_started' || reserved.status === 'reconciliation_required'
        ? 'existing provider operation requires reconciliation'
        : null,
    })
  }

  const started = await ledger.start(operationId)
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
    max_charge_usd: providerSpendCapUsd(plan.maximum_credits, markup),
  })
  const receipt = result.receipt ?? null
  const observed = now()
  let chargedCredits = 0
  let intendedAction: GtmSettleOutcome | 'mark_ambiguous'
  if (result.status === 'ok' || result.status === 'partial' || result.status === 'no_result') {
    chargedCredits = Math.min(
      creditsForUnits(
        result.cost_units ?? 0,
        plan.quoted_credits_per_unit,
        markup,
      ),
      plan.maximum_credits,
    )
    intendedAction = result.status === 'partial' ? 'partially_charged' : 'charged'
  } else if (result.status === 'ambiguous') {
    intendedAction = 'mark_ambiguous'
  } else {
    intendedAction = 'refunded'
  }

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
      schema_version: 'gtm-provider-outcome-v1',
      observed_at: observed.toISOString(),
      adapter_status: result.status,
      intended_ledger_action: intendedAction,
      intended_charged_credits: chargedCredits,
      provider_error: result.error ?? null,
      output_count: Array.isArray(result.data) ? result.data.length : 0,
      settlement_pending: true,
    },
  }
  await em.transactional(async (tem) => {
    shadow.receipt = observedReceipt
    tem.persist(shadow)
    await tem.flush()
  })

  let ledgerStatus = shadow.localStatusMirror ?? 'provider_started'
  try {
    if (intendedAction === 'mark_ambiguous') {
      ledgerStatus = await ledger.markAmbiguous(operationId, {
        error: result.error ?? 'ambiguous provider outcome',
        receipt,
      })
    } else {
      ledgerStatus = await ledger.settle(operationId, intendedAction, chargedCredits, receipt)
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
    if (result.status !== 'ambiguous') shadow.settledAt = now()
    tem.persist(shadow)
    await tem.flush()
  })

  if (result.status === 'ambiguous') {
    return emptyResult({
      outcome: 'ambiguous',
      operation_id: operationId,
      ledger_status: ledgerStatus,
      reconciliation_required: true,
      error: result.error ?? 'ambiguous provider outcome',
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

  const companyByUrl = new Map(
    plan.companies.map((company) => [normalizedCompanyUrl(company.linkedin_url), company]),
  )
  const summary = emptyResult({
    outcome: result.status,
    operation_id: operationId,
    ledger_status: ledgerStatus,
    charged_credits: chargedCredits,
  })
  for (const observation of result.data ?? []) {
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
  return summary
}
