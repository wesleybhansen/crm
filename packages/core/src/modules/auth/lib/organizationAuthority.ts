import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { RbacService } from '@open-mercato/core/modules/auth/services/rbacService'
import { resolveOrganizationScope } from '@open-mercato/core/modules/directory/utils/organizationScope'

/* Commands that touch identity and organisation records used to trust the
 * tenant alone. While every Noli customer shared one tenant, a member of one
 * organisation could edit users, organisations and role ACLs belonging to
 * another. These helpers make the caller's own organisation scope the hard
 * boundary unless the account is a super admin. Since each customer has its
 * own tenant, tenant-wide rows of the caller's own tenant are theirs to manage
 * (`requireOwnTenantOrSuperAdmin`). A command run with no auth context
 * (internal code, not the HTTP dispatcher) is left to its caller. */

async function actorIsSuperAdmin(ctx: CommandRuntimeContext): Promise<boolean> {
  const auth = ctx.auth
  if (!auth?.sub || auth.isApiKey === true) return false
  try {
    const rbac = ctx.container.resolve('rbacService') as RbacService
    const acl = await rbac.loadAcl(auth.sub, { tenantId: auth.tenantId ?? null, organizationId: auth.orgId ?? null })
    return acl?.isSuperAdmin === true
  } catch {
    return false
  }
}

export async function requireSuperAdmin(ctx: CommandRuntimeContext, what: string): Promise<void> {
  if (!ctx.auth) return
  if (!(await actorIsSuperAdmin(ctx))) {
    throw new CrudHttpError(403, { error: `Only a super administrator can ${what}` })
  }
}

/**
 * One tenant per customer (CRM_TENANT_PER_CUSTOMER, live since 2026-09-24):
 * a tenant-wide row (a role, a price kind, a top-level organisation) inside
 * the actor's own tenant belongs to that customer alone, so their admins may
 * manage it. A row in another tenant, or a global row with no tenant, is a
 * platform act and stays super-admin only. `tenantId` is the tenant the row
 * lives in (or will live in after the write).
 */
export async function requireOwnTenantOrSuperAdmin(
  ctx: CommandRuntimeContext,
  tenantId: string | null | undefined,
  what: string,
): Promise<void> {
  if (!ctx.auth) return
  const own = typeof ctx.auth.tenantId === 'string' && ctx.auth.tenantId.length > 0 ? ctx.auth.tenantId : null
  if (own && typeof tenantId === 'string' && tenantId.length > 0 && tenantId === own) return
  if (await actorIsSuperAdmin(ctx)) return
  throw new CrudHttpError(403, { error: `Only a super administrator can ${what}` })
}

export async function assertActorManagesOrganization(
  ctx: CommandRuntimeContext,
  organizationId: string | null | undefined,
): Promise<void> {
  if (!ctx.auth) return
  if (await actorIsSuperAdmin(ctx)) return
  if (!organizationId) throw new CrudHttpError(403, { error: 'Organization scope required' })
  const em = ctx.container.resolve('em') as EntityManager
  const rbac = ctx.container.resolve('rbacService') as RbacService
  const scope = await resolveOrganizationScope({ em, rbac, auth: ctx.auth })
  const allowed = scope.allowedIds
  if (!Array.isArray(allowed) || !allowed.includes(String(organizationId))) {
    throw new CrudHttpError(403, { error: 'That record belongs to another organization' })
  }
}

/**
 * Every id must be an organisation the actor already manages. Used for the
 * hierarchy fields of organisation create/update: listing another customer's
 * organisation as a child (or parent) would pull it into the actor's subtree,
 * and so into their access scope. Super admins and auth-less internal calls
 * are exempt, as in `assertActorManagesOrganization`.
 */
export async function assertActorManagesOrganizations(
  ctx: CommandRuntimeContext,
  organizationIds: Iterable<string | null | undefined>,
): Promise<void> {
  if (!ctx.auth) return
  const ids = Array.from(new Set(Array.from(organizationIds).filter((id): id is string => typeof id === 'string' && id.length > 0)))
  if (!ids.length) return
  if (await actorIsSuperAdmin(ctx)) return
  const em = ctx.container.resolve('em') as EntityManager
  const rbac = ctx.container.resolve('rbacService') as RbacService
  const scope = await resolveOrganizationScope({ em, rbac, auth: ctx.auth })
  const allowed = Array.isArray(scope.allowedIds) ? new Set(scope.allowedIds.map(String)) : null
  if (!allowed || ids.some((id) => !allowed.has(String(id)))) {
    throw new CrudHttpError(403, { error: 'That record belongs to another organization' })
  }
}
