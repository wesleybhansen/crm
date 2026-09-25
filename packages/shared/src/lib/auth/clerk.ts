/* Keep Next's client-bundle guard, but tolerate plain Node.
 *
 * `server-only` resolves to a module that throws unconditionally unless the
 * `react-server` export condition is active. Next sets that condition; a plain
 * Node process never does. This package is consumed by both, so a bare
 * `import 'server-only'` is a false positive outside Next -- it took down the
 * MCP server, which runs as a CLI process and only ever reached this module
 * through a dynamic import.
 *
 * Same try/catch idiom already used in lib/di/container.ts and
 * lib/i18n/server.ts, for the same reason. */
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('server-only');
} catch {
  // noop: allows CLI processes to use this module outside Next.
}
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AuthContext } from './server'
import { isMaintenanceMode, isTenantPerCustomerEnabled } from '../runtime/tenancy'

/** Tenants this process has already confirmed as seeded (per-customer mode). */
const seededTenants = new Set<string>()

/** Test seam. */
export function resetSeededTenantCacheForTests(): void {
  seededTenants.clear()
}

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
 *      — Organization + User (with encrypted email + emailHash) +
 *      UserRole(admin) in a single transaction. This is what makes
 *      customer #2 actually able to use CRM after they sign up at
 *      app.noliai.com and buy a CRM-included plan.
 *      CRM_TENANT_PER_CUSTOMER=1: a new Noli org gets its own tenant (and so
 *      its own data key), created in the same transaction, and the tenant is
 *      seeded after commit (ensureTenantSeeded; retried on later sign-ins
 *      until it succeeds). Off: every org joins the one shared tenant.
 *
 * Returns null on any failure (no noli-core user, not entitled, provisioning
 * error). Caller's responsibility is to translate null to 401.
 */
export async function resolveClerkUserToAuthContext(
  clerkUserId: string,
  options?: {
    /**
     * When true, a failed lookup (database down, timeout, noli-core error)
     * throws AuthUnavailableError instead of returning null, so interactive
     * callers can show "reconnecting" rather than signing the user out.
     * Definitive answers (no such user, not entitled) still return null.
     */
    throwOnUnavailable?: boolean
  },
): Promise<AuthContext> {
  if (!clerkUserId) return null
  const unavailable = async (err: unknown): Promise<never> => {
    const { AuthUnavailableError } = await import('./errors')
    throw new AuthUnavailableError('Sign-in check is temporarily unavailable', err)
  }

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
    if (options?.throwOnUnavailable) return unavailable(err)
    return null
  }

  // 2. Resolve to Mercato User
  try {
    const { createRequestContainer } = await import(
      '@open-mercato/shared/lib/di/container'
    )
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const perCustomer = isTenantPerCustomerEnabled()
    const maintenance = isMaintenanceMode()
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
    //    Per-customer tenants: only a row inside the tenant of the user's own
    //    Noli org may be claimed; a same-email row in another customer's
    //    tenant is never taken over.
    if (!user && noliUser.email && !maintenance) {
      const emailHash = computeEmailHash(noliUser.email)
      let scopeTenantId: string | null | undefined = undefined
      if (perCustomer) {
        const linked = noliOrgId
          ? await em.findOne(Organization, { noliOrgId, deletedAt: null }, { populate: ['tenant'] })
          : null
        scopeTenantId = linked?.tenant?.id ? String(linked.tenant.id) : null
      }
      const byHash = scopeTenantId === null
        ? null
        : await em.findOne(User, {
            emailHash,
            clerkUserId: null,
            deletedAt: null,
            ...(scopeTenantId ? { tenantId: scopeTenantId } : {}),
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
      if (maintenance) {
        // Maintenance window (tenant split): nothing may be created while
        // organizations are moving between tenants.
        return null
      }
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
    } else if (noliOrgId && user.organizationId && !maintenance) {
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

    // 4b. Per-customer tenants: make sure the tenant is seeded. Normally a
    //     no-op (cached per process); heals a sign-in that crashed between
    //     provisioning and seeding. Never blocks the sign-in on failure.
    if (perCustomer && !maintenance && user.tenantId && user.organizationId) {
      await ensureTenantSeededOnce(em, container, String(user.tenantId), String(user.organizationId))
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
    if (options?.throwOnUnavailable) return unavailable(err)
    return null
  }
}

async function ensureTenantSeededOnce(
  em: EntityManager,
  container: unknown,
  tenantId: string,
  organizationId: string,
): Promise<void> {
  if (seededTenants.has(tenantId)) return
  try {
    const { ensureTenantSeeded, tenantNeedsSeeding } = await import(
      '@open-mercato/core/modules/auth/lib/provision-tenant'
    )
    if (!(await tenantNeedsSeeding(em, tenantId))) {
      seededTenants.add(tenantId)
      return
    }
    const { getModules } = await import('@open-mercato/shared/lib/modules/registry')
    let modules: ReturnType<typeof getModules> = []
    try {
      modules = getModules()
    } catch {
      modules = []
    }
    const result = await ensureTenantSeeded(em, {
      tenantId,
      organizationId,
      modules,
      container: container as never,
    })
    if (result.failures.length === 0) seededTenants.add(tenantId)
    else console.error(`[clerk-auth] tenant ${tenantId} seeding incomplete: ${result.failures.map((f) => f.step).join(', ')}`)
  } catch (err) {
    console.error(`[clerk-auth] tenant ${tenantId} seeding failed:`, (err as Error)?.message ?? err)
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
 * packages/core/src/modules/auth/lib/setup-app.ts.
 *
 * CRM_TENANT_PER_CUSTOMER=1: a new org is created with its own tenant
 * (createCustomerTenant, same transaction) and there is no shared-tenant
 * fallback of any kind.
 * Off (legacy, deprecated): insert into the shared Noli tenant resolved from
 * NOLI_TENANT_ID, falling back to the first non-deleted tenant by created_at.
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
    const perCustomer = isTenantPerCustomerEnabled()
    const { createCustomerTenant, ensureTenantRoles } = perCustomer
      ? await import('@open-mercato/core/modules/auth/lib/provision-tenant')
      : { createCustomerTenant: null, ensureTenantRoles: null }

    // Legacy shared tenant (flag off only). Deprecated: removed once every
    // customer has its own tenant.
    let tenant: InstanceType<typeof Tenant> | null = null
    if (!perCustomer) {
      const envTenantId = process.env.NOLI_TENANT_ID?.trim() || null
      tenant = envTenantId
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
    }

    const displayName =
      [noliUser.first_name, noliUser.last_name].filter(Boolean).join(' ') ||
      noliUser.email

    let createdUser: unknown = null
    // Set when this sign-in created the workspace; seeded after commit below.
    let newOrgScope = null as { tenantId: string; organizationId: string } | null

    // Retry once at the transaction boundary: if a teammate's concurrent first
    // sign-in raced us on the unique noli_org_id, reset the EM and retry — the
    // org findOne then resolves the winner and we join it (no duplicate org).
    for (let attempt = 0; attempt < 2; attempt++) {
     try {
      await em.transactional(async (tem) => {
      const typedTem = tem as unknown as EntityManager
      newOrgScope = null
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
      let orgTenant = organization?.tenant ?? tenant
      if (!organization && perCustomer && createCustomerTenant) {
        // Own tenant for a new customer: tenant + org (+ default roles) in
        // this transaction, so a failure or a lost race leaves nothing.
        const createdTenant = await createCustomerTenant(typedTem, {
          name: displayName,
          noliOrgId: noliOrgId ?? null,
        })
        organization = createdTenant.organization
        orgTenant = createdTenant.tenant
        newOrgScope = { tenantId: String(createdTenant.tenant.id), organizationId: String(createdTenant.organization.id) }
      }
      if (!orgTenant) throw new Error('CRM tenant could not be resolved')
      if (!organization) {
        organization = tem.create(Organization, {
          name: displayName,
          tenant: orgTenant,
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
        newOrgScope = { tenantId: String(orgTenant.id), organizationId: String(organization.id) }
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
      //    admin since CRM data is team-shared). Prefer tenant-scoped Role.
      //    Per-customer tenants never fall back to a global (tenantId=NULL)
      //    role: the tenant's own role is created here if it is missing.
      //    Legacy mode keeps the global fallback.
      const adminRole = perCustomer && ensureTenantRoles
        ? (await tem.findOne(Role, { name: 'admin', tenantId: orgTenant.id })) ??
          (await ensureTenantRoles(typedTem, String(orgTenant.id), ['admin']))[0]
        : (await tem.findOne(Role, { name: 'admin', tenantId: orgTenant.id })) ??
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
      break
     } catch (txErr) {
      const code = (txErr as { code?: string }).code
      if (
        attempt === 0 &&
        (code === '23505' || /unique|duplicate key/i.test(String(txErr)))
      ) {
        em.clear()
        if (perCustomer) {
          // A parallel first sign-in of the same Clerk user won the race
          // (users.clerk_user_id is unique): use its row, do not create a
          // second tenant.
          const winner = await em.findOne(User, { clerkUserId })
          if (winner) return winner
        }
        continue
      }
      throw txErr
     }
    }

    // Default pipeline, stages, deal statuses and currencies for a new
    // workspace. After commit and best-effort: it must never fail sign-in.
    if (newOrgScope) {
      try {
        const { ensureCustomerDealDefaults } = await import(
          '@open-mercato/core/modules/customers/lib/dealDefaults'
        )
        await ensureCustomerDealDefaults(em.fork() as EntityManager, newOrgScope)
      } catch (seedErr) {
        console.error('[clerk-auth] Deal defaults seeding failed (sign-in continues):', seedErr)
      }
    }

    console.info(
      `[clerk-auth] Auto-provisioned Mercato user for clerkUserId=${clerkUserId} email=${noliUser.email}`,
    )
    return createdUser
  } catch (err) {
    console.error('[clerk-auth] Auto-provision exception:', err)
    return null
  }
}
