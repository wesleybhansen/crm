import type { Knex } from 'knex'
import { hasFeature } from '@open-mercato/shared/security/features'

interface AclRow {
  user_id: string
  features_json: unknown
  is_super_admin: boolean
}

function normalizeFeatures(features: unknown): string[] | undefined {
  if (!Array.isArray(features)) return undefined
  const normalized = features.filter((feature): feature is string => typeof feature === 'string')
  return normalized.length ? normalized : undefined
}

/**
 * Extract user IDs from ACL rows that have the required feature or are super admins.
 */
function collectUsersWithFeature(
  userIdsSet: Set<string>,
  rows: AclRow[],
  requiredFeature: string
): void {
  for (const row of rows) {
    if (row.is_super_admin) {
      userIdsSet.add(row.user_id)
      continue
    }

    const features = normalizeFeatures(row.features_json)
    if (features && hasFeature(features, requiredFeature)) {
      userIdsSet.add(row.user_id)
    }
  }
}

/* Every Noli customer lives in ONE tenant, separated only by organization,
 * and every customer's members share the seeded roles. Fan-out by role or by
 * feature therefore used to reach every customer's admins in the tenant (a
 * leave request, a quote, an inbound email went to all of them). The audience
 * is now the source organization: members of that organization and of its
 * ancestors (the only accounts whose scope already covers it). With no source
 * organization the fan-out reaches super administrators only; it never
 * spreads across customers. */

export type NotificationAudienceOrganization = string | null | undefined

/**
 * Organization ids whose members may receive a notification raised in
 * `organizationId`: the organization itself plus its ancestors. `[]` when the
 * organization is unknown in this tenant (fail closed).
 */
export async function resolveAudienceOrganizationIds(
  knex: Knex,
  tenantId: string,
  organizationId: string,
): Promise<string[]> {
  const row = await knex('organizations')
    .where('id', organizationId)
    .where('tenant_id', tenantId)
    .whereNull('deleted_at')
    .select('id', 'ancestor_ids')
    .first()
  if (!row) return []
  const ancestors = parseIdList((row as { ancestor_ids?: unknown }).ancestor_ids)
  return Array.from(new Set([String((row as { id: string }).id), ...ancestors]))
}

function parseIdList(value: unknown): string[] {
  let raw = value
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (!Array.isArray(raw)) return []
  return raw.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
}

type AudienceScope =
  | { kind: 'organizations'; organizationIds: string[] }
  | { kind: 'superAdminsOnly' }

async function resolveAudienceScope(
  knex: Knex,
  tenantId: string,
  organizationId: NotificationAudienceOrganization,
): Promise<AudienceScope> {
  const orgId = typeof organizationId === 'string' && organizationId.trim().length > 0 ? organizationId.trim() : null
  if (!orgId) return { kind: 'superAdminsOnly' }
  return { kind: 'organizations', organizationIds: await resolveAudienceOrganizationIds(knex, tenantId, orgId) }
}

export async function getRecipientUserIdsForRole(
  knex: Knex,
  tenantId: string,
  roleId: string,
  organizationId: NotificationAudienceOrganization,
): Promise<string[]> {
  const scope = await resolveAudienceScope(knex, tenantId, organizationId)
  // A role is shared by every customer; with no source organization there is
  // no safe audience for a role fan-out.
  if (scope.kind !== 'organizations' || scope.organizationIds.length === 0) return []
  const userRoles = await knex('user_roles')
    .join('users', 'user_roles.user_id', 'users.id')
    .where('user_roles.role_id', roleId)
    .whereNull('user_roles.deleted_at')
    .whereNull('users.deleted_at')
    .where('users.tenant_id', tenantId)
    .whereIn('users.organization_id', scope.organizationIds)
    .select('users.id as user_id')

  return Array.from(new Set(userRoles.map((row: { user_id: string }) => row.user_id)))
}

export async function getRecipientUserIdsForFeature(
  knex: Knex,
  tenantId: string,
  requiredFeature: string,
  organizationId: NotificationAudienceOrganization,
): Promise<string[]> {
  const scope = await resolveAudienceScope(knex, tenantId, organizationId)
  if (scope.kind === 'organizations' && scope.organizationIds.length === 0) return []
  const userIdsSet = new Set<string>()

  let userAclQuery = knex('user_acls')
    .join('users', 'user_acls.user_id', 'users.id')
    .where('user_acls.tenant_id', tenantId)
    .whereNull('user_acls.deleted_at')
    .whereNull('users.deleted_at')
    .where('users.tenant_id', tenantId)
  userAclQuery = scope.kind === 'organizations'
    ? userAclQuery.whereIn('users.organization_id', scope.organizationIds)
    : userAclQuery.where('user_acls.is_super_admin', true)
  const userAcls = await userAclQuery
    .select('users.id as user_id', 'user_acls.features_json', 'user_acls.is_super_admin')

  collectUsersWithFeature(userIdsSet, userAcls, requiredFeature)

  let roleAclQuery = knex('role_acls')
    .join('user_roles', 'role_acls.role_id', 'user_roles.role_id')
    .join('users', 'user_roles.user_id', 'users.id')
    .where('role_acls.tenant_id', tenantId)
    .whereNull('role_acls.deleted_at')
    .whereNull('user_roles.deleted_at')
    .whereNull('users.deleted_at')
    .where('users.tenant_id', tenantId)
  roleAclQuery = scope.kind === 'organizations'
    ? roleAclQuery.whereIn('users.organization_id', scope.organizationIds)
    : roleAclQuery.where('role_acls.is_super_admin', true)
  const roleAcls = await roleAclQuery
    .select('users.id as user_id', 'role_acls.features_json', 'role_acls.is_super_admin')

  collectUsersWithFeature(userIdsSet, roleAcls, requiredFeature)

  return Array.from(userIdsSet)
}
