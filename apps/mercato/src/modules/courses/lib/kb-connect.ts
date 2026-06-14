import 'server-only'
import type { EntityManager } from '@mikro-orm/postgresql'

/*
 * KB auto-connect (Noli App-Connectivity, Option A).
 *
 * CRM auto-connects to the user's Knowledge Base without a hand-pasted key,
 * matching AMS/PM/COS. If the current user has no cached KB key, we ask KB to
 * mint one server-to-server (proven by the shared platform secret, resolving
 * the user by their noli-core id) and cache it.
 *
 * Identity: KB's provision-key resolves a noliUserId (noli-core user id) → email
 * → KB-local user. CRM already carries the current user's noliUserId on its
 * AuthContext (set in lib/auth/clerk.ts, consumed by lib/usage/log.ts), so we
 * pass it straight through, so no email-side resolution is needed.
 *
 * Per-user caching (mirrors AMS settings.pkbApiKeys): each KB is a personal
 * Knowledge Base, but a CRM org is team-shared (every member of a noli-core org
 * shares ONE Mercato org). Caching one org-level key would mean every member
 * read whichever member first triggered connect, a cross-user exposure. So we
 * cache the minted key under business_profiles.pkb_api_keys[noliUserId] (a
 * { noliUserId: key } JSONB map) and resolve per current user.
 *
 * Manual paste: the legacy org-level business_profiles.pkb_api_key column stays
 * as a fallback. If set (a member explicitly pasted a shared key), it wins for
 * any member who has no per-user key. We never overwrite it.
 */

const KB_BASE_URL = (process.env.NOLI_KB_BASE_URL ?? 'https://kb.noliai.com').replace(/\/$/, '')

/* Mint a KB key for a noli user. Retries once on a 5xx (KB cold-start). */
async function provisionKbKey(noliUserId: string): Promise<string | null> {
  const secret = process.env.NOLI_INTERNAL_SERVICE_SECRET
  if (!secret) {
    console.error('[kb-connect] NOLI_INTERNAL_SERVICE_SECRET not set')
    return null
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${KB_BASE_URL}/api/internal/provision-key`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ noliUserId, source: 'crm' }),
      })
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as { key?: string }
        return data.key ?? null
      }
      // Retry once on a transient server error; bail on 4xx (auth/identity).
      if (res.status >= 500 && attempt === 0) {
        console.warn(`[kb-connect] provision-key ${res.status}, retrying`)
        continue
      }
      console.error('[kb-connect] provision-key failed', res.status)
      return null
    } catch (err) {
      if (attempt === 0) {
        console.warn('[kb-connect] provision-key error, retrying', err)
        continue
      }
      console.error('[kb-connect] provision-key error', err)
      return null
    }
  }
  return null
}

/* Parse the per-user { noliUserId: key } map (jsonb may arrive as object or text). */
function parseKeyMap(raw: unknown): Record<string, string> {
  if (!raw) return {}
  if (typeof raw === 'object') return raw as Record<string, string>
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
    } catch {
      return {}
    }
  }
  return {}
}

/*
 * Returns a working KB API key for the CURRENT user, or null if KB can't be
 * reached / the user can't be identified. Resolution order:
 *
 *   1. Per-user cached key: business_profiles.pkb_api_keys[noliUserId].
 *   2. Org-level manually pasted key: business_profiles.pkb_api_key (fallback
 *      shared across members; manual override is respected, never overwritten).
 *   3. Auto-provision via KB provision-key (source "crm"), then cache under
 *      pkb_api_keys[noliUserId] and return it.
 */
export async function ensureKbApiKey(
  knex: ReturnType<EntityManager['getKnex']>,
  orgId: string,
  noliUserId: string | null | undefined,
  tenantId?: string | null,
): Promise<string | null> {
  if (!orgId) return null

  const profile = await knex('business_profiles').where('organization_id', orgId).first()
  const keyMap = parseKeyMap(profile?.pkb_api_keys)

  // 1. Per-user cached key wins.
  if (noliUserId) {
    const perUser = typeof keyMap[noliUserId] === 'string' ? keyMap[noliUserId].trim() : ''
    if (perUser) return perUser
  }

  // 2. Org-level manually pasted key is the shared fallback.
  const pasted = typeof profile?.pkb_api_key === 'string' ? profile.pkb_api_key.trim() : ''
  if (pasted) return pasted

  if (!noliUserId) {
    console.error('[kb-connect] no noliUserId on auth context; cannot auto-provision')
    return null
  }

  // 3. Auto-provision and cache under this user's id.
  const key = await provisionKbKey(noliUserId)
  if (!key) return null

  try {
    const nextMap = { ...keyMap, [noliUserId]: key }
    // Every org gets a business_profiles row at setup, so this UPDATE matches in
    // practice. The INSERT branch is a rare fallback (tenant_id is NOT NULL on
    // the table, and organization_id has a UNIQUE constraint backing the upsert).
    const updated = await knex('business_profiles')
      .where('organization_id', orgId)
      .update({ pkb_api_keys: JSON.stringify(nextMap) })
    if (!updated && tenantId) {
      await knex('business_profiles')
        .insert({ organization_id: orgId, tenant_id: tenantId, pkb_api_keys: JSON.stringify(nextMap) })
        .onConflict('organization_id')
        .merge({ pkb_api_keys: JSON.stringify(nextMap) })
    }
  } catch (err) {
    // Caching is best-effort; still return the working key for this request.
    console.error('[kb-connect] failed to cache KB key', err)
  }

  return key
}
