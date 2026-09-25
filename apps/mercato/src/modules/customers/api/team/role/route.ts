// ORM-SKIP: complex multi-table JOINs — raw SQL more maintainable
export const metadata = { path: '/team/role', PUT: { requireAuth: true } }
import { NextResponse } from 'next/server'
import { query, queryOne } from '@/lib/db'
import { getTeamAuth, isTeamManager } from '../auth'
import crypto from 'node:crypto'
import { resolveTeamRoleId, TeamRoleConfigError, type TeamRoleName } from '../../../lib/team-roles'

export async function PUT(req: Request) {
  const auth = await getTeamAuth()
  if (!auth) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  if (!isTeamManager(auth.roleName, auth.isOwner)) {
    return NextResponse.json({ ok: false, error: 'Only admins can change roles' }, { status: 403 })
  }

  try {
    const body = await req.json()
    const { userId, role } = body as { userId?: string; role?: string }

    if (!userId || !role || !['admin', 'member'].includes(role)) {
      return NextResponse.json({ ok: false, error: 'userId and role ("admin" or "member") are required' }, { status: 400 })
    }

    // Every Noli customer shares one tenant: the target must be a member of
    // the caller's own workspace, or this rewrote another customer's roles.
    const target = await queryOne(
      `SELECT id FROM users WHERE id = $1 AND organization_id = $2 AND tenant_id = $3 AND deleted_at IS NULL`,
      [userId, auth.orgId, auth.tenantId]
    )
    if (!target) {
      return NextResponse.json({ ok: false, error: 'Team member not found' }, { status: 404 })
    }

    const org = await queryOne(`SELECT owner_user_id FROM organizations WHERE id = $1`, [auth.orgId])
    if (org?.owner_user_id === userId) {
      return NextResponse.json({ ok: false, error: 'Cannot change the owner\'s role' }, { status: 403 })
    }

    if (role === 'admin' && !auth.isOwner) {
      return NextResponse.json({ ok: false, error: 'Only the owner can promote members to admin' }, { status: 403 })
    }

    let roleId: string
    try {
      roleId = await resolveTeamRoleId({ query, queryOne }, String(auth.tenantId), role as TeamRoleName)
    } catch (err) {
      if (err instanceof TeamRoleConfigError) {
        console.error('[team.role] role configuration', err.message)
        return NextResponse.json({ ok: false, error: err.message }, { status: 500 })
      }
      throw err
    }

    await query(
      `UPDATE user_roles SET deleted_at = now() WHERE user_id = $1 AND deleted_at IS NULL`,
      [userId]
    )

    await query(
      `INSERT INTO user_roles (id, user_id, role_id, created_at) VALUES ($1, $2, $3, now())`,
      [crypto.randomUUID(), userId, roleId]
    )

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[team.role]', error)
    return NextResponse.json({ ok: false, error: 'Failed to update role' }, { status: 500 })
  }
}
