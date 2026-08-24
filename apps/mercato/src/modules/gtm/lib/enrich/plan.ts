import type { EnrichAdapter, VerifyAdapter } from '../adapters/types'
import { creditsForUnits, defaultMarkupMultiplier } from '../credits/markup'
import { descriptorHash, immutableHash } from '../research/plan'
import { normalizeCompanyWebsite } from './company-domain'

type CandidateRow = {
  id: string
  entityKind?: string
  identity?: Record<string, unknown>
}
type ContactPointRow = {
  id?: string
  candidateId: string
  channel: string
  value?: string
  verificationState: string
}

export type EnrichmentOperationProjection = {
  candidateId?: string | null
  kind: string
  provider: string
  localStatusMirror?: string | null
}

const TERMINAL_VERIFICATION_STATES = new Set([
  'verified',
  'risky',
  'catch_all',
  'not_found',
  'unknown',
  'provider_ambiguous',
])

function normalizedEmail(value?: string): string | null {
  const normalized = value?.trim().toLowerCase() ?? ''
  return normalized || null
}

export type EnrichmentProviderQuote = {
  adapter_id: string
  layer: 'enrich' | 'verify'
  billable_unit: string
  max_units: number
  quoted_credits_per_unit: number
  max_credits: number
  pay_on_found: boolean
  price_version: string
  terms_version: string
  descriptor_hash: string
}

export type EnrichmentPlan = {
  schema_version: '5'
  plan_hash: string
  candidates_considered: number
  candidates_needing_enrichment: number
  emails_needing_verification: number
  operations_already_consumed: number
  operations_requiring_reconciliation: number
  maximum_credits: number
  providers: EnrichmentProviderQuote[]
  note: string
}

// Must stay identical to customerUseAllowed in research/plan.ts and
// enrich/waterfall.ts. A quote that omits the frozen-terms check would price a
// provider the waterfall then refuses to call, or the reverse.
function usable(adapter: EnrichAdapter | VerifyAdapter): boolean {
  const license = adapter.descriptor.constraints.license
  return (
    (license.status === 'approved' || license.status === 'test_only') &&
    Boolean(license.terms_version) &&
    license.export &&
    license.customer_display &&
    license.outreach_allowed
  )
}

export function buildEnrichmentPlan(
  candidates: CandidateRow[],
  contactPoints: ContactPointRow[],
  enrichAdapters: EnrichAdapter[],
  verifyAdapters: VerifyAdapter[],
  markup = defaultMarkupMultiplier(),
  existingOperations: EnrichmentOperationProjection[] = [],
): EnrichmentPlan {
  const reachableCandidates = candidates.filter(
    (candidate) => candidate.entityKind === undefined || candidate.entityKind === 'person',
  )
  const reachableCandidateIds = new Set(reachableCandidates.map((candidate) => candidate.id))
  const scopedContactPoints = contactPoints.filter((point) =>
    reachableCandidateIds.has(point.candidateId),
  )
  const emailByCandidate = new Map<string, ContactPointRow[]>()
  for (const point of scopedContactPoints) {
    if (point.channel !== 'email') continue
    const rows = emailByCandidate.get(point.candidateId) ?? []
    rows.push(point)
    emailByCandidate.set(point.candidateId, rows)
  }
  const unresolved = reachableCandidates.filter(
    (candidate) => !emailByCandidate.get(candidate.id)?.some((point) => point.verificationState === 'verified'),
  )
  const needingEnrichment = unresolved.filter(
    (candidate) => !(emailByCandidate.get(candidate.id)?.length),
  )

  // For adapters whose execution key is exactly candidate + adapter, a local
  // provider-operation shadow is sufficient to prove that the canonical
  // reserve will not start another provider call. Do not apply this inference
  // to adapters with request fingerprints: the shadow does not retain enough
  // identity to tell an old request from a newly corrected input.
  const operationStates = new Map<string, Set<string>>()
  for (const operation of existingOperations) {
    if (
      !operation.candidateId
      || operation.kind !== 'contact_enrich'
      || !reachableCandidateIds.has(operation.candidateId)
    ) continue
    const key = `${operation.candidateId}:${operation.provider}`
    const states = operationStates.get(key) ?? new Set<string>()
    states.add(operation.localStatusMirror?.trim() || 'unknown')
    operationStates.set(key, states)
  }
  type OperationDisposition = 'available' | 'consumed' | 'reconciliation'
  const dispositionFor = (
    candidate: CandidateRow,
    adapter: EnrichAdapter,
  ): OperationDisposition => {
    if (adapter.operationFingerprint) return 'available'
    const states = operationStates.get(`${candidate.id}:${adapter.descriptor.adapter_id}`)
    if (!states || states.size === 0 || [...states].every((state) => state === 'reserved')) {
      return 'available'
    }
    if (
      states.has('provider_started')
      || states.has('reconciliation_required')
      || states.has('estimated')
      || states.has('unknown')
    ) return 'reconciliation'
    if ([...states].some((state) =>
      state === 'charged'
      || state === 'partially_charged'
      || state === 'refunded'
      || state === 'released',
    )) return 'consumed'
    // A shadow vocabulary outside the canonical contract cannot safely prove
    // either retry eligibility or completion.
    return 'reconciliation'
  }
  const eligibleByAdapter = new Map<string, CandidateRow[]>()
  const consumedKeys = new Set<string>()
  const reconciliationKeys = new Set<string>()
  for (const adapter of enrichAdapters) {
    if (usable(adapter)) eligibleByAdapter.set(adapter.descriptor.adapter_id, [])
  }
  for (const candidate of needingEnrichment) {
    for (const adapter of enrichAdapters) {
      if (!usable(adapter)) continue
      if (adapter.supportsCandidate && !adapter.supportsCandidate({
        entity_kind: candidate.entityKind ?? 'person',
        identity: candidate.identity ?? null,
      })) continue
      const disposition = dispositionFor(candidate, adapter)
      const operationKey = `${candidate.id}:${adapter.descriptor.adapter_id}`
      if (disposition === 'consumed') {
        consumedKeys.add(operationKey)
        continue
      }
      if (disposition === 'reconciliation') {
        reconciliationKeys.add(operationKey)
        // The waterfall parks this candidate and does not reach any later
        // adapter after an unresolved canonical/provider operation.
        break
      }
      eligibleByAdapter.get(adapter.descriptor.adapter_id)?.push(candidate)
    }
  }
  const candidatesNeedingEnrichment = new Set(
    [...eligibleByAdapter.values()].flatMap((rows) => rows.map((candidate) => candidate.id)),
  )
  // Verification is address-scoped, not row-scoped. One normalized address is
  // verified once and the terminal result is reused for duplicate contact
  // rows. This mirrors provider duplicate-credit semantics and prevents two
  // candidate rows carrying the same address from authorizing duplicate spend.
  const terminalByAddress = new Map<string, string | null>()
  for (const point of scopedContactPoints) {
    if (point.channel !== 'email' || !TERMINAL_VERIFICATION_STATES.has(point.verificationState)) continue
    const address = normalizedEmail(point.value)
    if (!address) continue
    const prior = terminalByAddress.get(address)
    if (prior === undefined) terminalByAddress.set(address, point.verificationState)
    else if (prior !== point.verificationState) terminalByAddress.set(address, null)
  }
  const verificationIdentities = new Set<string>()
  let unidentifiedPointSequence = 0
  for (const candidate of unresolved) {
    for (const point of emailByCandidate.get(candidate.id) ?? []) {
      if (point.verificationState !== 'found') continue
      const address = normalizedEmail(point.value)
      if (address && terminalByAddress.get(address)) continue
      verificationIdentities.add(
        address
          ? `email:${address}`
          : `point:${point.id ?? `${candidate.id}:${unidentifiedPointSequence++}`}`,
      )
    }
  }
  const pointsNeedingVerification = verificationIdentities.size
  // Freeze the largest address yield any eligible adapter can expose for each
  // candidate. The enrichment waterfall stops after the first adapter that
  // finds points, so this is a max per candidate, not a sum across adapters.
  const maximumNewPoints = needingEnrichment.reduce((sum, candidate) => {
    const perAdapter = enrichAdapters.flatMap((adapter) => {
      if (!eligibleByAdapter.get(adapter.descriptor.adapter_id)?.some((row) => row.id === candidate.id)) return []
      const ceiling = adapter.maxContactPointsPerCandidate ?? 1
      return [Number.isSafeInteger(ceiling) && ceiling > 0 ? ceiling : 1]
    })
    return sum + Math.max(0, ...perAdapter)
  }, 0)
  const verificationCeiling = pointsNeedingVerification + maximumNewPoints
  const providers: EnrichmentProviderQuote[] = []

  const add = (adapter: EnrichAdapter | VerifyAdapter, units: number) => {
    if (!usable(adapter) || units <= 0) return
    const descriptor = adapter.descriptor
    providers.push({
      adapter_id: descriptor.adapter_id,
      layer: descriptor.layer as 'enrich' | 'verify',
      billable_unit: descriptor.cost_model.unit,
      max_units: units,
      quoted_credits_per_unit: descriptor.cost_model.quoted_credits_per_unit,
      max_credits: creditsForUnits(units, descriptor.cost_model.quoted_credits_per_unit, markup),
      pay_on_found: descriptor.cost_model.pay_on_found,
      price_version: descriptor.cost_model.price_version,
      terms_version: descriptor.constraints.license.terms_version,
      descriptor_hash: descriptorHash(descriptor),
    })
  }
  for (const adapter of enrichAdapters) {
    const units = eligibleByAdapter.get(adapter.descriptor.adapter_id)?.length ?? 0
    add(adapter, units)
  }
  for (const adapter of verifyAdapters) add(adapter, verificationCeiling)

  const frozen = {
    schema_version: '5' as const,
    candidate_ids: unresolved.map((candidate) => candidate.id).sort(),
    candidate_company_domains: unresolved
      .map((candidate) => [
        candidate.id,
        normalizeCompanyWebsite(candidate.identity?.domain)?.companyDomain ?? null,
      ] as const)
      .sort((left, right) => left[0].localeCompare(right[0])),
    contact_identities: scopedContactPoints
      .filter((point) => point.channel === 'email')
      .map((point) => [
        point.id ?? null,
        point.candidateId,
        point.value?.trim().toLowerCase() ?? null,
        point.verificationState,
      ])
      .sort((a, b) => {
        const left = JSON.stringify(a)
        const right = JSON.stringify(b)
        return left < right ? -1 : left > right ? 1 : 0
      }),
    candidates_considered: reachableCandidates.length,
    candidates_needing_enrichment: candidatesNeedingEnrichment.size,
    emails_needing_verification: verificationCeiling,
    operations_already_consumed: consumedKeys.size,
    operations_requiring_reconciliation: reconciliationKeys.size,
    existing_enrichment_operations: existingOperations
      .filter((operation) =>
        operation.candidateId
        && reachableCandidateIds.has(operation.candidateId)
        && operation.kind === 'contact_enrich',
      )
      .map((operation) => [
        operation.candidateId,
        operation.provider,
        operation.localStatusMirror?.trim() || 'unknown',
      ])
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    providers,
  }
  const note = reconciliationKeys.size > 0
    ? 'One or more prior provider operations must be reconciled before they can be retried.'
    : consumedKeys.size > 0
      ? 'Maximum authorized ceiling. Previously completed lookups are not re-quoted.'
      : 'Maximum authorized ceiling. Found-only misses and waterfall short-circuits can reduce actual credits.'
  return {
    schema_version: frozen.schema_version,
    plan_hash: immutableHash(frozen),
    candidates_considered: reachableCandidates.length,
    candidates_needing_enrichment: candidatesNeedingEnrichment.size,
    emails_needing_verification: verificationCeiling,
    operations_already_consumed: consumedKeys.size,
    operations_requiring_reconciliation: reconciliationKeys.size,
    maximum_credits: providers.reduce((sum, provider) => sum + provider.max_credits, 0),
    providers,
    note,
  }
}
