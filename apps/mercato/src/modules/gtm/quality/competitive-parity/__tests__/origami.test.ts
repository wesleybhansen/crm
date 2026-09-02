import {
  ORIGAMI_LINKEDIN_REALTOR_REFERENCE,
  evaluateOrigamiLinkedInRealtorParity,
} from '../origami'

describe('Origami same-prompt competitive parity gate', () => {
  it('freezes the owner-observed comparator without treating it as current external truth', () => {
    expect(ORIGAMI_LINKEDIN_REALTOR_REFERENCE).toEqual({
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
    })
  })

  it('passes a safer, evidence-complete Noli run at the observed cost and volume baseline', () => {
    const result = evaluateOrigamiLinkedInRealtorParity({
      acceptedLeads: 15,
      humanUsefulAcceptedLeads: 13,
      analyzedLeads: 50,
      totalCostUsd: 0.5,
      evidenceBackedLeads: 15,
      duplicateLeads: 2,
      unsupportedClaimCount: 0,
      sensitiveTargetingCount: 0,
    })
    expect(result.passed).toBe(true)
    expect(result.metrics).toEqual({
      humanUsefulPrecision: 13 / 15,
      evidenceCoverage: 1,
      duplicateRate: 2 / 50,
      costPerUsefulLeadUsd: 0.5 / 13,
    })
  })

  it('fails quantity, quality, evidence, duplicate, safety, and cost independently', () => {
    const result = evaluateOrigamiLinkedInRealtorParity({
      acceptedLeads: 10,
      humanUsefulAcceptedLeads: 6,
      analyzedLeads: 20,
      totalCostUsd: 1,
      evidenceBackedLeads: 9,
      duplicateLeads: 3,
      unsupportedClaimCount: 1,
      sensitiveTargetingCount: 1,
    })
    expect(result.passed).toBe(false)
    expect(result.gates.filter((gate) => !gate.passed).map((gate) => gate.id)).toEqual([
      'accepted_quantity',
      'human_useful_precision',
      'evidence_coverage',
      'duplicate_rate',
      'unsupported_claims',
      'sensitive_targeting',
      'cost_per_useful_lead',
    ])
  })
})
