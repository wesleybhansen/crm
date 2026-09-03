import crypto from 'crypto'
import { LockMode } from '@mikro-orm/core'
import type { GtmCtx } from '../campaign/build'
import { hashAddress } from '../campaign/exclusions'
import { approvalEnvelopeMatches, canonicalHash } from '../campaign/approve'
import { computeExecutionEligibility } from '../eligibility'
import type { Clock, ExecutionEm } from './schedule'
import {
  allocateDailyCapacitySlot,
  allocateCapacitySlotKey,
  buildCapacityReservations,
  CAPACITY_RESERVED_STATES,
  clampToBusinessWindow,
  GtmExecutionError,
  isWithinBusinessWindow,
  parseVersionSettings,
  readStepKey,
} from './schedule'
import type { GtmSendTransport } from './transport'
import { isAmbiguousTransportError, isRetryableTransportError } from './transport'
import { buildUnsubscribeUrl } from '../unsubscribe'
import { messageContentHash, substituteUnsubscribeUrl } from '../campaign/render'
import { readWorkspacePostalAddress } from '../workspace-settings'
import {
  GtmCampaign,
  GtmCampaignVersion,
  GtmContactPoint,
  GtmEnrollment,
  GtmMailboxPolicy,
  GtmPlay,
  GtmRenderedMessage,
  GtmSendAttempt,
  GtmSuppression,
  GtmStep,
  GtmWorkspace,
} from '../../data/entities'
import { EmailConnection, EmailUnsubscribe } from '../../../email/data/schema'
import { readMailboxSendPermission } from '../reputation/mailbox-health'
import {
  mailboxPolicyMatchesSettings,
  settingsFromMailboxPolicy,
} from './mailbox-policy'

/*
 * Claimed-attempt execution (SPEC-066 section 6 rules 2-5, section 8).
 *
 * The executor holds the claim token + fence issued by claim.ts. EVERY write
 * it makes is a conditional UPDATE keyed on (id, claim_token, fence): a
 * writer whose lease expired and whose row was reclaimed (fence bumped, new
 * token) matches zero rows and is fenced out - it can neither resurrect the
 * attempt nor double-record an outcome (rule 5, test target).
 *
 * Order of operations (rules 2-4):
 *   1. pre-send recheck INSIDE the claim, immediately before transport:
 *      suppression, enrollment still active (the atomic-stop marker),
 *      campaign active + current version match + version approved and not
 *      invalidated, play still executable, sender connection active, daily
 *      cap headroom, exact org/tenant. Any failure -> 'failed' with an
 *      explicit reason, never a silent skip.
 *   2. mint rfc_message_id and DURABLY persist it with the 'claimed' ->
 *      'provider_started' transition BEFORE any transport contact, so a
 *      crash mid-send leaves a correlatable, non-resendable row.
 *   3. transport.send(...) carrying the RFC 8058 one-click headers.
 *   4. outcome: resolve -> 'accepted' (+provider_message_id, receipt,
 *      sent_at); thrown Error -> 'failed' (a retry is a NEW attempt row,
 *      not built in this tranche); GtmSendTimeoutError -> 'ambiguous',
 *      parked forever for reconciliation, never auto-retried;
 *      GtmSendRetryableError (the provider provably refused the payload
 *      before accepting it) -> back to 'approved' with a bounded backoff,
 *      counted in transport_retry_count, 'failed' once the bound is hit.
 *
 * Time source: the tick passes the DB-resolved claim `now` (deps.now); this
 * executor advances from that anchor by process elapsed time so window,
 * capacity, health and lease decisions never mix DB and wall-clock time.
 *
 * ORM lifecycle rule: after the fenced nativeUpdate the managed `attempt`
 * entity is NEVER mutated. A managed entity mutated after a nativeUpdate is
 * flushed back over the row by the next transaction commit (MikroORM copies
 * the identity map into the transaction fork and flushes it on commit), which
 * reverted every accepted send but the last one to 'provider_started' (C1).
 */

export type ExecuteOutcome =
  | { outcome: 'accepted'; attemptId: string }
  | { outcome: 'failed'; attemptId: string; reason: string }
  | { outcome: 'ambiguous'; attemptId: string; reason: string }
  | {
      outcome: 'rescheduled'
      attemptId: string
      reason: 'outside_send_window' | 'daily_cap_reached' | 'transport_retry'
      scheduledFor: Date
    }
  | {
      outcome: 'paused'
      attemptId: string
      reason: string
      retryAt: Date
    }
  | { outcome: 'fenced'; attemptId: string }
  | { outcome: 'campaign_paused'; attemptId: string }
  // The tick released the claim untouched because its lease was about to
  // expire (M2); the row is due again immediately.
  | { outcome: 'released'; attemptId: string; reason: 'lease_expiring' }

export type ExecuteDeps = {
  transport: GtmSendTransport
  clock?: Clock
  // DB-resolved time of the claim that produced this attempt (claim.ts).
  now?: Date
  leaseMinutes?: number
  beforeProviderStartTransaction?: () => void | Promise<void>
}

// Definitely-not-sent provider refusals are retried at most this many times
// per attempt row, with exponential backoff (5, 10, 20 minutes).
export const MAX_TRANSPORT_RETRIES = 3
const TRANSPORT_RETRY_BASE_MS = 5 * 60 * 1000

export function transportRetryBackoffMs(retryCount: number): number {
  return TRANSPORT_RETRY_BASE_MS * 2 ** Math.max(0, Math.min(retryCount, MAX_TRANSPORT_RETRIES))
}

// Postgres LIKE/ILIKE pattern for an exact (case-insensitive) match.
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          entry != null && typeof entry === 'object' && !Array.isArray(entry),
      )
    : []
}

function exactlyOne(
  rows: Array<Record<string, unknown>>,
  predicate: (row: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  const matches = rows.filter(predicate)
  return matches.length === 1 ? matches[0] : null
}

export async function executeClaimedAttempt(
  em: ExecutionEm,
  ctx: GtmCtx,
  attempt: GtmSendAttempt,
  deps: ExecuteDeps,
): Promise<ExecuteOutcome> {
  // Snapshot the credentials this executor holds. (Do not re-read them from
  // the row later: a reclaim may have rotated them.)
  const claimToken = attempt.claimToken
  const fence = attempt.fence
  const attemptId = attempt.id
  // A stop (reply / unsubscribe / removal request) landing between
  // claimDueAttempts and here CANCELS the claim and nulls the token on
  // purpose. That is a routine race, not caller error: report it as 'fenced'
  // - another writer won, do nothing - rather than throwing, which would
  // abort the rest of this tick's sends. (A reclaim by another worker needs
  // no special case: the row is still 'claimed' with a rotated token, so the
  // conditional writes below match 0 rows and return 'fenced' anyway.)
  if (
    attempt.state === 'paused'
    || (attempt.state === 'failed'
      && (attempt.failureReason === 'stopped' || attempt.failureReason === 'campaign_stopped'))
  ) {
    return { outcome: 'fenced', attemptId }
  }
  // Anything else not under claim is genuine misuse of this function.
  if (attempt.state !== 'claimed' || !claimToken) {
    throw new GtmExecutionError(
      'attempt_not_claimed',
      `Attempt ${attemptId} is not held under a claim (state '${attempt.state}')`,
    )
  }
  // Anchor on the DB-resolved claim time when the tick provides it and let
  // it advance with process elapsed time; an injected clock (tests) wins.
  const anchor = deps.now ?? null
  const anchoredAt = Date.now()
  const now = () =>
    deps.clock?.now()
    ?? (anchor ? new Date(anchor.getTime() + (Date.now() - anchoredAt)) : new Date())
  const leaseMs = (deps.leaseMinutes && deps.leaseMinutes > 0 ? deps.leaseMinutes : 10) * 60 * 1000

  // Every write presents the claim token + fence (rule 5).
  const fencedUpdateOn = async (
    targetEm: ExecutionEm,
    extraWhere: Record<string, unknown>,
    data: Record<string, unknown>,
  ): Promise<number> =>
    targetEm.nativeUpdate(
      GtmSendAttempt,
      { id: attemptId, claimToken, fence, ...extraWhere },
      { ...data, updatedAt: now() },
    )
  const fencedUpdate = async (
    extraWhere: Record<string, unknown>,
    data: Record<string, unknown>,
  ): Promise<number> => fencedUpdateOn(em, extraWhere, data)

  const fail = async (reason: string): Promise<ExecuteOutcome> => {
    const n = await fencedUpdate(
      {},
      { state: 'failed', failureReason: reason, failedAt: now(), capacitySlotKey: null },
    )
    return n === 1 ? { outcome: 'failed', attemptId, reason } : { outcome: 'fenced', attemptId }
  }

  // -------------------------------------------------------------------------
  // Rule 2: pre-send recheck inside the claim, immediately before transport.
  // -------------------------------------------------------------------------

  // Exact org/tenant identity.
  if (attempt.organizationId !== ctx.organizationId || attempt.tenantId !== ctx.tenantId) {
    return fail('org_tenant_mismatch')
  }

  // Enrollment still active: this is also the durable stop marker the atomic
  // stop (replies/unsubscribe) sets for rows already under claim.
  const enrollment = await em.findOne(GtmEnrollment, {
    id: attempt.enrollmentId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  if (!enrollment) return fail('enrollment_not_found')
  if (enrollment.status !== 'active') return fail('enrollment_stopped')

  // Campaign active and the attempt's version is the CURRENT approved one.
  const campaign = await em.findOne(GtmCampaign, {
    id: enrollment.campaignId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  if (!campaign) return fail('campaign_not_found')
  if (campaign.status !== 'active') return fail('campaign_not_active')
  if (campaign.currentVersionId !== attempt.campaignVersionId) return fail('version_superseded')
  if (enrollment.campaignVersionId !== attempt.campaignVersionId) {
    return fail('enrollment_version_mismatch')
  }
  const version = await em.findOne(GtmCampaignVersion, {
    id: attempt.campaignVersionId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
  })
  if (!version) return fail('version_missing')
  if (version.invalidatedAt) return fail('version_invalidated')
  if (!version.approvedAt) return fail('version_not_approved')
  if (!approvalEnvelopeMatches(version.snapshot, version.contentHash)) {
    return fail('approval_envelope_changed')
  }
  const snapshot = (version.snapshot ?? {}) as Record<string, unknown>
  if (snapshot.campaign_id !== campaign.id) return fail('approval_campaign_mismatch')

  // Play eligibility recomputed from the play row's current state
  // (section 7 boundary 6).
  const play = await em.findOne(GtmPlay, {
    id: campaign.playId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  if (!play) return fail('play_not_found')
  if (snapshot.play_id !== play.id) return fail('approval_play_mismatch')
  const eligibility = computeExecutionEligibility({
    market_type: play.marketType ?? null,
    geography: play.geography ?? null,
  })
  if (eligibility.execution_eligibility !== 'executable') return fail('play_not_executable')
  if (snapshot.eligibility !== eligibility.execution_eligibility) {
    return fail('approval_eligibility_mismatch')
  }

  // CAN-SPAM defense in depth: approval already required the org's postal
  // address, but the workspace setting may have been cleared since. The
  // frozen footer would then carry a stale address the org disowned, so the
  // send fails closed with an explicit reason.
  const workspace = await em.findOne(GtmWorkspace, {
    id: campaign.workspaceId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  const snapshotSettings = (snapshot.settings ?? {}) as Record<string, unknown>
  const approvedPostalAddress = typeof snapshotSettings.postal_address === 'string'
    ? snapshotSettings.postal_address
    : null
  if (!approvedPostalAddress || readWorkspacePostalAddress(workspace) !== approvedPostalAddress) {
    return fail('postal_address_changed')
  }

  // Manual social task rows share the durable attempt table but deliberately
  // have neither binding. They can never cross into the email executor.
  const mailboxConnectionId = attempt.mailboxConnectionId
  const renderedMessageId = attempt.renderedMessageId
  if (!mailboxConnectionId || !renderedMessageId) return fail('attempt_binding_missing')
  if (snapshotSettings.sender_mailbox_id !== mailboxConnectionId) {
    return fail('attempt_sender_mismatch')
  }

  // Sender connection exists, belongs to this org/tenant, and is active.
  const connection = await em.findOne(EmailConnection, {
    id: mailboxConnectionId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  if (!connection || !connection.isActive) return fail('sender_inactive')
  const approvedSender = snapshotSettings.sender as Record<string, unknown> | null | undefined
  if (!approvedSender || typeof approvedSender.fingerprint !== 'string') {
    return fail('sender_not_approved')
  }
  const currentSenderMaterial = {
    mailbox_connection_id: connection.id,
    provider: connection.provider,
    email_address: connection.emailAddress.trim().toLowerCase(),
    user_id: connection.userId,
    purpose: connection.purpose ?? null,
    updated_at: connection.updatedAt.toISOString(),
  }
  if (
    approvedSender.mailbox_connection_id !== connection.id
    || approvedSender.fingerprint !== canonicalHash(currentSenderMaterial)
  ) {
    return fail('sender_changed')
  }

  // Recipient address (current verified contact point) + suppression.
  const approvedRecipients = recordArray(snapshot.recipients)
  const approvedRecipient = exactlyOne(
    approvedRecipients,
    (row) => row.candidate_id === enrollment.candidateId,
  )
  if (
    !approvedRecipient
    || typeof approvedRecipient.contact_point_id !== 'string'
    || typeof approvedRecipient.address_hash !== 'string'
  ) {
    return fail('recipient_not_approved')
  }
  if ((approvedRecipient.contact_id ?? null) !== (enrollment.contactId ?? null)) {
    return fail('recipient_contact_mismatch')
  }
  const runtimeIds = (snapshot.ids ?? {}) as Record<string, unknown>
  const approvedEnrollment = exactlyOne(
    recordArray(runtimeIds.enrollments),
    (row) =>
      row.candidate_id === enrollment.candidateId
      && row.enrollment_id === enrollment.id,
  )
  if (!approvedEnrollment) return fail('enrollment_not_approved')
  const point = await em.findOne(GtmContactPoint, {
    id: approvedRecipient.contact_point_id,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    candidateId: enrollment.candidateId,
    channel: 'email',
    verificationState: 'verified',
    deletedAt: null,
  })
  const address = point?.value?.trim().toLowerCase() ?? null
  if (!address) return fail('no_verified_contact_point')
  const addressHash = hashAddress(address)
  if (addressHash !== approvedRecipient.address_hash) return fail('recipient_changed')
  const suppressed = await findSuppression(em, ctx.organizationId, addressHash, now())
  if (suppressed) return fail('suppressed')
  // Bounded lookup (M5): one address, case-insensitive, instead of loading
  // every legacy unsubscribe row of the org on every send.
  const legacyRows = await em.find(EmailUnsubscribe, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    email: { $ilike: escapeLikePattern(address) },
  })
  if (legacyRows.some((row) => row.email.trim().toLowerCase() === address)) {
    return fail('legacy_unsubscribe')
  }

  let settings: ReturnType<typeof parseVersionSettings>
  try {
    settings = parseVersionSettings(version)
  } catch {
    return fail('approval_capacity_invalid')
  }
  const step = await em.findOne(GtmStep, {
    id: attempt.stepId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    campaignVersionId: version.id,
    deletedAt: null,
  })
  if (!step || step.mode !== 'automated_email' || step.channel !== 'email') {
    return fail('step_not_approved_email')
  }
  const stepKey = readStepKey(step)
  const approvedStep = exactlyOne(
    recordArray(snapshot.steps),
    (row) => row.key === stepKey,
  )
  const approvedStepId = exactlyOne(
    recordArray(runtimeIds.steps),
    (row) => row.key === stepKey && row.id === step.id,
  )
  if (!approvedStep || !approvedStepId) return fail('step_not_approved')
  const stepWindow = (step.sendWindow ?? {}) as Record<string, unknown>
  if (
    approvedStep.order !== step.order
    || approvedStep.channel !== step.channel
    || approvedStep.mode !== step.mode
    || approvedStep.delay_days !== step.delayDays
    || approvedStep.dependency_kind !== step.dependencyKind
    || (approvedStep.social_action ?? null) !== (stepWindow.social_action ?? null)
    || (approvedStepId.depends_on_step_id ?? null) !== (step.dependsOnStepId ?? null)
  ) {
    return fail('step_changed')
  }
  if (
    stepWindow.step_key !== stepKey
    || stepWindow.start_hour !== settings.send_window.start_hour
    || stepWindow.end_hour !== settings.send_window.end_hour
    || stepWindow.timezone !== settings.send_window.timezone
    || stepWindow.jitter_minutes !== settings.jitter_minutes
  ) {
    return fail('step_window_changed')
  }

  const rendered = await em.findOne(GtmRenderedMessage, {
    id: renderedMessageId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    campaignVersionId: version.id,
    enrollmentId: enrollment.id,
    stepId: step.id,
    deletedAt: null,
  })
  if (!rendered) return fail('rendered_message_missing')
  const approvedRendered = exactlyOne(
    recordArray(snapshot.rendered),
    (row) => row.candidate_id === enrollment.candidateId && row.step_key === stepKey,
  )
  const approvedRenderedId = exactlyOne(
    recordArray(runtimeIds.rendered),
    (row) =>
      row.enrollment_id === enrollment.id
      && row.step_id === step.id
      && row.step_key === stepKey
      && row.rendered_message_id === rendered.id,
  )
  if (!approvedRendered || !approvedRenderedId) return fail('rendered_message_not_approved')
  const computedContentHash = messageContentHash(
    rendered.subject ?? '',
    rendered.bodyHtml ?? '',
    rendered.bodyText ?? '',
    stepKey,
  )
  if (
    rendered.contentHash !== computedContentHash
    || approvedRendered.content_hash !== computedContentHash
    || approvedRenderedId.content_hash !== computedContentHash
  ) {
    return fail('rendered_message_changed')
  }

  // -------------------------------------------------------------------------
  // Rule 3: mint + persist rfc_message_id, go 'provider_started' durably
  // BEFORE the transport is contacted.
  // -------------------------------------------------------------------------
  const senderDomain = (connection.emailAddress || '').split('@')[1] || 'invalid.local'
  const rfcMessageId = `<${crypto.randomUUID()}@${senderDomain}>`
  await deps.beforeProviderStartTransaction?.()
  const startDecision = await em.transactional(async (tem) => {
    const lockedConnection = await tem.findOne(
      EmailConnection,
      {
        id: mailboxConnectionId,
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        deletedAt: null,
      },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    )
    const lockedSenderMaterial = lockedConnection && lockedConnection.isActive
      ? {
          mailbox_connection_id: lockedConnection.id,
          provider: lockedConnection.provider,
          email_address: lockedConnection.emailAddress.trim().toLowerCase(),
          user_id: lockedConnection.userId,
          purpose: lockedConnection.purpose ?? null,
          updated_at: lockedConnection.updatedAt.toISOString(),
        }
      : null
    if (
      !lockedSenderMaterial
      || approvedSender.mailbox_connection_id !== lockedConnection?.id
      || approvedSender.fingerprint !== canonicalHash(lockedSenderMaterial)
    ) {
      const updated = await fencedUpdateOn(
        tem,
        { state: 'claimed' },
        {
          state: 'failed',
          failureReason: 'sender_changed',
          failedAt: now(),
          capacitySlotKey: null,
        },
      )
      return updated === 1
        ? ({ outcome: 'failed', attemptId, reason: 'sender_changed' } as const)
        : ({ outcome: 'fenced', attemptId } as const)
    }

    const lockedCampaign = await tem.findOne(
      GtmCampaign,
      {
        id: campaign.id,
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        deletedAt: null,
      },
      { lockMode: LockMode.PESSIMISTIC_READ },
    )
    if (lockedCampaign?.status === 'paused') {
      const updated = await fencedUpdateOn(
        tem,
        { state: 'claimed' },
        {
          state: 'paused',
          claimToken: null,
          claimExpiresAt: null,
          capacitySlotKey: null,
          failureReason: null,
          failedAt: null,
        },
      )
      return updated === 1
        ? ({ outcome: 'campaign_paused', attemptId } as const)
        : ({ outcome: 'fenced', attemptId } as const)
    }
    if (
      !lockedCampaign
      || lockedCampaign.status !== 'active'
      || lockedCampaign.currentVersionId !== version.id
    ) {
      const updated = await fencedUpdateOn(
        tem,
        { state: 'claimed' },
        { state: 'failed', failureReason: 'campaign_not_active', failedAt: now(), capacitySlotKey: null },
      )
      return updated === 1
        ? ({ outcome: 'failed', attemptId, reason: 'campaign_not_active' } as const)
        : ({ outcome: 'fenced', attemptId } as const)
    }
    const mailboxPolicy = await tem.findOne(
      GtmMailboxPolicy,
      {
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        mailboxConnectionId,
        deletedAt: null,
      },
      { lockMode: LockMode.PESSIMISTIC_READ },
    )
    if (!mailboxPolicy || !mailboxPolicyMatchesSettings(mailboxPolicy, settings)) {
      const updated = await fencedUpdateOn(
        tem,
        { state: 'claimed' },
        { state: 'failed', failureReason: 'mailbox_policy_conflict', failedAt: now(), capacitySlotKey: null },
      )
      return updated === 1
        ? ({ outcome: 'failed', attemptId, reason: 'mailbox_policy_conflict' } as const)
        : ({ outcome: 'fenced', attemptId } as const)
    }
    const capacitySettings = settingsFromMailboxPolicy(mailboxPolicy)

    const healthNow = now()
    const sendPermission = await readMailboxSendPermission(
      tem,
      ctx,
      mailboxConnectionId,
      healthNow,
    )
    if (!sendPermission.allowed) {
      const retryAt = sendPermission.pauseUntil
        ?? new Date(healthNow.getTime() + 24 * 60 * 60 * 1000)
      const updated = await fencedUpdateOn(
        tem,
        { state: 'claimed' },
        {
          state: 'approved',
          claimToken: null,
          claimExpiresAt: null,
          scheduledFor: retryAt,
          capacitySlotKey: null,
          failureReason: `mailbox_paused:${sendPermission.pauseReason}`,
          failedAt: null,
        },
      )
      return updated === 1
        ? ({
            outcome: 'paused',
            attemptId,
            reason: sendPermission.pauseReason,
            retryAt,
          } as const)
        : ({ outcome: 'fenced', attemptId } as const)
    }

    // Repeat the suppression check INSIDE the locked transaction (L4): a
    // suppression written by any path that does not cancel the claim (manual
    // suppress, classifier) between the recheck above and provider_started
    // must still win.
    if (await findSuppression(tem, ctx.organizationId, addressHash, now())) {
      const updated = await fencedUpdateOn(
        tem,
        { state: 'claimed' },
        { state: 'failed', failureReason: 'suppressed', failedAt: now(), capacitySlotKey: null },
      )
      return updated === 1
        ? ({ outcome: 'failed', attemptId, reason: 'suppressed' } as const)
        : ({ outcome: 'fenced', attemptId } as const)
    }

    const capacityNow = now()
    const capacityRows = await loadCapacityRows(tem, ctx, mailboxConnectionId, capacityNow)
    const reservations = buildCapacityReservations(
      capacityRows,
      capacitySettings.send_window.timezone,
      attemptId,
    )
    const withinWindow = isWithinBusinessWindow(capacityNow, capacitySettings.send_window)
    const candidateSlot = withinWindow
      ? capacityNow
      : clampToBusinessWindow(capacityNow, capacitySettings.send_window)
    const scheduledFor = allocateDailyCapacitySlot(candidateSlot, capacitySettings, reservations)
    const capacitySlotKey = allocateCapacitySlotKey(
      mailboxConnectionId,
      scheduledFor,
      capacitySettings,
      capacityRows,
      { excludeAttemptId: attemptId, preferredKey: attempt.capacitySlotKey },
    )
    const mustReschedule = !withinWindow || scheduledFor.getTime() !== capacityNow.getTime()
    if (mustReschedule) {
      const reason = withinWindow ? 'daily_cap_reached' : 'outside_send_window'
      const updated = await fencedUpdateOn(
        tem,
        { state: 'claimed' },
        {
          state: 'approved',
          claimToken: null,
          claimExpiresAt: null,
          scheduledFor,
          capacitySlotKey,
          failureReason: null,
          failedAt: null,
        },
      )
      return updated === 1
        ? ({ outcome: 'rescheduled', attemptId, reason, scheduledFor } as const)
        : ({ outcome: 'fenced', attemptId } as const)
    }

    // Re-lease under the fence (M2): the lease was set once at claim time and
    // a serial tick can reach this row minutes later. A fresh lease from
    // here keeps a slow-but-successful transport call from being parked
    // ambiguous by a concurrent recoverStuckAttempts pass.
    const started = await fencedUpdateOn(
      tem,
      { state: 'claimed' },
      {
        state: 'provider_started',
        rfcMessageId,
        capacitySlotKey,
        claimExpiresAt: new Date(now().getTime() + leaseMs),
      },
    )
    return started === 1
      ? ({ outcome: 'started' } as const)
      : ({ outcome: 'fenced', attemptId } as const)
  })
  if (startDecision.outcome !== 'started') return startDecision
  // The managed entity is deliberately left untouched here (see the header
  // note); rfcMessageId is carried in the local below.

  // RFC 8058 one-click headers on every GTM send (section 8).
  const unsubscribeUrl = buildUnsubscribeUrl({
    organizationId: enrollment.organizationId,
    tenantId: enrollment.tenantId,
    enrollmentId: enrollment.id,
    addressHash,
  })
  const headers: Record<string, string> = {
    'List-Unsubscribe': unsubscribeUrl
      ? `<mailto:${connection.emailAddress}?subject=unsubscribe>, <${unsubscribeUrl}>`
      : `<mailto:${connection.emailAddress}?subject=unsubscribe>`,
  }
  if (unsubscribeUrl?.startsWith('https://')) {
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click'
  }

  // Substitute the [[unsubscribe_url]] compliance-footer token on a COPY of
  // the frozen content, right before transport. The stored rendered row is
  // never mutated: its content hash deliberately covers the TOKEN (the
  // reviewer approved the token, and the hash must stay verifiable), while
  // the real URL is per-enrollment and signed, so it can only exist here at
  // send time. Without a signable URL we fall back to the mailto unsubscribe
  // already carried in the List-Unsubscribe header.
  const unsubscribeHref =
    unsubscribeUrl ?? `mailto:${connection.emailAddress}?subject=unsubscribe`
  const outboundHtml = substituteUnsubscribeUrl(rendered.bodyHtml ?? '', unsubscribeHref)
  const outboundText = substituteUnsubscribeUrl(rendered.bodyText ?? '', unsubscribeHref)

  // -------------------------------------------------------------------------
  // Rules 3-4: transport contact + outcome mapping.
  // -------------------------------------------------------------------------
  try {
    const result = await deps.transport.send({
      connection,
      from: connection.emailAddress,
      to: address,
      subject: rendered.subject ?? '',
      html: outboundHtml,
      text: outboundText,
      headers,
      messageId: rfcMessageId,
    })
    const sentAt = now()
    const n = await fencedUpdate(
      { state: 'provider_started' },
      {
        state: 'accepted',
        providerMessageId: result.providerMessageId ?? null,
        providerReceipt: result.receipt ?? null,
        sentAt,
        acceptedAt: sentAt,
      },
    )
    return n === 1 ? { outcome: 'accepted', attemptId } : { outcome: 'fenced', attemptId }
  } catch (err) {
    if (isAmbiguousTransportError(err)) {
      // Rule 4: unknown outcome after provider contact -> ambiguous, parked,
      // never auto-retried.
      const reason = `transport_timeout: ${(err as Error).message}`
      const n = await fencedUpdate(
        { state: 'provider_started' },
        { state: 'ambiguous', ambiguousAt: now(), failureReason: reason },
      )
      return n === 1
        ? { outcome: 'ambiguous', attemptId, reason }
        : { outcome: 'fenced', attemptId }
    }
    if (isRetryableTransportError(err)) {
      // The provider provably refused the payload before accepting it (M1):
      // nothing is with the provider, so the row goes back to 'approved'
      // with backoff. Bounded: after MAX_TRANSPORT_RETRIES it fails closed
      // with an explicit reason instead of retrying forever.
      const retries = attempt.transportRetryCount ?? 0
      if (retries < MAX_TRANSPORT_RETRIES) {
        const scheduledFor = new Date(now().getTime() + transportRetryBackoffMs(retries))
        const reason = `transport_retry: ${(err as Error).message}`
        const n = await fencedUpdate(
          { state: 'provider_started' },
          {
            state: 'approved',
            claimToken: null,
            claimExpiresAt: null,
            scheduledFor,
            transportRetryCount: retries + 1,
            failureReason: reason,
            failedAt: null,
          },
        )
        return n === 1
          ? { outcome: 'rescheduled', attemptId, reason: 'transport_retry', scheduledFor }
          : { outcome: 'fenced', attemptId }
      }
      const reason = `transport_error: retries exhausted: ${(err as Error).message}`
      const n = await fencedUpdate(
        { state: 'provider_started' },
        { state: 'failed', failureReason: reason, failedAt: now(), capacitySlotKey: null },
      )
      return n === 1 ? { outcome: 'failed', attemptId, reason } : { outcome: 'fenced', attemptId }
    }
    const reason = `transport_error: ${(err as Error)?.message ?? 'unknown'}`
    const n = await fencedUpdate(
      { state: 'provider_started' },
      { state: 'failed', failureReason: reason, failedAt: now(), capacitySlotKey: null },
    )
    return n === 1 ? { outcome: 'failed', attemptId, reason } : { outcome: 'fenced', attemptId }
  }
}

// Capacity reservations only matter for the mailbox-local day being
// scheduled and the days after it; rows that settled before yesterday can
// never change today's count. Bounding the read (M5) keeps the FOR UPDATE
// hold on the connection row short as accepted/delivered history grows.
export const CAPACITY_LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000

export async function loadCapacityRows(
  em: ExecutionEm,
  ctx: Pick<GtmCtx, 'organizationId' | 'tenantId'>,
  mailboxConnectionId: string,
  now: Date,
): Promise<GtmSendAttempt[]> {
  const since = new Date(now.getTime() - CAPACITY_LOOKBACK_MS)
  return em.find(GtmSendAttempt, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    mailboxConnectionId,
    state: { $in: [...CAPACITY_RESERVED_STATES] },
    deletedAt: null,
    $or: [
      { scheduledFor: { $gte: since } },
      { sentAt: { $gte: since } },
      { ambiguousAt: { $gte: since } },
      { updatedAt: { $gte: since } },
    ],
  })
}

// Org + global suppression lookup for one address hash. The channel is part
// of the where so the (organization_id, channel, address_hash) unique index
// is usable (L3).
export async function findSuppression(
  em: ExecutionEm,
  organizationId: string,
  addressHash: string,
  now: Date,
): Promise<GtmSuppression | null> {
  const rows = [
    ...(await em.find(GtmSuppression, {
      organizationId,
      channel: { $in: ['email', 'all'] },
      addressHash,
      deletedAt: null,
    })),
    ...(await em.find(GtmSuppression, {
      scope: 'global',
      channel: { $in: ['email', 'all'] },
      addressHash,
      deletedAt: null,
    })),
  ]
  for (const row of rows) {
    if (row.channel !== 'email' && row.channel !== 'all') continue
    if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) continue
    return row
  }
  return null
}
