import 'server-only'
import type { EntityManager } from '@mikro-orm/postgresql'

/*
 * KB auto-connect (Noli App-Connectivity, Option A).
 *
 * CRM auto-connects to the user's Knowledge Base without a hand-pasted key,
 * matching AMS/PM/COS. If the org's business_profiles row has no cached KB key,
 * we ask KB to mint one server-to-server (proven by the shared platform secret,
 * resolving the user by their noli-core id) and cache it in the SAME
 * business_profiles.pkb_api_key column the pasted key used to live in.
 *
 * Identity: KB's provision-key resolves a noliUserId (noli-core user id) → email
 * → KB-local user. CRM already carries the current user's noliUserId on its
 * AuthContext (set in lib/auth/clerk.ts, consumed by lib/usage/log.ts), so we
 * pass it straight through, so no email-side resolution is needed.
 *
 * Org-level caching: CRM data is team-shared (every member of a noli-core org
 * shares ONE Mercato org and is an org admin), so a single org-level KB key is
 * consistent with the rest of CRM. The key is minted for whichever member first
 * triggers connect. A manually pasted key always wins (we never overwrite it).
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

/*
 * Returns a working KB API key for the current org/user, or null if KB can't
 * be reached / the user can't be identified.
 *
 * - If business_profiles.pkb_api_key is already set (auto OR manually pasted),
 *   return it as-is (manual override is respected).
 * - Otherwise auto-provision via KB provision-key (source "crm"), persist into
 *   business_profiles.pkb_api_key, and return it.
 */
export async function ensureKbApiKey(
  knex: ReturnType<EntityManager['getKnex']>,
  orgId: string,
  noliUserId: string | null | undefined,
  tenantId?: string | null,
): Promise<string | null> {
  if (!orgId) return null

  const profile = await knex('business_profiles').where('organization_id', orgId).first()
  const existing = typeof profile?.pkb_api_key === 'string' ? profile.pkb_api_key.trim() : ''
  if (existing) return existing

  if (!noliUserId) {
    console.error('[kb-connect] no noliUserId on auth context; cannot auto-provision')
    return null
  }

  const key = await provisionKbKey(noliUserId)
  if (!key) return null

  try {
    // Persist into the same column the pasted key uses. Every org gets a
    // business_profiles row at setup, so this UPDATE matches in practice. The
    // INSERT branch is a rare fallback (tenant_id is NOT NULL on the table, and
    // organization_id has a UNIQUE constraint backing the upsert).
    const updated = await knex('business_profiles')
      .where('organization_id', orgId)
      .update({ pkb_api_key: key })
    if (!updated && tenantId) {
      await knex('business_profiles')
        .insert({ organization_id: orgId, tenant_id: tenantId, pkb_api_key: key })
        .onConflict('organization_id')
        .merge({ pkb_api_key: key })
    }
  } catch (err) {
    // Caching is best-effort; still return the working key for this request.
    console.error('[kb-connect] failed to cache KB key', err)
  }

  return key
}
