import { NextResponse } from 'next/server'
import { query, queryOne } from '@/app/api/funnels/db'
import { getTeamAuth, isTeamManager } from '../auth'

export async function DELETE(req: Request) {
  const auth = await getTeamAuth()
  if (!auth) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  if (!isTeamManager(auth.roleName, auth.isOwner)) {
    return NextResponse.json({ ok: false, error: 'Only admins can remove team members' }, { status: 403 })
  }

  try {
    const body = await req.json()
    const { userId } = body as { userId?: string }

    if (!userId) {
      return NextResponse.json({ ok: false, error: 'userId is required' }, { status: 400 })
    }

    if (userId === auth.userId) {
      return NextResponse.json({ ok: false, error: 'You cannot remove yourself' }, { status: 400 })
    }

    const org = await queryOne(`SELECT owner_user_id FROM organizations WHERE id = $1`, [auth.orgId])
    if (org?.owner_user_id === userId) {
      return NextResponse.json({ ok: false, error: 'Cannot remove the organization owner' }, { status: 403 })
    }

    if (!auth.isOwner) {
      const targetRoleRow = await queryOne(
        `SELECT r.name FROM roles r
         JOIN user_roles ur ON ur.role_id = r.id AND ur.deleted_at IS NULL
         WHERE ur.user_id = $1 AND r.tenant_id = $2
         LIMIT 1`,
        [userId, auth.tenantId]
      )
      if (targetRoleRow?.name === 'admin') {
        return NextResponse.json({ ok: false, error: 'Only the owner can remove an admin' }, { status: 403 })
      }
    }

    await query(
      `UPDATE users SET deleted_at = now() WHERE id = $1 AND organization_id = $2`,
      [userId, auth.orgId]
    )

    await query(
      `UPDATE user_roles SET deleted_at = now() WHERE user_id = $1 AND deleted_at IS NULL`,
      [userId]
    )

    await query(
      `UPDATE user_acls SET deleted_at = now() WHERE user_id = $1 AND deleted_at IS NULL`,
      [userId]
    )

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[team.member.remove]', error)
    return NextResponse.json({ ok: false, error: 'Failed to remove team member' }, { status: 500 })
  }
}
