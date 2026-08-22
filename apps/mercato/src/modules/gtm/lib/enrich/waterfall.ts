import crypto from 'crypto'
import {
  capabilityCovers,
  type AdapterDescriptor,
  type AdapterResult,
  type CandidateIdentity,
  type EnrichAdapter,
  type VerificationState,
  type VerifyAdapter,
} from '../adapters/types'
import { UniqueConstraintViolationException } from '@mikro-orm/core'
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
import { descriptorHash } from '../research/plan'
import type { ResearchEm } from '../research/execute'
import { GtmCandidate, GtmContactPoint, GtmProviderOperation } from '../../data/entities'

/*
 * Enrichment + verification waterfall (SPEC-066 sections 4, 11.2, 14 Tranche 4).
 *
 * Scope rule (spec 4.1 step 6): enrichment runs ONLY over candidates that
 * survived qualification - fit_status 'accepted'. Rejected and unscored
 * candidates are never touched, never enriched, never spend a credit.
 *
 * Per accepted candidate lacking a VERIFIED email contact point:
 *
 *   enrich phase (only when the candidate has no email contact point yet):
 *     adapters run in registry order through the SAME 11.2 credit-coupled
 *     wrapper research uses: reserve -> shadow row -> start -> provider call
 *     -> settle | markAmbiguous. Idempotency key `enrich:{candidateId}:{adapter_id}`.
 *     pay_on_found: a definitive no_result settles 'refunded' 0 when the
 *     descriptor's cost model is pay_on_found, else 'charged'. Found points
 *     are written as gtm_contact_points rows (channel 'email', state 'found',
 *     provider_operation_id = the SHADOW row id, provenance jsonb). The first
 *     adapter that yields points ends the enrich waterfall for the candidate.
 *     An ambiguous outcome parks the operation (never auto-retried) and stops
 *     this candidate for the run.
 *
 *   verify phase (over email points in state 'found'):
 *     adapters run in registry order, idempotency key
 *     `verify:{contactPointId}:{adapter_id}`, mapping outcomes onto
 *     verified | risky | catch_all | not_found | unknown | provider_ambiguous.
 *     provider_ambiguous points are PARKED: they are skipped on every later
 *     run and never auto-retried (reconciliation resolves the SAME parked
 *     noli-core operation). A definitive outcome ends the verify waterfall
 *     for that point; 'verified' ends the whole candidate ("stop at first
 *     verified point").
 *
 * Stop conditions:
 * - per-run maxCredits budget is enforced BEFORE each reserve (charged plus
 *   outstanding reservations plus the next estimate must fit);
 * - insufficient_credits from the ledger fails the run closed with zero
 *   further adapter calls;
 * - a candidate stops its waterfall at its first verified point.
 *
 * Idempotency on re-run: already-verified candidates are skipped before any
 * reserve; a reserve that returns an operation already past 'reserved'
 * (settled or parked by an earlier run) skips the adapter call entirely -
 * the same idempotency keys make re-running a run/workspace safe.
 */

export type EnrichWaterfallDeps = {
  em: ResearchEm
  ledger: GtmCreditLedger
  // registry order = waterfall order
  enrichAdapters: EnrichAdapter[]
  verifyAdapters: VerifyAdapter[]
  // any fit status; the waterfall itself filters to accepted candidates
  candidates: GtmCandidate[]
  // existing contact points for those candidates (skip-if-verified, parked skip)
  contactPoints: GtmContactPoint[]
  // Canonical Noli Core organization UUID for pooled-credit accounting.
  noliOrgId: string
  // Noli Core user UUID used by the canonical provider ledger. The CRM user
  // UUID remains the actor identity for CRM authorization/audit only.
  noliUserId: string
  runId?: string | null
  // 0/undefined = unbounded by the caller (the ledger still bounds spend)
  maxCredits?: number | null
  markupMultiplier?: number
  now?: () => Date
}

export type EnrichWaterfallStop = 'completed' | 'budget_exhausted' | 'insufficient_credits'

export type EnrichWaterfallSummary = {
  // contact points written by the enrich phase this run
  enriched: number
  // points that reached each terminal verification state this run
  verified: number
  risky: number
  catch_all: number
  not_found: number
  unknown: number
  // parked outcomes this run (enrich or verify operations marked ambiguous)
  ambiguous: number
  // credits actually charged this run
  credits: number
  stopped: EnrichWaterfallStop
  candidatesConsidered: number
  candidatesSkippedVerified: number
}

const GEOGRAPHY = 'US'
const ENRICH_SIGNAL = 'contact_discovery'
const VERIFY_SIGNAL = 'email_verification'
const VERIFY_ENTITY_UNIT = 'contacts'
const TERMINAL_VERIFICATION_STATES = new Set<VerificationState>([
  'verified',
  'risky',
  'catch_all',
  'not_found',
  'unknown',
  'provider_ambiguous',
])

type ReusableVerification = {
  state: VerificationState
  sourcePointId: string
  verification: Record<string, unknown>
}

function normalizedAddress(point: GtmContactPoint): string | null {
  const normalized = point.value.trim().toLowerCase()
  return normalized || null
}

function verificationProvenance(point: GtmContactPoint): Record<string, unknown> {
  const provenance = point.provenance
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) return {}
  const verification = (provenance as Record<string, unknown>).verification
  return verification && typeof verification === 'object' && !Array.isArray(verification)
    ? (verification as Record<string, unknown>)
    : {}
}

function entityUnitFor(candidate: GtmCandidate): string {
  return candidate.entityKind === 'company' ? 'companies' : 'people'
}

function customerUseAllowed(descriptor: AdapterDescriptor): boolean {
  const license = descriptor.constraints.license
  return (
    (license.status === 'approved' || license.status === 'test_only') &&
    Boolean(license.terms_version) &&
    license.export &&
    license.customer_display &&
    license.outreach_allowed
  )
}

type Budget = {
  maxCredits: number
  charged: number
  outstanding: number
}

function fitsBudget(budget: Budget, estimate: number): boolean {
  if (budget.maxCredits <= 0) return true
  return budget.charged + budget.outstanding + estimate <= budget.maxCredits
}

type WrappedInvoke<T> =
  | { kind: 'budget_exhausted' }
  | { kind: 'insufficient_credits'; message: string }
  // an earlier run already owns/settled/parked this exact operation - no call made
  | { kind: 'already_settled'; ledgerStatus: string }
  | {
      kind: 'invoked'
      result: AdapterResult<T>
      operationId: string
      shadowId: string
      ledgerStatus: string
      chargedCredits: number
    }

/*
 * The single SPEC-066 section 11.2 wrapper both phases share:
 * budget check -> reserve -> shadow row -> start -> provider call ->
 * settle | markAmbiguous -> shadow mirror. Exactly one ledger settlement
 * path per invocation; an ambiguous outcome parks the SAME operation.
 */
async function invokeWithLedger<T>(
  deps: {
    em: ResearchEm
    ledger: GtmCreditLedger
    budget: Budget
    descriptor: AdapterDescriptor
    kind: 'enrich' | 'verify'
    idempotencyKey: string
    // CRM scope for the local shadow.
    orgId: string
    // Noli Core scope for the canonical ledger.
    noliOrgId: string
    tenantId: string
    noliUserId: string
    runId: string | null
    candidateId: string
    fingerprint: Record<string, unknown>
    markup: number
    now: () => Date
    /*
     * Receives the per-call PROVIDER spend cap in USD, derived from the
     * reservation this wrapper just made (see providerSpendCapUsd below).
     * Adapters that can pass a hard cap to their provider forward it; the rest
     * ignore the argument.
     */
    call: (maxChargeUsd: number) => Promise<AdapterResult<T>>
  },
): Promise<WrappedInvoke<T>> {
  const { em, ledger, budget, descriptor, markup, now } = deps
  const quoted = descriptor.cost_model.quoted_credits_per_unit
  const estimate = creditsForUnits(1, quoted, markup)

  // Budget stop BEFORE the reserve (never after spend is committed).
  if (!fitsBudget(budget, estimate)) return { kind: 'budget_exhausted' }

  let operationId: string
  let reservedStatus: string
  try {
    const reserved = await ledger.reserve({
      orgId: deps.noliOrgId,
      userId: deps.noliUserId,
      kind: deps.kind === 'enrich' ? 'contact_enrich' : 'contact_verify',
      provider: descriptor.adapter_id,
      estimatedCredits: estimate,
      idempotencyKey: deps.idempotencyKey,
      unitCostSnapshot: {
        unit: descriptor.cost_model.unit,
        quoted_credits_per_unit: quoted,
        markup_multiplier: markup,
        pay_on_found: descriptor.cost_model.pay_on_found,
        price_version: descriptor.cost_model.price_version,
        terms_version: descriptor.constraints.license.terms_version,
        descriptor_hash: descriptorHash(descriptor),
      },
      fingerprint: deps.fingerprint,
    })
    operationId = reserved.operationId
    reservedStatus = reserved.status
  } catch (err) {
    if (err instanceof GtmCreditLedgerError && err.code === 'insufficient_credits') {
      return { kind: 'insufficient_credits', message: err.message }
    }
    // FAIL CLOSED: any other reserve failure (transport, unknown) propagates;
    // the adapter is never called without a confirmed reservation.
    throw err
  }

  // Idempotent re-run: the same (org, key) returned an operation an earlier
  // run already moved past 'reserved'. Nothing new was reserved; calling the
  // provider again would risk double spend, so skip the invocation.
  if (reservedStatus !== 'reserved') {
    return { kind: 'already_settled', ledgerStatus: reservedStatus }
  }
  budget.outstanding += estimate

  // Shadow row BEFORE provider contact (correlation only, never a balance).
  let shadow = await em.findOne(GtmProviderOperation, {
    noliCoreOperationId: operationId,
    organizationId: deps.orgId,
    tenantId: deps.tenantId,
  })
  if (!shadow) {
    try {
      shadow = await em.transactional(async (tem) => {
        const row = tem.create(GtmProviderOperation, {
          id: crypto.randomUUID(),
          organizationId: deps.orgId,
          tenantId: deps.tenantId,
          noliCoreOperationId: operationId,
          researchRunId: deps.runId,
          candidateId: deps.candidateId,
          kind: deps.kind === 'enrich' ? 'contact_enrich' : 'contact_verify',
          provider: descriptor.adapter_id,
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
        organizationId: deps.orgId,
        tenantId: deps.tenantId,
      })
      if (!shadow) throw err
    }
  }

  const started = await ledger.start(operationId)
  shadow.localStatusMirror = started.status
  await em.transactional(async (tem) => {
    tem.persist(shadow as GtmProviderOperation)
    await tem.flush()
  })
  if (!started.startedNow) {
    return { kind: 'already_settled', ledgerStatus: started.status }
  }

  /*
   * Belt and braces on the money path: the provider's own hard spend cap is
   * computed from THIS reservation, with our markup divided back out (the
   * customer's reserved credits include markup; the provider bills raw cost).
   * Our ledger escrows the credits, the provider refuses to bill past the
   * dollars, and neither number is an adapter-side default.
   */
  const result = await deps.call(providerSpendCapUsd(estimate, markup))

  const receipt = (result.receipt ?? null) as Record<string, unknown> | null
  const observedAt = now()
  let ledgerStatus = shadow.localStatusMirror ?? 'provider_started'
  let chargedCredits = 0
  let settlementPending = false
  let settlementError: string | null = null
  let intendedAction: GtmSettleOutcome | 'mark_ambiguous'

  if (result.status === 'ok' || result.status === 'partial') {
    const actualUnits =
      result.cost_units ?? (Array.isArray(result.data) ? result.data.length : result.data ? 1 : 0)
    chargedCredits = Math.min(creditsForUnits(actualUnits, quoted, markup), estimate)
    intendedAction = result.status === 'partial' ? 'partially_charged' : 'charged'
  } else if (result.status === 'no_result') {
    // pay_on_found semantics: nothing found costs nothing; otherwise the
    // lookup itself is billable.
    if (descriptor.cost_model.pay_on_found) {
      intendedAction = 'refunded'
    } else {
      chargedCredits = Math.min(creditsForUnits(result.cost_units ?? 1, quoted, markup), estimate)
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
      // Park the SAME operation; the reservation stays escrowed (outstanding)
      // until a delayed settle or operator reconciliation lands on it.
      ledgerStatus = await ledger.markAmbiguous(operationId, {
        error: result.error ?? 'ambiguous provider outcome',
        receipt,
      })
    } else {
      ledgerStatus = await ledger.settle(operationId, intendedAction, chargedCredits, receipt)
      budget.outstanding -= estimate
      if (intendedAction === 'charged' || intendedAction === 'partially_charged') {
        budget.charged += chargedCredits
      }
    }
  } catch (error) {
    settlementPending = true
    settlementError = error instanceof Error
      ? `${error.name}: ${error.message}`.slice(0, 500)
      : 'unknown canonical ledger error'
  }

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

  return {
    kind: 'invoked',
    result: settlementPending
      ? {
          status: 'ambiguous',
          data: null,
          cost_units: null,
          receipt,
          error: 'canonical ledger outcome unresolved after provider response',
        }
      : result,
    operationId,
    shadowId: shadow.id,
    ledgerStatus,
    chargedCredits: settlementPending ? 0 : chargedCredits,
  }
}

export async function runEnrichmentWaterfall(
  deps: EnrichWaterfallDeps,
): Promise<EnrichWaterfallSummary> {
  const { em, ledger, noliOrgId, noliUserId } = deps
  const markup = deps.markupMultiplier ?? defaultMarkupMultiplier()
  const now = deps.now ?? (() => new Date())
  const runId = deps.runId ?? null

  const maxCredits =
    deps.maxCredits != null && Number.isFinite(deps.maxCredits) && deps.maxCredits > 0
      ? Math.floor(deps.maxCredits)
      : 0
  const budget: Budget = { maxCredits, charged: 0, outstanding: 0 }

  const summary: EnrichWaterfallSummary = {
    enriched: 0,
    verified: 0,
    risky: 0,
    catch_all: 0,
    not_found: 0,
    unknown: 0,
    ambiguous: 0,
    credits: 0,
    stopped: 'completed',
    candidatesConsidered: 0,
    candidatesSkippedVerified: 0,
  }

  // Live per-candidate index over the caller-provided contact points plus
  // any points this run writes.
  const pointsByCandidate = new Map<string, GtmContactPoint[]>()
  for (const point of deps.contactPoints) {
    if (point.deletedAt) continue
    const list = pointsByCandidate.get(point.candidateId) ?? []
    list.push(point)
    pointsByCandidate.set(point.candidateId, list)
  }

  // Reuse only an unambiguous terminal state for the exact normalized address
  // inside the tenant. A conflicting historical state deliberately disables
  // reuse so it cannot silently overwrite evidence that needs reconciliation.
  const verificationByAddress = new Map<string, ReusableVerification | null>()
  const freshVerificationByAddress = new Map<string, ReusableVerification>()
  const addressKey = (point: GtmContactPoint): string | null => {
    const address = normalizedAddress(point)
    return address ? `${point.organizationId}:${point.tenantId}:${address}` : null
  }
  const reusableFromPoint = (
    point: GtmContactPoint,
    state: VerificationState,
  ): ReusableVerification => ({
    state,
    sourcePointId: point.id,
    verification: verificationProvenance(point),
  })
  const rememberVerification = (point: GtmContactPoint, state: VerificationState) => {
    const key = addressKey(point)
    if (!key) return
    const prior = verificationByAddress.get(key)
    if (prior === null) return
    if (prior && prior.state !== state) {
      verificationByAddress.set(key, null)
      return
    }
    if (!prior) {
      verificationByAddress.set(key, reusableFromPoint(point, state))
    }
  }
  const rememberFreshVerification = (point: GtmContactPoint, state: VerificationState) => {
    const key = addressKey(point)
    if (key) freshVerificationByAddress.set(key, reusableFromPoint(point, state))
  }
  for (const point of deps.contactPoints) {
    if (point.deletedAt || point.channel !== 'email') continue
    const state = point.verificationState as VerificationState
    if (TERMINAL_VERIFICATION_STATES.has(state)) rememberVerification(point, state)
  }

  // Spec 4.1 step 6: enrichment runs over ACCEPTED candidates only.
  const accepted = deps.candidates.filter(
    (candidate) => candidate.fitStatus === 'accepted' && !candidate.deletedAt,
  )

  candidateLoop: for (const candidate of accepted) {
    const emailPoints = () =>
      (pointsByCandidate.get(candidate.id) ?? []).filter((point) => point.channel === 'email')

    // Skip-if-verified: an already-verified candidate spends nothing.
    if (emailPoints().some((point) => point.verificationState === 'verified')) {
      summary.candidatesSkippedVerified += 1
      continue
    }
    summary.candidatesConsidered += 1

    // -----------------------------------------------------------------
    // Enrich phase: only when the candidate has no email contact point.
    // -----------------------------------------------------------------
    if (emailPoints().length === 0) {
      for (const adapter of deps.enrichAdapters) {
        const descriptor = adapter.descriptor
        if (!customerUseAllowed(descriptor)) continue
        const request = {
          signal_kind: ENRICH_SIGNAL,
          entity_unit: entityUnitFor(candidate),
          geography: GEOGRAPHY,
          channel: 'email' as const,
          candidate: {
            entity_kind: candidate.entityKind as 'person' | 'company',
            identity: candidate.identity as unknown as CandidateIdentity,
          },
        }
        // Fail closed before spend: an uncovered dimension never reserves.
        if (!capabilityCovers(descriptor, request).covered) continue

        const invoked = await invokeWithLedger(
          {
            em,
            ledger,
            budget,
            descriptor,
            kind: 'enrich',
            idempotencyKey: `enrich:${candidate.id}:${descriptor.adapter_id}`,
            orgId: candidate.organizationId,
            noliOrgId,
            tenantId: candidate.tenantId,
            noliUserId,
            runId,
            candidateId: candidate.id,
            fingerprint: {
              candidate_id: candidate.id,
              adapter_id: descriptor.adapter_id,
              channel: 'email',
              entity_kind: candidate.entityKind,
            },
            markup,
            now,
            // the reserved-credits-derived cap travels with the request
            call: (maxChargeUsd) => adapter.enrich({ ...request, max_charge_usd: maxChargeUsd }),
          },
        )

        if (invoked.kind === 'budget_exhausted') {
          summary.stopped = 'budget_exhausted'
          break candidateLoop
        }
        if (invoked.kind === 'insufficient_credits') {
          summary.stopped = 'insufficient_credits'
          break candidateLoop
        }
        // Earlier run already consumed this operation and any points it found
        // are already in the index; try the next adapter in the waterfall.
        if (invoked.kind === 'already_settled') {
          if (
            invoked.ledgerStatus === 'provider_started' ||
            invoked.ledgerStatus === 'reconciliation_required'
          ) {
            summary.ambiguous += 1
            continue candidateLoop
          }
          continue
        }

        const { result } = invoked
        if (result.status === 'ambiguous') {
          // Parked, never auto-retried: stop this candidate for the run.
          summary.ambiguous += 1
          continue candidateLoop
        }
        if (result.status === 'ok' || result.status === 'partial') {
          const found = (Array.isArray(result.data) ? result.data : []).filter(
            (point) => point.channel === 'email',
          )
          if (found.length > 0) {
            await em.transactional(async (tem) => {
              for (const point of found) {
                const row = tem.create(GtmContactPoint, {
                  id: crypto.randomUUID(),
                  organizationId: candidate.organizationId,
                  tenantId: candidate.tenantId,
                  candidateId: candidate.id,
                  channel: 'email',
                  value: point.value,
                  verificationState: 'found',
                  // shadow row id (gtm_provider_operations.id), per section 4
                  providerOperationId: invoked.shadowId,
                  provenance: {
                    ...(point.provenance ?? {}),
                    adapter_id: descriptor.adapter_id,
                    noli_core_operation_id: invoked.operationId,
                    provider_request_id:
                      (result.receipt as Record<string, unknown> | null)?.provider_request_id ??
                      null,
                  },
                })
                tem.persist(row)
                const list = pointsByCandidate.get(candidate.id) ?? []
                list.push(row)
                pointsByCandidate.set(candidate.id, list)
              }
              await tem.flush()
            })
            summary.enriched += found.length
            break // first adapter that yields points ends the enrich waterfall
          }
        }
        // no_result / error / empty ok: fall through to the next adapter.
      }
    }

    // -----------------------------------------------------------------
    // Verify phase: found-but-unverified email points, registry order.
    // provider_ambiguous points are parked and never auto-retried.
    // -----------------------------------------------------------------
    for (const point of emailPoints()) {
      if (point.verificationState !== 'found') continue

      const key = addressKey(point)
      const reusable = key
        ? freshVerificationByAddress.get(key) ?? verificationByAddress.get(key)
        : undefined
      if (reusable) {
        await em.transactional(async (tem) => {
          point.verificationState = reusable.state
          if (reusable.state === 'verified') point.verifiedAt = now()
          point.provenance = {
            ...(point.provenance ?? {}),
            verification: {
              ...reusable.verification,
              state: reusable.state,
              deduplicated: true,
              reused_from_contact_point_id: reusable.sourcePointId,
            },
          }
          tem.persist(point)
          await tem.flush()
        })
        if (reusable.state === 'verified') summary.verified += 1
        else if (reusable.state === 'risky') summary.risky += 1
        else if (reusable.state === 'catch_all') summary.catch_all += 1
        else if (reusable.state === 'not_found') summary.not_found += 1
        else if (reusable.state === 'unknown') summary.unknown += 1
        else if (reusable.state === 'provider_ambiguous') summary.ambiguous += 1
        if (reusable.state === 'verified') continue candidateLoop
        continue
      }

      for (const adapter of deps.verifyAdapters) {
        const descriptor = adapter.descriptor
        if (!customerUseAllowed(descriptor)) continue
        const request = {
          signal_kind: VERIFY_SIGNAL,
          entity_unit: VERIFY_ENTITY_UNIT,
          geography: GEOGRAPHY,
          channel: 'email' as const,
          value: point.value,
        }
        if (!capabilityCovers(descriptor, request).covered) continue

        const invoked = await invokeWithLedger(
          {
            em,
            ledger,
            budget,
            descriptor,
            kind: 'verify',
            idempotencyKey: `verify:${point.id}:${descriptor.adapter_id}`,
            orgId: point.organizationId,
            noliOrgId,
            tenantId: point.tenantId,
            noliUserId,
            runId,
            candidateId: candidate.id,
            fingerprint: {
              contact_point_id: point.id,
              adapter_id: descriptor.adapter_id,
              channel: 'email',
            },
            markup,
            now,
            // no verify adapter accepts a provider-side USD cap yet; the
            // wrapper still computes one so adding a paid verifier is a
            // one-line change rather than a metering gap.
            call: () => adapter.verify(request),
          },
        )

        if (invoked.kind === 'budget_exhausted') {
          summary.stopped = 'budget_exhausted'
          break candidateLoop
        }
        if (invoked.kind === 'insufficient_credits') {
          summary.stopped = 'insufficient_credits'
          break candidateLoop
        }
        if (invoked.kind === 'already_settled') {
          if (
            invoked.ledgerStatus === 'provider_started' ||
            invoked.ledgerStatus === 'reconciliation_required'
          ) {
            await em.transactional(async (tem) => {
              point.verificationState = 'provider_ambiguous'
              point.provenance = {
                ...(point.provenance ?? {}),
                verification: {
                  ...verificationProvenance(point),
                  parked: true,
                  canonical_status: invoked.ledgerStatus,
                },
              }
              tem.persist(point)
              await tem.flush()
            })
            summary.ambiguous += 1
            continue candidateLoop
          }
          continue
        }

        const { result } = invoked
        let state: VerificationState | null = null
        if (result.status === 'ambiguous') {
          state = 'provider_ambiguous'
        } else if (result.status === 'no_result') {
          state = 'not_found'
        } else if ((result.status === 'ok' || result.status === 'partial') && result.data) {
          state = result.data.verification_state
        }
        // definitive provider error: leave the point 'found', try the next
        // verify adapter in the waterfall
        if (state === null || state === 'found') continue

        await em.transactional(async (tem) => {
          point.verificationState = state as string
          if (state === 'verified') point.verifiedAt = now()
          point.provenance = {
            ...(point.provenance ?? {}),
            verification: {
              adapter_id: descriptor.adapter_id,
              noli_core_operation_id: invoked.operationId,
              provider_operation_shadow_id: invoked.shadowId,
              state,
              parked: state === 'provider_ambiguous',
            },
          }
          tem.persist(point)
          await tem.flush()
        })
        // A fresh result is authoritative for the remaining duplicate rows in
        // this run even when conflicting historical rows disabled old-result
        // reuse. The old conflict remains intact for operator review.
        rememberFreshVerification(point, state)

        if (state === 'verified') summary.verified += 1
        else if (state === 'risky') summary.risky += 1
        else if (state === 'catch_all') summary.catch_all += 1
        else if (state === 'not_found') summary.not_found += 1
        else if (state === 'unknown') summary.unknown += 1
        else if (state === 'provider_ambiguous') summary.ambiguous += 1

        if (state === 'verified') continue candidateLoop // stop at first verified point
        break // definitive (or parked) outcome ends this point's verify waterfall
      }
    }
  }

  summary.credits = budget.charged
  return summary
}
