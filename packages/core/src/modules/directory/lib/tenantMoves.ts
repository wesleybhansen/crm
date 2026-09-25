/**
 * Lookups over organization_tenant_moves (written by scripts/split-tenants.ts).
 *
 * Artefacts signed before an organization moved to its own tenant carry the
 * tenant id of the time: GTM unsubscribe links in mail already sent, and the
 * deterministic platform COS credential (derived from the tenant id). These
 * helpers let such an artefact resolve to the organization's current tenant,
 * and only for an (organization, old tenant) pair the split actually recorded:
 * a token naming any other tenant stays unresolved.
 *
 * Relative imports only (reachable from workers).
 */

export type TenantMoveSql = (sql: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>

let tableKnown: boolean | null = null

/** Test seam. */
export function resetTenantMovesCacheForTests(): void {
  tableKnown = null
}

async function movesTableExists(sql: TenantMoveSql): Promise<boolean> {
  if (tableKnown === true) return true
  const rows = (await sql(`select to_regclass('organization_tenant_moves')::text as t`, [])) ?? []
  tableKnown = Boolean(rows[0]?.t)
  return tableKnown
}

/** Tenant ids an organization belonged to before it was moved, newest first. */
export async function previousTenantIdsForOrganization(sql: TenantMoveSql, organizationId: string): Promise<string[]> {
  if (!organizationId || !(await movesTableExists(sql))) return []
  const rows = (await sql(
    `select from_tenant_id from organization_tenant_moves where organization_id = ? order by moved_at desc`,
    [organizationId],
  )) ?? []
  return rows.map((r) => String(r.from_tenant_id))
}

/**
 * The tenant a signed (organization, tenant) claim refers to today: the claim
 * itself when it is current (or unknown), the organization's current tenant
 * when the claim names a tenant the organization was moved away from.
 */
export async function resolveCurrentTenantForOrganization(
  sql: TenantMoveSql,
  organizationId: string,
  claimedTenantId: string,
): Promise<string> {
  if (!organizationId || !claimedTenantId) return claimedTenantId
  const org = (await sql(`select tenant_id from organizations where id = ?`, [organizationId])) ?? []
  const current = org[0]?.tenant_id ? String(org[0].tenant_id) : null
  if (!current || current === claimedTenantId) return claimedTenantId
  const previous = await previousTenantIdsForOrganization(sql, organizationId)
  return previous.includes(claimedTenantId) ? current : claimedTenantId
}
