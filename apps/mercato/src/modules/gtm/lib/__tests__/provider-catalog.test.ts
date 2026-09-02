import { selectedProviderCatalog } from '../adapters/provider-catalog'

describe('selected GTM provider catalog', () => {
  it('publishes only the selected DataForSEO and Apify stack with frozen unit economics', () => {
    const catalog = selectedProviderCatalog(2)

    expect(catalog.basis).toEqual({
      credits_per_usd: 250_000,
      markup_multiplier: 2,
      quote_posture: 'estimate_until_reserved',
    })
    expect(catalog.items.map((row) => row.id)).toEqual([
      'dataforseo-google-maps',
      'dataforseo-google-organic-opportunities',
      'dataforseo-google-events-opportunities',
      'apify-linkedin-company-search',
      'apify-linkedin-post-comments',
      'apify-linkedin-commenter-leads',
      'apify-linkedin-profile',
      'apify-linkedin-profile-email',
      'apify-public-website-email',
      'apify-email-verification',
    ])
    expect(catalog.items.map((row) => row.provider_usd_per_unit)).toEqual([
      0.002,
      0.002,
      0.002,
      0.004,
      0.002,
      0.002,
      0.004,
      0.01,
      0.01,
      0.0037,
    ])
    expect(catalog.items.map((row) => row.estimated_noli_credits_per_unit)).toEqual([
      1_000,
      1_000,
      1_000,
      2_000,
      1_000,
      1_000,
      2_000,
      5_000,
      5_000,
      1_850,
    ])
    expect(catalog.items.at(-1)).toMatchObject({
      name: 'Mailbox verification',
      max_results_per_request: 1,
      price_version:
        'automation-lab-email-enrichment-0.1.49-bronze-0.001-start-0.0027-per-row-2026-08-29',
    })
  })

  it('contains no runtime, credential, token, or account fields', () => {
    const serialized = JSON.stringify(selectedProviderCatalog(2)).toLowerCase()
    for (const forbidden of ['credential', 'password', 'token', 'account_id', 'enabled']) {
      expect(serialized).not.toContain(forbidden)
    }
  })
})
