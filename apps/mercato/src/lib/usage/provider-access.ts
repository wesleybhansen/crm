export type ProviderAllowanceGate = {
  allowed: boolean
  message?: string
  byoApiKey?: string
}

export type SupportedAiProvider = 'google' | 'anthropic' | 'openai'

export type PlatformProviderKeys = {
  google?: string | null
  anthropic?: string | null
  openai?: string | null
}

export type ProviderAccess = {
  apiKey: string | null
  byoKey: boolean
  blocked: boolean
  message?: string
}

function presentKey(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function normalizeAiProvider(value: string | null | undefined): SupportedAiProvider {
  if (value === 'anthropic' || value === 'openai') return value
  return 'google'
}

export function resolvePlatformProviderApiKey(
  provider: SupportedAiProvider,
  keys: PlatformProviderKeys,
): string | null {
  return presentKey(keys[provider])
}

export function resolvePrimaryProviderAccess(
  gate: ProviderAllowanceGate,
  platformApiKey: string | null | undefined,
): ProviderAccess {
  if (!gate.allowed) {
    return { apiKey: null, byoKey: false, blocked: true, message: gate.message }
  }

  const byoApiKey = presentKey(gate.byoApiKey)
  if (byoApiKey) {
    return { apiKey: byoApiKey, byoKey: true, blocked: false }
  }

  return {
    apiKey: presentKey(platformApiKey),
    byoKey: false,
    blocked: false,
  }
}

/**
 * Resolve a cross-provider fallback without letting a provider-specific BYO
 * route spill onto a platform key. Once the primary gate proves the pool is
 * exhausted (either BYO or blocked), the fallback must also use that
 * provider's customer key. Rechecking the fallback remains necessary because
 * keys can be added or removed between attempts.
 */
export function resolveFallbackProviderAccess(
  primaryGate: ProviderAllowanceGate,
  fallbackGate: ProviderAllowanceGate,
  platformApiKey: string | null | undefined,
): ProviderAccess {
  if (!fallbackGate.allowed) {
    return { apiKey: null, byoKey: false, blocked: true, message: fallbackGate.message }
  }

  const fallbackByoApiKey = presentKey(fallbackGate.byoApiKey)
  const primaryRequiresByo = !primaryGate.allowed || presentKey(primaryGate.byoApiKey) !== null

  if (primaryRequiresByo && !fallbackByoApiKey) {
    return {
      apiKey: null,
      byoKey: false,
      blocked: true,
      message: fallbackGate.message ?? primaryGate.message,
    }
  }

  if (fallbackByoApiKey) {
    return { apiKey: fallbackByoApiKey, byoKey: true, blocked: false }
  }

  return {
    apiKey: presentKey(platformApiKey),
    byoKey: false,
    blocked: false,
  }
}
