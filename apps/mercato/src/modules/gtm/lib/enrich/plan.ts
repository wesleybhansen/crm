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
  schema_version: '4'
  plan_hash: string
  candidates_considered: number
  candidates_needing_enrichment: number
  emails_needing_verification: number
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
      if (!usable(adapter)) return []
      if (adapter.supportsCandidate && !adapter.supportsCandidate({
        entity_kind: candidate.entityKind ?? 'person',
        identity: candidate.identity ?? null,
      })) return []
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
    const units = adapter.supportsCandidate
      ? needingEnrichment.filter((candidate) => adapter.supportsCandidate?.({
          entity_kind: candidate.entityKind ?? 'person',
          identity: candidate.identity ?? null,
        })).length
      : needingEnrichment.length
    add(adapter, units)
  }
  for (const adapter of verifyAdapters) add(adapter, verificationCeiling)

  const frozen = {
    schema_version: '4' as const,
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
    candidates_needing_enrichment: needingEnrichment.length,
    emails_needing_verification: verificationCeiling,
    providers,
  }
  return {
    schema_version: frozen.schema_version,
    plan_hash: immutableHash(frozen),
    candidates_considered: reachableCandidates.length,
    candidates_needing_enrichment: needingEnrichment.length,
    emails_needing_verification: verificationCeiling,
    maximum_credits: providers.reduce((sum, provider) => sum + provider.max_credits, 0),
    providers,
    note: 'Maximum authorized ceiling. Found-only misses and waterfall short-circuits can reduce actual credits.',
  }
}
