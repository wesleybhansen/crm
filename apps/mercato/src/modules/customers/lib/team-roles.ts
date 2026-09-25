import crypto from 'node:crypto'

/* Team role resolution for the CRM-native team screens (invite accept, role
 * change). Every Noli customer shares ONE tenant, so these rules are the
 * boundary between customers:
 *
 * - Roles are looked up only inside the given tenant, never globally.
 * - Nothing here ever grants is_super_admin. The tenant's seeded `admin`
 *   role (auth setup + ensureDefaultRoleAcls) carries the normal admin
 *   features; a missing admin role or ACL is a configuration error, not a
 *   reason to mint a super-admin ACL (which used to happen and made an
 *   invited customer admin a platform super admin across every customer).
 * - `member` is not a seeded role, so it is created on demand with the fixed
 *   member feature list and is_super_admin = false.
 *
 * Relative imports only. */

export type TeamRoleName = 'admin' | 'member'

export const TEAM_MEMBER_FEATURES = [
  'customers.*', 'calendar.*', 'payments.view', 'payments.manage',
  'courses.view', 'courses.manage', 'forms.view', 'forms.manage',
]

export type TeamRoleQuery = {
  query: (text: string, params?: unknown[]) => Promise<any[]>
  queryOne: (text: string, params?: unknown[]) => Promise<any>
}

export class TeamRoleConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TeamRoleConfigError'
  }
}

export function isTeamRoleName(value: unknown): value is TeamRoleName {
  return value === 'admin' || value === 'member'
}

/** Resolve (and for `member`, provision) the tenant role id for a team role. */
export async function resolveTeamRoleId(
  db: TeamRoleQuery,
  tenantId: string,
  role: TeamRoleName,
): Promise<string> {
  if (!tenantId) throw new TeamRoleConfigError('Workspace tenant is missing')
  const existing = await db.queryOne(
    `SELECT id FROM roles WHERE tenant_id = $1 AND name = $2 AND deleted_at IS NULL`,
    [tenantId, role],
  )

  if (role === 'admin') {
    if (!existing?.id) {
      throw new TeamRoleConfigError('The workspace admin role is not set up. Please contact support.')
    }
    const acl = await db.queryOne(
      `SELECT id, is_super_admin FROM role_acls WHERE role_id = $1 AND tenant_id = $2 AND deleted_at IS NULL ORDER BY is_super_admin DESC LIMIT 1`,
      [existing.id, tenantId],
    )
    if (!acl?.id) {
      throw new TeamRoleConfigError('The workspace admin role has no permissions set up. Please contact support.')
    }
    assertNotSuperAdminAcl(acl)
    return String(existing.id)
  }

  let roleId = existing?.id ? String(existing.id) : null
  if (!roleId) {
    roleId = crypto.randomUUID()
    await db.query(
      `INSERT INTO roles (id, tenant_id, name, created_at) VALUES ($1, $2, $3, now())`,
      [roleId, tenantId, role],
    )
  }
  const acl = await db.queryOne(
    `SELECT id, is_super_admin FROM role_acls WHERE role_id = $1 AND tenant_id = $2 AND deleted_at IS NULL ORDER BY is_super_admin DESC LIMIT 1`,
    [roleId, tenantId],
  )
  if (acl?.id) assertNotSuperAdminAcl(acl)
  if (!acl?.id) {
    await db.query(
      `INSERT INTO role_acls (id, role_id, tenant_id, is_super_admin, features_json, created_at) VALUES ($1, $2, $3, false, $4, now())`,
      [crypto.randomUUID(), roleId, tenantId, JSON.stringify(TEAM_MEMBER_FEATURES)],
    )
  }
  return roleId
}

/** A team role must never carry super-admin rights; one that does (an ACL
 *  minted by the old inline grant) is refused rather than handed out again. */
function assertNotSuperAdminAcl(acl: { is_super_admin?: unknown }) {
  if (acl.is_super_admin === true || acl.is_super_admin === 't') {
    throw new TeamRoleConfigError('The workspace role is misconfigured (super administrator rights). Please contact support.')
  }
}
