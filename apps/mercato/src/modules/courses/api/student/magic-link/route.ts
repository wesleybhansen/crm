// Per-IP limit (dispatcher) plus a per-address limit below: this route sends
// email, so neither one caller nor many callers may flood one inbox
// (security sweep 2026-09-25, low).
export const metadata = {
  POST: { requireAuth: false, rateLimit: { points: 5, duration: 300, blockDuration: 900, keyPrefix: 'courses-magic-link-ip' } },
}

import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { openSecretForTenant } from '@open-mercato/shared/lib/encryption/secretColumns'
import { espOwnFromAddress } from '../../../../email/lib/routing-service'
import crypto from 'crypto'
import { magicLinkExpiresAt, magicLinkTtlLabel } from '@/modules/courses/lib/magic-tokens'
import { getCachedRateLimiterService } from '@open-mercato/core/bootstrap'

const PER_EMAIL_LIMIT = { points: 3, duration: 15 * 60, keyPrefix: 'courses-magic-link-email' }

/** True when this address has asked for too many links recently. Fails open
 *  if the limiter is unavailable (the per-IP limit still applies). */
async function emailRateLimited(email: string): Promise<boolean> {
  try {
    const service = getCachedRateLimiterService()
    if (!service) return false
    const key = crypto.createHash('sha256').update(email).digest('hex')
    const result = await service.consume(key, PER_EMAIL_LIMIT)
    return !result.allowed
  } catch {
    return false
  }
}

export async function POST(req: Request) {
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { email, courseSlug } = body

    if (typeof email !== 'string' || !email.trim()) return NextResponse.json({ ok: false, error: 'Email is required' }, { status: 400 })
    if (email.length > 320) return NextResponse.json({ ok: false, error: 'Email is too long' }, { status: 400 })
    // Same answer as success, so the limit reveals nothing about the address.
    if (await emailRateLimited(email.trim().toLowerCase())) return NextResponse.json({ ok: true })

    // Find course by slug to get org
    let organizationId: string | null = null
    if (courseSlug) {
      const course = await knex('courses').where('slug', courseSlug).where('is_published', true).whereNull('deleted_at').first()
      if (course) organizationId = course.organization_id
    }
    if (!organizationId) {
      // Fallback: find any enrollment for this email
      const enrollment = await knex('course_enrollments').where('student_email', email.trim().toLowerCase()).where('status', 'active').first()
      if (enrollment) organizationId = enrollment.organization_id
    }
    if (!organizationId) {
      // Don't reveal if email exists — always return success
      return NextResponse.json({ ok: true })
    }

    // Verify email has at least one active enrollment
    const hasEnrollment = await knex('course_enrollments')
      .where('student_email', email.trim().toLowerCase())
      .where('organization_id', organizationId)
      .where('status', 'active')
      .first()

    if (!hasEnrollment) {
      return NextResponse.json({ ok: true }) // Don't reveal
    }

    // Generate token
    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = magicLinkExpiresAt()

    await knex('course_magic_tokens').insert({
      id: crypto.randomUUID(),
      organization_id: organizationId,
      email: email.trim().toLowerCase(),
      token,
      expires_at: expiresAt,
      created_at: new Date(),
    })

    // Send email with magic link
    const origin = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
    const magicLink = `${origin}/api/courses/student/verify?token=${token}`

    // Send the login link via the org's own ESP only (no platform sender).
    const espConn = await knex('esp_connections').where('organization_id', organizationId).where('is_active', true).first()
    const resendKey = espConn?.provider === 'resend'
      ? await openSecretForTenant(null, espConn.tenant_id, espConn.api_key)
      : null
    // The customer's own from address only; never Noli's EMAIL_FROM.
    const espFrom = espOwnFromAddress(espConn)
    if (resendKey && espFrom) {
      try {
        const { Resend } = await import('resend')
        const resend = new Resend(resendKey)
        await resend.emails.send({
          from: espFrom,
          to: [email.trim()],
          subject: 'Your Course Access Link',
          html: `
            <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:32px">
              <h2 style="margin:0 0 8px;font-size:20px">Access Your Courses</h2>
              <p style="color:#64748b;font-size:14px;line-height:1.6;margin-bottom:24px">Click the button below to log in and access your enrolled courses.</p>
              <a href="${magicLink}" style="display:inline-block;background:#6366f1;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">Open My Courses</a>
              <p style="color:#94a3b8;font-size:12px;margin-top:24px">This link is valid for ${magicLinkTtlLabel()}. You can request a new one anytime. If you didn't request this, you can safely ignore this email.</p>
            </div>`,
        })
      } catch (err) {
        console.error('[magic-link] Resend failed', err)
      }
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[courses.student.magic-link]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
