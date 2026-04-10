export const metadata = { PUT: { requireAuth: true } }
import { NextResponse } from 'next/server'
import { query, queryOne } from '@/app/api/funnels/db'
import { getTeamAuth, isTeamManager } from '../auth'
import crypto from 'node:crypto'

const MEMBER_FEATURES = [
  'customers.*', 'calendar.*', 'payments.view', 'payments.manage',
  'courses.view', 'courses.manage', 'forms.view', 'forms.manage',
]

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

    const org = await queryOne(`SELECT owner_user_id FROM organizations WHERE id = $1`, [auth.orgId])
    if (org?.owner_user_id === userId) {
      return NextResponse.json({ ok: false, error: 'Cannot change the owner\'s role' }, { status: 403 })
    }

    if (role === 'admin' && !auth.isOwner) {
      return NextResponse.json({ ok: false, error: 'Only the owner can promote members to admin' }, { status: 403 })
    }

    let targetRole = await queryOne(
      `SELECT id FROM roles WHERE tenant_id = $1 AND name = $2 AND deleted_at IS NULL`,
      [auth.tenantId, role]
    )
    if (!targetRole) {
      const roleId = crypto.randomUUID()
      await query(
        `INSERT INTO roles (id, tenant_id, name, created_at) VALUES ($1, $2, $3, now())`,
        [roleId, auth.tenantId, role]
      )
      targetRole = { id: roleId }
    }

    await query(
      `UPDATE user_roles SET deleted_at = now() WHERE user_id = $1 AND deleted_at IS NULL`,
      [userId]
    )

    await query(
      `INSERT INTO user_roles (id, user_id, role_id, created_at) VALUES ($1, $2, $3, now())`,
      [crypto.randomUUID(), userId, targetRole.id]
    )

    const existingAcl = await queryOne(
      `SELECT id FROM role_acls WHERE role_id = $1 AND tenant_id = $2`,
      [targetRole.id, auth.tenantId]
    )
    if (!existingAcl) {
      if (role === 'admin') {
        await query(
          `INSERT INTO role_acls (id, role_id, tenant_id, is_super_admin, created_at) VALUES ($1, $2, $3, true, now())`,
          [crypto.randomUUID(), targetRole.id, auth.tenantId]
        )
      } else {
        await query(
          `INSERT INTO role_acls (id, role_id, tenant_id, is_super_admin, features_json, created_at) VALUES ($1, $2, $3, false, $4, now())`,
          [crypto.randomUUID(), targetRole.id, auth.tenantId, JSON.stringify(MEMBER_FEATURES)]
        )
      }
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[team.role]', error)
    return NextResponse.json({ ok: false, error: 'Failed to update role' }, { status: 500 })
  }
}
