import crypto from 'crypto'
import {
  capabilityCovers,
  type AdapterDescriptor,
  type AdapterResult,
  type CandidateIdentity,
  type ContactPoint,
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
import type { GtmReserveResultWithEcho } from '../credits/noli-core-ledger'
import {
  creditsForUnits,
  defaultMarkupMultiplier,
  providerSpendCapUsd,
} from '../credits/markup'
import { descriptorHash } from '../research/plan'
import type { ResearchEm } from '../research/execute'
import { GtmCandidate, GtmContactPoint, GtmProviderOperation } from '../../data/entities'
import { lookupIdentityForEnrichment } from './company-domain'
import {
  enrichmentOperationDisposition,
  enrichmentRequestFingerprint,
  indexEnrichmentOperations,
  type EnrichmentOperationProjection,
} from './plan'

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
 *     -> retain data in the shadow receipt -> settle | markAmbiguous.
 *     Idempotency key `enrich:{candidateId}:{adapter_id}:{request fingerprint}`
 *     where the fingerprint is the adapter's own or, failing that, the
 *     candidate's company domain (a corrected domain is a new request).
 *     pay_on_found: a definitive no_result settles 'refunded' 0 when the
 *     descriptor's cost model is pay_on_found, else 'charged'. Found points
 *     are written as gtm_contact_points rows (channel 'email', state 'found'
 *     or the trusted provider's own verification state,
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
 *     noli-core operation and then resolveParkedContactPoints un-parks the
 *     row). 'unknown' is not definitive and falls through to the next
 *     verifier; a definitive outcome ends the verify waterfall for that
 *     point; 'verified' ends the whole candidate ("stop at first verified
 *     point").
 *
 * Money invariants of the wrapper:
 * - adapter data is written into the shadow receipt in the SAME transaction
 *   as the settlement_pending observation, BEFORE settle is called, so a
 *   settle whose response is lost after the canonical ledger committed never
 *   loses what the customer paid for: the next run rehydrates the points from
 *   the receipt instead of paying the next adapter for the same person;
 * - a settle/markAmbiguous echo must equal the intended outcome to count as
 *   settled; anything else leaves the operation parked for reconciliation;
 * - the provider spend cap and the settle ceiling derive from the ledger's
 *   own reserved_credits echo when it is present, never only from the local
 *   estimate;
 * - a non-ambiguous result that cannot state its cost (cost_units null) is
 *   treated as ambiguous, never charged zero; a definitive provider error
 *   that reports a nonzero cost is charged, never refunded.
 *
 * Stop conditions:
 * - per-run maxCredits budget is enforced BEFORE each reserve (charged plus
 *   outstanding reservations plus the next estimate must fit);
 * - insufficient_credits from the ledger fails the run closed with zero
 *   further adapter calls;
 * - a candidate stops its waterfall at its first verified point;
 * - a candidate whose prior enrichment operation still needs reconciliation
 *   (the plan's reconciliation keys) is parked before any reserve.
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
  // Contextual qualification lives on candidate matches. Routes that resolve
  // those matches pass the accepted identity set instead of relying on the
  // legacy candidate-level verdict.
  acceptedCandidateIds?: Set<string>
  // existing contact points for those candidates (skip-if-verified, parked skip)
  contactPoints: GtmContactPoint[]
  // Prior contact_enrich shadow rows for those candidates. The waterfall
  // parks a candidate whose earlier operation still needs reconciliation
  // (the same rule the enrichment plan quotes by) before any reserve.
  existingEnrichmentOperations?: EnrichmentOperationProjection[]
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
  // contact points written by the enrich phase this run (including points
  // rehydrated from a paid operation whose settle response was lost)
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
// States that may be reused across duplicate addresses. provider_ambiguous
// is deliberately NOT here: a parked row is a pending question about ONE
// operation, and copying it onto every duplicate address would park rows
// that never had an operation of their own.
const REUSABLE_VERIFICATION_STATES = new Set<VerificationState>([
  'verified',
  'risky',
  'catch_all',
  'not_found',
  'unknown',
])
const VERIFICATION_STATES = new Set<VerificationState>([
  'found',
  'verified',
  'risky',
  'catch_all',
  'not_found',
  'unknown',
  'provider_ambiguous',
])
const UNRESOLVED_LEDGER_STATUSES = new Set(['provider_started', 'reconciliation_required'])
const PAID_LEDGER_STATUSES = new Set(['charged', 'partially_charged'])

// Enrichment providers whose own verification verdict is trusted enough to
// skip a separate paid verifier for the same address.
const TRUSTED_ENRICH_VERIFICATION_PROVIDERS = new Set(['leadmagic'])

type ReusableVerification = {
  state: VerificationState
  sourcePointId: string
  verification: Record<string, unknown>
}

function normalizedAddress(point: GtmContactPoint): string | null {
  const normalized = point.value.trim().toLowerCase()
  return normalized || null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function verificationProvenance(point: GtmContactPoint): Record<string, unknown> {
  const provenance = point.provenance
  if (!isRecord(provenance)) return {}
  const verification = provenance.verification
  return isRecord(verification) ? verification : {}
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

// Maps a trusted enrichment provider's own status onto the frozen state set.
// Anything unrecognised (or any untrusted provider) stays 'found' and goes
// through the paid verifier as before.
export function providerVerificationState(
  provenance: Record<string, unknown> | null | undefined,
): Exclude<VerificationState, 'found' | 'provider_ambiguous'> | null {
  if (!isRecord(provenance)) return null
  const provider = typeof provenance.provider === 'string' ? provenance.provider.toLowerCase() : ''
  if (!TRUSTED_ENRICH_VERIFICATION_PROVIDERS.has(provider)) return null
  const status = typeof provenance.provider_status === 'string'
    ? provenance.provider_status.trim().toLowerCase()
    : ''
  if (status === 'valid' || status === 'verified' || status === 'deliverable') return 'verified'
  if (status === 'valid_catch_all' || status === 'catch_all' || status === 'accept_all') return 'catch_all'
  if (status === 'invalid' || status === 'undeliverable') return 'not_found'
  return null
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
  // an earlier run already owns/settled/parked this exact operation - no call
  // made; the shadow (when it still exists) carries whatever data that run
  // retained before settling
  | {
      kind: 'already_settled'
      ledgerStatus: string
      operationId: string
      shadowId: string | null
      retainedData: unknown
    }
  | {
      kind: 'invoked'
      result: AdapterResult<T>
      operationId: string
      shadowId: string
      ledgerStatus: string
      chargedCredits: number
    }

function retainedDataOf(shadow: GtmProviderOperation | null): unknown {
  const observation = shadow?.receipt?.gtm_observation
  if (!isRecord(observation)) return undefined
  return 'retained_data' in observation ? observation.retained_data : undefined
}

function requestFingerprintOf(shadow: GtmProviderOperation | null): string | null {
  const request = shadow?.receipt?.gtm_request
  if (!isRecord(request)) return null
  return typeof request.request_fingerprint === 'string' ? request.request_fingerprint : null
}

/*
 * The single SPEC-066 section 11.2 wrapper both phases share:
 * budget check -> reserve -> shadow row -> start -> provider call ->
 * retain data + observation -> settle | markAmbiguous -> shadow mirror.
 * Exactly one ledger settlement path per invocation; an ambiguous outcome
 * parks the SAME operation.
 */
async function invokeWithLedger<T>(
  deps: {
    em: ResearchEm
    ledger: GtmCreditLedger
    budget: Budget
    descriptor: AdapterDescriptor
    kind: 'enrich' | 'verify'
    idempotencyKey: string
    requestFingerprint: string | null
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
  let reservedEcho: number | undefined
  try {
    const reserved: GtmReserveResultWithEcho = await ledger.reserve({
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
    reservedEcho = Number.isSafeInteger(reserved.reservedCredits) && (reserved.reservedCredits as number) >= 0
      ? reserved.reservedCredits
      : undefined
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
  // provider again would risk double spend, so skip the invocation and hand
  // back what that run retained.
  if (reservedStatus !== 'reserved') {
    const priorShadow = await em.findOne(GtmProviderOperation, {
      noliCoreOperationId: operationId,
      organizationId: deps.orgId,
      tenantId: deps.tenantId,
    })
    return {
      kind: 'already_settled',
      ledgerStatus: reservedStatus,
      operationId,
      shadowId: priorShadow?.id ?? null,
      retainedData: retainedDataOf(priorShadow),
    }
  }
  budget.outstanding += estimate

  // The ledger's own echo is the honest ceiling: never authorise the provider
  // or settle above what the canonical ledger actually escrowed, and never
  // above what this run budgeted for.
  const ceiling = reservedEcho !== undefined ? Math.min(estimate, reservedEcho) : estimate

  // Shadow row BEFORE provider contact (correlation only, never a balance).
  // It carries the request fingerprint so the enrichment plan can tell an
  // old request from a corrected one.
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
          receipt: {
            gtm_request: {
              schema_version: 'gtm-provider-request-v1',
              idempotency_key: deps.idempotencyKey,
              request_fingerprint: deps.requestFingerprint,
              reserved_credits: reservedEcho ?? null,
              estimated_credits: estimate,
            },
          },
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
  const gtmRequest = isRecord(shadow.receipt?.gtm_request) ? shadow.receipt.gtm_request : null

  let started
  try {
    started = await ledger.start(operationId)
  } catch (err) {
    // The start outcome is unknown. Try to give the escrow back: release is
    // legal only from reserved, so if start actually landed the release is
    // refused (illegal_transition) and the operation stays provider_started
    // for reconciliation. Either way the original error propagates.
    budget.outstanding -= estimate
    try {
      const released = await ledger.release(operationId)
      shadow.localStatusMirror = released
      await em.transactional(async (tem) => {
        tem.persist(shadow as GtmProviderOperation)
        await tem.flush()
      })
    } catch {
      // keep the shadow at 'reserved'; reconciliation sees the mirror
    }
    throw err
  }
  shadow.localStatusMirror = started.status
  await em.transactional(async (tem) => {
    tem.persist(shadow as GtmProviderOperation)
    await tem.flush()
  })
  if (!started.startedNow) {
    return {
      kind: 'already_settled',
      ledgerStatus: started.status,
      operationId,
      shadowId: shadow.id,
      retainedData: retainedDataOf(shadow),
    }
  }

  /*
   * Belt and braces on the money path: the provider's own hard spend cap is
   * computed from THIS reservation, with our markup divided back out (the
   * customer's reserved credits include markup; the provider bills raw cost).
   * Our ledger escrows the credits, the provider refuses to bill past the
   * dollars, and neither number is an adapter-side default.
   */
  const result = await deps.call(providerSpendCapUsd(ceiling, markup))

  const receipt = (result.receipt ?? null) as Record<string, unknown> | null
  const observedAt = now()
  let ledgerStatus = shadow.localStatusMirror ?? 'provider_started'
  let chargedCredits = 0
  let settlementPending = false
  let settlementError: string | null = null
  let intendedAction: GtmSettleOutcome | 'mark_ambiguous'
  let ambiguityReason: string | null = null

  if (result.status === 'ok' || result.status === 'partial') {
    if (result.cost_units == null) {
      // A result that cannot state what it cost is not a definitive outcome;
      // charging zero (or guessing from the row count) would be a local
      // inference of the provider's bill.
      intendedAction = 'mark_ambiguous'
      ambiguityReason = 'provider result omitted cost_units'
    } else {
      chargedCredits = Math.min(creditsForUnits(result.cost_units, quoted, markup), ceiling)
      intendedAction = result.status === 'partial' ? 'partially_charged' : 'charged'
    }
  } else if (result.status === 'no_result') {
    if (result.cost_units == null) {
      intendedAction = 'mark_ambiguous'
      ambiguityReason = 'provider no_result omitted cost_units'
    } else if (descriptor.cost_model.pay_on_found || result.cost_units === 0) {
      // pay_on_found semantics: nothing found costs nothing.
      intendedAction = 'refunded'
    } else {
      // the lookup itself is billable when the finalized provider receipt
      // reports a nonzero unit amount.
      chargedCredits = Math.min(creditsForUnits(result.cost_units, quoted, markup), ceiling)
      intendedAction = 'charged'
    }
  } else if (result.status === 'ambiguous') {
    intendedAction = 'mark_ambiguous'
  } else if (result.cost_units != null && result.cost_units > 0) {
    // A definitive provider error that still reports a charge is charged:
    // the provider billed it, so refunding would invent a local outcome.
    chargedCredits = Math.min(creditsForUnits(result.cost_units, quoted, markup), ceiling)
    intendedAction = 'charged'
  } else {
    intendedAction = 'refunded'
  }

  // Retain the adapter's data in the same transaction as the pending
  // observation, BEFORE settle: if the settle response is lost after the
  // canonical ledger committed, the paid-for data is still here and the next
  // run rehydrates it instead of paying the next adapter.
  const retained = intendedAction !== 'mark_ambiguous' && result.data != null
    ? { retained_data: result.data }
    : {}
  const observedReceipt = {
    ...(receipt ?? {}),
    ...(gtmRequest ? { gtm_request: gtmRequest } : {}),
    gtm_observation: {
      schema_version: 'gtm-provider-outcome-v2',
      observed_at: observedAt.toISOString(),
      adapter_status: result.status,
      intended_ledger_action: intendedAction,
      intended_charged_credits: chargedCredits,
      provider_error: result.error ?? ambiguityReason ?? null,
      output_count: Array.isArray(result.data) ? result.data.length : result.data ? 1 : 0,
      settlement_pending: true,
      ...retained,
    },
  }
  await em.transactional(async (tem) => {
    shadow.receipt = observedReceipt
    tem.persist(shadow)
    await tem.flush()
  })

  const expectedStatus = intendedAction === 'mark_ambiguous' ? 'reconciliation_required' : intendedAction
  try {
    if (intendedAction === 'mark_ambiguous') {
      // Park the SAME operation; the reservation stays escrowed (outstanding)
      // until a delayed settle or operator reconciliation lands on it.
      ledgerStatus = await ledger.markAmbiguous(operationId, {
        error: result.error ?? ambiguityReason ?? 'ambiguous provider outcome',
        receipt,
      })
    } else {
      ledgerStatus = await ledger.settle(operationId, intendedAction, chargedCredits, receipt)
    }
    if (ledgerStatus !== expectedStatus) {
      // The canonical ledger answered with a different state than the one we
      // asked for (a stale reservation re-settled, a concurrent reconciliation,
      // a vocabulary drift). That is not "settled as intended"; park it.
      settlementPending = true
      settlementError = `canonical status ${ledgerStatus} does not match intended ${expectedStatus}`
    } else if (intendedAction !== 'mark_ambiguous') {
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

  const treatAsAmbiguous = settlementPending || intendedAction === 'mark_ambiguous'
  await em.transactional(async (tem) => {
    shadow.localStatusMirror = ledgerStatus
    shadow.receipt = {
      ...observedReceipt,
      ...(intendedAction === 'mark_ambiguous'
        ? { ambiguous_at: observedAt.toISOString(), detail: result.error ?? ambiguityReason ?? null }
        : {}),
      gtm_observation: {
        ...observedReceipt.gtm_observation,
        settlement_pending: settlementPending,
        canonical_status: ledgerStatus,
        settlement_error: settlementError,
      },
    }
    if (!treatAsAmbiguous) shadow.settledAt = now()
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
      : intendedAction === 'mark_ambiguous' && result.status !== 'ambiguous'
        ? {
            status: 'ambiguous',
            data: null,
            cost_units: null,
            receipt,
            error: ambiguityReason ?? 'ambiguous provider outcome',
          }
        : result,
    operationId,
    shadowId: shadow.id,
    ledgerStatus,
    chargedCredits: settlementPending ? 0 : chargedCredits,
  }
}

function retainedContactPoints(value: unknown): ContactPoint[] | null {
  if (!Array.isArray(value)) return null
  return value.filter(
    (point): point is ContactPoint =>
      isRecord(point) && typeof point.channel === 'string' && typeof point.value === 'string',
  )
}

function retainedVerificationState(value: unknown): VerificationState | null {
  if (!isRecord(value)) return null
  const state = value.verification_state
  return typeof state === 'string' && VERIFICATION_STATES.has(state as VerificationState)
    ? (state as VerificationState)
    : null
}

/*
 * Un-parks contact points that were parked on ONE verify operation once the
 * operator has reconciled it on the canonical ledger. Called by the
 * reconciliation path after the canonical status is final:
 * - refunded / released: the provider never answered for money; the point
 *   returns to 'found' so a later run can verify it;
 * - charged / partially_charged: the provider was paid; the verdict is taken
 *   from the data retained in the shadow receipt, and 'unknown' when that
 *   run retained nothing (honest: paid, outcome unrecorded);
 * - anything else: still unresolved, nothing changes.
 */
export type ParkedContactPointEm = ResearchEm & {
  find<T extends object>(
    entityClass: new () => T,
    where: Record<string, unknown>,
    options?: { limit?: number },
  ): Promise<T[]>
}

export async function resolveParkedContactPoints(
  em: ParkedContactPointEm,
  ctx: { organizationId: string; tenantId: string },
  input: { providerOperationShadowId: string; canonicalStatus: string; now?: () => Date },
): Promise<{ resolved: number; state: VerificationState | null }> {
  const now = input.now ?? (() => new Date())
  const shadow = await em.findOne(GtmProviderOperation, {
    id: input.providerOperationShadowId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
  })
  if (!shadow || shadow.kind !== 'contact_verify' || !shadow.candidateId) {
    return { resolved: 0, state: null }
  }
  let state: VerificationState | null = null
  if (input.canonicalStatus === 'refunded' || input.canonicalStatus === 'released') {
    state = 'found'
  } else if (PAID_LEDGER_STATUSES.has(input.canonicalStatus)) {
    const retained = retainedVerificationState(retainedDataOf(shadow))
    state = retained && retained !== 'found' && retained !== 'provider_ambiguous' ? retained : 'unknown'
  }
  if (!state) return { resolved: 0, state: null }

  const parked = (await em.find(GtmContactPoint, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    candidateId: shadow.candidateId,
    verificationState: 'provider_ambiguous',
    deletedAt: null,
  }, { limit: 500 })).filter(
    (point) => verificationProvenance(point).provider_operation_shadow_id === shadow.id,
  )
  if (parked.length === 0) return { resolved: 0, state }
  await em.transactional(async (tem) => {
    for (const point of parked) {
      point.verificationState = state as string
      if (state === 'verified') point.verifiedAt = now()
      point.provenance = {
        ...(point.provenance ?? {}),
        verification: {
          ...verificationProvenance(point),
          state,
          parked: false,
          resolved_at: now().toISOString(),
          resolved_from_canonical_status: input.canonicalStatus,
        },
      }
      tem.persist(point)
    }
    await tem.flush()
  })
  return { resolved: parked.length, state }
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
    if (!REUSABLE_VERIFICATION_STATES.has(state)) return
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
    if (!REUSABLE_VERIFICATION_STATES.has(state)) return
    const key = addressKey(point)
    if (key) freshVerificationByAddress.set(key, reusableFromPoint(point, state))
  }
  for (const point of deps.contactPoints) {
    if (point.deletedAt || point.channel !== 'email') continue
    rememberVerification(point, point.verificationState as VerificationState)
  }
  const countState = (state: VerificationState) => {
    if (state === 'verified') summary.verified += 1
    else if (state === 'risky') summary.risky += 1
    else if (state === 'catch_all') summary.catch_all += 1
    else if (state === 'not_found') summary.not_found += 1
    else if (state === 'unknown') summary.unknown += 1
    else if (state === 'provider_ambiguous') summary.ambiguous += 1
  }

  // Spec 4.1 step 6: enrichment runs over ACCEPTED candidates only.
  const accepted = deps.candidates.filter(
    (candidate) =>
      (deps.acceptedCandidateIds?.has(candidate.id) ?? candidate.fitStatus === 'accepted')
      && !candidate.deletedAt
      && candidate.entityKind === 'person',
  )
  const operationIndex = indexEnrichmentOperations(
    deps.existingEnrichmentOperations ?? [],
    new Set(accepted.map((candidate) => candidate.id)),
  )

  /*
   * Writes the points one enrich operation found (fresh, or rehydrated from
   * the receipt of a paid operation whose settle response was lost). A
   * trusted provider's own verification verdict is honoured so the paid
   * verifier is not run again for an address the provider already verified.
   * Returns true when one of the written points is verified.
   */
  const writeFoundPoints = async (
    candidate: GtmCandidate,
    found: ContactPoint[],
    source: { shadowId: string; operationId: string; adapterId: string; providerRequestId: unknown; rehydrated: boolean },
  ): Promise<boolean> => {
    let anyVerified = false
    const written: Array<{ row: GtmContactPoint; state: VerificationState }> = []
    await em.transactional(async (tem) => {
      for (const point of found) {
        const providerState = providerVerificationState(point.provenance)
        const state: VerificationState = providerState ?? 'found'
        const row = tem.create(GtmContactPoint, {
          id: crypto.randomUUID(),
          organizationId: candidate.organizationId,
          tenantId: candidate.tenantId,
          candidateId: candidate.id,
          channel: 'email',
          value: point.value,
          verificationState: state,
          ...(state === 'verified' ? { verifiedAt: now() } : {}),
          // shadow row id (gtm_provider_operations.id), per section 4
          providerOperationId: source.shadowId,
          provenance: {
            ...(point.provenance ?? {}),
            adapter_id: source.adapterId,
            noli_core_operation_id: source.operationId,
            provider_request_id: source.providerRequestId ?? null,
            ...(source.rehydrated ? { rehydrated_from_receipt: true } : {}),
            ...(providerState
              ? {
                  verification: {
                    source: 'provider_status',
                    adapter_id: source.adapterId,
                    noli_core_operation_id: source.operationId,
                    provider_operation_shadow_id: source.shadowId,
                    provider_status: point.provenance?.provider_status ?? null,
                    state: providerState,
                    parked: false,
                  },
                }
              : {}),
          },
        })
        tem.persist(row)
        const list = pointsByCandidate.get(candidate.id) ?? []
        list.push(row)
        pointsByCandidate.set(candidate.id, list)
        written.push({ row, state })
      }
      await tem.flush()
    })
    for (const { row, state } of written) {
      if (state === 'found') continue
      rememberFreshVerification(row, state)
      countState(state)
      if (state === 'verified') anyVerified = true
    }
    summary.enriched += written.length
    return anyVerified
  }

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
      // A generic-host domain (facebook.com, gmail.com) never reaches a paid
      // finder and is dropped from the lookup identity; the name and company
      // still travel.
      const lookupIdentity = lookupIdentityForEnrichment(
        candidate.identity as Record<string, unknown>,
      )
      for (const adapter of deps.enrichAdapters) {
        const descriptor = adapter.descriptor
        if (!customerUseAllowed(descriptor)) continue
        const request = {
          signal_kind: ENRICH_SIGNAL,
          entity_unit: entityUnitFor(candidate),
          geography: GEOGRAPHY,
          channel: 'email' as const,
          candidate: {
            // `accepted` is structurally filtered to people above. Keep the
            // request literal so an opportunity can never be coerced into a
            // contact-enrichment call if entity kinds expand again.
            entity_kind: 'person' as const,
            identity: lookupIdentity as unknown as CandidateIdentity,
          },
        }
        if (adapter.supportsCandidate && !adapter.supportsCandidate(request.candidate)) continue
        // Fail closed before spend: an uncovered dimension never reserves.
        if (!capabilityCovers(descriptor, request).covered) continue
        // Honour the plan: an earlier operation for this candidate + adapter
        // that still needs reconciliation parks the candidate before any
        // reserve, exactly as the quote said it would.
        if (
          enrichmentOperationDisposition(
            { id: candidate.id, entityKind: candidate.entityKind, identity: lookupIdentity },
            adapter,
            operationIndex,
          ) === 'reconciliation'
        ) {
          summary.ambiguous += 1
          continue candidateLoop
        }
        const adapterRequestFingerprint = adapter.operationFingerprint?.(request) ?? null
        const requestFingerprint = adapter.operationFingerprint
          ? adapterRequestFingerprint
          : enrichmentRequestFingerprint(lookupIdentity)

        const invoked = await invokeWithLedger(
          {
            em,
            ledger,
            budget,
            descriptor,
            kind: 'enrich',
            idempotencyKey: `enrich:${candidate.id}:${descriptor.adapter_id}${
              requestFingerprint ? `:${requestFingerprint}` : ''
            }`,
            requestFingerprint,
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
              adapter_request_fingerprint: adapterRequestFingerprint,
              request_fingerprint: requestFingerprint,
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
        if (invoked.kind === 'already_settled') {
          if (UNRESOLVED_LEDGER_STATUSES.has(invoked.ledgerStatus)) {
            summary.ambiguous += 1
            continue candidateLoop
          }
          if (PAID_LEDGER_STATUSES.has(invoked.ledgerStatus)) {
            // The earlier run PAID for this lookup. Its data lives in the
            // shadow receipt; rehydrate it rather than paying the next
            // adapter for the same person. A paid operation with nothing
            // retained (a legacy row, or a lost shadow) is parked, not
            // silently re-bought.
            const retained = retainedContactPoints(invoked.retainedData)
            if (retained === null || !invoked.shadowId) {
              summary.ambiguous += 1
              continue candidateLoop
            }
            const found = retained.filter((point) => point.channel === 'email')
            if (found.length === 0) continue // paid no_result: next adapter
            const alreadyWritten = await em.findOne(GtmContactPoint, {
              organizationId: candidate.organizationId,
              tenantId: candidate.tenantId,
              candidateId: candidate.id,
              providerOperationId: invoked.shadowId,
            })
            if (alreadyWritten) break // points exist (index was stale); enrich phase done
            const verified = await writeFoundPoints(candidate, found, {
              shadowId: invoked.shadowId,
              operationId: invoked.operationId,
              adapterId: descriptor.adapter_id,
              providerRequestId: null,
              rehydrated: true,
            })
            if (verified) continue candidateLoop
            break
          }
          // refunded / released: that adapter definitively found nothing;
          // try the next adapter in the waterfall.
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
            const verified = await writeFoundPoints(candidate, found, {
              shadowId: invoked.shadowId,
              operationId: invoked.operationId,
              adapterId: descriptor.adapter_id,
              providerRequestId:
                (result.receipt as Record<string, unknown> | null)?.provider_request_id ?? null,
              rehydrated: false,
            })
            if (verified) continue candidateLoop // provider-verified: stop this candidate
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
        countState(reusable.state)
        if (reusable.state === 'verified') continue candidateLoop
        continue
      }

      const writeVerification = async (
        state: VerificationState,
        verification: Record<string, unknown>,
      ) => {
        await em.transactional(async (tem) => {
          point.verificationState = state as string
          if (state === 'verified') point.verifiedAt = now()
          point.provenance = {
            ...(point.provenance ?? {}),
            verification,
          }
          tem.persist(point)
          await tem.flush()
        })
      }

      let finalState: VerificationState | null = null
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
            requestFingerprint: null,
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
              address_sha256: crypto
                .createHash('sha256')
                .update(point.value.trim().toLowerCase())
                .digest('hex'),
            },
            markup,
            now,
            call: (maxChargeUsd) => adapter.verify({ ...request, max_charge_usd: maxChargeUsd }),
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
          if (UNRESOLVED_LEDGER_STATUSES.has(invoked.ledgerStatus)) {
            await writeVerification('provider_ambiguous', {
              ...verificationProvenance(point),
              adapter_id: descriptor.adapter_id,
              noli_core_operation_id: invoked.operationId,
              provider_operation_shadow_id: invoked.shadowId,
              parked: true,
              canonical_status: invoked.ledgerStatus,
            })
            summary.ambiguous += 1
            continue candidateLoop
          }
          if (PAID_LEDGER_STATUSES.has(invoked.ledgerStatus)) {
            // Paid verification whose settle response was lost: the verdict
            // is in the retained receipt data.
            const retained = retainedVerificationState(invoked.retainedData)
            if (retained && retained !== 'found' && retained !== 'provider_ambiguous') {
              await writeVerification(retained, {
                adapter_id: descriptor.adapter_id,
                noli_core_operation_id: invoked.operationId,
                provider_operation_shadow_id: invoked.shadowId,
                state: retained,
                parked: false,
                rehydrated_from_receipt: true,
              })
              rememberFreshVerification(point, retained)
              finalState = retained
              if (retained === 'unknown') continue
              break
            }
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

        await writeVerification(state, {
          adapter_id: descriptor.adapter_id,
          noli_core_operation_id: invoked.operationId,
          provider_operation_shadow_id: invoked.shadowId,
          state,
          parked: state === 'provider_ambiguous',
          ...(result.data?.detail ? { detail: result.data.detail } : {}),
        })
        // A fresh result is authoritative for the remaining duplicate rows in
        // this run even when conflicting historical rows disabled old-result
        // reuse. The old conflict remains intact for operator review.
        rememberFreshVerification(point, state)
        finalState = state
        // 'unknown' is the verifier declining to answer, not a verdict: the
        // waterfall continues to the next verifier and keeps 'unknown' only
        // when none answers.
        if (state === 'unknown') continue
        break // definitive (or parked) outcome ends this point's verify waterfall
      }
      if (finalState) countState(finalState)
      if (finalState === 'verified') continue candidateLoop // stop at first verified point
    }
  }

  summary.credits = budget.charged
  return summary
}
