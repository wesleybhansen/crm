export const metadata = { path: '/invite/accept', GET: { requireAuth: true }, POST: { requireAuth: true } }
import { NextResponse } from 'next/server'
import { query, queryOne } from '@/app/api/funnels/db'
import { signJwt } from '@open-mercato/shared/lib/auth/jwt'
import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'

const MEMBER_FEATURES = [
  'customers.*', 'calendar.*', 'payments.view', 'payments.manage',
  'courses.view', 'courses.manage', 'forms.view', 'forms.manage',
]

export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const token = url.searchParams.get('token')

    if (!token) {
      return NextResponse.json({ ok: false, error: 'Token is required' }, { status: 400 })
    }

    const invite = await queryOne(
      `SELECT ti.email, ti.role, ti.organization_id, o.name as org_name
       FROM team_invites ti
       JOIN organizations o ON o.id = ti.organization_id
       WHERE ti.token = $1 AND ti.status = 'pending' AND ti.expires_at > now()`,
      [token]
    )

    if (!invite) {
      return NextResponse.json({ ok: false, error: 'This invite has expired or is no longer valid' }, { status: 400 })
    }

    return NextResponse.json({
      ok: true,
      data: { email: invite.email, orgName: invite.org_name, role: invite.role },
    })
  } catch (error) {
    console.error('[invite.accept.validate]', error)
    return NextResponse.json({ ok: false, error: 'Failed to validate invite' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const { token, name, password } = body as { token?: string; name?: string; password?: string }

    if (!token) {
      return NextResponse.json({ ok: false, error: 'Token is required' }, { status: 400 })
    }
    if (!name?.trim()) {
      return NextResponse.json({ ok: false, error: 'Name is required' }, { status: 400 })
    }
    if (!password || password.length < 8) {
      return NextResponse.json({ ok: false, error: 'Password must be at least 8 characters' }, { status: 400 })
    }

    const invite = await queryOne(
      `SELECT id, email, role, organization_id, tenant_id
       FROM team_invites
       WHERE token = $1 AND status = 'pending' AND expires_at > now()`,
      [token]
    )

    if (!invite) {
      return NextResponse.json({ ok: false, error: 'This invite has expired or is no longer valid' }, { status: 400 })
    }

    // Check if user already exists in this specific org
    const existingInOrg = await queryOne(
      `SELECT id FROM users WHERE email = $1 AND organization_id = $2 AND deleted_at IS NULL`,
      [invite.email, invite.organization_id]
    )
    if (existingInOrg) {
      return NextResponse.json({ ok: false, error: 'You are already a member of this workspace' }, { status: 409 })
    }

    const passwordHash = await bcrypt.hash(password, 10)
    let userId: string

    // Check if email exists globally (user has account in another org)
    const existingUser = await queryOne(
      `SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL`,
      [invite.email]
    )
    if (existingUser) {
      // User exists in another org — update their record to point to this org
      // (In a multi-org model, we'd create a separate user record, but the email unique constraint prevents that)
      // Instead, update the existing user's org to the invited one and update password
      userId = existingUser.id
      await query(
        `UPDATE users SET tenant_id = $1, organization_id = $2, name = COALESCE(NULLIF($3, ''), name), password_hash = $4 WHERE id = $5`,
        [invite.tenant_id, invite.organization_id, name.trim(), passwordHash, userId]
      )
    } else {
      userId = crypto.randomUUID()
      await query(
        `INSERT INTO users (id, tenant_id, organization_id, email, name, password_hash, is_confirmed, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, true, now())`,
        [userId, invite.tenant_id, invite.organization_id, invite.email, name.trim(), passwordHash]
      )
    }

    // Clean up any existing role assignments for this user in case they're moving orgs
    await query(`UPDATE user_roles SET deleted_at = now() WHERE user_id = $1 AND deleted_at IS NULL`, [userId])

    let role = await queryOne(
      `SELECT id FROM roles WHERE tenant_id = $1 AND name = $2 AND deleted_at IS NULL`,
      [invite.tenant_id, invite.role]
    )
    if (!role) {
      const roleId = crypto.randomUUID()
      await query(
        `INSERT INTO roles (id, tenant_id, name, created_at) VALUES ($1, $2, $3, now())`,
        [roleId, invite.tenant_id, invite.role]
      )
      role = { id: roleId }
    }

    await query(
      `INSERT INTO user_roles (id, user_id, role_id, created_at) VALUES ($1, $2, $3, now())`,
      [crypto.randomUUID(), userId, role.id]
    )

    const existingAcl = await queryOne(
      `SELECT id FROM role_acls WHERE role_id = $1 AND tenant_id = $2`,
      [role.id, invite.tenant_id]
    )
    if (!existingAcl) {
      if (invite.role === 'admin') {
        await query(
          `INSERT INTO role_acls (id, role_id, tenant_id, is_super_admin, created_at) VALUES ($1, $2, $3, true, now())`,
          [crypto.randomUUID(), role.id, invite.tenant_id]
        )
      } else {
        await query(
          `INSERT INTO role_acls (id, role_id, tenant_id, is_super_admin, features_json, created_at) VALUES ($1, $2, $3, false, $4, now())`,
          [crypto.randomUUID(), role.id, invite.tenant_id, JSON.stringify(MEMBER_FEATURES)]
        )
      }
    }

    await query(
      `UPDATE team_invites SET status = 'accepted', accepted_at = now() WHERE id = $1`,
      [invite.id]
    )

    const jwt = signJwt({
      sub: userId,
      tenantId: invite.tenant_id,
      orgId: invite.organization_id,
      email: invite.email,
      roles: [invite.role],
    })

    const res = NextResponse.json({ ok: true, redirect: '/backend' })

    res.cookies.set('auth_token', jwt, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 8,
    })

    res.cookies.set('session_token', jwt, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 8,
    })

    return res
  } catch (error) {
    console.error('[invite.accept]', error)
    return NextResponse.json({ ok: false, error: 'Failed to accept invite' }, { status: 500 })
  }
}
