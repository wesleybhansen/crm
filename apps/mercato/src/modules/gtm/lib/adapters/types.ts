/*
 * Provider adapter capability contracts (SPEC-066 section 11.1, frozen shape).
 *
 * Every adapter (source, enrichment, verification, sending) declares a static
 * AdapterDescriptor consumed by planning/pricing and enforced at run time. A
 * requested dimension with no covering capability fails closed at PLAN time
 * (capabilityCovers, below) before any invoke, and the same check runs again
 * inside every adapter invoke path so a contract-disabled capability cannot
 * run even by direct call.
 *
 * Pure types + one pure function; no ORM or framework imports.
 */

export type AdapterLayer = 'source' | 'enrich' | 'verify' | 'send'

export type AdapterChannel = 'email' | 'linkedin' | 'x'

/*
 * One capability row: the adapter can service `signal_kind` for the listed
 * entity units / geographies / channels. Entries compare case-insensitively;
 * '*' is an explicit wildcard entry. A geography entry covers itself and its
 * hyphenated subdivisions ('US' covers 'US-CA'; 'US-CA' does not cover 'US').
 * `channels: []` means the capability has no channel dimension at all (e.g. a
 * pure source search); any channel-bearing request against it is unsupported.
 */
export type AdapterCapability = {
  signal_kind: string
  entity_units: string[]
  geographies: string[]
  channels: string[]
}

export type AdapterLicenseConstraints = {
  // Legal/commercial review state. Only `approved` providers may serve
  // customers; `test_only` is reserved for deterministic local fixtures.
  status: 'approved' | 'test_only' | 'provisional' | 'blocked'
  // Immutable identifier for the exact provider terms reviewed by Noli.
  terms_version: string
  export: boolean
  customer_display: boolean
  outreach_allowed: boolean
  retention_days: number | null
  // SPEC-069. Missing means legacy business-only. Consumer use is never
  // inferred from a credential, a wildcard capability, or outreach_allowed.
  audience_modes?: Array<'business' | 'consumer'>
  manual_outreach_allowed?: boolean
  automated_email_allowed?: boolean
  public_profile_contact_allowed?: boolean
  public_opportunity_use_allowed?: boolean
}

export type AdapterRateLimits = {
  requests_per_minute?: number
  concurrent?: number
}

export type AdapterConstraints = {
  license: AdapterLicenseConstraints
  rate_limits?: AdapterRateLimits
  max_batch: number
  // Optional deterministic continuation contract. Offset pagination is
  // frozen into the quoted plan; opaque cursors are deliberately excluded
  // because they cannot be known before approval or replayed after a crash.
  pagination?: {
    mode: 'offset'
    page_size: number
    max_pages: number
  }
}

export type AdapterCostModel = {
  // what one billed unit is, e.g. 'candidate' | 'contact_point' | 'verification'
  unit: string
  quoted_credits_per_unit: number
  // Immutable identifier for the rate card used to create a quote.
  price_version: string
  // true = only found/returned units are charged (no_result costs 0)
  pay_on_found: boolean
}

export type AdapterEvidencePolicy = {
  source_url: 'required' | 'preferred' | 'not_applicable'
  observed_at: 'required' | 'preferred' | 'not_applicable'
  max_age_days: number | null
  min_confidence: number
}

export type AdapterAmbiguityContract = {
  // true = a timeout maps to status 'ambiguous', never to a silent retry
  timeout_is_ambiguous: boolean
  // field names every receipt this adapter returns must carry
  receipt_fields: string[]
}

export type AdapterDsr = {
  deletion_supported: boolean
}

export type AdapterDescriptor = {
  contract_version: '2'
  adapter_id: string
  layer: AdapterLayer
  capabilities: AdapterCapability[]
  constraints: AdapterConstraints
  cost_model: AdapterCostModel
  evidence_policy: AdapterEvidencePolicy
  ambiguity_contract: AdapterAmbiguityContract
  dsr: AdapterDsr
}

/*
 * Uniform adapter result envelope.
 * - 'ok'        full result
 * - 'no_result' the provider answered definitively with nothing found
 * - 'partial'   some units returned, the rest definitively unavailable
 * - 'error'     definitive failure, safe to retry via a NEW operation
 * - 'ambiguous' unknown outcome (timeout / accepted-unconfirmed / pending):
 *               never auto-retried, parked for reconciliation (section 6/11)
 * `receipt` always carries the descriptor's ambiguity_contract.receipt_fields.
 * `cost_units` is null when spend is unknown (ambiguous), 0 when nothing was
 * charged, otherwise the charged unit count.
 */
export type AdapterResultStatus = 'ok' | 'no_result' | 'partial' | 'error' | 'ambiguous'

export type AdapterResult<T> = {
  status: AdapterResultStatus
  data: T | null
  receipt: Record<string, unknown> | null
  cost_units: number | null
  error?: string
}

// ---------------------------------------------------------------------------
// Domain payloads (narrow, matching the gtm_candidates / gtm_evidence /
// gtm_contact_points column vocabulary)
// ---------------------------------------------------------------------------

export type CandidateIdentity = {
  name: string
  company?: string | null
  title?: string | null
  domain?: string | null
  urls?: string[]
  location?: string | null
  // Frozen provider targeting provenance is distinct from the returned
  // entity's street address. Structured locality fields preserve the exact
  // provider observation without forcing downstream code to parse addresses.
  provider_location?: string | null
  city?: string | null
  region?: string | null
  country_code?: string | null
  latitude?: number | null
  longitude?: number | null
  industry?: string | null
  employee_count?: number | null
  employee_range?: string | null
  technologies?: string[]
  company_description?: string | null
  seniority?: string | null
  department?: string | null
  // The LinkedIn post-search actor returns vanity profile URLs for commenters
  // and opaque profile URLs for reactors. This adapter-owned fingerprint is
  // derived only from the same returned public name + headline so those two
  // URL representations dedupe without making every LinkedIn source abandon
  // its stronger canonical-URL identity contract.
  linkedin_engagement_fingerprint?: string | null
  // SPEC-069 demand-surface fields. These are intentionally bounded and
  // source-shaped, not an open provider payload. A consumer opportunity is a
  // public place or conversation where an audience gathers, never a recipient.
  opportunity_kind?: 'community' | 'forum' | 'group' | 'thread' | 'post' | 'event' | 'creator_audience' | 'other'
  platform?: string | null
  intent_kind?: 'buyer_intent' | 'seller_intent' | 'local_audience' | 'mixed_intent' | null
  audience_description?: string | null
  activity_level?: 'high' | 'medium' | 'low' | 'unknown' | null
  member_count?: number | null
  engagement_count?: number | null
  access_type?: 'public' | 'approval_required' | 'ticketed' | 'unknown' | null
  // Result of a bounded, same-request DNS-pinned public destination check.
  // Missing means the destination has not been independently validated.
  destination_validation_status?: 'verified_public' | 'unavailable' | 'blocked' | 'unknown' | null
  destination_validated_at?: string | null
  destination_http_status?: number | null
  // Publication time reported by the source platform. This is deliberately
  // distinct from evidence.observed_at (when Noli retrieved the row): using
  // retrieval time as publication time makes old posts look fresh.
  source_published_at?: string | null
  event_start_at?: string | null
  participation_rules?: string | null
  // Whether the venue's rules were actually present in returned source
  // evidence. Adapter-authored safety reminders are useful guidance, but
  // they are not proof that a person may participate in the destination.
  participation_rules_status?: 'observed' | 'unverified' | null
  recommended_action?: string | null
  message_angle?: string | null
  people_to_follow?: Array<{
    name: string
    role?: string | null
    profile_url?: string | null
  }>
}

export type CandidateEvidence = {
  claim: string
  source_url: string | null
  observed_at: string
  confidence: number
  /*
   * Optional inert provider payload for this observation (engagement kind,
   * reaction types, the comment body, the actor's echo of the source post).
   * DATA ONLY: it is stored on the evidence row's provider_ref jsonb and is
   * never interpolated into a claim, a template, or any instruction path.
   * Omitted entirely when the adapter has nothing verified to put in it.
   */
  detail?: Record<string, unknown>
}

export type Candidate = {
  entity_kind: 'person' | 'company' | 'opportunity'
  identity: CandidateIdentity
  evidence: CandidateEvidence[]
}

export type ContactPoint = {
  channel: AdapterChannel
  value: string
  provenance?: Record<string, unknown>
}

// mirrors gtm_contact_points.verification_state
export type VerificationState =
  | 'found'
  | 'verified'
  | 'risky'
  | 'catch_all'
  | 'not_found'
  | 'unknown'
  | 'provider_ambiguous'

export type VerificationOutcome = {
  channel: AdapterChannel
  value: string
  verification_state: VerificationState
  detail?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Invocation parameter types
// ---------------------------------------------------------------------------

/*
 * `call_sequence` makes multi-call provider behavior (delayed completion,
 * webhook replay) explicitly deterministic: the caller states which attempt
 * this is (1-based) instead of the adapter keeping hidden state. It is
 * excluded from input identity/idempotency hashing.
 */
export type SourceSearchPlan = {
  signal_kind: string
  entity_unit: string
  geography: string
  query: string
  provider_query?: Record<string, unknown>
  max_candidates: number
  // Frozen provider offset for a quoted continuation page. Never combine with
  // an opaque cursor; it is part of the operation fingerprint.
  offset?: number
  call_sequence?: number
  /*
   * Optional per-batch provider budget in USD, i.e. what the caller reserved
   * for this one call. Adapters whose provider accepts a hard per-run spend
   * cap (Apify's mandatory maxTotalChargeUsd) pass it straight through, so the
   * provider enforces our budget server side as well as our ledger enforcing
   * it locally. Omitted when the caller has no USD-denominated budget; the
   * adapter then falls back to its own configured cap.
   */
  max_charge_usd?: number
}

export type SourceQuote = {
  // Candidate ceiling sent to the provider. It is deliberately distinct
  // from provider_units because many providers bill per search/task/request.
  max_candidates: number
  provider_units: number
  billable_unit: string
  expected_candidates: {
    low: number
    high: number
    basis: 'contract' | 'historical' | 'provider_quote' | 'unknown'
  }
  quoted_credits_per_unit: number
  estimated_credits_before_markup: number
}

export type EnrichRequest = {
  signal_kind: string
  entity_unit: string
  geography: string
  channel: AdapterChannel
  candidate: Pick<Candidate, 'entity_kind' | 'identity'>
  call_sequence?: number
  /*
   * Optional per-call provider budget in USD, i.e. what the caller reserved for
   * this one enrichment. Same contract as SourceSearchPlan.max_charge_usd:
   * adapters whose provider accepts a hard per-run spend cap (Apify's mandatory
   * maxTotalChargeUsd) pass it straight through so the provider enforces our
   * reservation server side too. Omitted when the caller has no USD-denominated
   * budget; the adapter then falls back to its own configured cap.
   */
  max_charge_usd?: number
}

export type VerifyRequest = {
  signal_kind: string
  entity_unit: string
  geography: string
  channel: AdapterChannel
  value: string
  call_sequence?: number
  max_charge_usd?: number
}

export interface SourceAdapter {
  descriptor: AdapterDescriptor
  quote(plan: Omit<SourceSearchPlan, 'call_sequence' | 'max_charge_usd'>): SourceQuote
  search(plan: SourceSearchPlan): Promise<AdapterResult<Candidate[]>>
}

export interface EnrichAdapter {
  descriptor: AdapterDescriptor
  // Maximum number of contact points one successful candidate call can
  // expose to the verification phase. The immutable plan uses this ceiling;
  // omitted adapters preserve the historical one-point contract.
  maxContactPointsPerCandidate?: number
  supportsCandidate?(candidate: {
    entity_kind?: string | null
    identity?: Record<string, unknown> | null
  }): boolean
  operationFingerprint?(request: EnrichRequest): string | null
  enrich(request: EnrichRequest): Promise<AdapterResult<ContactPoint[]>>
}

export interface VerifyAdapter {
  descriptor: AdapterDescriptor
  verify(request: VerifyRequest): Promise<AdapterResult<VerificationOutcome>>
}

// ---------------------------------------------------------------------------
// Plan-time capability check (fail-closed)
// ---------------------------------------------------------------------------

export type CapabilityRequest = {
  signal_kind?: string | null
  entity_unit?: string | null
  geography?: string | null
  channel?: string | null
}

export type CapabilityCoverage = {
  covered: boolean
  reason?: string
}

export type AdapterAudienceUse = 'business' | 'consumer'

// Same shape as registry.fixtureAdaptersEnabled without the flag check: a
// test build always allows test_only descriptors, development allows them,
// anything else (production, unset, unknown) requires the OM_TEST_MODE harness.
export function testOnlyLicensesPermitted(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === 'test' || env.NODE_ENV === 'development') return true
  return env.OM_TEST_MODE === '1'
}

export type AdapterAudienceRights = {
  allowed: boolean
  reason?: string
}

/**
 * Customer-serving rights are checked independently from technical
 * capability. Legacy descriptors retain their current business behavior but
 * can never serve consumer records without every explicit SPEC-069 right.
 */
export function adapterAudienceRights(
  descriptor: AdapterDescriptor,
  audience: AdapterAudienceUse,
  entityKind?: 'person' | 'company' | 'opportunity' | null,
): AdapterAudienceRights {
  const license = descriptor.constraints.license
  if (license.status !== 'approved' && license.status !== 'test_only') {
    return { allowed: false, reason: `provider license is ${license.status}` }
  }
  // 'test_only' is reserved for deterministic local fixtures. It can only
  // serve a plan where fixtures may register at all (review 2026-09-02, L2/H14);
  // the registry gate is mirrored here rather than imported to avoid a cycle.
  if (license.status === 'test_only' && !testOnlyLicensesPermitted()) {
    return { allowed: false, reason: 'provider license is test_only and this environment does not run fixtures' }
  }
  if (!license.terms_version || !license.export || !license.customer_display) {
    return { allowed: false, reason: 'provider customer display or export rights are incomplete' }
  }
  if (audience === 'business') {
    if (license.audience_modes && !license.audience_modes.includes('business')) {
      return { allowed: false, reason: 'provider contract excludes business audience use' }
    }
    if (!license.outreach_allowed) {
      return { allowed: false, reason: 'provider contract does not permit customer outreach use' }
    }
    return { allowed: true }
  }

  if (!license.audience_modes?.includes('consumer')) {
    return { allowed: false, reason: 'consumer customer-serving rights are not approved' }
  }
  if (
    license.manual_outreach_allowed !== true
    || license.retention_days == null
    || !descriptor.dsr.deletion_supported
  ) {
    return { allowed: false, reason: 'consumer display, manual-use, retention, or deletion rights are incomplete' }
  }
  if (entityKind === 'opportunity' && license.public_opportunity_use_allowed !== true) {
    return { allowed: false, reason: 'public demand-opportunity use is not approved' }
  }
  if (entityKind !== 'opportunity' && license.public_profile_contact_allowed !== true) {
    return { allowed: false, reason: 'public profile contact use is not approved' }
  }
  return { allowed: true }
}

function norm(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

function entryMatches(entry: string, requested: string): boolean {
  const e = norm(entry)
  return e === '*' || e === requested
}

function geographyMatches(entry: string, requested: string): boolean {
  const e = norm(entry)
  if (e === '*' || e === requested) return true
  // hierarchical: 'us' covers 'us-ca'; never the reverse
  return requested.startsWith(`${e}-`)
}

/*
 * Returns { covered: true } only when one single capability row covers EVERY
 * requested dimension. Anything missing, unknown, or uncovered returns
 * { covered: false, reason } so planning can surface "unsupported dimension"
 * BEFORE any spend and before any adapter invoke (SPEC-066 section 11.1).
 *
 * Fail-closed rules:
 * - signal_kind, entity_unit, and geography are always required
 * - channel is required for 'verify' and 'send' layer adapters, and is
 *   checked whenever provided for any layer
 */
export function capabilityCovers(
  descriptor: AdapterDescriptor,
  request: CapabilityRequest,
): CapabilityCoverage {
  const signalKind = norm(request.signal_kind)
  const entityUnit = norm(request.entity_unit)
  const geography = norm(request.geography)
  const channel = norm(request.channel)
  const channelRequired = descriptor.layer === 'verify' || descriptor.layer === 'send'

  if (!signalKind) return { covered: false, reason: 'missing required dimension: signal_kind' }
  if (!entityUnit) return { covered: false, reason: 'missing required dimension: entity_unit' }
  if (!geography) return { covered: false, reason: 'missing required dimension: geography' }
  if (channelRequired && !channel) {
    return { covered: false, reason: 'missing required dimension: channel' }
  }

  const bySignal = descriptor.capabilities.filter((cap) => norm(cap.signal_kind) === signalKind)
  if (bySignal.length === 0) {
    return { covered: false, reason: `unsupported signal_kind: ${signalKind}` }
  }

  const byUnit = bySignal.filter((cap) =>
    cap.entity_units.some((unit) => entryMatches(unit, entityUnit)),
  )
  if (byUnit.length === 0) {
    return { covered: false, reason: `unsupported entity_unit: ${entityUnit} for signal_kind ${signalKind}` }
  }

  const byGeo = byUnit.filter((cap) =>
    cap.geographies.some((geo) => geographyMatches(geo, geography)),
  )
  if (byGeo.length === 0) {
    return { covered: false, reason: `unsupported geography: ${geography} for signal_kind ${signalKind}` }
  }

  if (channel) {
    const byChannel = byGeo.filter((cap) =>
      cap.channels.some((entry) => entryMatches(entry, channel)),
    )
    if (byChannel.length === 0) {
      return { covered: false, reason: `unsupported channel: ${channel} for signal_kind ${signalKind}` }
    }
  }

  return { covered: true }
}
