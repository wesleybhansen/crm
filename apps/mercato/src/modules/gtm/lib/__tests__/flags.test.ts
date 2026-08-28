import {
  GTM_CONSUMER_LEGAL_APPROVAL_VERSION,
  GTM_CONSUMER_OWNER_PROBE_CEILINGS,
  GTM_CONSUMER_QUALITY_APPROVAL_VERSION,
  gtmConsumerOwnerProbeEnabled,
  gtmConsumerResearchEnabled,
  gtmConsumerResearchReleaseState,
} from '../flags'

const managedKeys = [
  'GTM_CONSUMER_RESEARCH_ENABLED',
  'GTM_CONSUMER_LEGAL_APPROVAL_VERSION',
  'GTM_CONSUMER_QUALITY_APPROVAL_VERSION',
  'GTM_CONSUMER_OWNER_PROBE_ENABLED',
  'GTM_CONSUMER_OWNER_PROBE_NOLI_USER_ID',
] as const

describe('consumer research release gate', () => {
  const original = Object.fromEntries(managedKeys.map((key) => [key, process.env[key]]))

  beforeEach(() => {
    for (const key of managedKeys) delete process.env[key]
  })

  afterAll(() => {
    for (const key of managedKeys) {
      const value = original[key]
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('fails closed when only the feature flag is enabled', () => {
    process.env.GTM_CONSUMER_RESEARCH_ENABLED = 'true'
    expect(gtmConsumerResearchEnabled()).toBe(false)
    expect(gtmConsumerResearchReleaseState()).toMatchObject({
      featureEnabled: true,
      legalApproved: false,
      qualityApproved: false,
      holdReasons: [
        'consumer_legal_approval_missing',
        'consumer_quality_approval_missing',
      ],
    })
  })

  it('requires exact version-bound legal and quality approvals', () => {
    process.env.GTM_CONSUMER_RESEARCH_ENABLED = 'true'
    process.env.GTM_CONSUMER_LEGAL_APPROVAL_VERSION = GTM_CONSUMER_LEGAL_APPROVAL_VERSION
    process.env.GTM_CONSUMER_QUALITY_APPROVAL_VERSION = GTM_CONSUMER_QUALITY_APPROVAL_VERSION
    expect(gtmConsumerResearchEnabled()).toBe(true)
    expect(gtmConsumerResearchReleaseState()).toMatchObject({
      enabled: true,
      legalApproved: true,
      qualityApproved: true,
      holdReasons: [],
    })
  })

  it('rejects stale or generic approval values', () => {
    process.env.GTM_CONSUMER_RESEARCH_ENABLED = 'true'
    process.env.GTM_CONSUMER_LEGAL_APPROVAL_VERSION = 'approved'
    process.env.GTM_CONSUMER_QUALITY_APPROVAL_VERSION = 'realtor-opportunity-benchmark-v1'
    expect(gtmConsumerResearchEnabled()).toBe(false)
  })

  it('permits only the configured owner inside every probe ceiling', () => {
    const ownerId = '1992dd12-99d9-4a40-b053-4e4ac784081b'
    process.env.GTM_CONSUMER_RESEARCH_ENABLED = 'true'
    process.env.GTM_CONSUMER_OWNER_PROBE_ENABLED = 'true'
    process.env.GTM_CONSUMER_OWNER_PROBE_NOLI_USER_ID = ownerId
    expect(gtmConsumerOwnerProbeEnabled(ownerId, {
      targetAccepted: GTM_CONSUMER_OWNER_PROBE_CEILINGS.targetAccepted,
      maxRawCandidates: GTM_CONSUMER_OWNER_PROBE_CEILINGS.maxRawCandidates,
      maxCredits: GTM_CONSUMER_OWNER_PROBE_CEILINGS.maxCredits,
    })).toBe(true)
    expect(gtmConsumerOwnerProbeEnabled('another-owner', {
      targetAccepted: 10,
      maxRawCandidates: 60,
      maxCredits: 30_000,
    })).toBe(false)
    expect(gtmConsumerOwnerProbeEnabled(ownerId, {
      targetAccepted: 10,
      maxRawCandidates: 61,
      maxCredits: 30_000,
    })).toBe(false)
    expect(gtmConsumerOwnerProbeEnabled(ownerId, {
      targetAccepted: 10,
      maxRawCandidates: 60,
      maxCredits: 30_001,
    })).toBe(false)
  })
})
