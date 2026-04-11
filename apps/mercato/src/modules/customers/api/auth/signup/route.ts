export const metadata = { path: '/auth/signup', POST: { requireAuth: true } }
import { NextRequest, NextResponse } from 'next/server'
import { query, queryOne } from '@/app/api/funnels/db'
import { signJwt } from '@open-mercato/shared/lib/auth/jwt'
import crypto from 'node:crypto'

const BETA_WHITELIST = ['wesley.b.hansen@gmail.com', 'weshansen123@yahoo.com']

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { name, email, password } = body as { name?: string; email?: string; password?: string }

    if (!name || !email || !password) {
      return NextResponse.json({ ok: false, error: 'Name, email, and password are required' }, { status: 400 })
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      return NextResponse.json({ ok: false, error: 'Please enter a valid email address' }, { status: 400 })
    }

    if (password.length < 8) {
      return NextResponse.json({ ok: false, error: 'Password must be at least 8 characters' }, { status: 400 })
    }

    const normalizedEmail = email.toLowerCase().trim()

    if (!BETA_WHITELIST.includes(normalizedEmail)) {
      return NextResponse.json({
        ok: false,
        error: 'Signups are currently invite-only. Contact us for access.',
      }, { status: 403 })
    }

    const existing = await queryOne('SELECT id FROM users WHERE email = $1', [normalizedEmail])
    if (existing) {
      return NextResponse.json({ ok: false, error: 'An account with this email already exists' }, { status: 409 })
    }

    const bcrypt = require('bcryptjs')
    const passwordHash = await bcrypt.hash(password, 10)

    const tenantId = crypto.randomUUID()
    const orgId = crypto.randomUUID()
    const userId = crypto.randomUUID()

    const nameParts = name.trim().split(/\s+/)
    const firstName = nameParts[0]
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : ''

    // Create tenant
    await query(
      'INSERT INTO tenants (id, name, created_at, updated_at) VALUES ($1, $2, now(), now())',
      [tenantId, `${firstName}'s Workspace`]
    )

    // Create organization with owner
    await query(
      'INSERT INTO organizations (id, name, tenant_id, owner_user_id, max_seats, created_at, updated_at) VALUES ($1, $2, $3, $4, 5, now(), now())',
      [orgId, name, tenantId, userId]
    )

    // Create user
    await query(
      `INSERT INTO users (id, tenant_id, organization_id, email, name, password_hash, is_confirmed, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, true, now())`,
      [userId, tenantId, orgId, normalizedEmail, name, passwordHash]
    )

    // Create owner, admin, and member roles for this tenant
    const ownerRoleId = crypto.randomUUID()
    const adminRoleId = crypto.randomUUID()
    const memberRoleId = crypto.randomUUID()

    await query(
      'INSERT INTO roles (id, tenant_id, name, created_at) VALUES ($1, $2, $3, now()), ($4, $5, $6, now()), ($7, $8, $9, now())',
      [ownerRoleId, tenantId, 'owner', adminRoleId, tenantId, 'admin', memberRoleId, tenantId, 'member']
    )

    // Assign owner role to the signing-up user
    await query(
      'INSERT INTO user_roles (id, user_id, role_id, created_at) VALUES ($1, $2, $3, now())',
      [crypto.randomUUID(), userId, ownerRoleId]
    )

    // Create role ACLs — owner and admin get super_admin, member gets explicit features
    await query(
      `INSERT INTO role_acls (id, role_id, tenant_id, is_super_admin, features_json, created_at)
       VALUES ($1, $2, $3, true, NULL, now()),
              ($4, $5, $6, true, NULL, now()),
              ($7, $8, $9, false, $10, now())`,
      [
        crypto.randomUUID(), ownerRoleId, tenantId,
        crypto.randomUUID(), adminRoleId, tenantId,
        crypto.randomUUID(), memberRoleId, tenantId,
        JSON.stringify(['customers.*', 'calendar.*', 'payments.view', 'payments.manage', 'courses.view', 'courses.manage', 'forms.view', 'forms.manage']),
      ]
    )

    // Sign JWT
    const token = signJwt({
      sub: userId,
      tenantId,
      orgId,
      email: normalizedEmail,
      roles: ['owner'],
    })

    // Build response with auth cookies
    const res = NextResponse.json({ ok: true, redirect: '/backend/welcome' })

    res.cookies.set('auth_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 8, // 8 hours
    })

    res.cookies.set('session_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 8,
    })

    return res
  } catch (err: unknown) {
    console.error('[auth/signup] Error:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
