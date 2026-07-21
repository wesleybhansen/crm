import {
  normalizeAiProvider,
  resolveFallbackProviderAccess,
  resolvePlatformProviderApiKey,
  resolvePrimaryProviderAccess,
} from '../provider-access'

describe('provider-specific allowance access', () => {
  it.each([
    ['google', 'google'],
    ['anthropic', 'anthropic'],
    ['openai', 'openai'],
    ['unknown-provider', 'google'],
    [undefined, 'google'],
  ] as const)('normalizes configured provider %s to %s', (configured, expected) => {
    expect(normalizeAiProvider(configured)).toBe(expected)
  })

  it.each([
    ['google', 'platform-google'],
    ['anthropic', 'platform-anthropic'],
    ['openai', 'platform-openai'],
  ] as const)('selects only the %s platform credential', (provider, expected) => {
    expect(resolvePlatformProviderApiKey(provider, {
      google: 'platform-google',
      anthropic: 'platform-anthropic',
      openai: 'platform-openai',
    })).toBe(expected)
  })

  it('uses the platform key while the primary provider is within allowance', () => {
    expect(resolvePrimaryProviderAccess({ allowed: true }, 'platform-google')).toEqual({
      apiKey: 'platform-google',
      byoKey: false,
      blocked: false,
    })
  })

  it('prefers the primary provider customer key after allowance exhaustion', () => {
    expect(resolvePrimaryProviderAccess({ allowed: true, byoApiKey: 'byo-google' }, 'platform-google')).toEqual({
      apiKey: 'byo-google',
      byoKey: true,
      blocked: false,
    })
  })

  it('preserves an authoritative primary allowance block', () => {
    expect(resolvePrimaryProviderAccess({ allowed: false, message: 'cap' }, 'platform-google')).toEqual({
      apiKey: null,
      byoKey: false,
      blocked: true,
      message: 'cap',
    })
  })

  it('permits a platform fallback only when the primary used platform allowance', () => {
    expect(resolveFallbackProviderAccess(
      { allowed: true },
      { allowed: true },
      'platform-openai',
    )).toEqual({
      apiKey: 'platform-openai',
      byoKey: false,
      blocked: false,
    })
  })

  it('uses the fallback provider customer key when both providers are BYO', () => {
    expect(resolveFallbackProviderAccess(
      { allowed: true, byoApiKey: 'byo-google' },
      { allowed: true, byoApiKey: 'byo-openai' },
      'platform-openai',
    )).toEqual({
      apiKey: 'byo-openai',
      byoKey: true,
      blocked: false,
    })
  })

  it('does not spill from a primary customer key onto the fallback platform key', () => {
    expect(resolveFallbackProviderAccess(
      { allowed: true, byoApiKey: 'byo-google' },
      { allowed: true },
      'platform-openai',
    )).toEqual({
      apiKey: null,
      byoKey: false,
      blocked: true,
    })
  })

  it('does not turn a primary cap denial into a fail-open platform fallback', () => {
    expect(resolveFallbackProviderAccess(
      { allowed: false, message: 'cap' },
      { allowed: true },
      'platform-openai',
    )).toEqual({
      apiKey: null,
      byoKey: false,
      blocked: true,
      message: 'cap',
    })
  })

  it('preserves an authoritative fallback-provider allowance block', () => {
    expect(resolveFallbackProviderAccess(
      { allowed: true },
      { allowed: false, message: 'fallback cap' },
      'platform-openai',
    )).toEqual({
      apiKey: null,
      byoKey: false,
      blocked: true,
      message: 'fallback cap',
    })
  })

  it('allows a fallback customer key when the primary provider has none', () => {
    expect(resolveFallbackProviderAccess(
      { allowed: false, message: 'cap' },
      { allowed: true, byoApiKey: 'byo-openai' },
      'platform-openai',
    )).toEqual({
      apiKey: 'byo-openai',
      byoKey: true,
      blocked: false,
    })
  })

  it('distinguishes missing configuration from an allowance block', () => {
    expect(resolveFallbackProviderAccess(
      { allowed: true },
      { allowed: true },
      undefined,
    )).toEqual({
      apiKey: null,
      byoKey: false,
      blocked: false,
    })
  })
})
