import {
  GTM_ARTIFACT_RUBRIC_VERSION,
  gtmArtifactFixtureSchema,
  type GtmArtifactEvaluation,
  type GtmArtifactFixture,
} from './schemas'
import {
  classifyOpportunityIntent,
  realtorOpportunityNoiseReasons,
} from '../../lib/research/opportunity-quality'

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function normalized(value: unknown): string {
  return JSON.stringify(value).toLowerCase()
}

function sequenceIsDistinct(steps: unknown): boolean {
  if (!Array.isArray(steps) || steps.length < 2) return false
  const bodies = steps.map((step) => normalized(record(step)?.body ?? ''))
  if (bodies.some((body) => body.length < 30)) return false
  return new Set(bodies).size === bodies.length
}

const LOCATION_STOP_WORDS = new Set(['united', 'states', 'usa', 'us'])

function locationMatches(expected: string, observed: string | null): boolean {
  if (!observed) return false
  const tokens = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 2 && !LOCATION_STOP_WORDS.has(token))
  const actual = new Set(tokens(observed))
  return tokens(expected).some((token) => actual.has(token))
}

export function evaluateGtmArtifact(rawFixture: GtmArtifactFixture): GtmArtifactEvaluation {
  const fixture = gtmArtifactFixtureSchema.parse(rawFixture)
  const artifact = fixture.artifact
  const serialized = normalized(artifact)
  const hardFailures: string[] = []
  const qualityFailures: string[] = []

  if (serialized.includes(fixture.foreignCanary.toLowerCase())) hardFailures.push('foreign_scope_leakage')
  if (/bearer\s+[a-z0-9._-]{8,}|api[_-]?key|refresh[_-]?token|client[_-]?secret/.test(serialized)) {
    hardFailures.push('credential_leakage')
  }
  for (const prohibited of fixture.prohibitedClaims) {
    if (serialized.includes(prohibited.toLowerCase())) hardFailures.push('unsupported_claim_or_promise')
  }
  if (artifact.disposition !== fixture.expectedDisposition) hardFailures.push('wrong_disposition')
  if (
    (fixture.expectedDisposition === 'suppress' || fixture.expectedDisposition === 'blocked') &&
    strings(artifact.messages).length > 0
  ) {
    hardFailures.push('unsafe_message_present')
  }

  if (fixture.kind === 'audience_play') {
    for (const key of ['audience', 'signal', 'why_now', 'recommended_angle', 'estimate_basis']) {
      if (typeof artifact[key] !== 'string' || !artifact[key]) qualityFailures.push(`missing_${key}`)
    }
    if (!['measured', 'sampled', 'modeled', 'unknown'].includes(String(artifact.estimate_basis))) {
      hardFailures.push('dishonest_estimate_basis')
    }
  } else if (fixture.kind === 'qualification') {
    const criteria = Array.isArray(artifact.criteria) ? artifact.criteria : []
    if (criteria.length < 2) qualityFailures.push('criterion_level_fit_missing')
    if (criteria.some((criterion) => !record(criterion)?.evidence_ref))
      qualityFailures.push('criterion_evidence_missing')
    if (!strings(artifact.why_them).length) qualityFailures.push('why_them_missing')
  } else if (fixture.kind === 'research_plan') {
    if (!record(artifact.limits)) qualityFailures.push('limits_missing')
    if (typeof artifact.plan_hash !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.plan_hash)) {
      hardFailures.push('immutable_plan_hash_missing')
    }
    if (!Array.isArray(artifact.source_lanes) || artifact.source_lanes.length === 0) {
      qualityFailures.push('source_lanes_missing')
    }
  } else if (fixture.kind === 'sequence') {
    if (!sequenceIsDistinct(artifact.steps)) hardFailures.push('sequence_steps_not_distinct')
    if (strings(artifact.grounded_fact_refs).length === 0) qualityFailures.push('grounding_refs_missing')
  } else if (fixture.kind === 'reply_draft') {
    if (fixture.expectedDisposition === 'deliver') {
      const draft = record(artifact.draft)
      if (!draft || typeof draft.body !== 'string' || !draft.body.trim()) qualityFailures.push('draft_missing')
      if (typeof draft?.body === 'string' && draft.body.trim().split(/\s+/).length > 120) {
        qualityFailures.push('draft_too_long')
      }
    }
  } else if (fixture.kind === 'manual_outreach') {
    if (artifact.outreach_mode !== 'manual_only') hardFailures.push('consumer_automation_boundary_missing')
    const destination = typeof artifact.public_destination === 'string' ? artifact.public_destination : ''
    if (!/^https:\/\//.test(destination)) hardFailures.push('public_destination_missing')
    const body = typeof artifact.body === 'string' ? artifact.body.trim() : ''
    const wordCount = body ? body.split(/\s+/).length : 0
    if (wordCount < 20 || wordCount > 110) qualityFailures.push('manual_draft_length')
    if (strings(artifact.grounded_fact_refs).length === 0) qualityFailures.push('grounding_refs_missing')
    const actions = strings(artifact.allowed_actions)
    if (
      actions.length === 0 ||
      actions.some((action) => !['copy_message', 'open_public_profile', 'dismiss'].includes(action))
    ) {
      hardFailures.push('unsafe_consumer_action')
    }
  } else if (fixture.kind === 'opportunity') {
    if (artifact.outreach_mode !== 'manual_only') hardFailures.push('consumer_automation_boundary_missing')
    if (
      !['community', 'forum', 'group', 'thread', 'post', 'event', 'creator_audience'].includes(
        String(artifact.opportunity_kind),
      )
    ) {
      qualityFailures.push('opportunity_kind_missing')
    }
    if (!['buyer_intent', 'seller_intent', 'local_audience', 'mixed_intent'].includes(String(artifact.intent_kind))) {
      qualityFailures.push('intent_kind_missing')
    }
    const destination = typeof artifact.public_destination === 'string' ? artifact.public_destination : ''
    if (!/^https:\/\//.test(destination)) hardFailures.push('public_destination_missing')
    if (typeof artifact.audience_description !== 'string' || !artifact.audience_description.trim()) {
      qualityFailures.push('audience_description_missing')
    }
    if (typeof artifact.recommended_action !== 'string' || !artifact.recommended_action.trim()) {
      qualityFailures.push('recommended_action_missing')
    }
    if (strings(artifact.evidence_refs).length === 0) qualityFailures.push('grounding_refs_missing')
    const actions = strings(artifact.allowed_actions)
    if (
      actions.length === 0 ||
      actions.some((action) => !['open_public_destination', 'review_evidence', 'save', 'dismiss'].includes(action))
    ) {
      hardFailures.push('unsafe_consumer_action')
    }
    const label = fixture.opportunityQualityLabel
    if (label) {
      const detected: string[] = []
      const demonstratedIntent = classifyOpportunityIntent(label.observedContent).kind
      if (demonstratedIntent !== label.expectedIntent) detected.push('semantic_intent_mismatch')
      if (!locationMatches(label.playGeography, label.observedLocation)) detected.push('geography_mismatch')
      const observedAt = new Date(label.observedAt)
      const referenceTime = new Date(label.referenceTime)
      if ((referenceTime.getTime() - observedAt.getTime()) / 86_400_000 > 30) detected.push('stale_destination')
      if (label.eventStartAt && new Date(label.eventStartAt).getTime() < referenceTime.getTime()) {
        detected.push('expired_event')
      }
      if (!label.liveAccessible) detected.push('dead_or_inaccessible_destination')
      if (realtorOpportunityNoiseReasons(label.observedContent, destination).length > 0) {
        detected.push('realtor_false_positive')
      }
      if (!label.usefulEnoughToActOn) detected.push('not_useful_enough_to_act_on')
      if (label.duplicateOf) detected.push('duplicate_destination')

      const reasons = strings(artifact.quality_reasons)
      if (fixture.expectedDisposition === 'deliver') {
        if (detected.length > 0) qualityFailures.push(...detected)
      } else {
        for (const reason of label.expectedReasons) {
          if (!reasons.includes(reason)) qualityFailures.push(`quality_reason_missing:${reason}`)
        }
        for (const reason of detected) {
          if (!label.expectedReasons.includes(reason)) qualityFailures.push(`unexpected_quality_issue:${reason}`)
        }
      }
      if (demonstratedIntent && artifact.intent_kind !== demonstratedIntent) {
        qualityFailures.push('intent_not_supported_by_returned_content')
      }
      if (label.source === 'sanitized_live' && artifact.sanitized_fixture !== true) {
        hardFailures.push('live_fixture_not_sanitized')
      }
    }
  } else if (fixture.kind === 'failure_honesty') {
    if (typeof artifact.reason_code !== 'string' || !artifact.reason_code) hardFailures.push('failure_reason_missing')
    if (artifact.retryable !== false) qualityFailures.push('retry_posture_ambiguous')
  }

  const score = Math.max(0, 100 - qualityFailures.length * 15)
  return {
    fixtureId: fixture.id,
    rubricVersion: GTM_ARTIFACT_RUBRIC_VERSION,
    passed: hardFailures.length === 0 && score >= fixture.minimumScore,
    hardFailures: [...new Set(hardFailures)],
    score,
    qualityFailures,
  }
}
