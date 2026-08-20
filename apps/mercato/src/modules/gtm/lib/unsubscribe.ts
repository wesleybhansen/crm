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
 * New tokens are tenant-scoped v2 HMAC envelopes carrying a key id,
 * organization, tenant, enrollment, and address hash. A rotatable keyring
 * verifies both the active and retained keys. The legacy three-part token is
 * verify-only for already-issued links. Verification is length-guarded with
 * crypto.timingSafeEqual.
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

type UnsubscribeKeyring = {
  activeKeyId: string
  keys: ReadonlyMap<string, string>
}

function unsubscribeKeyring(): UnsubscribeKeyring | null {
  const raw = process.env.GTM_UNSUBSCRIBE_KEYRING
  const activeKeyId = (process.env.GTM_UNSUBSCRIBE_ACTIVE_KEY_ID || '').trim()
  if (!raw || !activeKeyId || !/^[A-Za-z0-9_-]{1,40}$/.test(activeKeyId)) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const keys = new Map<string, string>()
    for (const [keyId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(keyId)) continue
      if (typeof value === 'string' && value.length >= 16) keys.set(keyId, value)
    }
    if (!keys.has(activeKeyId)) return null
    return { activeKeyId, keys }
  } catch {
    return null
  }
}

function signPayload(enrollmentId: string, addressHash: string, secret: string): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`${enrollmentId}.${addressHash}`)
    .digest('hex')
}

function signVersionedPayload(
  keyId: string,
  organizationId: string,
  tenantId: string,
  enrollmentId: string,
  addressHash: string,
  secret: string,
): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`v2.${keyId}.${organizationId}.${tenantId}.${enrollmentId}.${addressHash}`)
    .digest('hex')
}

export type ScopedUnsubscribeToken = {
  organizationId: string
  tenantId: string
  enrollmentId: string
  addressHash: string
}

export function signScopedUnsubscribeToken(input: ScopedUnsubscribeToken): string | null {
  const keyring = unsubscribeKeyring()
  if (!keyring) return null
  const keyId = keyring.activeKeyId
  const key = keyring.keys.get(keyId)
  if (!key) return null
  const signature = signVersionedPayload(
    keyId,
    input.organizationId,
    input.tenantId,
    input.enrollmentId,
    input.addressHash,
    key,
  )
  return [
    'v2',
    keyId,
    input.organizationId,
    input.tenantId,
    input.enrollmentId,
    input.addressHash,
    signature,
  ].join('.')
}

export function signUnsubscribeToken(
  enrollmentId: string,
  addressHash: string,
  secret?: string | null,
): string | null {
  if (secret !== undefined) {
    if (!secret) return null
    return `${enrollmentId}.${addressHash}.${signPayload(enrollmentId, addressHash, secret)}`
  }
  // The legacy-shaped helper is retained only for already-issued v1 links
  // and deterministic tests. New sends must use signScopedUnsubscribeToken.
  const legacySecret = unsubscribeSecret()
  if (!legacySecret) return null
  return `${enrollmentId}.${addressHash}.${signPayload(enrollmentId, addressHash, legacySecret)}`
}

export function verifyUnsubscribeToken(
  token: unknown,
  secret?: string | null,
): (ScopedUnsubscribeToken & { version: 'v2' }) | ({ enrollmentId: string; addressHash: string; version: 'v1' }) | null {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length === 7 && parts[0] === 'v2' && secret === undefined) {
    const [, keyId, organizationId, tenantId, enrollmentId, addressHash, signature] = parts
    const key =
      unsubscribeKeyring()?.keys.get(keyId) ??
      (keyId === 'legacy' ? unsubscribeSecret() : null)
    if (!key || !organizationId || !tenantId || !enrollmentId || !addressHash || !signature) return null
    const expected = signVersionedPayload(
      keyId,
      organizationId,
      tenantId,
      enrollmentId,
      addressHash,
      key,
    )
    const provided = Buffer.from(signature)
    const wanted = Buffer.from(expected)
    if (provided.length !== wanted.length || !crypto.timingSafeEqual(provided, wanted)) return null
    return { version: 'v2', organizationId, tenantId, enrollmentId, addressHash }
  }
  if (parts.length !== 3) return null
  const legacySecret = secret === undefined ? unsubscribeSecret() : secret
  if (!legacySecret) return null
  const [enrollmentId, addressHash, signature] = parts
  if (!enrollmentId || !addressHash || !signature) return null
  const expected = signPayload(enrollmentId, addressHash, legacySecret)
  const provided = Buffer.from(signature)
  const wanted = Buffer.from(expected)
  if (provided.length !== wanted.length) return null
  if (!crypto.timingSafeEqual(provided, wanted)) return null
  return { version: 'v1', enrollmentId, addressHash }
}

// The https URL carried in the List-Unsubscribe header (RFC 8058 one-click
// POST target). Module API routes register under /api/<metadata.path>.
export function buildUnsubscribeUrl(input: ScopedUnsubscribeToken): string | null {
  // Fail closed for new signed links when a scoped rotatable keyring is absent.
  // The caller retains a mailto-only unsubscribe path; it must never mint a
  // new token with the verify-only legacy secret.
  const token = signScopedUnsubscribeToken(input)
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
  input: { enrollmentId: string; addressHash: string; organizationId?: string; tenantId?: string },
  deps: { clock?: Clock } = {},
): Promise<UnsubscribeResult> {
  const now = deps.clock?.now() ?? new Date()
  const enrollment = await em.findOne(GtmEnrollment, {
    id: input.enrollmentId,
    ...(input.organizationId ? { organizationId: input.organizationId } : {}),
    ...(input.tenantId ? { tenantId: input.tenantId } : {}),
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
          claimExpiresAt: null,
          capacitySlotKey: null,
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
