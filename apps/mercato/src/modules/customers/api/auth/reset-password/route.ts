export const metadata = { path: '/auth/reset-password', POST: {} }

import { NextRequest, NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { AuthService } from '@open-mercato/core/modules/auth/services/authService'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const token = String((body as any)?.token || '').trim()
    const password = String((body as any)?.password || '')

    if (!token || !password) {
      return NextResponse.json({ ok: false, error: 'Token and password are required' }, { status: 400 })
    }
    if (password.length < 8) {
      return NextResponse.json({ ok: false, error: 'Password must be at least 8 characters' }, { status: 400 })
    }

    const container = await createRequestContainer()
    const auth = container.resolve('authService') as AuthService
    const user = await auth.confirmPasswordReset(token, password)
    if (!user) {
      return NextResponse.json({ ok: false, error: 'Invalid or expired reset link' }, { status: 400 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[auth/reset-password] Error:', err)
    return NextResponse.json({ ok: false, error: 'Internal server error' }, { status: 500 })
  }
}
