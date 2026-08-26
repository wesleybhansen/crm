import { escapeLikePattern } from '@open-mercato/shared/lib/db/escapeLikePattern'
import { UniqueConstraintViolationException } from '@mikro-orm/core'
import type { Clock, ExecutionEm } from './execute/schedule'
import { hashAddress } from './campaign/exclusions'
import {
  GtmAuditEvent,
  GtmCandidate,
  GtmContactPoint,
  GtmEnrollment,
  GtmSendAttempt,
  GtmSuppression,
} from '../data/entities'
import { executeRemovalDeletion } from './privacy/deletion'
import { consumerProfileDedupeKey, normalizeConsumerProfileUrl } from './research/execute'
export {
  GLOBAL_SUPPRESSION_ORG_ID,
  GLOBAL_SUPPRESSION_TENANT_ID,
} from './privacy/constants'
import {
  GLOBAL_SUPPRESSION_ORG_ID,
  GLOBAL_SUPPRESSION_TENANT_ID,
} from './privacy/constants'

/*
 * Public prospect-removal request (privacy policy section 3.8).
 *
 * Anyone - user or not - can ask to be removed from the Prospect Data Noli
 * sources on behalf of its customers. This is the write half of that promise:
 * a PLATFORM-WIDE suppression plus an immediate stop of anything already
 * queued for that address.
 *
 * Global suppression convention (matched to the existing schema, nothing
 * invented): gtm_suppressions carries scope 'org' | 'global' and is deduped
 * by TWO indexes - `unique (organization_id, channel, address_hash)` for org
 * rows, and the partial
 *   create unique index "gtm_suppressions_global_channel_address_unique"
 *     on "gtm_suppressions" ("channel", "address_hash") where scope = 'global'
 * for global ones. Every reader (campaign/exclusions.ts, execute/send.ts,
 * replies/send.ts) fetches globals with `{ scope: 'global', addressHash }`
 * and never looks at organization_id, so a global row's org/tenant are
 * unused - but the columns are NOT NULL, so a value is still required. We
 * write the nil UUID for both, which (a) is inert, (b) belongs to no real
 * tenant, and (c) makes the org unique index coincide with the global
 * partial index, so both constraints protect the same single row.
 *
 * Privacy: only the SHA-256 of the lowercased address is stored
 * (address_display stays null) - the minimum needed to enforce the
 * suppression, since deleting even that would let the address be re-sourced.
 * No raw address ever reaches an audit row or a log line.
 *
 * The stop half reuses the applyUnsubscribe transaction shape: enrollment
 * stopped (stop_reason 'removal_request'), every attempt that has not yet
 * contacted the provider cancelled, audit event, one transaction per
 * enrollment.
 *
 * 'claimed' IS cancelled (claim_token nulled). execute/send.ts does recheck
 * suppression and enrollment status before provider contact, which narrows
 * this race - but it does NOT close it: those reads happen several statements
 * before the transport call, so a removal committing in between would still
 * be mailed over. Cancelling the claim is what actually closes it.
 *
 * Safe because send.ts writes 'provider_started' BEFORE the transport, so a
 * 'claimed' row has provably not reached the provider; the executor's fenced
 * write then matches 0 rows and returns 'fenced'. 'provider_started' and
 * later are left alone - the message may already be out.
 *
 * Idempotent: a repeat request finds the suppression already present, has no
 * active enrollments left to stop, and still returns ok.
 */

// gtm_suppressions.organization_id / tenant_id are NOT NULL but meaningless
// for scope='global' rows (no reader filters on them). The nil UUID is the
// inert placeholder; never treat it as a real organization.
export const REMOVAL_REQUEST_REASON = 'removal_request'

const NON_TERMINAL_CANCELABLE = ['planned', 'rendered', 'reviewed', 'approved', 'claimed']

const MAX_EMAIL_CHARS = 200

export type RemovalRequestInput = {
  email: string
  // Free-text, optional, supplied by the requester. Never stored: it could
  // carry personal detail we have no reason to keep.
  reason?: string | null
  // Where the request came in from, e.g. 'public_form'. Stored on the
  // suppression row's source jsonb (no address, no free text).
  source?: string | null
}

export type ProfileRemovalRequestInput = {
  profileUrl: string
  reason?: string | null
  source?: string | null
}

export type RemovalRequestResult = {
  ok: true
  suppressed: true
  addressHash: string
  suppressionCreated: boolean
  enrollmentsStopped: number
  attemptsCancelled: number
  deletionRequestId: string
  deletionStatus: string
  recordsAnonymized: number
  dsrOperations: number
}

/** Normalizes the submitted address exactly as the suppression code does
 *  (trim + lowercase) and rejects anything that is not plausibly an email.
 *  Returns null rather than throwing so callers can stay opaque. */
export function normalizeRemovalEmail(raw: unknown): string | null {
  const email = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (!email || email.length > MAX_EMAIL_CHARS) return null
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null
  return email
}

export async function applyRemovalRequest(
  em: ExecutionEm,
  input: RemovalRequestInput,
  deps: { clock?: Clock } = {},
): Promise<RemovalRequestResult> {
  const now = deps.clock?.now() ?? new Date()
  const address = normalizeRemovalEmail(input.email)
  if (!address) throw new Error('invalid_email')
  const addressHash = hashAddress(address)
  const source = typeof input.source === 'string' && input.source.trim() ? input.source.trim() : 'public_form'

  const suppressionCreated = await writeGlobalSuppression(em, { addressHash, source, channel: 'email', now })

  // Everything already queued for this address, across every org. The
  // contact-point match is case-insensitive at the DB (values are stored as
  // sourced) and then re-confirmed by hash in JS, so a collation or pattern
  // surprise can never widen the blast radius to somebody else's address.
  const points = (
    await em.find(GtmContactPoint, {
      channel: 'email',
      value: { $ilike: escapeLikePattern(address) },
      deletedAt: null,
    })
  ).filter((point) => hashAddress(point.value) === addressHash)

  let enrollmentsStopped = 0
  let attemptsCancelled = 0
  for (const point of points) {
    const enrollments = await em.find(GtmEnrollment, {
      organizationId: point.organizationId,
      tenantId: point.tenantId,
      candidateId: point.candidateId,
      status: 'active',
      deletedAt: null,
    })
    for (const enrollment of enrollments) {
      const stopped = await stopEnrollment(em, enrollment, { addressHash, now })
      if (stopped.enrollmentStopped) enrollmentsStopped += 1
      attemptsCancelled += stopped.attemptsCancelled
    }
  }

  // Suppression and stop are immediate; the same request then drives a
  // resumable, idempotent local anonymization/DSR record. The raw address is
  // transient and is never written to a deletion, DSR, or audit row.
  const deletion = await executeRemovalDeletion(
    em,
    { addressHash, normalizedAddress: address, points },
    { clock: deps.clock },
  )

  return {
    ok: true,
    suppressed: true,
    addressHash,
    suppressionCreated,
    enrollmentsStopped,
    attemptsCancelled,
    deletionRequestId: deletion.request.id,
    deletionStatus: deletion.request.status,
    recordsAnonymized:
      deletion.candidatesAnonymized +
      deletion.evidenceAnonymized +
      deletion.contactPointsAnonymized +
      deletion.relationsAnonymized +
      deletion.renderedMessagesAnonymized +
      deletion.repliesAnonymized +
      deletion.emailMessagesAnonymized,
    dsrOperations: deletion.dsrOperations,
  }
}

export async function applyProfileRemovalRequest(
  em: ExecutionEm,
  input: ProfileRemovalRequestInput,
  deps: { clock?: Clock } = {},
): Promise<RemovalRequestResult> {
  const now = deps.clock?.now() ?? new Date()
  const normalizedProfile = normalizeConsumerProfileUrl(input.profileUrl)
  const addressHash = consumerProfileDedupeKey(input.profileUrl)
  if (!normalizedProfile || !addressHash) throw new Error('invalid_profile_url')
  const source = typeof input.source === 'string' && input.source.trim() ? input.source.trim() : 'public_form'
  const suppressionCreated = await writeGlobalSuppression(em, {
    addressHash,
    source,
    channel: 'public_profile',
    now,
  })
  const candidates = await em.find(GtmCandidate, {
    entityKind: 'person',
    dedupeKey: addressHash,
    deletedAt: null,
  })
  const points = candidates.map((candidate) => ({
    id: candidate.id,
    organizationId: candidate.organizationId,
    tenantId: candidate.tenantId,
    candidateId: candidate.id,
    value: normalizedProfile,
  }))
  const deletion = await executeRemovalDeletion(
    em,
    { addressHash, normalizedAddress: normalizedProfile, points },
    { clock: deps.clock },
  )
  return {
    ok: true,
    suppressed: true,
    addressHash,
    suppressionCreated,
    enrollmentsStopped: 0,
    attemptsCancelled: 0,
    deletionRequestId: deletion.request.id,
    deletionStatus: deletion.request.status,
    recordsAnonymized:
      deletion.candidatesAnonymized
      + deletion.evidenceAnonymized
      + deletion.contactPointsAnonymized
      + deletion.relationsAnonymized
      + deletion.renderedMessagesAnonymized
      + deletion.repliesAnonymized
      + deletion.emailMessagesAnonymized
      + deletion.manualDraftsAnonymized,
    dsrOperations: deletion.dsrOperations,
  }
}

/* ── Global suppression (idempotent) ───────────────────────────────────── */

async function writeGlobalSuppression(
  em: ExecutionEm,
  args: { addressHash: string; source: string; channel: 'email' | 'public_profile'; now: Date },
): Promise<boolean> {
  const insert = async (): Promise<boolean> =>
    em.transactional(async (tem) => {
      const existing = await tem.findOne(GtmSuppression, {
        scope: 'global',
        channel: args.channel,
        addressHash: args.addressHash,
        deletedAt: null,
      })
      if (existing) return false
      tem.persist(
        tem.create(GtmSuppression, {
          organizationId: GLOBAL_SUPPRESSION_ORG_ID,
          tenantId: GLOBAL_SUPPRESSION_TENANT_ID,
          scope: 'global',
          channel: args.channel,
          addressHash: args.addressHash,
          // Deliberately null: hash only, never the readable address.
          addressDisplay: null,
          reason: REMOVAL_REQUEST_REASON,
          source: { via: 'removal_request', channel: args.source },
          expiresAt: null,
        }),
      )
      tem.persist(
        tem.create(GtmAuditEvent, {
          organizationId: GLOBAL_SUPPRESSION_ORG_ID,
          tenantId: GLOBAL_SUPPRESSION_TENANT_ID,
          actor: 'system',
          actorUserId: null,
          action: 'gtm.suppression.removal_requested',
          objectType: 'gtm_suppression',
          objectId: null,
          requestId: null,
          metadata: {
            address_hash: args.addressHash,
            scope: 'global',
            channel: args.channel,
            source: args.source,
          },
        }),
      )
      await tem.flush()
      return true
    })
  try {
    return await insert()
  } catch (err) {
    // A concurrent removal request won the unique index and aborted ours.
    // The row it committed is the row we wanted: report "already present".
    if (err instanceof UniqueConstraintViolationException) return false
    throw err
  }
}

/* ── Stop + cancel (applyUnsubscribe transaction shape) ────────────────── */

async function stopEnrollment(
  em: ExecutionEm,
  enrollment: GtmEnrollment,
  args: { addressHash: string; now: Date },
): Promise<{ enrollmentStopped: boolean; attemptsCancelled: number }> {
  let enrollmentStopped = false
  let attemptsCancelled = 0
  await em.transactional(async (tem) => {
    if (enrollment.status === 'active') {
      enrollment.status = 'stopped'
      enrollment.stopReason = REMOVAL_REQUEST_REASON
      enrollment.stoppedAt = args.now
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
        failedAt: args.now,
        updatedAt: args.now,
      },
    )
    if (enrollmentStopped || attemptsCancelled > 0) {
      tem.persist(
        tem.create(GtmAuditEvent, {
          organizationId: enrollment.organizationId,
          tenantId: enrollment.tenantId,
          actor: 'system',
          actorUserId: null,
          action: 'gtm.enrollment.removal_requested',
          objectType: 'gtm_enrollment',
          objectId: enrollment.id,
          requestId: null,
          metadata: {
            address_hash: args.addressHash,
            attempts_cancelled: attemptsCancelled,
          },
        }),
      )
    }
    await tem.flush()
  })
  return { enrollmentStopped, attemptsCancelled }
}
