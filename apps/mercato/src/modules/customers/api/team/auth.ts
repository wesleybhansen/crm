import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { queryOne } from '@/app/api/funnels/db'

export async function getTeamAuth() {
  const auth = await getAuthFromCookies()
  const userId = auth?.sub
  if (!auth?.tenantId || !auth?.orgId || !userId) return null

  const roleRow = await queryOne(
    `SELECT r.name FROM roles r
     JOIN user_roles ur ON ur.role_id = r.id AND ur.deleted_at IS NULL
     WHERE ur.user_id = $1 AND r.tenant_id = $2
     LIMIT 1`,
    [userId, auth.tenantId]
  )

  const org = await queryOne(
    `SELECT owner_user_id, max_seats FROM organizations WHERE id = $1`,
    [auth.orgId]
  )

  return {
    userId,
    tenantId: auth.tenantId,
    orgId: auth.orgId,
    email: auth.email,
    roleName: roleRow?.name || 'member',
    isOwner: org?.owner_user_id === userId,
    maxSeats: org?.max_seats || 5,
  }
}

export function isTeamManager(roleName: string, isOwner: boolean): boolean {
  return isOwner || roleName === 'owner' || roleName === 'admin'
}
