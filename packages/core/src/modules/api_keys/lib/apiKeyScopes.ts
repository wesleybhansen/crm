/**
 * API key scope enforcement (SPEC-062 Phase 4).
 *
 * Scopes are an OPTIONAL narrowing of the key's role permissions. When the
 * key has no scopes (null/empty), behavior is identical to pre-Phase-4:
 * role features alone decide access. When scopes are set, EVERY feature
 * required by the requested route must match at least one scope pattern.
 *
 * Scopes cannot grant features the role doesn't already have — that check
 * runs first. Scopes can only restrict further.
 *
 * Pattern syntax:
 *   exact:    "customers.people.view"      matches "customers.people.view"
 *   prefix:   "customers.people.*"         matches "customers.people.anything"
 *   module:   "customers.*"                matches "customers.whatever.else"
 *   root:     "*"                          matches everything (useless as a narrow)
 */

function scopeMatches(scope: string, required: string): boolean {
  if (scope === required) return true
  if (scope === '*') return true
  if (scope.endsWith('.*')) {
    const prefix = scope.slice(0, -2) + '.'
    return required === scope.slice(0, -2) || required.startsWith(prefix)
  }
  return false
}

/**
 * Check whether a set of required features is covered by the key's scopes.
 *
 * - Returns `allowed: true, applies: false` when the key has no scopes
 *   (the caller should fall back to role-only enforcement).
 * - Returns `allowed: false` with the first uncovered feature when a scope
 *   list is present but doesn't cover one of the required features.
 */
export function checkApiKeyScopes(
  scopes: string[] | null | undefined,
  requiredFeatures: readonly string[] | undefined,
): { allowed: true; applies: boolean } | { allowed: false; missingFeature: string } {
  if (!scopes || scopes.length === 0) return { allowed: true, applies: false }
  const required = Array.isArray(requiredFeatures) ? requiredFeatures.filter((f) => typeof f === 'string' && f.length > 0) : []
  if (required.length === 0) {
    // No features required — routes without a feature gate (e.g. public
    // GETs) are callable regardless of scope. This keeps things predictable;
    // users who want a public route off a scoped key can just not expose
    // the key publicly.
    return { allowed: true, applies: true }
  }
  const normalizedScopes = scopes.map((s) => String(s).trim()).filter(Boolean)
  for (const feature of required) {
    const covered = normalizedScopes.some((scope) => scopeMatches(scope, feature))
    if (!covered) return { allowed: false, missingFeature: feature }
  }
  return { allowed: true, applies: true }
}
