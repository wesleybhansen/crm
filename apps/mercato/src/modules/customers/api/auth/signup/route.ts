export const metadata = { path: '/auth/signup', POST: {} }

import { NextRequest, NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { AuthService } from '@open-mercato/core/modules/auth/services/authService'
import { setupInitialTenant } from '@open-mercato/core/modules/auth/lib/setup-app'
import { getModules } from '@open-mercato/shared/lib/modules/registry'
import { signJwt } from '@open-mercato/shared/lib/auth/jwt'

const BETA_WHITELIST = ['wesley.b.hansen@gmail.com', 'weshansen123@yahoo.com']

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const name = String(body?.name || '').trim()
    const email = String(body?.email || '').trim().toLowerCase()
    const password = String(body?.password || '')

    if (!name || !email || !password) {
      return NextResponse.json({ ok: false, error: 'Name, email, and password are required' }, { status: 400 })
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ ok: false, error: 'Please enter a valid email address' }, { status: 400 })
    }
    if (password.length < 8) {
      return NextResponse.json({ ok: false, error: 'Password must be at least 8 characters' }, { status: 400 })
    }
    if (!BETA_WHITELIST.includes(email)) {
      return NextResponse.json({
        ok: false,
        error: 'Signups are currently invite-only. Contact us for access.',
      }, { status: 403 })
    }

    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const auth = container.resolve('authService') as AuthService

    const existing = await auth.findUserByEmail(email)
    if (existing) {
      return NextResponse.json({ ok: false, error: 'An account with this email already exists' }, { status: 409 })
    }

    const nameParts = name.split(/\s+/)
    const firstName = nameParts[0]
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : undefined

    const result = await setupInitialTenant(em, {
      orgName: `${firstName}'s Workspace`,
      primaryUser: {
        email,
        password,
        firstName,
        lastName,
        displayName: name,
        confirm: true,
      },
      primaryUserRoles: ['admin'],
      includeDerivedUsers: false,
      includeSuperadminRole: true,
      modules: getModules(),
    })

    const primary = result.users.find((u) => u.roles.includes('admin'))
    if (!primary) {
      console.error('[auth/signup] setupInitialTenant returned no admin user', result)
      return NextResponse.json({ ok: false, error: 'Failed to create account' }, { status: 500 })
    }
    const user = primary.user

    const token = signJwt({
      sub: String(user.id),
      tenantId: result.tenantId,
      orgId: result.organizationId,
      email,
      roles: primary.roles,
    })

    const res = NextResponse.json({ ok: true, redirect: '/backend/welcome', token })
    const cookieOpts = {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax' as const,
      path: '/',
      maxAge: 60 * 60 * 8,
    }
    res.cookies.set('auth_token', token, cookieOpts)
    res.cookies.set('session_token', token, cookieOpts)
    return res
  } catch (err: unknown) {
    console.error('[auth/signup] Error:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
