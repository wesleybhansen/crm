import crypto from 'crypto'
import type { Clock, ExecutionEm } from './execute/schedule'
import {
  GtmAuditEvent,
  GtmEnrollment,
  GtmSendAttempt,
  GtmSuppression,
} from '../data/entities'
import { UniqueConstraintViolationException } from '@mikro-orm/core'

/*
 * GTM unsubscribe: signed HMAC token + the atomic suppress-and-stop
 * (SPEC-066 section 8).
 *
 * Token: hex HMAC-SHA256 over `{enrollmentId}.{addressHash}` keyed by
 * GTM_UNSUBSCRIBE_SECRET (falling back to NOLI_INTERNAL_SERVICE_SECRET),
 * carried self-contained as `{enrollmentId}.{addressHash}.{signature}` so
 * the public endpoint can verify without a session. Verification is
 * length-guarded crypto.timingSafeEqual, so a tampered signature is rejected
 * in constant time relative to other bad signatures of the same length.
 *
 * applyUnsubscribe runs in ONE transaction: gtm_suppressions row (reason
 * 'unsubscribe', channel 'email', org-scoped), enrollment stopped
 * (stop_reason 'unsubscribe'), every attempt that has NOT yet contacted the
 * provider cancelled (-> 'failed' reason 'stopped'), audit event.
 * Idempotent: repeats change nothing and still return ok.
 *
 * 'claimed' IS cancelled here, and that is the whole point. The executor's
 * pre-send recheck reads enrollment.status early, then performs nine more DB
 * round trips before contacting the provider; a stop committing anywhere in
 * that window would otherwise be ignored and the mail would ship AFTER the
 * unsubscribe was durable. Cancelling the claim closes that race.
 *
 * Cancelling a claimed row is SAFE because execute/send.ts writes
 * 'provider_started' BEFORE it calls the transport: a row still in 'claimed'
 * has provably not reached the provider. Nulling claim_token makes the
 * executor's fencedUpdate({state:'claimed'}, ...) match 0 rows, so it returns
 * 'fenced' and sends nothing.
 *
 * 'provider_started' and later are deliberately left alone: the message may
 * already be out, so there is nothing left to stop, and their own fenced
 * writes settle the real outcome.
 */

const NON_TERMINAL_CANCELABLE = ['planned', 'rendered', 'reviewed', 'approved', 'claimed']

export function unsubscribeSecret(): string | null {
  return process.env.GTM_UNSUBSCRIBE_SECRET || process.env.NOLI_INTERNAL_SERVICE_SECRET || null
}

function signPayload(enrollmentId: string, addressHash: string, secret: string): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`${enrollmentId}.${addressHash}`)
    .digest('hex')
}

export function signUnsubscribeToken(
  enrollmentId: string,
  addressHash: string,
  secret: string | null = unsubscribeSecret(),
): string | null {
  if (!secret) return null
  return `${enrollmentId}.${addressHash}.${signPayload(enrollmentId, addressHash, secret)}`
}

export function verifyUnsubscribeToken(
  token: unknown,
  secret: string | null = unsubscribeSecret(),
): { enrollmentId: string; addressHash: string } | null {
  if (!secret || typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [enrollmentId, addressHash, signature] = parts
  if (!enrollmentId || !addressHash || !signature) return null
  const expected = signPayload(enrollmentId, addressHash, secret)
  const provided = Buffer.from(signature)
  const wanted = Buffer.from(expected)
  if (provided.length !== wanted.length) return null
  if (!crypto.timingSafeEqual(provided, wanted)) return null
  return { enrollmentId, addressHash }
}

// The https URL carried in the List-Unsubscribe header (RFC 8058 one-click
// POST target). Module API routes register under /api/<metadata.path>.
export function buildUnsubscribeUrl(enrollmentId: string, addressHash: string): string | null {
  const token = signUnsubscribeToken(enrollmentId, addressHash)
  if (!token) return null
  const base = (process.env.GTM_PUBLIC_BASE_URL || process.env.APP_URL || 'http://localhost:3000')
    .trim()
    .replace(/\/+$/, '')
  return `${base}/api/gtm/unsubscribe?token=${encodeURIComponent(token)}`
}

export type UnsubscribeResult = {
  ok: boolean
  enrollmentFound: boolean
  suppressionCreated: boolean
  enrollmentStopped: boolean
  attemptsCancelled: number
}

// Public-endpoint path: identity comes from the verified token, org/tenant
// scope from the enrollment row itself (there is no session to trust).
export async function applyUnsubscribe(
  em: ExecutionEm,
  input: { enrollmentId: string; addressHash: string },
  deps: { clock?: Clock } = {},
): Promise<UnsubscribeResult> {
  const now = deps.clock?.now() ?? new Date()
  const enrollment = await em.findOne(GtmEnrollment, {
    id: input.enrollmentId,
    deletedAt: null,
  })
  if (!enrollment) {
    return {
      ok: false,
      enrollmentFound: false,
      suppressionCreated: false,
      enrollmentStopped: false,
      attemptsCancelled: 0,
    }
  }

  let suppressionCreated = false
  let enrollmentStopped = false
  let attemptsCancelled = 0
  const runOnce = () =>
    em.transactional(async (tem) => {
      const existing = await tem.findOne(GtmSuppression, {
        organizationId: enrollment.organizationId,
        channel: 'email',
        addressHash: input.addressHash,
        deletedAt: null,
      })
      if (!existing) {
        tem.persist(
          tem.create(GtmSuppression, {
            organizationId: enrollment.organizationId,
            tenantId: enrollment.tenantId,
            scope: 'org',
            channel: 'email',
            addressHash: input.addressHash,
            reason: 'unsubscribe',
            source: { via: 'one_click', enrollment_id: enrollment.id },
          }),
        )
        suppressionCreated = true
      }
      if (enrollment.status === 'active') {
        enrollment.status = 'stopped'
        enrollment.stopReason = 'unsubscribe'
        enrollment.stoppedAt = now
        tem.persist(enrollment)
        enrollmentStopped = true
      }
      attemptsCancelled = await tem.nativeUpdate(
        GtmSendAttempt,
        {
          organizationId: enrollment.organizationId,
          tenantId: enrollment.tenantId,
          enrollmentId: enrollment.id,
          state: { $in: NON_TERMINAL_CANCELABLE },
        },
        {
          state: 'failed',
          failureReason: 'stopped',
          claimToken: null,
          failedAt: now,
          updatedAt: now,
        },
      )
      if (suppressionCreated || enrollmentStopped || attemptsCancelled > 0) {
        tem.persist(
          tem.create(GtmAuditEvent, {
            organizationId: enrollment.organizationId,
            tenantId: enrollment.tenantId,
            actor: 'system',
            actorUserId: null,
            action: 'gtm.enrollment.unsubscribed',
            objectType: 'gtm_enrollment',
            objectId: enrollment.id,
            requestId: null,
            metadata: {
              address_hash: input.addressHash,
              suppression_created: suppressionCreated,
              attempts_cancelled: attemptsCancelled,
            },
          }),
        )
      }
      await tem.flush()
    })
  try {
    await runOnce()
  } catch (err) {
    if (!(err instanceof UniqueConstraintViolationException)) throw err
    // A concurrent unsubscribe won the suppression insert and aborted our
    // transaction. Re-run once: the second pass finds the committed
    // suppression row and still performs the stop + cancel idempotently.
    suppressionCreated = false
    enrollmentStopped = false
    attemptsCancelled = 0
    await runOnce()
  }

  return {
    ok: true,
    enrollmentFound: true,
    suppressionCreated,
    enrollmentStopped,
    attemptsCancelled,
  }
}
