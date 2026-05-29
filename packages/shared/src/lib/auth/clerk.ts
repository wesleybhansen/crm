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
 *   4. Auto-provisioning: if no Mercato User row exists at all, create one
 *      inside the shared Noli tenant — Organization + User (with encrypted
 *      email + emailHash) + UserRole(admin) in a single transaction. This
 *      is what makes customer #2 actually able to use CRM after they sign
 *      up at app.noliai.com and buy a CRM-included plan.
 *
 * Returns null on any failure (no noli-core user, not entitled, provisioning
 * error). Caller's responsibility is to translate null to 401.
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
  let noliOrgId: string | null = null
  try {
    const { findUserByClerkId, isEntitled, findPrimaryOrgIdForUser } = await import(
      '@open-mercato/shared/lib/noli/core-client'
    )
    noliUser = await findUserByClerkId(clerkUserId)
    if (!noliUser) return null
    const entitled = await isEntitled(noliUser.id, 'crm')
    if (!entitled) return null
    // The user's noli-core org — every member of it shares ONE Mercato org.
    noliOrgId = await findPrimaryOrgIdForUser(noliUser.id)
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
    const { Organization } = await import(
      '@open-mercato/core/modules/directory/data/entities'
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

    // 4. Auto-provision: brand-new Noli user with CRM entitlement. Joins the
    //    team's shared Mercato org (by noli-core org link) if one exists, else
    //    creates it.
    if (!user) {
      const provisioned = (await provisionMercatoUserForClerk(
        em,
        noliUser,
        clerkUserId,
        noliOrgId,
      )) as typeof user
      if (!provisioned) {
        console.error(
          `[clerk-auth] Auto-provision failed for clerkUserId=${clerkUserId} email=${noliUser.email}`,
        )
        return null
      }
      user = provisioned
    } else if (noliOrgId && user.organizationId) {
      // Lazy backfill: link a pre-multi-tenancy Mercato org to its noli-core
      // org the first time its owner signs in, so invited teammates can find
      // and join this existing org. (Existing orgs are single-user = the owner.)
      const existingOrg = await em.findOne(Organization, { id: user.organizationId })
      if (existingOrg && !existingOrg.noliOrgId) {
        existingOrg.noliOrgId = noliOrgId
        try {
          await em.persistAndFlush(existingOrg)
        } catch {
          // Unique-violation if that noli org already links elsewhere — ignore.
        }
      }
    }

    // 5. Resolve role names for downstream requireRoles checks.
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
      // noliUserId is consumed by lib/usage/log.ts to write per-call rows
      // into noli-core's ai_usage table for cross-app aggregation. The
      // AuthContext type has `[k: string]: unknown` so this is type-safe.
      noliUserId: noliUser.id,
    }
  } catch (err) {
    console.error('[clerk-auth] Mercato user resolution failed:', err)
    return null
  }
}

/**
 * Auto-provision a brand-new Mercato User for a Clerk identity that has a
 * valid noli-core 'crm' entitlement. Creates a fresh Organization (one
 * Mercato Organization per Noli user — see Migration20260509120000),
 * encrypts the email via TenantDataEncryptionService if enabled, and
 * grants the admin role within the tenant.
 *
 * Pattern adapted from setupInitialTenant in
 * packages/core/src/modules/auth/lib/setup-app.ts but trimmed to
 * insert-into-existing-tenant (the Noli tenant seeded by the same
 * migration). Tenant resolved from NOLI_TENANT_ID env var, falling back
 * to the first non-deleted tenant by created_at (matches the migration's
 * "first tenant" convention).
 *
 * Returns null on any error so the caller falls through to 401 rather
 * than partially-provisioning a user.
 */
async function provisionMercatoUserForClerk(
  em: EntityManager,
  noliUser: {
    id: string
    email: string
    first_name: string | null
    last_name: string | null
  },
  clerkUserId: string,
  noliOrgId: string | null,
): Promise<unknown | null> {
  try {
    const { Tenant, Organization } = await import(
      '@open-mercato/core/modules/directory/data/entities'
    )
    const { User, Role, UserRole } = await import(
      '@open-mercato/core/modules/auth/data/entities'
    )
    const { EncryptionMap } = await import(
      '@open-mercato/core/modules/entities/data/entities'
    )
    const { DEFAULT_ENCRYPTION_MAPS } = await import(
      '@open-mercato/core/modules/entities/lib/encryptionDefaults'
    )
    const { isTenantDataEncryptionEnabled } = await import(
      '@open-mercato/shared/lib/encryption/toggles'
    )
    const { createKmsService } = await import(
      '@open-mercato/shared/lib/encryption/kms'
    )
    const { TenantDataEncryptionService } = await import(
      '@open-mercato/shared/lib/encryption/tenantDataEncryptionService'
    )
    const { computeEmailHash } = await import(
      '@open-mercato/core/modules/auth/lib/emailHash'
    )

    const envTenantId = process.env.NOLI_TENANT_ID?.trim() || null
    let tenant = envTenantId
      ? await em.findOne(Tenant, { id: envTenantId, deletedAt: null })
      : null
    if (!tenant) {
      tenant = await em.findOne(
        Tenant,
        { deletedAt: null },
        { orderBy: { createdAt: 'asc' } },
      )
    }
    if (!tenant) {
      console.error(
        '[clerk-auth] No Noli tenant found — Migration20260509120000 may not have run',
      )
      return null
    }

    const displayName =
      [noliUser.first_name, noliUser.last_name].filter(Boolean).join(' ') ||
      noliUser.email

    let createdUser: unknown = null

    await em.transactional(async (tem) => {
      // a. Find the team's shared Mercato org by its noli-core link, or create
      //    it. All members of one noli-core org share ONE Mercato org (so they
      //    see the same contacts/deals/pipelines). The org's tenant governs the
      //    encryption context below.
      let organization = noliOrgId
        ? await tem.findOne(
            Organization,
            { noliOrgId, deletedAt: null },
            { populate: ['tenant'] },
          )
        : null
      const orgTenant = organization?.tenant ?? tenant
      if (!organization) {
        organization = tem.create(Organization, {
          name: displayName,
          tenant,
          noliOrgId: noliOrgId ?? null,
          isActive: true,
          depth: 0,
          ancestorIds: [],
          childIds: [],
          descendantIds: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        tem.persist(organization)
        await tem.flush()
      }

      // b. EncryptionMap rows for (orgTenant, org). Idempotent — only creates
      //    maps that are missing, so it's safe whether the org is brand-new or
      //    a pre-existing one this member is joining.
      if (isTenantDataEncryptionEnabled()) {
        for (const spec of DEFAULT_ENCRYPTION_MAPS) {
          const existing = await tem.findOne(EncryptionMap, {
            entityId: spec.entityId,
            tenantId: orgTenant.id,
            organizationId: organization.id,
            deletedAt: null,
          })
          if (!existing) {
            tem.persist(
              tem.create(EncryptionMap, {
                entityId: spec.entityId,
                tenantId: orgTenant.id,
                organizationId: organization.id,
                fieldsJson: spec.fields,
                isActive: true,
                createdAt: new Date(),
                updatedAt: new Date(),
              }),
            )
          }
        }
        await tem.flush()
      }

      // c. Encrypt the email under (orgTenant, org) if enabled.
      const encryptionService = isTenantDataEncryptionEnabled()
        ? new TenantDataEncryptionService(tem as unknown as EntityManager, {
            kms: createKmsService(),
          })
        : null
      if (encryptionService) {
        await encryptionService.invalidateMap(
          'auth:user',
          String(orgTenant.id),
          String(organization.id),
        )
      }
      const encryptedPayload = encryptionService
        ? await encryptionService.encryptEntityPayload(
            'auth:user',
            { email: noliUser.email },
            orgTenant.id,
            organization.id,
          )
        : { email: noliUser.email, emailHash: computeEmailHash(noliUser.email) }

      // d. Create the User attached to the (shared or new) org. Clerk owns auth
      //    so passwordHash stays null.
      const newUser = tem.create(User, {
        email:
          ((encryptedPayload as Record<string, unknown>).email as string) ??
          noliUser.email,
        emailHash:
          ((encryptedPayload as Record<string, unknown>).emailHash as string) ??
          computeEmailHash(noliUser.email),
        passwordHash: null,
        organizationId: organization.id,
        tenantId: orgTenant.id,
        clerkUserId,
        name: displayName,
        isConfirmed: true,
        createdAt: new Date(),
      })
      tem.persist(newUser)
      await tem.flush()

      // e. Grant the admin role (v1: every member of a team's CRM is an org
      //    admin since CRM data is team-shared). Prefer tenant-scoped Role;
      //    fall back to global Role with tenantId=NULL.
      const adminRole =
        (await tem.findOne(Role, { name: 'admin', tenantId: orgTenant.id })) ??
        (await tem.findOne(Role, { name: 'admin', tenantId: null }))
      if (adminRole) {
        tem.persist(
          tem.create(UserRole, {
            user: newUser,
            role: adminRole,
            createdAt: new Date(),
          }),
        )
        await tem.flush()
      } else {
        console.warn(
          '[clerk-auth] No admin role found for tenant; user provisioned without role',
        )
      }

      createdUser = newUser
    })

    console.info(
      `[clerk-auth] Auto-provisioned Mercato user for clerkUserId=${clerkUserId} email=${noliUser.email}`,
    )
    return createdUser
  } catch (err) {
    console.error('[clerk-auth] Auto-provision exception:', err)
    return null
  }
}
