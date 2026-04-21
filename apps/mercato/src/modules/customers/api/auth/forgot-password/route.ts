export const metadata = { path: '/auth/forgot-password', POST: {} }

import { NextRequest, NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { AuthService } from '@open-mercato/core/modules/auth/services/authService'
import { sendEmail } from '@open-mercato/shared/lib/email/send'
import ResetPasswordEmail from '@open-mercato/core/modules/auth/emails/ResetPasswordEmail'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const email = String((body as any)?.email || '').trim().toLowerCase()
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ ok: true })
    }

    const container = await createRequestContainer()
    const auth = container.resolve('authService') as AuthService

    // For Google-only accounts (no password set) silently skip — the reset
    // link wouldn't help them. They'll see the Google button on /login.
    const existing = await auth.findUserByEmail(email)
    if (existing && existing.googleSub && !existing.passwordHash) {
      return NextResponse.json({ ok: true })
    }

    const resReq = await auth.requestPasswordReset(email)
    if (!resReq) return NextResponse.json({ ok: true })

    const { token } = resReq
    const url = new URL(req.url)
    const base = process.env.APP_URL || `${url.protocol}//${url.host}`
    const resetUrl = `${base}/reset-password?token=${token}`

    const { translate } = await resolveTranslations()
    const subject = translate('auth.email.resetPassword.subject', 'Reset your LaunchOS password')
    const copy = {
      preview: translate('auth.email.resetPassword.preview', 'Reset your password'),
      title: translate('auth.email.resetPassword.title', 'Reset your password'),
      body: translate('auth.email.resetPassword.body', 'Click the link below to set a new password. This link expires in 60 minutes.'),
      cta: translate('auth.email.resetPassword.cta', 'Set a new password'),
      hint: translate('auth.email.resetPassword.hint', "If you didn't request this, you can safely ignore this email."),
    }

    try {
      await sendEmail({ to: email, subject, react: ResetPasswordEmail({ resetUrl, copy }) })
    } catch (mailErr) {
      console.error('[auth/forgot-password] Failed to send reset email:', mailErr)
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[auth/forgot-password] Error:', err)
    return NextResponse.json({ ok: true })
  }
}
