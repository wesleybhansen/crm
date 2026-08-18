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
import { GtmSendTimeoutError } from './transport'
import { buildUnsubscribeUrl } from '../unsubscribe'
import { messageContentHash, substituteUnsubscribeUrl } from '../campaign/render'
import { readWorkspacePostalAddress } from '../workspace-settings'
import {
  GtmCampaign,
  GtmCampaignVersion,
  GtmContactPoint,
  GtmEnrollment,
  GtmPlay,
  GtmRenderedMessage,
  GtmSendAttempt,
  GtmSuppression,
  GtmStep,
  GtmWorkspace,
} from '../../data/entities'
import { EmailConnection, EmailUnsubscribe } from '../../../email/data/schema'

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
 *      parked forever for reconciliation, never auto-retried.
 */

export type ExecuteOutcome =
  | { outcome: 'accepted'; attemptId: string }
  | { outcome: 'failed'; attemptId: string; reason: string }
  | { outcome: 'ambiguous'; attemptId: string; reason: string }
  | {
      outcome: 'rescheduled'
      attemptId: string
      reason: 'outside_send_window' | 'daily_cap_reached'
      scheduledFor: Date
    }
  | { outcome: 'fenced'; attemptId: string }

export type ExecuteDeps = {
  transport: GtmSendTransport
  clock?: Clock
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
  if (attempt.state === 'failed' && attempt.failureReason === 'stopped') {
    return { outcome: 'fenced', attemptId }
  }
  // Anything else not under claim is genuine misuse of this function.
  if (attempt.state !== 'claimed' || !claimToken) {
    throw new GtmExecutionError(
      'attempt_not_claimed',
      `Attempt ${attemptId} is not held under a claim (state '${attempt.state}')`,
    )
  }
  const now = () => deps.clock?.now() ?? new Date()

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
  const legacyRows = await em.find(EmailUnsubscribe, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
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

    const capacityRows = await tem.find(GtmSendAttempt, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      mailboxConnectionId,
      state: { $in: [...CAPACITY_RESERVED_STATES] },
      deletedAt: null,
    })
    const reservations = buildCapacityReservations(
      capacityRows,
      settings.send_window.timezone,
      attemptId,
    )
    const capacityNow = now()
    const withinWindow = isWithinBusinessWindow(capacityNow, settings.send_window)
    const candidateSlot = withinWindow
      ? capacityNow
      : clampToBusinessWindow(capacityNow, settings.send_window)
    const scheduledFor = allocateDailyCapacitySlot(candidateSlot, settings, reservations)
    const capacitySlotKey = allocateCapacitySlotKey(
      mailboxConnectionId,
      scheduledFor,
      settings,
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

    const started = await fencedUpdateOn(
      tem,
      { state: 'claimed' },
      { state: 'provider_started', rfcMessageId, capacitySlotKey },
    )
    return started === 1
      ? ({ outcome: 'started' } as const)
      : ({ outcome: 'fenced', attemptId } as const)
  })
  if (startDecision.outcome !== 'started') return startDecision
  attempt.state = 'provider_started'
  attempt.rfcMessageId = rfcMessageId

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
    if (err instanceof GtmSendTimeoutError || (err as Error)?.name === 'GtmSendTimeoutError') {
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
    const reason = `transport_error: ${(err as Error)?.message ?? 'unknown'}`
    const n = await fencedUpdate(
      { state: 'provider_started' },
      { state: 'failed', failureReason: reason, failedAt: now(), capacitySlotKey: null },
    )
    return n === 1 ? { outcome: 'failed', attemptId, reason } : { outcome: 'fenced', attemptId }
  }
}

async function findSuppression(
  em: ExecutionEm,
  organizationId: string,
  addressHash: string,
  now: Date,
): Promise<GtmSuppression | null> {
  const rows = [
    ...(await em.find(GtmSuppression, {
      organizationId,
      addressHash,
      deletedAt: null,
    })),
    ...(await em.find(GtmSuppression, {
      scope: 'global',
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
