import crypto from 'crypto'
import type { GtmCtx } from '../campaign/build'
import { hashAddress } from '../campaign/exclusions'
import { canonicalHash } from '../campaign/approve'
import { computeExecutionEligibility } from '../eligibility'
import type { Clock, ExecutionEm } from './schedule'
import { GtmExecutionError, parseVersionSettings } from './schedule'
import type { GtmSendTransport } from './transport'
import { GtmSendTimeoutError } from './transport'
import { buildUnsubscribeUrl } from '../unsubscribe'
import { substituteUnsubscribeUrl } from '../campaign/render'
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

// States that consumed provider capacity for the daily-cap count.
const CAP_COUNTED_STATES = [
  'provider_started',
  'accepted',
  'delivered',
  'bounced',
  'complained',
  'replied',
  'ambiguous',
]

export type ExecuteOutcome =
  | { outcome: 'accepted'; attemptId: string }
  | { outcome: 'failed'; attemptId: string; reason: string }
  | { outcome: 'ambiguous'; attemptId: string; reason: string }
  | { outcome: 'fenced'; attemptId: string }

export type ExecuteDeps = {
  transport: GtmSendTransport
  clock?: Clock
}

function dayKey(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date)
  } catch {
    return date.toISOString().slice(0, 10)
  }
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
  const fencedUpdate = async (
    extraWhere: Record<string, unknown>,
    data: Record<string, unknown>,
  ): Promise<number> =>
    em.nativeUpdate(
      GtmSendAttempt,
      { id: attemptId, claimToken, fence, ...extraWhere },
      { ...data, updatedAt: now() },
    )

  const fail = async (reason: string): Promise<ExecuteOutcome> => {
    const n = await fencedUpdate({}, { state: 'failed', failureReason: reason, failedAt: now() })
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
  const version = await em.findOne(GtmCampaignVersion, {
    id: attempt.campaignVersionId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
  })
  if (!version) return fail('version_missing')
  if (version.invalidatedAt) return fail('version_invalidated')
  if (!version.approvedAt) return fail('version_not_approved')

  // Play eligibility recomputed from the play row's current state
  // (section 7 boundary 6).
  const play = await em.findOne(GtmPlay, {
    id: campaign.playId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  if (!play) return fail('play_not_found')
  const eligibility = computeExecutionEligibility({
    market_type: play.marketType ?? null,
    geography: play.geography ?? null,
  })
  if (eligibility.execution_eligibility !== 'executable') return fail('play_not_executable')

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
  const snapshot = (version.snapshot ?? {}) as Record<string, unknown>
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
  const approvedRecipients = Array.isArray(snapshot.recipients)
    ? snapshot.recipients as Array<Record<string, unknown>>
    : []
  const approvedRecipient = approvedRecipients.find(
    (row) => row.candidate_id === enrollment.candidateId,
  )
  if (
    !approvedRecipient
    || typeof approvedRecipient.contact_point_id !== 'string'
    || typeof approvedRecipient.address_hash !== 'string'
  ) {
    return fail('recipient_not_approved')
  }
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

  // Daily cap headroom for this mailbox within the send-window day.
  const settings = parseVersionSettings(version)
  const windowTz = settings.send_window.timezone
  const today = dayKey(now(), windowTz)
  const counted = await em.find(GtmSendAttempt, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    mailboxConnectionId,
    state: { $in: CAP_COUNTED_STATES },
    deletedAt: null,
  })
  const sentToday = counted.filter((row) => {
    const ts = row.sentAt ?? row.ambiguousAt ?? row.updatedAt
    return ts != null && dayKey(ts, windowTz) === today
  }).length
  if (sentToday >= settings.daily_cap) return fail('daily_cap_reached')

  // Frozen message content.
  const rendered = await em.findOne(GtmRenderedMessage, {
    id: renderedMessageId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  if (!rendered) return fail('rendered_message_missing')

  // -------------------------------------------------------------------------
  // Rule 3: mint + persist rfc_message_id, go 'provider_started' durably
  // BEFORE the transport is contacted.
  // -------------------------------------------------------------------------
  const senderDomain = (connection.emailAddress || '').split('@')[1] || 'invalid.local'
  const rfcMessageId = `<${crypto.randomUUID()}@${senderDomain}>`
  const started = await fencedUpdate(
    { state: 'claimed' },
    { state: 'provider_started', rfcMessageId },
  )
  if (started !== 1) return { outcome: 'fenced', attemptId }
  attempt.rfcMessageId = rfcMessageId

  // RFC 8058 one-click headers on every GTM send (section 8).
  const unsubscribeUrl = buildUnsubscribeUrl(enrollment.id, addressHash)
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
      { state: 'failed', failureReason: reason, failedAt: now() },
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
