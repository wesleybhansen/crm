import crypto from 'crypto'
import { UniqueConstraintViolationException } from '@mikro-orm/core'
import type { Candidate, SourceAdapter } from '../adapters/types'
import {
  GtmCreditLedgerError,
  type GtmCreditLedger,
  type GtmSettleOutcome,
} from '../credits/ledger'
import {
  creditsForUnits,
  defaultMarkupMultiplier,
  providerSpendCapUsd,
} from '../credits/markup'
import type { SourcePlanBatch } from './plan'
import { ruleBasedFitScorer, type FitScorer } from './qualify'
import { assessEvidence } from './evidence-quality'
import {
  GtmCandidate,
  GtmCandidateMatch,
  GtmEvidence,
  GtmProviderOperation,
  GtmResearchRun,
} from '../../data/entities'

/*
 * Research-run execution against source adapters through the SPEC-066 section
 * 11.2 credit-coupled wrapper. Per planned batch, in order:
 *
 *   1. cap check (maxCandidates reached, or maxCredits would be exceeded by
 *      this reserve) -> stop planning further batches
 *   2. ledger.reserve BEFORE any adapter call; insufficient_credits fails the
 *      run closed with ZERO adapter calls for that batch
 *   3. GtmProviderOperation shadow row (noli_core_operation_id = the canonical
 *      operation id; shadow only, never a balance)
 *   4. ledger.start
 *   5. adapter.search (fixture in this tranche)
 *   6. outcome:
 *      ok/partial   -> settle charged|partially_charged with
 *                      actual units x quoted x markup
 *      no_result    -> settle refunded 0 when pay_on_found, else charged
 *      ambiguous    -> ledger.markAmbiguous + shadow parked, NO retry, run
 *                      continues but is flagged reconciliation_required
 *      error        -> settle refunded 0 + failure recorded
 *   7. candidates inserted with dedupe_key = sha256 of the normalized
 *      identity, honoring the unique (org, workspace, dedupe_key) constraint
 *      race-safely (unique violation = counted duplicate); evidence rows from
 *      adapter receipts; deterministic rule-based qualification
 *
 * Every write happens inside em.transactional. Candidate inserts run in
 * per-candidate transactions so a unique-constraint duplicate aborts only
 * that candidate's insert (a violation inside one shared Postgres transaction
 * would poison every later write in it).
 */

// Minimal structural slice of MikroORM's EntityManager used here, so tests
// can drive execution with an in-memory fake and routes pass the real em.
export interface ResearchEm {
  transactional<T>(cb: (tem: ResearchEm) => Promise<T>): Promise<T>
  create<T extends object>(entityClass: new () => T, data: object): T
  persist(entity: object): unknown
  flush(): Promise<void>
  findOne<T extends object>(entityClass: new () => T, where: Record<string, unknown>): Promise<T | null>
}

export type ExecuteResearchRunDeps = {
  em: ResearchEm
  ledger: GtmCreditLedger
  // adapter_id -> adapter; registries fail closed when no real provider is enabled
  adapters: Record<string, SourceAdapter>
  run: GtmResearchRun
  play: {
    id?: string
    signal?: string | null
    entityUnit?: string | null
    geography?: string | null
    audience?: string | null
    providerQuery?: Record<string, unknown> | null
    recencyWindow?: string | null
  }
  // Canonical Noli Core organization UUID. CRM organizationId remains the
  // tenant/data scope and must never be used for pooled-credit accounting.
  noliOrgId: string
  // Noli Core user UUID. This is deliberately not the Mercato/CRM user UUID:
  // provider settlement writes ai_usage in Noli Core, whose FK is users.id.
  noliUserId: string
  scorer?: FitScorer
  markupMultiplier?: number
  now?: () => Date
}

export type BatchOutcome = {
  batchNo: number
  adapterId: string
  idempotencyKey: string
  operationId: string | null
  // adapter result status, or a skip marker when the adapter was never called
  outcome:
    | 'ok'
    | 'partial'
    | 'no_result'
    | 'error'
    | 'ambiguous'
    | 'skipped_target_accepted'
    | 'skipped_max_raw_candidates'
    | 'skipped_max_candidates'
    | 'skipped_max_credits'
    | 'skipped_source_exhausted'
    | 'skipped_source_unresolved'
    | 'blocked_insufficient_credits'
  ledgerStatus: string | null
  chargedCredits: number
  candidatesInserted: number
  candidateMatchesCreated: number
  candidatesReused: number
  duplicatesSkipped: number
  rawCandidatesFound: number
  accepted: number
  review: number
  rejected: number
  failureReason: string | null
}

export type ResearchFunnel = {
  targetAccepted: number
  maxRawCandidates: number
  rawCandidatesFound: number
  uniqueCandidatesInserted: number
  candidateMatchesCreated: number
  candidatesReused: number
  duplicatesSkipped: number
  evidenceQualified: number
  accepted: number
  review: number
  rejected: number
  acceptanceRate: number
  targetMet: boolean
  stopReason:
    | 'target_accepted'
    | 'max_raw_candidates'
    | 'max_credits'
    | 'unresolved_provider_outcome'
    | 'sources_exhausted'
    | 'failed'
  byReason: Record<string, number>
}

export type ResearchRunExecutionResult = {
  status: 'completed' | 'failed'
  failureReason: string | null
  reconciliationRequired: boolean
  reconciledCredits: number
  candidatesInserted: number
  candidateMatchesCreated: number
  candidatesReused: number
  duplicatesSkipped: number
  evidenceInserted: number
  funnel: ResearchFunnel
  batches: BatchOutcome[]
}

const CANDIDATE_RETENTION_DAYS = 90

// dedupe_key = sha256 of the normalized identity triple
// (entity_kind|name|domain-or-city), SPEC-066 section 4.
export function candidateDedupeKey(candidate: Pick<Candidate, 'entity_kind' | 'identity'>): string {
  const identity = (candidate.identity ?? {}) as Record<string, unknown>
  const name = normalizePart(identity.name)
  const domainOrCity =
    normalizePart(identity.domain) || normalizePart(identity.city) || normalizePart(identity.location)
  const material = `${candidate.entity_kind}|${name}|${domainOrCity}`
  return crypto.createHash('sha256').update(material).digest('hex')
}

function normalizePart(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, ' ') : ''
}

type ParsedProviderPlan = {
  adapterPlan: SourcePlanBatch[]
  query: string
}

function parseProviderPlan(run: GtmResearchRun): ParsedProviderPlan {
  const plan = (run.providerPlan ?? {}) as Record<string, unknown>
  const adapterPlan = Array.isArray(plan.adapterPlan) ? (plan.adapterPlan as SourcePlanBatch[]) : []
  const query = typeof plan.query === 'string' ? plan.query : ''
  return { adapterPlan, query }
}

function parseLimits(run: GtmResearchRun): {
  targetAccepted: number
  maxRawCandidates: number
  maxCredits: number
} {
  const limits = (run.limits ?? {}) as Record<string, unknown>
  const legacyMaxCandidates = Number(limits.maxCandidates)
  const maxRawCandidates = Number(limits.maxRawCandidates ?? limits.maxCandidates)
  const targetAccepted = Number(limits.targetAccepted ?? limits.maxCandidates)
  const maxCredits = Number(limits.maxCredits)
  return {
    targetAccepted: Number.isFinite(targetAccepted) && targetAccepted > 0
      ? Math.floor(targetAccepted)
      : Number.isFinite(legacyMaxCandidates) && legacyMaxCandidates > 0
        ? Math.floor(legacyMaxCandidates)
        : 0,
    maxRawCandidates: Number.isFinite(maxRawCandidates) && maxRawCandidates > 0
      ? Math.floor(maxRawCandidates)
      : 0,
    maxCredits: Number.isFinite(maxCredits) && maxCredits > 0 ? Math.floor(maxCredits) : 0,
  }
}

export async function executeResearchRun(
  deps: ExecuteResearchRunDeps,
): Promise<ResearchRunExecutionResult> {
  const { em, ledger, adapters, run, play, noliOrgId, noliUserId } = deps
  const scorer = deps.scorer ?? ruleBasedFitScorer
  const markup = deps.markupMultiplier ?? defaultMarkupMultiplier()
  const now = deps.now ?? (() => new Date())
  const qualificationReferenceTime = now()

  const { adapterPlan, query } = parseProviderPlan(run)
  const limits = parseLimits(run)

  const batches: BatchOutcome[] = []
  const adapterBatchCounters = new Map<string, number>()
  const exhaustedAdapters = new Set<string>()
  const unresolvedAdapters = new Set<string>()
  let candidatesInserted = 0
  let candidateMatchesCreated = 0
  let candidatesReused = 0
  let duplicatesSkipped = 0
  let evidenceInserted = 0
  let rawCandidatesFound = 0
  let evidenceQualified = 0
  let accepted = 0
  let review = 0
  let rejected = 0
  const fitByReason: Record<string, number> = {}
  let reconciledCredits = 0
  let outstandingReserved = 0
  let reconciliationRequired = false
  let failureReason: string | null = null

  for (const planned of adapterPlan) {
    const batchNo = (adapterBatchCounters.get(planned.adapter_id) ?? 0) + 1
    adapterBatchCounters.set(planned.adapter_id, batchNo)
    const idempotencyKey = `${run.id}:${planned.adapter_id}:${batchNo}`

    const base: BatchOutcome = {
      batchNo,
      adapterId: planned.adapter_id,
      idempotencyKey,
      operationId: null,
      outcome: 'error',
      ledgerStatus: null,
      chargedCredits: 0,
      candidatesInserted: 0,
      candidateMatchesCreated: 0,
      candidatesReused: 0,
      duplicatesSkipped: 0,
      rawCandidatesFound: 0,
      accepted: 0,
      review: 0,
      rejected: 0,
      failureReason: null,
    }

    // Adaptive stop: later source lanes are shortfall refills, not mandatory
    // spend. Once enough qualified leads exist, no more provider is contacted.
    if (limits.targetAccepted > 0 && accepted >= limits.targetAccepted) {
      batches.push({ ...base, outcome: 'skipped_target_accepted' })
      continue
    }
    if (limits.maxRawCandidates > 0 && rawCandidatesFound >= limits.maxRawCandidates) {
      batches.push({ ...base, outcome: 'skipped_max_raw_candidates' })
      continue
    }
    const continuationPage = planned.continuationPage ?? 1
    if (continuationPage > 1 && unresolvedAdapters.has(planned.adapter_id)) {
      batches.push({ ...base, outcome: 'skipped_source_unresolved' })
      continue
    }
    if (continuationPage > 1 && exhaustedAdapters.has(planned.adapter_id)) {
      batches.push({ ...base, outcome: 'skipped_source_exhausted' })
      continue
    }

    const plannedCandidateCap = planned.maxCandidates ?? planned.estimatedUnits
    const remainingCandidates = limits.maxRawCandidates > 0
      ? limits.maxRawCandidates - rawCandidatesFound
      : plannedCandidateCap
    const requestCandidates = Math.min(plannedCandidateCap, remainingCandidates)
    const providerUnits = planned.providerUnits ?? planned.estimatedUnits
    const batchEstimatedCredits = creditsForUnits(
      providerUnits,
      planned.quotedCreditsPerUnit,
      markup,
    )

    // Cap: stop BEFORE a reserve that would exceed maxCredits.
    if (
      limits.maxCredits > 0 &&
      reconciledCredits + outstandingReserved + batchEstimatedCredits > limits.maxCredits
    ) {
      batches.push({ ...base, outcome: 'skipped_max_credits' })
      continue
    }

    const adapter = adapters[planned.adapter_id]
    if (!adapter) {
      const reason = `unknown adapter ${planned.adapter_id}`
      failureReason ??= reason
      batches.push({ ...base, outcome: 'error', failureReason: reason })
      continue
    }

    // 1. Reserve BEFORE any adapter call. Insufficient credits fails the run
    //    closed with zero adapter calls.
    let operationId: string
    try {
      const reserved = await ledger.reserve({
        orgId: noliOrgId,
        userId: noliUserId,
        kind: 'source_search',
        provider: planned.adapter_id,
        estimatedCredits: batchEstimatedCredits,
        idempotencyKey,
        unitCostSnapshot: {
          unit: planned.billableUnit ?? 'candidate',
          provider_units: providerUnits,
          quoted_credits_per_unit: planned.quotedCreditsPerUnit,
          markup_multiplier: markup,
          price_version: planned.priceVersion ?? 'legacy',
          terms_version: planned.termsVersion ?? 'legacy',
        },
        fingerprint: {
          research_run_id: run.id,
          adapter_id: planned.adapter_id,
          batch_no: batchNo,
          signal_kind: planned.capability.signal_kind,
          entity_unit: planned.capability.entity_unit,
          geography: planned.capability.geography,
          query,
          provider_query: planned.providerQuery ?? null,
          continuation_page: continuationPage,
          continuation_offset: planned.continuationOffset ?? null,
          max_candidates: requestCandidates,
          provider_units: providerUnits,
          billable_unit: planned.billableUnit ?? 'candidate',
          descriptor_hash: planned.descriptorHash ?? null,
        },
      })
      operationId = reserved.operationId
      if (reserved.status !== 'reserved') {
        if (reserved.status === 'provider_started' || reserved.status === 'reconciliation_required') {
          reconciliationRequired = true
          unresolvedAdapters.add(planned.adapter_id)
        }
        batches.push({
          ...base,
          operationId,
          outcome: 'ambiguous',
          ledgerStatus: reserved.status,
          failureReason: 'existing provider operation requires reconciliation',
        })
        continue
      }
    } catch (err) {
      if (err instanceof GtmCreditLedgerError && err.code === 'insufficient_credits') {
        failureReason = err.message
        batches.push({ ...base, outcome: 'blocked_insufficient_credits', failureReason: err.message })
        break
      }
      throw err
    }
    outstandingReserved += batchEstimatedCredits

    // 2. Shadow row before provider contact (receipt lands later).
    let shadow = await em.findOne(GtmProviderOperation, {
      noliCoreOperationId: operationId,
      organizationId: run.organizationId,
      tenantId: run.tenantId,
    })
    if (!shadow) {
      try {
        shadow = await em.transactional(async (tem) => {
          const row = tem.create(GtmProviderOperation, {
            organizationId: run.organizationId,
            tenantId: run.tenantId,
            noliCoreOperationId: operationId,
            researchRunId: run.id,
            kind: 'source_search',
            provider: planned.adapter_id,
            localStatusMirror: 'reserved',
            requestedAt: now(),
          })
          tem.persist(row)
          await tem.flush()
          return row
        })
      } catch (err) {
        if (!(err instanceof UniqueConstraintViolationException)) throw err
        shadow = await em.findOne(GtmProviderOperation, {
          noliCoreOperationId: operationId,
          organizationId: run.organizationId,
          tenantId: run.tenantId,
        })
        if (!shadow) throw err
      }
    }

    // 3. Start, then the single provider call.
    const started = await ledger.start(operationId)
    shadow.localStatusMirror = started.status
    await em.transactional(async (tem) => {
      tem.persist(shadow)
      await tem.flush()
    })
    if (!started.startedNow) {
      reconciliationRequired = true
      unresolvedAdapters.add(planned.adapter_id)
      batches.push({
        ...base,
        operationId,
        outcome: 'ambiguous',
        ledgerStatus: started.status,
        failureReason: 'provider start is already owned by another execution',
      })
      continue
    }

    /*
     * The provider spend cap is DERIVED FROM THE RESERVATION we just made, not
     * from an adapter default. The reservation carries our markup and the
     * provider bills raw cost, so the markup is divided back out first
     * (providerSpendCapUsd). Adapters whose provider accepts a hard per-run cap
     * pass this straight through as maxTotalChargeUsd, so the provider itself
     * refuses to bill past what our ledger escrowed. Adapters without such a
     * cap simply ignore the field.
     */
    const maxChargeUsd = providerSpendCapUsd(batchEstimatedCredits, markup)
    const result = await adapter.search({
      signal_kind: planned.capability.signal_kind,
      entity_unit: planned.capability.entity_unit,
      geography: planned.capability.geography,
      query,
      provider_query: planned.providerQuery ?? undefined,
      max_candidates: requestCandidates,
      offset: planned.continuationOffset ?? undefined,
      max_charge_usd: maxChargeUsd,
    })

    // 4. Persist the observed provider outcome BEFORE asking Noli Core to
    // settle it. If the canonical write is unavailable, the operator still
    // has the provider's status/cost/request receipt and the operation is
    // parked without a second provider call.
    const receipt = (result.receipt ?? null) as Record<string, unknown> | null
    const observedAt = now()
    let ledgerStatus = shadow.localStatusMirror ?? 'provider_started'
    let chargedCredits = 0
    let batchFailure: string | null = null
    let settlementPending = false
    let settlementError: string | null = null
    let intendedAction: GtmSettleOutcome | 'mark_ambiguous'

    if (result.status === 'ok' || result.status === 'partial') {
      const actualUnits = result.cost_units ?? (Array.isArray(result.data) ? result.data.length : 0)
      chargedCredits = Math.min(
        creditsForUnits(actualUnits, planned.quotedCreditsPerUnit, markup),
        batchEstimatedCredits,
      )
      intendedAction = result.status === 'partial' ? 'partially_charged' : 'charged'
    } else if (result.status === 'no_result') {
      if (adapter.descriptor.cost_model.pay_on_found) {
        intendedAction = 'refunded'
      } else {
        chargedCredits = Math.min(
          creditsForUnits(result.cost_units ?? 1, planned.quotedCreditsPerUnit, markup),
          batchEstimatedCredits,
        )
        intendedAction = 'charged'
      }
    } else if (result.status === 'ambiguous') {
      intendedAction = 'mark_ambiguous'
    } else {
      intendedAction = 'refunded'
    }

    const observedReceipt = {
      ...(receipt ?? {}),
      gtm_observation: {
        schema_version: 'gtm-provider-outcome-v1',
        observed_at: observedAt.toISOString(),
        adapter_status: result.status,
        intended_ledger_action: intendedAction,
        intended_charged_credits: chargedCredits,
        provider_error: result.error ?? null,
        output_count: Array.isArray(result.data) ? result.data.length : result.data ? 1 : 0,
        settlement_pending: true,
      },
    }
    await em.transactional(async (tem) => {
      shadow.receipt = observedReceipt
      tem.persist(shadow)
      await tem.flush()
    })

    try {
      if (intendedAction === 'mark_ambiguous') {
        // Unknown provider outcome: park the SAME operation, never retry, and
        // never infer a charge locally. The reservation stays escrowed.
        ledgerStatus = await ledger.markAmbiguous(operationId, {
          error: result.error ?? 'ambiguous provider outcome',
          receipt,
        })
        reconciliationRequired = true
        unresolvedAdapters.add(planned.adapter_id)
        batchFailure = result.error ?? 'ambiguous provider outcome'
      } else {
        ledgerStatus = await ledger.settle(
          operationId,
          intendedAction,
          chargedCredits,
          receipt,
        )
        outstandingReserved -= batchEstimatedCredits
        if (intendedAction === 'charged' || intendedAction === 'partially_charged') {
          reconciledCredits += chargedCredits
        }
      }
    } catch (error) {
      settlementPending = true
      reconciliationRequired = true
      unresolvedAdapters.add(planned.adapter_id)
      settlementError = error instanceof Error
        ? `${error.name}: ${error.message}`.slice(0, 500)
        : 'unknown canonical ledger error'
      batchFailure = 'canonical ledger outcome unresolved after provider response'
    }

    if (result.status === 'error' && !settlementPending) {
      exhaustedAdapters.add(planned.adapter_id)
      batchFailure = result.error ?? 'provider error'
    }

    if (result.status === 'no_result') {
      exhaustedAdapters.add(planned.adapter_id)
    } else if (result.status === 'ok' || result.status === 'partial') {
      const returnedRaw = Number(receipt?.returned_people)
      const returnedForContinuation = Number.isFinite(returnedRaw)
        ? Math.max(0, Math.floor(returnedRaw))
        : Array.isArray(result.data)
          ? result.data.length
          : 0
      if (returnedForContinuation < requestCandidates) {
        exhaustedAdapters.add(planned.adapter_id)
      }
    }

    // 5. Mirror canonical truth after the receipt-first write. A failed
    // settlement deliberately leaves local_status_mirror at provider_started;
    // the receipt carries the intended decision for operator reconciliation.
    await em.transactional(async (tem) => {
      shadow.localStatusMirror = ledgerStatus
      shadow.receipt = {
        ...observedReceipt,
        ...(result.status === 'ambiguous'
          ? { ambiguous_at: observedAt.toISOString(), detail: result.error ?? null }
          : {}),
        gtm_observation: {
          ...observedReceipt.gtm_observation,
          settlement_pending: settlementPending,
          canonical_status: ledgerStatus,
          settlement_error: settlementError,
        },
      }
      if (!settlementPending && result.status !== 'ambiguous') shadow.settledAt = now()
      tem.persist(shadow)
      await tem.flush()
    })

    // 6. Candidates + evidence + deterministic qualification.
    let batchInserted = 0
    let batchMatchesCreated = 0
    let batchReused = 0
    let batchDuplicates = 0
    let batchAccepted = 0
    let batchReview = 0
    let batchRejected = 0
    // Do not release provider output while its canonical billing transition is
    // unresolved. The reserved credits remain escrowed and the receipt is
    // available to the operator; a later explicit reconciliation decides it.
    const providerRows = settlementPending
      ? []
      : Array.isArray(result.data) ? result.data : []
    // Adapter-side slicing is not a security boundary. Enforce the generic
    // remaining raw ceiling here even when a provider over-returns.
    const remainingRaw = limits.maxRawCandidates > 0
      ? Math.max(0, limits.maxRawCandidates - rawCandidatesFound)
      : providerRows.length
    const found = providerRows.slice(0, remainingRaw)
    rawCandidatesFound += found.length
    for (const candidate of found) {
      const plannedEntityKind = planned.capability.entity_kind
        ?? (planned.capability.entity_unit.toLowerCase().startsWith('compan') ? 'company' : 'person')
      if (candidate.entity_kind !== plannedEntityKind) {
        batchFailure ??= `provider returned ${candidate.entity_kind} for frozen ${plannedEntityKind} plan`
        failureReason ??= batchFailure
        continue
      }
      const evidenceAssessment = assessEvidence(
        candidate.evidence ?? [],
        adapter.descriptor.evidence_policy,
        now(),
      )
      const fit = scorer.score(candidate, {
        ...play,
        referenceTime: qualificationReferenceTime,
      }, evidenceAssessment.validEvidence)
      const dedupeKey = candidateDedupeKey(candidate)
      const qualification = {
        reason: fit.reason,
        breakdown: fit.breakdown,
        unknowns: fit.unknowns,
        contradictions: fit.contradictions,
        profile: fit.profile ?? null,
        criteria: fit.criteria ?? [],
        evidence_issues: evidenceAssessment.issues,
      }

      const persistMatch = async (
        row: GtmCandidate,
        insertCandidate: boolean,
      ): Promise<{ matchCreated: boolean; candidateInserted: boolean; evidenceRows: number }> =>
        em.transactional(async (tem) => {
          const priorMatch = await tem.findOne(GtmCandidateMatch, {
            organizationId: run.organizationId,
            tenantId: run.tenantId,
            researchRunId: run.id,
            candidateId: row.id,
            deletedAt: null,
          })
          if (priorMatch) {
            return { matchCreated: false, candidateInserted: false, evidenceRows: 0 }
          }
          if (insertCandidate) tem.persist(row)
          const match = tem.create(GtmCandidateMatch, {
            organizationId: run.organizationId,
            tenantId: run.tenantId,
            workspaceId: run.workspaceId,
            playId: run.playId,
            researchRunId: run.id,
            candidateId: row.id,
            providerOperationId: shadow.id,
            fitStatus: fit.verdict,
            fitScore: String(fit.fitScore),
            rejectReason: fit.verdict === 'accepted' ? null : fit.reason,
            qualityStatus: evidenceAssessment.status,
            qualityScore: String(evidenceAssessment.score),
            qualification,
            qualificationVersion: fit.version,
          })
          tem.persist(match)
          let evidenceRows = 0
          for (const assessed of evidenceAssessment.rows) {
            const evidence = assessed.evidence
            const evidenceRow = tem.create(GtmEvidence, {
              organizationId: run.organizationId,
              tenantId: run.tenantId,
              candidateId: row.id,
              researchRunId: run.id,
              claim: evidence.claim,
              sourceUrl: evidence.source_url ?? null,
              providerRef: {
                provider: planned.adapter_id,
                operation_id: operationId,
                provider_request_id: receipt?.provider_request_id ?? null,
                query,
                ...(evidence.detail ? { detail: evidence.detail } : {}),
              },
              observedAt: evidence.observed_at ? new Date(evidence.observed_at) : null,
              retrievedAt: now(),
              confidence: String(evidence.confidence),
              license: adapter.descriptor.constraints.license,
              qualityStatus: assessed.status,
              qualityIssues: assessed.issues,
              evidenceType: 'provider_observation',
            })
            tem.persist(evidenceRow)
            evidenceRows += 1
          }
          await tem.flush()
          return { matchCreated: true, candidateInserted: insertCandidate, evidenceRows }
        })

      try {
        let existing = await em.findOne(GtmCandidate, {
          organizationId: run.organizationId,
          tenantId: run.tenantId,
          workspaceId: run.workspaceId,
          dedupeKey,
          deletedAt: null,
        })
        let persisted: { matchCreated: boolean; candidateInserted: boolean; evidenceRows: number }
        if (existing) {
          persisted = await persistMatch(existing, false)
        } else {
          const row = em.create(GtmCandidate, {
            // app-side id so evidence rows can reference the candidate before
            // the transaction flushes (the column default is DB-generated)
            id: crypto.randomUUID(),
            organizationId: run.organizationId,
            tenantId: run.tenantId,
            researchRunId: run.id,
            workspaceId: run.workspaceId,
            entityKind: candidate.entity_kind,
            identity: candidate.identity as Record<string, unknown>,
            dedupeKey,
            fitStatus: fit.verdict,
            fitScore: String(fit.fitScore),
            rejectReason: fit.verdict === 'accepted' ? null : fit.reason,
            qualityStatus: evidenceAssessment.status,
            qualityScore: String(evidenceAssessment.score),
            qualification,
            qualificationVersion: fit.version,
            retentionExpiresAt: new Date(
              now().getTime() + CANDIDATE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
            ),
          })
          try {
            persisted = await persistMatch(row, true)
          } catch (err) {
            if (!(err instanceof UniqueConstraintViolationException)) throw err
            // Another transaction won the workspace identity race. Reuse its
            // row, but still preserve this run's independent qualification.
            existing = await em.findOne(GtmCandidate, {
              organizationId: run.organizationId,
              tenantId: run.tenantId,
              workspaceId: run.workspaceId,
              dedupeKey,
              deletedAt: null,
            })
            if (!existing) throw err
            persisted = await persistMatch(existing, false)
          }
        }
        if (!persisted.matchCreated) {
          batchDuplicates += 1
          duplicatesSkipped += 1
          continue
        }
        batchMatchesCreated += 1
        candidateMatchesCreated += 1
        if (persisted.candidateInserted) {
          batchInserted += 1
          candidatesInserted += 1
        } else {
          batchReused += 1
          candidatesReused += 1
        }
        evidenceInserted += persisted.evidenceRows
        if (evidenceAssessment.validEvidence.length > 0) evidenceQualified += 1
        if (fit.verdict === 'accepted') {
          accepted += 1
          batchAccepted += 1
        } else if (fit.verdict === 'review') {
          review += 1
          batchReview += 1
        } else {
          rejected += 1
          batchRejected += 1
        }
        fitByReason[fit.reason] = (fitByReason[fit.reason] ?? 0) + 1
      } catch (err) {
        // Race-safe dedupe: a concurrent (or same-run) duplicate loses the
        // unique (org, workspace, dedupe_key) race and is counted, not fatal.
        if (err instanceof UniqueConstraintViolationException) {
          batchDuplicates += 1
          duplicatesSkipped += 1
          continue
        }
        throw err
      }
    }

    batches.push({
      ...base,
      operationId,
      outcome: settlementPending ? 'ambiguous' : result.status,
      ledgerStatus,
      chargedCredits,
      candidatesInserted: batchInserted,
      candidateMatchesCreated: batchMatchesCreated,
      candidatesReused: batchReused,
      duplicatesSkipped: batchDuplicates,
      rawCandidatesFound: found.length,
      accepted: batchAccepted,
      review: batchReview,
      rejected: batchRejected,
      failureReason: batchFailure,
    })
  }

  // A definitive provider/application error may fall through to a later source,
  // but a run where every contacted source errored is not a successful
  // "sources exhausted" run. Preserve the refunded ledger outcome while
  // surfacing the execution failure honestly to the operator.
  const hasUsableProviderOutcome = batches.some((batch) =>
    batch.outcome === 'ok' || batch.outcome === 'partial' || batch.outcome === 'no_result')
  if (!failureReason && !hasUsableProviderOutcome) {
    failureReason = batches.find((batch) => batch.outcome === 'error')?.failureReason ?? null
  }
  const status: 'completed' | 'failed' = failureReason ? 'failed' : 'completed'
  const targetMet = limits.targetAccepted > 0 && accepted >= limits.targetAccepted
  const skippedForCredits = batches.some((batch) => batch.outcome === 'skipped_max_credits')
  const stopReason: ResearchFunnel['stopReason'] = failureReason
    ? 'failed'
    : reconciliationRequired
      ? 'unresolved_provider_outcome'
      : targetMet
      ? 'target_accepted'
      : limits.maxRawCandidates > 0 && rawCandidatesFound >= limits.maxRawCandidates
        ? 'max_raw_candidates'
        : skippedForCredits
          ? 'max_credits'
          : 'sources_exhausted'
  const funnel: ResearchFunnel = {
    targetAccepted: limits.targetAccepted,
    maxRawCandidates: limits.maxRawCandidates,
    rawCandidatesFound,
    uniqueCandidatesInserted: candidatesInserted,
    candidateMatchesCreated,
    candidatesReused,
    duplicatesSkipped,
    evidenceQualified,
    accepted,
    review,
    rejected,
    acceptanceRate: candidateMatchesCreated > 0 ? accepted / candidateMatchesCreated : 0,
    targetMet,
    stopReason,
    byReason: fitByReason,
  }
  const summary: ResearchRunExecutionResult = {
    status,
    failureReason,
    reconciliationRequired,
    reconciledCredits,
    candidatesInserted,
    candidateMatchesCreated,
    candidatesReused,
    duplicatesSkipped,
    evidenceInserted,
    funnel,
    batches,
  }

  // 7. Finalize the run row: status, reconciled credits, and the execution
  //    summary folded into the provider_plan jsonb (reconciliation_required
  //    and failure_reason live here; the entity has no dedicated columns and
  //    Tranche 3 adds no schema).
  await em.transactional(async (tem) => {
    run.status = status
    run.reconciledCredits = String(reconciledCredits)
    run.completedAt = now()
    run.providerPlan = {
      ...((run.providerPlan ?? {}) as Record<string, unknown>),
      execution: {
        status,
        failure_reason: failureReason,
        reconciliation_required: reconciliationRequired,
        reconciled_credits: reconciledCredits,
        candidates_inserted: candidatesInserted,
        candidate_matches_created: candidateMatchesCreated,
        candidates_reused: candidatesReused,
        duplicates_skipped: duplicatesSkipped,
        evidence_inserted: evidenceInserted,
        funnel: {
          target_accepted: funnel.targetAccepted,
          max_raw_candidates: funnel.maxRawCandidates,
          raw_candidates_found: funnel.rawCandidatesFound,
          unique_candidates_inserted: funnel.uniqueCandidatesInserted,
          candidate_matches_created: funnel.candidateMatchesCreated,
          candidates_reused: funnel.candidatesReused,
          duplicates_skipped: funnel.duplicatesSkipped,
          evidence_qualified: funnel.evidenceQualified,
          accepted: funnel.accepted,
          review: funnel.review,
          rejected: funnel.rejected,
          acceptance_rate: funnel.acceptanceRate,
          target_met: funnel.targetMet,
          stop_reason: funnel.stopReason,
          by_reason: funnel.byReason,
        },
        batches: batches.map((batch) => ({
          batch_no: batch.batchNo,
          adapter_id: batch.adapterId,
          idempotency_key: batch.idempotencyKey,
          operation_id: batch.operationId,
          outcome: batch.outcome,
          ledger_status: batch.ledgerStatus,
          charged_credits: batch.chargedCredits,
          candidates_inserted: batch.candidatesInserted,
          candidate_matches_created: batch.candidateMatchesCreated,
          candidates_reused: batch.candidatesReused,
          duplicates_skipped: batch.duplicatesSkipped,
          raw_candidates_found: batch.rawCandidatesFound,
          accepted: batch.accepted,
          review: batch.review,
          rejected: batch.rejected,
          failure_reason: batch.failureReason,
        })),
      },
    }
    tem.persist(run)
    await tem.flush()
  })

  return summary
}
