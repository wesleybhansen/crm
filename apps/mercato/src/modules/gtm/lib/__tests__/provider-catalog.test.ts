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
      'apify-linkedin-post-comments',
      'apify-linkedin-profile',
      'apify-linkedin-profile-email',
    ])
    expect(catalog.items.map((row) => row.provider_usd_per_unit)).toEqual([
      0.002,
      0.002,
      0.004,
      0.01,
    ])
    expect(catalog.items.map((row) => row.estimated_noli_credits_per_unit)).toEqual([
      1_000,
      1_000,
      2_000,
      5_000,
    ])
  })

  it('contains no runtime, credential, token, or account fields', () => {
    const serialized = JSON.stringify(selectedProviderCatalog(2)).toLowerCase()
    for (const forbidden of ['credential', 'password', 'token', 'account_id', 'enabled']) {
      expect(serialized).not.toContain(forbidden)
    }
  })
})
