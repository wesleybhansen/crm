import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { rateLimitErrorSchema } from '@open-mercato/shared/lib/ratelimit/helpers'
import { readEndpointRateLimitConfig } from '@open-mercato/shared/lib/ratelimit/config'
import { requestPasswordResetSchema } from '@open-mercato/core/modules/auth/data/validators'
import { checkAuthRateLimit } from '@open-mercato/core/modules/auth/lib/rateLimitCheck'
import { AuthService } from '@open-mercato/core/modules/auth/services/authService'
import { sendEmail } from '@open-mercato/shared/lib/email/send'
import ResetPasswordEmail from '@open-mercato/core/modules/auth/emails/ResetPasswordEmail'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'

export const metadata = { path: '/auth/forgot-password', POST: {} }

const resetRateLimitConfig = readEndpointRateLimitConfig('RESET', {
  points: 3,
  duration: 60,
  blockDuration: 60,
  keyPrefix: 'reset',
})

const resetIpRateLimitConfig = readEndpointRateLimitConfig('RESET_IP', {
  points: 10,
  duration: 60,
  blockDuration: 60,
  keyPrefix: 'reset-ip',
})

export async function POST(req: Request) {
  const payload = await readJsonSafe<unknown>(req)
  const parsed = requestPasswordResetSchema.safeParse(payload)
  const email = parsed.success ? parsed.data.email.trim().toLowerCase() : ''
  const { error: rateLimitError } = await checkAuthRateLimit({
    req,
    ipConfig: resetIpRateLimitConfig,
    compoundConfig: resetRateLimitConfig,
    compoundIdentifier: email,
  })
  if (rateLimitError) return rateLimitError
  if (!parsed.success) return NextResponse.json({ ok: true })

  try {
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
    const subject = translate('auth.email.resetPassword.subject', 'Reset your Noli password')
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

const forgotPasswordResponseSchema = z.object({ ok: z.literal(true) })

export const openApi: OpenApiRouteDoc = {
  tag: 'Authentication & Accounts',
  summary: 'Request a Noli password reset',
  methods: {
    POST: {
      summary: 'Request a password reset email',
      description: 'Always returns the same success response so account existence is not disclosed.',
      requestBody: {
        contentType: 'application/json',
        schema: requestPasswordResetSchema,
      },
      responses: [
        { status: 200, description: 'Request accepted', schema: forgotPasswordResponseSchema },
      ],
      errors: [
        { status: 429, description: 'Too many password reset requests', schema: rateLimitErrorSchema },
      ],
    },
  },
}
