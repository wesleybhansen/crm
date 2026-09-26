// Per-IP limit (dispatcher) plus a per-address limit below: this route sends
// email, so neither one caller nor many callers may flood one inbox
// (security sweep 2026-09-25, low).
export const metadata = {
  POST: { requireAuth: false, rateLimit: { points: 5, duration: 300, blockDuration: 900, keyPrefix: 'courses-magic-link-ip' } },
}

import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import crypto from 'crypto'
import { getCachedRateLimiterService } from '@open-mercato/core/bootstrap'
import { sendEmailByPurpose } from '../../../../email/lib/email-router'
import { hasSendingSetup } from '../../../../email/lib/routing-service'
import { requestCourseSignInLink } from '../../../lib/sign-in-link'

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

// The link goes through the business's own sending setup, like the
// enrollment email (lib/sign-in-link.ts): never a Noli sender, and a plain
// "connect email" answer when the business has none.
export async function POST(req: Request) {
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { email, courseSlug, token } = body

    if (typeof email !== 'string' || !email.trim()) return NextResponse.json({ ok: false, error: 'Email is required' }, { status: 400 })
    if (email.length > 320) return NextResponse.json({ ok: false, error: 'Email is too long' }, { status: 400 })
    // Same answer as success, so the limit reveals nothing about the address.
    if (await emailRateLimited(email.trim().toLowerCase())) return NextResponse.json({ ok: true })

    const result = await requestCourseSignInLink(knex, { email, courseSlug, token }, {
      send: sendEmailByPurpose,
      hasSendingSetup: (k, orgId, purpose) => hasSendingSetup(k, orgId, purpose),
    })
    return NextResponse.json(result.body, { status: result.status })
  } catch (error) {
    console.error('[courses.student.magic-link]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
