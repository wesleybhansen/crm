import 'server-only'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AuthContext } from './server'

/**
 * Resolve a Clerk session id to a Mercato AuthContext.
 *
 * Pipeline:
 *   1. Verify the user exists in noli-core (the cross-app users table) and
 *      has an active 'crm' entitlement. If either check fails, return null
 *      so the caller can 401/redirect-to-upgrade.
 *   2. Look up Mercato User by `clerk_user_id`. Found → build AuthContext.
 *   3. Email-fallback identity linking: if no row matches by clerk_user_id
 *      but a row exists with the same email_hash and a NULL clerk_user_id,
 *      stamp the Clerk id onto that row. This preserves legacy user data
 *      from before the Clerk migration (Wesley was relinked manually in
 *      Phase A4; this path catches any other pre-existing user once they
 *      first sign in).
 *   4. If still no row found, return null. Auto-provisioning of brand-new
 *      users is intentionally NOT implemented in v1 — Mercato's
 *      tenant-DEK envelope encryption + EncryptionMap setup makes this
 *      non-trivial and we have exactly one real user (Wesley) at cutover.
 *      Track as a Phase G+ follow-up if/when a second Noli user appears.
 *
 * Returns null on any failure (no noli-core user, not entitled, no Mercato
 * row, DB error). Caller's responsibility is to translate null to 401.
 */
export async function resolveClerkUserToAuthContext(
  clerkUserId: string,
): Promise<AuthContext> {
  if (!clerkUserId) return null

  // 1. noli-core lookup + entitlement gate
  let noliUser:
    | {
        id: string
        clerk_user_id: string
        email: string
        first_name: string | null
        last_name: string | null
      }
    | null = null
  try {
    const { findUserByClerkId, isEntitled } = await import(
      '@open-mercato/shared/lib/noli/core-client'
    )
    noliUser = await findUserByClerkId(clerkUserId)
    if (!noliUser) return null
    const entitled = await isEntitled(noliUser.id, 'crm')
    if (!entitled) return null
  } catch (err) {
    console.error('[clerk-auth] noli-core lookup failed:', err)
    return null
  }

  // 2. Resolve to Mercato User
  try {
    const { createRequestContainer } = await import(
      '@open-mercato/shared/lib/di/container'
    )
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const { User, UserRole } = await import(
      '@open-mercato/core/modules/auth/data/entities'
    )
    const { computeEmailHash } = await import(
      '@open-mercato/core/modules/auth/lib/emailHash'
    )

    let user = await em.findOne(User, { clerkUserId })

    // 3. Email-fallback: stamp clerk_user_id onto a pre-Clerk legacy row.
    if (!user && noliUser.email) {
      const emailHash = computeEmailHash(noliUser.email)
      const byHash = await em.findOne(User, {
        emailHash,
        clerkUserId: null,
        deletedAt: null,
      })
      if (byHash) {
        byHash.clerkUserId = clerkUserId
        await em.persistAndFlush(byHash)
        user = byHash
      }
    }

    if (!user) {
      // No auto-provisioning yet (see header). Caller treats null as 401.
      console.warn(
        `[clerk-auth] No Mercato User for clerkUserId=${clerkUserId} email=${noliUser.email}. ` +
          'Auto-provisioning is a Phase G+ feature.',
      )
      return null
    }

    // 4. Resolve role names for downstream requireRoles checks.
    const links = await em.find(
      UserRole,
      { user, deletedAt: null },
      { populate: ['role'] },
    )
    const roleNames = links
      .map((l) => l.role.name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0)

    return {
      sub: user.id,
      userId: user.id,
      email: noliUser.email,
      tenantId: user.tenantId ?? null,
      orgId: user.organizationId ?? null,
      roles: roleNames,
    }
  } catch (err) {
    console.error('[clerk-auth] Mercato user resolution failed:', err)
    return null
  }
}
