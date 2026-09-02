/*
 * Frozen competitive reference from the owner-captured Origami run dated
 * 2026-07-22. This is not a claim about Origami's current product or pricing;
 * it is the exact observed comparator for Noli's controlled same-prompt run.
 */

export const ORIGAMI_LINKEDIN_REALTOR_REFERENCE = {
  referenceVersion: 'origami-linkedin-realtor-2026-07-22-v1',
  prompt:
    'Residential real estate agents, brokers, and team leads in the US who have recently engaged with LinkedIn posts about AI in real estate. Exclude commercial real estate, appraisers, proptech vendors, and investors without an agent license.',
  observed: {
    acceptedLeads: 15,
    disqualifiedLeads: 81,
    analyzedLeads: 96,
    displayedQualificationRate: 0.16,
    displayedUsdPerAcceptedLead: 0.046,
    visibleEngagementType: 'LIKE',
  },
} as const

export type CompetitiveParityInput = {
  acceptedLeads: number
  humanUsefulAcceptedLeads: number
  analyzedLeads: number
  totalCostUsd: number
  evidenceBackedLeads: number
  duplicateLeads: number
  unsupportedClaimCount: number
  sensitiveTargetingCount: number
}

export type CompetitiveParityGate = {
  id:
    | 'accepted_quantity'
    | 'human_useful_precision'
    | 'evidence_coverage'
    | 'duplicate_rate'
    | 'unsupported_claims'
    | 'sensitive_targeting'
    | 'cost_per_useful_lead'
  passed: boolean
  actual: number
  threshold: number
  comparator: '>=' | '<='
}

function safeCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function safeUsd(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

export function evaluateOrigamiLinkedInRealtorParity(input: CompetitiveParityInput): {
  referenceVersion: typeof ORIGAMI_LINKEDIN_REALTOR_REFERENCE.referenceVersion
  passed: boolean
  metrics: {
    humanUsefulPrecision: number
    evidenceCoverage: number
    duplicateRate: number
    costPerUsefulLeadUsd: number
  }
  gates: CompetitiveParityGate[]
} {
  const accepted = safeCount(input.acceptedLeads)
  const useful = Math.min(accepted, safeCount(input.humanUsefulAcceptedLeads))
  const analyzed = Math.max(accepted, safeCount(input.analyzedLeads))
  const evidenceBacked = Math.min(accepted, safeCount(input.evidenceBackedLeads))
  const duplicates = Math.min(analyzed, safeCount(input.duplicateLeads))
  const humanUsefulPrecision = accepted > 0 ? useful / accepted : 0
  const evidenceCoverage = accepted > 0 ? evidenceBacked / accepted : 0
  const duplicateRate = analyzed > 0 ? duplicates / analyzed : 0
  const costPerUsefulLeadUsd = useful > 0 ? safeUsd(input.totalCostUsd) / useful : Number.POSITIVE_INFINITY

  const gates: CompetitiveParityGate[] = [
    {
      id: 'accepted_quantity',
      passed: accepted >= ORIGAMI_LINKEDIN_REALTOR_REFERENCE.observed.acceptedLeads,
      actual: accepted,
      threshold: ORIGAMI_LINKEDIN_REALTOR_REFERENCE.observed.acceptedLeads,
      comparator: '>=',
    },
    {
      id: 'human_useful_precision',
      passed: humanUsefulPrecision >= 0.8,
      actual: humanUsefulPrecision,
      threshold: 0.8,
      comparator: '>=',
    },
    {
      id: 'evidence_coverage',
      passed: evidenceCoverage >= 1,
      actual: evidenceCoverage,
      threshold: 1,
      comparator: '>=',
    },
    {
      id: 'duplicate_rate',
      passed: duplicateRate <= 0.1,
      actual: duplicateRate,
      threshold: 0.1,
      comparator: '<=',
    },
    {
      id: 'unsupported_claims',
      passed: safeCount(input.unsupportedClaimCount) <= 0,
      actual: safeCount(input.unsupportedClaimCount),
      threshold: 0,
      comparator: '<=',
    },
    {
      id: 'sensitive_targeting',
      passed: safeCount(input.sensitiveTargetingCount) <= 0,
      actual: safeCount(input.sensitiveTargetingCount),
      threshold: 0,
      comparator: '<=',
    },
    {
      id: 'cost_per_useful_lead',
      passed:
        costPerUsefulLeadUsd <=
        ORIGAMI_LINKEDIN_REALTOR_REFERENCE.observed.displayedUsdPerAcceptedLead,
      actual: costPerUsefulLeadUsd,
      threshold: ORIGAMI_LINKEDIN_REALTOR_REFERENCE.observed.displayedUsdPerAcceptedLead,
      comparator: '<=',
    },
  ]

  return {
    referenceVersion: ORIGAMI_LINKEDIN_REALTOR_REFERENCE.referenceVersion,
    passed: gates.every((gate) => gate.passed),
    metrics: { humanUsefulPrecision, evidenceCoverage, duplicateRate, costPerUsefulLeadUsd },
    gates,
  }
}
