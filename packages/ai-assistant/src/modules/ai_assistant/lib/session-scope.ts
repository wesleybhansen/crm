import crypto from 'node:crypto'

/** Constant-time compare that never throws on differing lengths. */
function secretEquals(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest()
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest()
  return crypto.timingSafeEqual(ha, hb)
}

/**
 * Which `_sessionToken` a caller may present alongside its API key
 * (MCP sweep 2026-09-25, medium 6).
 *
 * A session token swaps the tool call's identity to the session user. It used
 * to be honoured whatever the API key's own tenant and organization were, so
 * any key holder who obtained another tenant's session token could act inside
 * that tenant through their own key. Now a session must belong to the key's
 * own tenant, and to its organization when the key is organization-scoped.
 *
 * The one exception is the platform's own assistant transport key
 * (MCP_SERVER_API_KEY, used by the in-app OpenCode assistant): by design it
 * carries no user identity of its own and serves every tenant's users through
 * their session tokens (ai_assistant AGENTS.md, "Two-Tier Authentication").
 */
export type ScopedKey = { tenantId?: string | null; organizationId?: string | null }

export function isPlatformTransportKey(providedSecret: string | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
  const configured = env.MCP_SERVER_API_KEY?.trim()
  if (!configured || !providedSecret) return false
  return secretEquals(providedSecret.trim(), configured)
}

export function sessionAllowedForKey(
  session: ScopedKey,
  key: ScopedKey,
  options: { transportKey: boolean },
): boolean {
  if (options.transportKey) return true
  const keyTenant = key.tenantId ?? null
  const sessionTenant = session.tenantId ?? null
  if (keyTenant !== sessionTenant) return false
  const keyOrg = key.organizationId ?? null
  if (keyOrg !== null && (session.organizationId ?? null) !== keyOrg) return false
  return true
}
