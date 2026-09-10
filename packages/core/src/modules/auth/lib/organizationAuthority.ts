import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { RbacService } from '@open-mercato/core/modules/auth/services/rbacService'
import { resolveOrganizationScope } from '@open-mercato/core/modules/directory/utils/organizationScope'

/* Commands that touch identity and organisation records used to trust the
 * tenant alone. Every Noli customer lives in one tenant, so a member of one
 * organisation could edit users, organisations and role ACLs belonging to
 * another. These helpers make the caller's own organisation scope the hard
 * boundary unless the account is a super admin. A command run with no auth
 * context (internal code, not the HTTP dispatcher) is left to its caller. */

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
