import crypto from 'crypto'
import {
  capabilityCovers,
  type AdapterDescriptor,
  type AdapterResult,
  type Candidate,
  type ContactPoint,
  type EnrichAdapter,
  type EnrichRequest,
  type SourceAdapter,
  type SourceSearchPlan,
  type VerificationOutcome,
  type VerificationState,
  type VerifyAdapter,
  type VerifyRequest,
} from './types'
import rawFixtureData from './__fixtures__/fixture-data.json'

/*
 * Deterministic fixture adapter (SPEC-066 section 11.3): implements the
 * source, enrich, and verify layers from a versioned JSON fixture file so
 * every acceptance test runs with zero provider calls.
 *
 * Determinism rules:
 * - No Math.random and no Date.now anywhere: timestamps come from the fixed
 *   fixture clock, ids from a SHA-256 hash of the canonicalized input.
 * - Same input (same call_sequence) always produces a byte-identical result.
 * - Multi-call behavior (delayed completion, webhook replay) is driven by the
 *   caller-supplied `call_sequence` argument, never by hidden adapter state.
 *
 * Crafted cases are selected by a trigger token embedded in the input text
 * (source: plan.query, enrich: candidate name/company, verify: value); inputs
 * without a trigger take the normal path. Identities are synthetic only.
 *
 * Every result - including errors - carries the receipt fields declared in
 * the descriptor's ambiguity_contract, and every invoke re-runs the
 * capability check so an uncovered request fails closed even on direct call.
 */

type FixtureCaseId =
  | 'no_result'
  | 'partial'
  | 'timeout'
  | 'invalid_schema'
  | 'rate_limit'
  | 'provider_5xx'
  | 'delayed_completion'
  | 'webhook_replay'
  | 'ambiguous_acceptance'

type FixtureData = {
  version: number
  clock: string
  triggers: Record<FixtureCaseId, string>
  source_candidates: Candidate[]
  enrich_contact_points: Record<string, ContactPoint[]>
  verify_states: Record<string, VerificationState>
}

const fixtureData = rawFixtureData as unknown as FixtureData

export const FIXTURE_RECEIPT_FIELDS = [
  'provider_request_id',
  'provider_status',
  'input_hash',
  'attempted_at',
] as const

// ---------------------------------------------------------------------------
// Deterministic primitives
// ---------------------------------------------------------------------------

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
  return `{${entries.join(',')}}`
}

// Input identity hash: call_sequence is excluded so the "same input" keeps the
// same operation/receipt ids across sequential calls (delayed completion,
// webhook replay).
function inputHash(input: Record<string, unknown>): string {
  const { call_sequence: _ignored, ...rest } = input
  return crypto.createHash('sha256').update(canonicalJson(rest)).digest('hex')
}

function hashInt(hash: string): number {
  return parseInt(hash.slice(0, 8), 16)
}

function detectCase(text: string): FixtureCaseId | null {
  const haystack = text.toLowerCase()
  for (const [caseId, trigger] of Object.entries(fixtureData.triggers)) {
    if (haystack.includes(trigger.toLowerCase())) return caseId as FixtureCaseId
  }
  return null
}

function baseReceipt(hash: string, providerStatus: string): Record<string, unknown> {
  return {
    provider_request_id: `fixt_req_${hash.slice(0, 16)}`,
    provider_status: providerStatus,
    input_hash: hash.slice(0, 32),
    attempted_at: fixtureData.clock,
  }
}

// Charged units for a definitive (non-error, non-ambiguous) outcome.
function definitiveCost(descriptor: AdapterDescriptor, unitsFound: number): number {
  return descriptor.cost_model.pay_on_found ? unitsFound : 1
}

function unitCount(data: unknown): number {
  return Array.isArray(data) ? data.length : data == null ? 0 : 1
}

/*
 * Shared crafted-case machinery. Returns null when no trigger matched (normal
 * path). `makeData` builds the layer's full success payload; `makePartial`
 * builds the truncated payload for the 'partial' case.
 */
function craftedResult<T>(
  descriptor: AdapterDescriptor,
  caseId: FixtureCaseId | null,
  hash: string,
  callSequence: number,
  makeData: () => T,
  makePartial: () => T,
): AdapterResult<T> | null {
  if (!caseId) return null
  switch (caseId) {
    case 'no_result':
      return {
        status: 'no_result',
        data: null,
        receipt: baseReceipt(hash, 'no_result'),
        cost_units: descriptor.cost_model.pay_on_found ? 0 : 1,
      }
    case 'partial': {
      const data = makePartial()
      return {
        status: 'partial',
        data,
        receipt: { ...baseReceipt(hash, 'partial'), truncated: true },
        cost_units: definitiveCost(descriptor, unitCount(data)),
      }
    }
    case 'timeout':
      // ambiguity_contract.timeout_is_ambiguous: unknown outcome, never retried
      return {
        status: descriptor.ambiguity_contract.timeout_is_ambiguous ? 'ambiguous' : 'error',
        data: null,
        receipt: baseReceipt(hash, 'timeout'),
        cost_units: null,
        error: 'timeout: no provider response within the deadline',
      }
    case 'invalid_schema':
      return {
        status: 'error',
        data: null,
        receipt: baseReceipt(hash, 'invalid_schema'),
        cost_units: 0,
        error: 'invalid_schema: provider payload failed schema validation',
      }
    case 'rate_limit':
      return {
        status: 'error',
        data: null,
        receipt: { ...baseReceipt(hash, 'rate_limited'), retry_after_seconds: 60 },
        cost_units: 0,
        error: 'rate_limit: provider throttled the request',
      }
    case 'provider_5xx':
      return {
        status: 'error',
        data: null,
        receipt: { ...baseReceipt(hash, 'http_500'), http_status: 500 },
        cost_units: 0,
        error: 'provider_5xx: upstream returned HTTP 500',
      }
    case 'delayed_completion': {
      const operationRef = `fixt_op_${hash.slice(0, 12)}`
      if (callSequence <= 1) {
        return {
          status: 'ambiguous',
          data: null,
          receipt: {
            ...baseReceipt(hash, 'pending'),
            operation_ref: operationRef,
            pending: true,
          },
          cost_units: null,
          error: 'delayed_completion: result pending, poll the same operation',
        }
      }
      const data = makeData()
      return {
        status: 'ok',
        data,
        receipt: {
          ...baseReceipt(hash, 'completed'),
          operation_ref: operationRef,
          pending: false,
          resolved_on_call: callSequence,
        },
        cost_units: definitiveCost(descriptor, unitCount(data)),
      }
    }
    case 'webhook_replay': {
      // The SAME receipt id arrives on every delivery of this outcome; only
      // the delivery number differs, so consumers must dedupe on receipt_id.
      const data = makeData()
      return {
        status: 'ok',
        data,
        receipt: {
          ...baseReceipt(hash, 'completed'),
          receipt_id: `fixt_rcpt_${hash.slice(0, 12)}`,
          webhook_replay: true,
          delivery_number: callSequence,
        },
        cost_units: definitiveCost(descriptor, unitCount(data)),
      }
    }
    case 'ambiguous_acceptance':
      return {
        status: 'ambiguous',
        data: null,
        receipt: {
          ...baseReceipt(hash, 'accepted_unconfirmed'),
          acceptance_indicator: 'unknown',
        },
        cost_units: null,
        error: 'ambiguous_acceptance: provider accepted without confirming the outcome',
      }
  }
}

// Fail-closed invoke-path guard (SPEC-066 section 11.1: a contract-disabled
// capability cannot run even by direct call).
function uncoveredResult<T>(hash: string, reason: string): AdapterResult<T> {
  return {
    status: 'error',
    data: null,
    receipt: baseReceipt(hash, 'unsupported'),
    cost_units: 0,
    error: `unsupported_capability: ${reason}`,
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
}

// ---------------------------------------------------------------------------
// Descriptors
// ---------------------------------------------------------------------------

export const fixtureSourceDescriptor: AdapterDescriptor = {
  contract_version: '2',
  adapter_id: 'fixture-source',
  layer: 'source',
  capabilities: [
    { signal_kind: 'hiring_activity', entity_units: ['companies', 'people'], geographies: ['US'], channels: [] },
    { signal_kind: 'funding_event', entity_units: ['companies'], geographies: ['US'], channels: [] },
  ],
  constraints: {
    license: {
      status: 'test_only',
      terms_version: `fixture-v${fixtureData.version}`,
      export: true,
      customer_display: true,
      outreach_allowed: true,
      retention_days: 90,
    },
    rate_limits: { requests_per_minute: 60 },
    max_batch: 25,
  },
  cost_model: {
    unit: 'candidate',
    quoted_credits_per_unit: 1,
    price_version: `fixture-v${fixtureData.version}`,
    pay_on_found: true,
  },
  evidence_policy: {
    source_url: 'required',
    observed_at: 'required',
    max_age_days: 365,
    min_confidence: 0.5,
  },
  ambiguity_contract: { timeout_is_ambiguous: true, receipt_fields: [...FIXTURE_RECEIPT_FIELDS] },
  dsr: { deletion_supported: true },
}

export const fixtureEnrichDescriptor: AdapterDescriptor = {
  contract_version: '2',
  adapter_id: 'fixture-enrich',
  layer: 'enrich',
  capabilities: [
    {
      signal_kind: 'contact_discovery',
      entity_units: ['people', 'companies'],
      geographies: ['US'],
      channels: ['email', 'linkedin'],
    },
  ],
  constraints: {
    license: {
      status: 'test_only',
      terms_version: `fixture-v${fixtureData.version}`,
      export: true,
      customer_display: true,
      outreach_allowed: true,
      retention_days: 90,
    },
    rate_limits: { requests_per_minute: 120 },
    max_batch: 25,
  },
  cost_model: {
    unit: 'contact_point',
    quoted_credits_per_unit: 2,
    price_version: `fixture-v${fixtureData.version}`,
    pay_on_found: true,
  },
  evidence_policy: {
    source_url: 'not_applicable',
    observed_at: 'not_applicable',
    max_age_days: null,
    min_confidence: 0,
  },
  ambiguity_contract: { timeout_is_ambiguous: true, receipt_fields: [...FIXTURE_RECEIPT_FIELDS] },
  dsr: { deletion_supported: true },
}

export const fixtureVerifyDescriptor: AdapterDescriptor = {
  contract_version: '2',
  adapter_id: 'fixture-verify',
  layer: 'verify',
  capabilities: [
    { signal_kind: 'email_verification', entity_units: ['contacts'], geographies: ['*'], channels: ['email'] },
  ],
  constraints: {
    license: {
      status: 'test_only',
      terms_version: `fixture-v${fixtureData.version}`,
      export: true,
      customer_display: true,
      outreach_allowed: true,
      retention_days: 90,
    },
    rate_limits: { requests_per_minute: 300 },
    max_batch: 25,
  },
  cost_model: {
    unit: 'verification',
    quoted_credits_per_unit: 1,
    price_version: `fixture-v${fixtureData.version}`,
    pay_on_found: false,
  },
  evidence_policy: {
    source_url: 'not_applicable',
    observed_at: 'not_applicable',
    max_age_days: null,
    min_confidence: 0,
  },
  ambiguity_contract: { timeout_is_ambiguous: true, receipt_fields: [...FIXTURE_RECEIPT_FIELDS] },
  dsr: { deletion_supported: true },
}

// ---------------------------------------------------------------------------
// Source layer
// ---------------------------------------------------------------------------

function wantsCompanies(entityUnit: string): boolean {
  return entityUnit.trim().toLowerCase().startsWith('compan')
}

function sourceMatches(plan: SourceSearchPlan): Candidate[] {
  const pool = fixtureData.source_candidates.filter((candidate) =>
    wantsCompanies(plan.entity_unit)
      ? candidate.entity_kind === 'company'
      : candidate.entity_kind === 'person',
  )
  if (pool.length === 0) return []
  // Deterministic rotation seeded by the input hash, capped by both the
  // requested max and the descriptor's max_batch.
  const hash = inputHash(plan as unknown as Record<string, unknown>)
  const offset = hashInt(hash) % pool.length
  const rotated = [...pool.slice(offset), ...pool.slice(0, offset)]
  const cap = Math.min(
    Math.max(plan.max_candidates, 0),
    fixtureSourceDescriptor.constraints.max_batch,
    rotated.length,
  )
  return rotated.slice(0, cap)
}

export const fixtureSourceAdapter: SourceAdapter = {
  descriptor: fixtureSourceDescriptor,
  quote(plan) {
    const maxCandidates = Math.max(
      0,
      Math.min(Math.floor(plan.max_candidates), fixtureSourceDescriptor.constraints.max_batch),
    )
    return {
      max_candidates: maxCandidates,
      provider_units: maxCandidates,
      billable_unit: fixtureSourceDescriptor.cost_model.unit,
      expected_candidates: {
        low: Math.min(maxCandidates, fixtureData.source_candidates.length),
        high: maxCandidates,
        basis: 'contract',
      },
      quoted_credits_per_unit: fixtureSourceDescriptor.cost_model.quoted_credits_per_unit,
      estimated_credits_before_markup:
        maxCandidates * fixtureSourceDescriptor.cost_model.quoted_credits_per_unit,
    }
  },
  async search(plan: SourceSearchPlan): Promise<AdapterResult<Candidate[]>> {
    const hash = inputHash(plan as unknown as Record<string, unknown>)
    const coverage = capabilityCovers(fixtureSourceDescriptor, plan)
    if (!coverage.covered) return uncoveredResult(hash, coverage.reason ?? 'not covered')

    const crafted = craftedResult<Candidate[]>(
      fixtureSourceDescriptor,
      detectCase(plan.query),
      hash,
      plan.call_sequence ?? 1,
      () => sourceMatches(plan),
      () => sourceMatches(plan).slice(0, 1),
    )
    if (crafted) return crafted

    const data = sourceMatches(plan)
    if (data.length === 0) {
      return {
        status: 'no_result',
        data: null,
        receipt: baseReceipt(hash, 'no_result'),
        cost_units: 0,
      }
    }
    return {
      status: 'ok',
      data,
      receipt: { ...baseReceipt(hash, 'completed'), matched: data.length },
      cost_units: definitiveCost(fixtureSourceDescriptor, data.length),
    }
  },
}

// ---------------------------------------------------------------------------
// Enrich layer
// ---------------------------------------------------------------------------

function enrichMatches(request: EnrichRequest): ContactPoint[] {
  const name = request.candidate.identity.name
  const known = fixtureData.enrich_contact_points[name]
  if (known) return known.filter((point) => point.channel === request.channel)
  // Unknown synthetic identity: derive a deterministic contact point.
  if (request.channel === 'email') {
    const domain = request.candidate.identity.domain || 'synthetic-fallback.example'
    return [
      {
        channel: 'email',
        value: `${slugify(name)}@${domain}`,
        provenance: { method: 'derived_pattern', pattern: 'slug@domain' },
      },
    ]
  }
  return []
}

export const fixtureEnrichAdapter: EnrichAdapter = {
  descriptor: fixtureEnrichDescriptor,
  async enrich(request: EnrichRequest): Promise<AdapterResult<ContactPoint[]>> {
    const hash = inputHash(request as unknown as Record<string, unknown>)
    const coverage = capabilityCovers(fixtureEnrichDescriptor, request)
    if (!coverage.covered) return uncoveredResult(hash, coverage.reason ?? 'not covered')

    const triggerText = `${request.candidate.identity.name} ${request.candidate.identity.company ?? ''}`
    const crafted = craftedResult<ContactPoint[]>(
      fixtureEnrichDescriptor,
      detectCase(triggerText),
      hash,
      request.call_sequence ?? 1,
      () => enrichMatches(request),
      () => enrichMatches(request).slice(0, 1),
    )
    if (crafted) return crafted

    const data = enrichMatches(request)
    if (data.length === 0) {
      return {
        status: 'no_result',
        data: null,
        receipt: baseReceipt(hash, 'no_result'),
        cost_units: 0,
      }
    }
    return {
      status: 'ok',
      data,
      receipt: { ...baseReceipt(hash, 'completed'), matched: data.length },
      cost_units: definitiveCost(fixtureEnrichDescriptor, data.length),
    }
  },
}

// ---------------------------------------------------------------------------
// Verify layer
// ---------------------------------------------------------------------------

function verifyOutcome(request: VerifyRequest): VerificationOutcome {
  const mapped = fixtureData.verify_states[request.value.trim().toLowerCase()]
  return {
    channel: request.channel,
    value: request.value,
    // Unmapped synthetic addresses verify as catch_all: deterministic and
    // deliberately NOT 'verified', so tests must opt in to a verified address.
    verification_state: mapped ?? 'catch_all',
  }
}

export const fixtureVerifyAdapter: VerifyAdapter = {
  descriptor: fixtureVerifyDescriptor,
  async verify(request: VerifyRequest): Promise<AdapterResult<VerificationOutcome>> {
    const hash = inputHash(request as unknown as Record<string, unknown>)
    const coverage = capabilityCovers(fixtureVerifyDescriptor, request)
    if (!coverage.covered) return uncoveredResult(hash, coverage.reason ?? 'not covered')

    const crafted = craftedResult<VerificationOutcome>(
      fixtureVerifyDescriptor,
      detectCase(request.value),
      hash,
      request.call_sequence ?? 1,
      () => verifyOutcome(request),
      () => ({ ...verifyOutcome(request), verification_state: 'found' as const }),
    )
    if (crafted) return crafted

    const outcome = verifyOutcome(request)
    return {
      status: 'ok',
      data: outcome,
      receipt: { ...baseReceipt(hash, 'completed'), verification_state: outcome.verification_state },
      cost_units: definitiveCost(fixtureVerifyDescriptor, 1),
    }
  },
}
