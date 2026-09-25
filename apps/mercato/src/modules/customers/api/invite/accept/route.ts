// ORM-SKIP: security-critical auth flow — raw SQL conversion deferred for safety
export const metadata = { path: '/invite/accept', GET: { requireAuth: true }, POST: { requireAuth: true } }
import { NextResponse } from 'next/server'
import { query, queryOne } from '@/lib/db'
import { signJwt } from '@open-mercato/shared/lib/auth/jwt'
import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { encryptRowForRawWrite } from '@open-mercato/shared/lib/encryption/rawWrite'
import { computeEmailHash } from '@open-mercato/core/modules/auth/lib/emailHash'
import { isTeamRoleName, resolveTeamRoleId, TeamRoleConfigError } from '../../../lib/team-roles'
import { isTenantPerCustomerEnabled } from '@open-mercato/shared/lib/runtime/tenancy'

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

    // Every Noli customer shares ONE tenant, so an invite must never move an
    // existing account between workspaces or tenants: that rewrote the
    // user's tenant/organisation, reset their password and signed the token
    // holder in as them. Existing accounts are matched by email hash (users
    // emails are encrypted at rest) with a plaintext fallback for legacy rows.
    const inviteEmail = String(invite.email ?? '').trim().toLowerCase()
    const existingUser = await queryOne(
      `SELECT id, tenant_id, organization_id FROM users
       WHERE (email_hash = $1 OR lower(email) = $2) AND deleted_at IS NULL
       LIMIT 1`,
      [computeEmailHash(inviteEmail), inviteEmail]
    )
    if (existingUser) {
      if (String(existingUser.organization_id ?? '') === String(invite.organization_id)) {
        return NextResponse.json({ ok: false, error: 'You are already a member of this workspace' }, { status: 409 })
      }
      if (String(existingUser.tenant_id ?? '') !== String(invite.tenant_id)) {
        return NextResponse.json(
          { ok: false, error: 'This email already has an account on a different tenant. Sign in with that account or contact support to move it.' },
          { status: 409 },
        )
      }
      return NextResponse.json(
        { ok: false, error: 'This email already has an account in another workspace. Sign in with that account or contact support to move it.' },
        { status: 409 },
      )
    }

    // The invite joins the inviter's workspace, and so the tenant that
    // workspace lives in today. An invite whose stored tenant no longer
    // matches its organization (minted before a tenant move) is refused
    // rather than creating a user in the wrong tenant.
    const orgRow = await queryOne(
      `SELECT tenant_id FROM organizations WHERE id = $1 AND deleted_at IS NULL`,
      [invite.organization_id],
    )
    if (!orgRow || String(orgRow.tenant_id) !== String(invite.tenant_id)) {
      return NextResponse.json({ ok: false, error: 'This invite is no longer valid. Ask for a new invite.' }, { status: 400 })
    }

    if (isTenantPerCustomerEnabled()) {
      // Roles and ACLs come from the tenant's seeding, never from here.
      try {
        const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
        const { getModules } = await import('@open-mercato/shared/lib/modules/registry')
        const { ensureTenantSeeded } = await import('@open-mercato/core/modules/auth/lib/provision-tenant')
        const container = await createRequestContainer()
        await ensureTenantSeeded(container.resolve('em') as any, {
          tenantId: String(invite.tenant_id),
          organizationId: String(invite.organization_id),
          modules: getModules(),
          container: container as any,
        })
      } catch (err) {
        console.error('[invite.accept] tenant seeding', err instanceof Error ? err.message : err)
        return NextResponse.json({ ok: false, error: 'The workspace is not ready yet. Please try again shortly.' }, { status: 503 })
      }
    }

    let roleId: string
    try {
      roleId = await resolveTeamRoleId({ query, queryOne }, String(invite.tenant_id), isTeamRoleName(invite.role) ? invite.role : 'member')
    } catch (err) {
      if (err instanceof TeamRoleConfigError) {
        console.error('[invite.accept] role configuration', err.message)
        return NextResponse.json({ ok: false, error: err.message }, { status: 500 })
      }
      throw err
    }

    const passwordHash = await bcrypt.hash(password, 10)
    const userId = crypto.randomUUID()
    const encrypted = await encryptRowForRawWrite(
      'auth:user',
      { email: inviteEmail, email_hash: computeEmailHash(inviteEmail) },
      String(invite.tenant_id),
      String(invite.organization_id),
    )
    // Claim the invite before creating the user: two accepts of one link used
    // to race past the checks above and create two users (2026-09-25 review,
    // LOW). The loser gets a clear answer; a failure below releases it.
    const claimed = await queryOne(
      `UPDATE team_invites SET status = 'accepted', accepted_at = now()
        WHERE id = $1 AND status = 'pending' RETURNING id`,
      [invite.id],
    )
    if (!claimed) {
      return NextResponse.json({ ok: false, error: 'This invite has already been used' }, { status: 409 })
    }
    const releaseInvite = () => query(
      `UPDATE team_invites SET status = 'pending', accepted_at = NULL WHERE id = $1 AND status = 'accepted'`,
      [invite.id],
    ).catch(() => {})

    try {
      await query(
        `INSERT INTO users (id, tenant_id, organization_id, email, email_hash, name, password_hash, is_confirmed, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, now())`,
        [userId, invite.tenant_id, invite.organization_id, encrypted.email, encrypted.email_hash ?? computeEmailHash(inviteEmail), name.trim(), passwordHash]
      )
    } catch (err) {
      await releaseInvite()
      // users_tenant_email_hash_uniq: the email already has an account here.
      if ((err as { code?: string })?.code === '23505') {
        return NextResponse.json({ ok: false, error: 'This email already has an account in this workspace. Sign in instead.' }, { status: 409 })
      }
      throw err
    }

    await query(
      `INSERT INTO user_roles (id, user_id, role_id, created_at) VALUES ($1, $2, $3, now())`,
      [crypto.randomUUID(), userId, roleId]
    )

    const jwt = signJwt({
      sub: userId,
      tenantId: invite.tenant_id,
      orgId: invite.organization_id,
      email: inviteEmail,
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
