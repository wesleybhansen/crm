import {
  GTM_CONSUMER_LEGAL_APPROVAL_VERSION,
  GTM_CONSUMER_QUALITY_APPROVAL_VERSION,
  gtmConsumerResearchEnabled,
  gtmConsumerResearchReleaseState,
} from '../flags'

const managedKeys = [
  'GTM_CONSUMER_RESEARCH_ENABLED',
  'GTM_CONSUMER_LEGAL_APPROVAL_VERSION',
  'GTM_CONSUMER_QUALITY_APPROVAL_VERSION',
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
})
