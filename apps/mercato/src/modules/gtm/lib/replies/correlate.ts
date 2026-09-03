import crypto from 'crypto'
import type { GtmCtx } from '../campaign/build'
import type { Clock, ExecutionEm } from '../execute/schedule'
import { GtmExecutionError } from '../execute/schedule'
import { keywordClassifier, classifyReply, type ReplyClassifier } from './classify'
import { hashAddress } from '../campaign/exclusions'
import { refreshMailboxHealth } from '../reputation/mailbox-health'
import { UniqueConstraintViolationException } from '@mikro-orm/core'
import {
  GtmAuditEvent,
  GtmContactPoint,
  GtmEnrollment,
  GtmInboundEvent,
  GtmReply,
  GtmSendAttempt,
  GtmStep,
  GtmSuppression,
} from '../../data/entities'
import { EmailConnection, EmailMessage } from '../../../email/data/schema'

/*
 * Reply correlation + THE atomic stop (SPEC-066 sections 9, 3.3, Tranche 6).
 *
 * Provider ingestion persists fenced mailbox cursors separately; this
 * processor consumes durable inbound email rows, either the exact ids of one
 * ingested page (the normal path) or a bounded per-mailbox sweep (recovery).
 * Every provider event is first deduplicated in gtm_inbound_events before any
 * delivery, suppression, or stop side effect:
 *
 *   1. Header match: candidate Message-IDs parsed from
 *      metadata.headers['in-reply-to'] / ['references'] (when the ingest
 *      captured them) PLUS the row's thread_id (inbox-ingest stores the
 *      References-chain root there with angle brackets stripped, so a reply
 *      to a GTM send carries our rfc_message_id as its thread_id even though
 *      the raw headers are not persisted today). The candidates are matched
 *      against gtm_send_attempts.rfc_message_id by exact string lookup
 *      (bracketed + bare forms) - an indexed $in query, never a scan of the
 *      attempts table.
 *   2. Fallback match: same mailbox (email_messages.account_id equals the
 *      attempt's mailbox_connection_id) + counterparty from_address equal to
 *      a LIVE enrollment's verified contact address; the reply is linked to
 *      that enrollment's most recent provider-contacted attempt. When the
 *      address is live in MORE than one enrollment (duplicate_override
 *      campaigns) every candidate enrollment is stopped and the reply is
 *      attached to the most recent attempt, surfaced as unattributed
 *      (api-send-privacy M3): over-stopping is the safe direction.
 *
 * TRUST MODEL (review H1 / api-send-privacy M2, M4). Everything in an inbound
 * message is sender-controlled: From, In-Reply-To, Feedback-Type, subject.
 * Only the rfc_message_id reference is a secret the sender had to have
 * received from us, and only the provider's Authentication-Results header
 * says whether the From domain is genuine. So:
 *   - a human reply stops the enrollment (safe direction) whatever the
 *     evidence, but the suppression address is ALWAYS the enrollment's
 *     verified contact point, never the inbound From;
 *   - a COMPLAINT is honoured only when it references one of our
 *     rfc_message_ids AND the From domain passes DKIM/SPF/DMARC;
 *   - an explicit UNSUBSCRIBE event needs the authentication pass;
 *   - a BOUNCE needs a reference to our message and either a parsed DSN
 *     status or a failure subject from mailer-daemon/postmaster; a DSN
 *     status 4.x.x or a "(Delay)" notification is a SOFT bounce (H2);
 *   - subject-only heuristics (undeliverable, out of office, auto reply) are
 *     never applied to a message from the enrollment's own verified address:
 *     such a message is a human reply and surfaces in the inbox (M4);
 *   - anything destructive that fails those gates is recorded with
 *     correlation_confidence 'unauthenticated', still stops the enrollment,
 *     and surfaces in the inbox as an event row for a human to confirm; it
 *     never writes a suppression and never counts toward mailbox health.
 *
 * THE ATOMIC STOP (section 9), in ONE transaction: enrollment 'stopped'
 * (stop_reason 'email_reply' / 'social_reply'), every remaining pre-claim
 * attempt cancelled (approved/planned/rendered/reviewed -> 'failed' reason
 * 'stopped'), pending manual steps cancelled BY that same stop (manual
 * social steps have no rows of their own in this tranche - Tranche 7 tasks
 * key off enrollment.status, so status != 'active' IS the durable cancel
 * marker), THEN the GtmReply row is inserted in the same transaction. The
 * reply can never surface before the stop is durable. Rows already under
 * claim ARE cancelled (claim_token nulled), which is what actually closes the
 * race: the executor rechecks enrollment.status early but then does nine more
 * DB round trips before contacting the provider, so a reply correlating in
 * that window would otherwise still be mailed. Safe because send.ts writes
 * 'provider_started' BEFORE the transport, so a 'claimed' row has provably
 * not reached the provider; the executor's fenced write then matches 0 rows
 * and returns 'fenced'. 'provider_started' and later are left alone - the
 * message may already be out, and their own fenced writes settle it.
 *
 * Idempotent: a message that already has a GtmReply row is skipped;
 * re-recording a social reply for the same (enrollment, step) returns the
 * existing row.
 *
 * FAILURE ISOLATION (review H4): one message whose disposition throws marks
 * ITS inbound event 'failed' (re-claimable) and the loop continues; an event
 * that keeps failing is quarantined after MAX_EVENT_ATTEMPTS claims so it
 * can never poison a mailbox, an org, or a page forever.
 *
 * User-recorded social replies (recordSocialReply) take the IDENTICAL
 * transaction path - the non-negotiable that both reply kinds stop all
 * remaining mixed-channel steps atomically.
 */

const NON_TERMINAL_CANCELABLE = ['planned', 'rendered', 'reviewed', 'approved', 'claimed']
const PROVIDER_CONTACTED_STATES = [
  'provider_started',
  'accepted',
  'delivered',
  'bounced',
  'complained',
  'replied',
  'ambiguous',
]

// An inbound event whose disposition failed this many times is quarantined
// (left 'failed', never re-claimed by the sweep) instead of re-running on
// every page and every sweep forever.
export const MAX_EVENT_ATTEMPTS = 5

// Auto-responder deferrals per enrollment before the enrollment is stopped
// (workers L2): a permanent auto-responder must not keep an enrollment alive
// and re-allocating capacity indefinitely.
export const MAX_AUTOMATED_RESPONSE_DEFERRALS = 3

// Sweep bound when no exact message ids are given.
const DEFAULT_SWEEP_LIMIT = 500

// ExecutionEm declares find(entity, where) only; both MikroORM and the FakeEm
// take the standard options bag, which the sweep needs to stay bounded.
type BoundedFindEm = {
  find<T extends object>(
    entityClass: new () => T,
    where: Record<string, unknown>,
    options?: { orderBy?: Record<string, 'asc' | 'desc'>; limit?: number },
  ): Promise<T[]>
}

function normalizeMessageId(value: string): string {
  return value.replace(/[<>]/g, '').trim()
}

// Candidate Message-IDs a reply may reference: parsed In-Reply-To /
// References headers (metadata.headers, when present) plus thread_id.
export function parseReplyCandidateIds(message: EmailMessage): string[] {
  const out = new Set<string>()
  const metadata = (message.metadata ?? {}) as Record<string, unknown>
  const headers = (metadata.headers ?? {}) as Record<string, unknown>
  for (const key of ['in-reply-to', 'references']) {
    const raw = headers[key]
    if (typeof raw !== 'string' || !raw.trim()) continue
    for (const token of raw.split(/[\s,]+/)) {
      const normalized = normalizeMessageId(token)
      if (normalized) out.add(normalized)
    }
  }
  if (message.threadId) {
    const normalized = normalizeMessageId(message.threadId)
    if (normalized) out.add(normalized)
  }
  return [...out]
}

export type AtomicStopInput = {
  enrollment: GtmEnrollment
  stopReason: 'email_reply' | 'social_reply'
  channel: 'email' | 'linkedin' | 'x'
  sendAttemptId?: string | null
  stepId?: string | null
  emailMessageId?: string | null
  inboundEventId?: string | null
  eventKind?: string
  correlationConfidence?:
    | 'exact_header'
    | 'provider_message_id'
    | 'mailbox_counterparty'
    | 'user_recorded'
    | 'ambiguous'
    | 'unauthenticated'
  // Additional live enrollments for the same counterparty (ambiguous
  // fallback match): stopped in the SAME transaction, no reply row of their
  // own.
  alsoStop?: GtmEnrollment[]
  note?: string | null
  actorUserId?: string | null
  requestId?: string | null
  now: Date
}

async function cancelPendingAttempts(
  tem: ExecutionEm,
  enrollment: GtmEnrollment,
  now: Date,
  excludeAttemptId?: string | null,
): Promise<void> {
  await tem.nativeUpdate(
    GtmSendAttempt,
    {
      organizationId: enrollment.organizationId,
      tenantId: enrollment.tenantId,
      enrollmentId: enrollment.id,
      ...(excludeAttemptId ? { id: { $ne: excludeAttemptId } } : {}),
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
}

// ONE transaction: stop, cancel, then insert the reply (section 9).
export async function atomicStopWithReply(
  em: ExecutionEm,
  input: AtomicStopInput,
): Promise<GtmReply> {
  const { enrollment, now } = input
  return em.transactional(async (tem) => {
    if (enrollment.status === 'active') {
      enrollment.status = 'stopped'
      enrollment.stopReason = input.stopReason
      enrollment.stoppedAt = now
      tem.persist(enrollment)
    }
    // Cancel every attempt that has not yet contacted the provider, INCLUDING
    // 'claimed' (see the header note): nulling claim_token fences the in-flight
    // executor out. 'provider_started' and later settle through their own
    // fenced writes.
    await cancelPendingAttempts(tem, enrollment, now)
    for (const other of input.alsoStop ?? []) {
      if (other.id === enrollment.id) continue
      if (other.status === 'active') {
        other.status = 'stopped'
        other.stopReason = input.stopReason
        other.stoppedAt = now
        tem.persist(other)
      }
      await cancelPendingAttempts(tem, other, now)
    }
    const reply = tem.create(GtmReply, {
      organizationId: enrollment.organizationId,
      tenantId: enrollment.tenantId,
      enrollmentId: enrollment.id,
      sendAttemptId: input.sendAttemptId ?? null,
      stepId: input.stepId ?? null,
      channel: input.channel,
      direction: 'inbound',
      emailMessageId: input.emailMessageId ?? null,
      inboundEventId: input.inboundEventId ?? null,
      eventKind: input.eventKind ?? (input.stopReason === 'social_reply' ? 'social_reply' : 'human_reply'),
      correlationConfidence:
        input.correlationConfidence ??
        (input.stopReason === 'social_reply' ? 'user_recorded' : null),
      classification: null,
      classificationSource: null,
      draftResponse: input.note ? { note: input.note } : null,
      draftStatus: 'none',
    })
    tem.persist(reply)
    tem.persist(
      tem.create(GtmAuditEvent, {
        organizationId: enrollment.organizationId,
        tenantId: enrollment.tenantId,
        actor: input.actorUserId ? 'user_id' : 'system',
        actorUserId: input.actorUserId ?? null,
        action: 'gtm.reply.recorded',
        objectType: 'gtm_reply',
        objectId: reply.id,
        requestId: input.requestId ?? null,
        metadata: {
          enrollment_id: enrollment.id,
          stop_reason: input.stopReason,
          channel: input.channel,
          email_message_id: input.emailMessageId ?? null,
          inbound_event_id: input.inboundEventId ?? null,
          event_kind: input.eventKind ?? null,
          correlation_confidence: input.correlationConfidence ?? null,
          also_stopped_enrollment_ids: (input.alsoStop ?? [])
            .filter((row) => row.id !== enrollment.id)
            .map((row) => row.id),
          step_id: input.stepId ?? null,
        },
      }),
    )
    await tem.flush()
    return reply
  })
}

export type CorrelatedReply = {
  reply: GtmReply
  matchedBy: 'header' | 'fallback'
  attemptId: string
  enrollmentId: string
  emailMessageId: string
  inboundEventId: string
  eventKind: InboundEventKind
}

export type CorrelateResult = {
  scanned: number
  matched: CorrelatedReply[]
  systemEvents: number
  unmatched: number
  failed: number
  // Events left 'failed' after MAX_EVENT_ATTEMPTS; never retried automatically.
  quarantined: number
}

export type InboundEventKind =
  | 'human_reply'
  | 'delivered'
  | 'soft_bounce'
  | 'hard_bounce'
  | 'complaint'
  | 'out_of_office'
  | 'auto_reply'
  | 'unsubscribe'
  | 'unknown'

const EVENT_KINDS = new Set<InboundEventKind>([
  'human_reply',
  'delivered',
  'soft_bounce',
  'hard_bounce',
  'complaint',
  'out_of_office',
  'auto_reply',
  'unsubscribe',
  'unknown',
])

const DESTRUCTIVE_KINDS = new Set<InboundEventKind>(['hard_bounce', 'complaint', 'unsubscribe'])

function messageMetadata(message: EmailMessage): Record<string, unknown> {
  return (message.metadata ?? {}) as Record<string, unknown>
}

/**
 * Personal-mailbox syncs can surface a sent message again when the recipient
 * is an alias of the connected mailbox (for example, a Gmail plus-address).
 * It is not an inbound prospect reply and must never stop an enrollment or be
 * classified from the message's own unsubscribe footer.
 */
async function isMailboxOriginatedMessage(
  em: ExecutionEm,
  ctx: GtmCtx,
  message: EmailMessage,
): Promise<boolean> {
  if (!message.accountId || !message.fromAddress?.trim()) return false
  const connection = await em.findOne(EmailConnection, {
    id: message.accountId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    isActive: true,
    deletedAt: null,
  })
  if (!connection?.emailAddress?.trim()) return false
  return connection.emailAddress.trim().toLowerCase() === message.fromAddress.trim().toLowerCase()
}

function messageHeaders(message: EmailMessage): Record<string, string> {
  const headers = messageMetadata(message).headers
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return {}
  return Object.fromEntries(
    Object.entries(headers as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([key, value]) => [key.toLowerCase(), value]),
  )
}

function fromDomain(address: string): string {
  const at = address.lastIndexOf('@')
  return at >= 0 ? address.slice(at + 1).trim().toLowerCase() : ''
}

// Relaxed alignment (DMARC style): equal, or one is a subdomain of the other.
function domainsAligned(a: string, b: string): boolean {
  if (!a || !b) return false
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)
}

export type AuthenticationVerdict = 'pass' | 'fail' | 'none'

/**
 * Did the receiving provider verify the From domain? Parsed from the
 * Authentication-Results / ARC-Authentication-Results headers Gmail, Graph
 * and most IMAP hosts stamp on delivery (RFC 8601). 'pass' needs dmarc=pass,
 * or dkim=pass with header.d/header.i aligned to the From domain, or
 * spf=pass with smtp.mailfrom aligned. 'none' means no such header was
 * stored, which is treated exactly like 'fail' for destructive dispositions.
 */
export function authenticationVerdict(message: EmailMessage): AuthenticationVerdict {
  const headers = messageHeaders(message)
  const values = [headers['authentication-results'], headers['arc-authentication-results']]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  if (values.length === 0) return 'none'
  const domain = fromDomain((message.fromAddress ?? '').toLowerCase())
  if (!domain) return 'fail'
  for (const value of values) {
    for (const clause of value.toLowerCase().split(';')) {
      if (/\bdmarc=pass\b/.test(clause)) return 'pass'
      if (/\bdkim=pass\b/.test(clause)) {
        const signer = clause.match(/header\.(?:d|i)=@?([a-z0-9.-]+)/)?.[1]
        if (signer && domainsAligned(signer, domain)) return 'pass'
      }
      if (/\bspf=pass\b/.test(clause)) {
        const envelope = clause.match(/smtp\.mailfrom=(?:[^\s;@]+@)?([a-z0-9.-]+)/)?.[1]
        if (envelope && domainsAligned(envelope, domain)) return 'pass'
      }
    }
  }
  return 'fail'
}

const DAEMON_FROM = /(^|[<@])(mailer-daemon|postmaster|mail-daemon|noreply\+bounces?)[@>.]/
const FAILURE_SUBJECT =
  /\b(undeliverable|undelivered|delivery (status notification|failure|has failed)|mail delivery failed|returned mail|failure notice|could not be delivered)\b/
const DELAY_SUBJECT = /\b(delay|delayed|deferred|temporar(y|ily)|not yet been delivered|could not be delivered yet)\b/

type DsnInfo = { action: string | null; status: string | null }

function dsnInfo(message: EmailMessage): DsnInfo | null {
  const raw = messageMetadata(message).dsn
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const action = typeof record.action === 'string' ? record.action.trim().toLowerCase() : null
  const status = typeof record.status === 'string' ? record.status.trim() : null
  if (!action && !status) return null
  return { action, status }
}

export type DetectOptions = {
  // The enrollment's verified contact address when the message has been
  // correlated to one (lowercased). Subject-only heuristics are skipped for
  // a message from that address (M4).
  counterpartyAddress?: string | null
  // Whether the message references one of our rfc_message_ids. Sender-set
  // complaint headers only count when it does (H1c).
  referencesOurMessage?: boolean
}

/** Classify delivery-system dispositions before any stop side effect. */
export function detectInboundEventKind(
  message: EmailMessage,
  options: DetectOptions = {},
): InboundEventKind {
  const metadata = messageMetadata(message)
  const explicit = metadata.event_kind
  if (typeof explicit === 'string' && EVENT_KINDS.has(explicit as InboundEventKind)) {
    return explicit as InboundEventKind
  }
  const headers = messageHeaders(message)
  const from = (message.fromAddress ?? '').trim().toLowerCase()
  const subject = (message.subject ?? '').toLowerCase()
  const autoSubmitted = (headers['auto-submitted'] ?? '').toLowerCase()
  const fromDaemon = DAEMON_FROM.test(from)
  const counterparty = options.counterpartyAddress?.trim().toLowerCase() ?? null
  const fromCounterparty = Boolean(counterparty) && from === counterparty
  const dsn = dsnInfo(message)

  // Complaint (ARF) headers are sender-controlled: only a report that
  // references one of our messages and does not come from the prospect's
  // own address is a complaint; anything else is a human's mail.
  if (
    (headers['feedback-type'] || headers['x-complaint-type'] || metadata.complaint === true)
    && options.referencesOurMessage !== false
    && !fromCounterparty
  ) {
    return 'complaint'
  }
  if (metadata.soft_bounce === true || metadata.bounce_type === 'soft') {
    return 'soft_bounce'
  }
  // A parsed delivery-status report is the authoritative bounce evidence:
  // 4.x.x / delayed is transient, 5.x.x / failed is permanent (H2).
  if (dsn) {
    if (dsn.action === 'delayed' || dsn.action === 'relayed' || dsn.status?.startsWith('4')) {
      return 'soft_bounce'
    }
    if (dsn.action === 'failed' || dsn.status?.startsWith('5')) return 'hard_bounce'
    if (dsn.action === 'delivered' || dsn.status?.startsWith('2')) return 'delivered'
  }
  if (metadata.bounce === true) return 'hard_bounce'
  // Subject heuristics for bounces apply only to the delivery system itself.
  if (fromDaemon) {
    if (DELAY_SUBJECT.test(subject)) return 'soft_bounce'
    if (FAILURE_SUBJECT.test(subject)) return 'hard_bounce'
    return 'unknown'
  }
  // Auto-responder header signals are honoured from any sender; the subject
  // regexes only when the mail did not come from the verified prospect
  // address (a human writing "On leave, call next week" is a reply).
  if (headers['x-autoreply'] || headers['x-autorespond']) return 'out_of_office'
  if (autoSubmitted && autoSubmitted !== 'no') {
    return /\b(out of (the )?office|away from (the )?office|on (annual )?leave|vacation)\b/.test(subject)
      ? 'out_of_office'
      : 'auto_reply'
  }
  if (!fromCounterparty) {
    if (/\b(out of (the )?office|away from (the )?office|on (annual )?leave|vacation reply)\b/.test(subject)) {
      return 'out_of_office'
    }
    if (/\b(auto(matic)? reply|auto.?response)\b/.test(subject)) return 'auto_reply'
  }
  return 'human_reply'
}

function providerEventId(message: EmailMessage): { provider: string; id: string } {
  const metadata = messageMetadata(message)
  const provider =
    typeof metadata.provider === 'string' && metadata.provider.trim()
      ? metadata.provider.trim().toLowerCase()
      : 'email_message'
  const candidate = metadata.event_id ?? metadata.provider_event_id ?? metadata.provider_message_id
  return {
    provider,
    id: typeof candidate === 'string' && candidate.trim() ? candidate.trim() : `email:${message.id}`,
  }
}

function inboundDedupeKey(
  message: EmailMessage,
  identity: { provider: string; id: string },
): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        provider: identity.provider,
        mailbox: message.accountId ?? 'unknown',
        event: identity.id,
      }),
      'utf8',
    )
    .digest('hex')
}

function referencedProviderMessageId(message: EmailMessage): string | null {
  const metadata = messageMetadata(message)
  for (const key of [
    'original_provider_message_id',
    'in_reply_to_provider_message_id',
    'sent_provider_message_id',
  ]) {
    const value = metadata[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

async function persistInboundEvent(
  em: ExecutionEm,
  ctx: GtmCtx,
  message: EmailMessage,
  kind: InboundEventKind,
  authentication: AuthenticationVerdict,
  now: Date,
): Promise<GtmInboundEvent> {
  const identity = providerEventId(message)
  const dedupeKey = inboundDedupeKey(message, identity)
  const existing = await em.findOne(GtmInboundEvent, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    dedupeKey,
    deletedAt: null,
  })
  if (existing) return existing
  const event = em.create(GtmInboundEvent, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    mailboxConnectionId: message.accountId ?? null,
    provider: identity.provider,
    providerEventId: identity.id,
    dedupeKey,
    eventKind: kind,
    providerMessageId: referencedProviderMessageId(message),
    rfcMessageId: parseReplyCandidateIds(message)[0] ?? null,
    emailMessageId: message.id,
    evidenceRedacted: {
      source: 'email_message',
      has_reply_reference: parseReplyCandidateIds(message).length > 0,
      header_names: Object.keys(messageHeaders(message)).sort().slice(0, 64),
      authentication,
      dsn: dsnInfo(message),
    },
    occurredAt: message.createdAt ?? now,
    processingState: 'pending',
  })
  em.persist(event)
  try {
    await em.flush()
    return event
  } catch (error) {
    if (!(error instanceof UniqueConstraintViolationException)) throw error
    const winner = await em.findOne(GtmInboundEvent, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      dedupeKey,
      deletedAt: null,
    })
    if (!winner) throw error
    return winner
  }
}

async function claimInboundEvent(
  em: ExecutionEm,
  event: GtmInboundEvent,
  now: Date,
): Promise<{ token: string; fence: number } | null> {
  if (event.processingState === 'processed' || event.processingState === 'unmatched') return null
  const token = crypto.randomUUID()
  const nextFence = event.processingFence + 1
  const claimed = await em.nativeUpdate(
    GtmInboundEvent,
    {
      id: event.id,
      organizationId: event.organizationId,
      tenantId: event.tenantId,
      processingState: { $in: ['pending', 'failed', 'processing'] },
      processingFence: event.processingFence,
      $or: [
        { processingClaimToken: null },
        { processingClaimExpiresAt: null },
        { processingClaimExpiresAt: { $lte: now } },
      ],
    },
    {
      processingState: 'processing',
      processingClaimToken: token,
      processingClaimExpiresAt: new Date(now.getTime() + 5 * 60 * 1000),
      processingFence: nextFence,
      lastError: null,
      updatedAt: now,
    },
  )
  if (claimed !== 1) return null
  // Mirror the CAS on the managed entity so the finishing write below sees
  // the fence it must present (nativeUpdate never touches the identity map).
  event.processingState = 'processing'
  event.processingClaimToken = token
  event.processingFence = nextFence
  return { token, fence: nextFence }
}

async function finishInboundEvent(
  em: ExecutionEm,
  event: GtmInboundEvent,
  claim: { token: string; fence: number },
  input: { state: 'processed' | 'unmatched' | 'failed'; now: Date; error?: string | null },
): Promise<void> {
  await em.nativeUpdate(
    GtmInboundEvent,
    {
      id: event.id,
      organizationId: event.organizationId,
      tenantId: event.tenantId,
      processingState: 'processing',
      processingClaimToken: claim.token,
      processingFence: claim.fence,
    },
    {
      processingState: input.state,
      processingClaimToken: null,
      processingClaimExpiresAt: null,
      processedAt: input.state === 'failed' ? null : input.now,
      lastError: input.error?.slice(0, 500) ?? null,
      updatedAt: input.now,
    },
  )
  event.processingState = input.state
  event.processingClaimToken = null
  event.processingClaimExpiresAt = null
}

type AttemptCorrelation = {
  attempt: GtmSendAttempt | null
  method: 'header' | 'provider_message_id' | 'fallback' | null
  confidence: 'exact_header' | 'provider_message_id' | 'mailbox_counterparty' | 'ambiguous' | 'none'
  // Ambiguous fallback only: every live enrollment the counterparty address
  // belongs to (the attempt above belongs to the first of them).
  alternates: GtmEnrollment[]
}

async function correlateAttempt(
  em: ExecutionEm,
  ctx: GtmCtx,
  message: EmailMessage,
): Promise<AttemptCorrelation> {
  if (!message.accountId) {
    return { attempt: null, method: null, confidence: 'none', alternates: [] }
  }
  const mailboxMatches = (attempt: GtmSendAttempt) =>
    attempt.mailboxConnectionId === message.accountId

  const candidateIds = parseReplyCandidateIds(message)
  if (candidateIds.length > 0) {
    const forms = candidateIds.flatMap((id) => [id, `<${id}>`])
    const matches = (
      await em.find(GtmSendAttempt, {
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        rfcMessageId: { $in: forms },
        deletedAt: null,
      })
    ).filter(mailboxMatches)
    if (matches.length === 1) {
      return { attempt: matches[0], method: 'header', confidence: 'exact_header', alternates: [] }
    }
    if (matches.length > 1) {
      return { attempt: null, method: 'header', confidence: 'ambiguous', alternates: [] }
    }
  }

  const providerReference = referencedProviderMessageId(message)
  if (providerReference) {
    const matches = (
      await em.find(GtmSendAttempt, {
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        providerMessageId: providerReference,
        deletedAt: null,
      })
    ).filter(mailboxMatches)
    if (matches.length === 1) {
      return {
        attempt: matches[0],
        method: 'provider_message_id',
        confidence: 'provider_message_id',
        alternates: [],
      }
    }
    if (matches.length > 1) {
      return { attempt: null, method: 'provider_message_id', confidence: 'ambiguous', alternates: [] }
    }
  }

  if (message.accountId && message.fromAddress) {
    const fallback = await fallbackMatch(em, ctx, message)
    if (fallback.attempt) {
      return {
        attempt: fallback.attempt,
        method: 'fallback',
        confidence: fallback.ambiguous ? 'ambiguous' : 'mailbox_counterparty',
        alternates: fallback.ambiguous ? fallback.enrollments : [],
      }
    }
  }
  return { attempt: null, method: null, confidence: 'none', alternates: [] }
}

async function resolveAttemptAddress(
  em: ExecutionEm,
  attempt: GtmSendAttempt,
): Promise<string | null> {
  const enrollment = await em.findOne(GtmEnrollment, {
    id: attempt.enrollmentId,
    organizationId: attempt.organizationId,
    tenantId: attempt.tenantId,
    deletedAt: null,
  })
  if (!enrollment) return null
  const points = await em.find(GtmContactPoint, {
    organizationId: attempt.organizationId,
    tenantId: attempt.tenantId,
    candidateId: enrollment.candidateId,
    channel: 'email',
    verificationState: 'verified',
    deletedAt: null,
  })
  return points[0]?.value?.trim().toLowerCase() ?? null
}

async function countAutomatedDeferrals(
  em: ExecutionEm,
  enrollment: GtmEnrollment,
  excludeEventId: string,
): Promise<number> {
  const events = await em.find(GtmInboundEvent, {
    organizationId: enrollment.organizationId,
    tenantId: enrollment.tenantId,
    enrollmentId: enrollment.id,
    eventKind: { $in: ['out_of_office', 'auto_reply'] },
    processingState: 'processed',
    deletedAt: null,
  })
  return events.filter((event) => event.id !== excludeEventId).length
}

async function deferAutomatedResponse(
  em: ExecutionEm,
  enrollment: GtmEnrollment,
  now: Date,
  days: number,
): Promise<void> {
  const notBefore = new Date(now.getTime() + days * 24 * 60 * 60 * 1000)
  const attempts = await em.find(GtmSendAttempt, {
    organizationId: enrollment.organizationId,
    tenantId: enrollment.tenantId,
    enrollmentId: enrollment.id,
    state: { $in: ['planned', 'rendered', 'reviewed', 'approved', 'claimed'] },
    deletedAt: null,
  })
  for (const attempt of attempts) {
    if (!attempt.scheduledFor || attempt.scheduledFor < notBefore) attempt.scheduledFor = notBefore
    if (attempt.state === 'claimed') {
      attempt.state = 'approved'
      attempt.claimToken = null
      attempt.claimExpiresAt = null
    }
    attempt.capacitySlotKey = null
    attempt.updatedAt = now
    em.persist(attempt)
  }
  await em.flush()
}

// Stop an enrollment for a non-reply reason with no suppression and no
// reply row (auto-responder cap).
async function stopEnrollmentQuietly(
  em: ExecutionEm,
  enrollment: GtmEnrollment,
  reason: string,
  event: GtmInboundEvent,
  now: Date,
): Promise<void> {
  await em.transactional(async (tem) => {
    if (enrollment.status === 'active') {
      enrollment.status = 'stopped'
      enrollment.stopReason = reason
      enrollment.stoppedAt = now
      tem.persist(enrollment)
    }
    await cancelPendingAttempts(tem, enrollment, now)
    tem.persist(
      tem.create(GtmAuditEvent, {
        organizationId: enrollment.organizationId,
        tenantId: enrollment.tenantId,
        actor: 'system',
        actorUserId: null,
        action: `gtm.enrollment.${reason}`,
        objectType: 'gtm_inbound_event',
        objectId: event.id,
        requestId: null,
        metadata: { enrollment_id: enrollment.id },
      }),
    )
    await tem.flush()
  })
}

async function stopForSystemEvent(
  em: ExecutionEm,
  enrollment: GtmEnrollment,
  attempt: GtmSendAttempt,
  event: GtmInboundEvent,
  kind: 'hard_bounce' | 'complaint' | 'unsubscribe',
  now: Date,
): Promise<void> {
  // The suppression address is the enrollment's verified contact point,
  // never the inbound From header (H1b).
  const address = await resolveAttemptAddress(em, attempt)
  await em.transactional(async (tem) => {
    if (enrollment.status === 'active') {
      enrollment.status = 'stopped'
      enrollment.stopReason = kind
      enrollment.stoppedAt = now
      tem.persist(enrollment)
    }
    await cancelPendingAttempts(tem, enrollment, now, attempt.id)
    const targetState = kind === 'complaint' ? 'complained' : kind === 'hard_bounce' ? 'bounced' : 'replied'
    await tem.nativeUpdate(
      GtmSendAttempt,
      {
        id: attempt.id,
        organizationId: enrollment.organizationId,
        tenantId: enrollment.tenantId,
        state: { $in: PROVIDER_CONTACTED_STATES },
      },
      {
        state: targetState,
        ...(kind === 'complaint'
          ? { complainedAt: now }
          : kind === 'hard_bounce'
            ? { bouncedAt: now }
            : { repliedAt: now }),
        updatedAt: now,
      },
    )
    if (address) {
      const addressHash = hashAddress(address)
      const existing = await tem.findOne(GtmSuppression, {
        organizationId: enrollment.organizationId,
        channel: 'email',
        addressHash,
        deletedAt: null,
      })
      if (!existing) {
        tem.persist(
          tem.create(GtmSuppression, {
            organizationId: enrollment.organizationId,
            tenantId: enrollment.tenantId,
            scope: 'org',
            channel: 'email',
            addressHash,
            addressDisplay: null,
            reason: kind,
            source: { via: 'inbound_event', inbound_event_id: event.id },
            expiresAt: null,
          }),
        )
      }
      event.addressHash = addressHash
      tem.persist(event)
    }
    tem.persist(
      tem.create(GtmAuditEvent, {
        organizationId: enrollment.organizationId,
        tenantId: enrollment.tenantId,
        actor: 'system',
        actorUserId: null,
        action: `gtm.delivery.${kind}`,
        objectType: 'gtm_inbound_event',
        objectId: event.id,
        requestId: null,
        metadata: { enrollment_id: enrollment.id, send_attempt_id: attempt.id },
      }),
    )
    await tem.flush()
  })
}

// Surface a correlated delivery-system event in the inbox WITHOUT the atomic
// stop semantics (the stop, when warranted, already happened). One row per
// inbound message; idempotent on the unique (org, tenant, email_message_id).
async function surfaceSystemEvent(
  em: ExecutionEm,
  ctx: GtmCtx,
  input: {
    enrollment: GtmEnrollment
    attempt: GtmSendAttempt
    message: EmailMessage
    event: GtmInboundEvent
    eventKind: string
    correlationConfidence: string
  },
): Promise<GtmReply> {
  const existing = await em.findOne(GtmReply, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    emailMessageId: input.message.id,
  })
  if (existing) return existing
  return em.transactional(async (tem) => {
    const reply = tem.create(GtmReply, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      enrollmentId: input.enrollment.id,
      sendAttemptId: input.attempt.id,
      stepId: null,
      channel: 'email',
      direction: 'inbound',
      emailMessageId: input.message.id,
      inboundEventId: input.event.id,
      eventKind: input.eventKind,
      correlationConfidence: input.correlationConfidence,
      classification: null,
      classificationSource: null,
      draftResponse: null,
      draftStatus: 'none',
    })
    tem.persist(reply)
    await tem.flush()
    return reply
  })
}

/*
 * Destructive dispositions need evidence the sender could not forge:
 *   complaint    -> references our rfc_message_id AND authenticated From
 *   unsubscribe  -> authenticated From (explicit provider/list event)
 *   hard_bounce  -> references our message (header or provider id); the
 *                   From is the delivery system, so DKIM is not required
 */
function destructiveAllowed(
  kind: InboundEventKind,
  correlation: AttemptCorrelation,
  authentication: AuthenticationVerdict,
): boolean {
  if (kind === 'complaint') return correlation.method === 'header' && authentication === 'pass'
  if (kind === 'unsubscribe') return authentication === 'pass'
  if (kind === 'hard_bounce') {
    return correlation.method === 'header' || correlation.method === 'provider_message_id'
  }
  return true
}

export type CorrelateInput = {
  sinceMinutes?: number
  clock?: Clock
  classifier?: ReplyClassifier
  // Exact inbound rows to process (one ingested page). When given, no time
  // window scan happens at all.
  messageIds?: string[]
  // Bound a window scan to one mailbox (the ingesting one).
  mailboxConnectionId?: string | null
  limit?: number
}

async function loadMessages(
  em: ExecutionEm,
  ctx: GtmCtx,
  input: CorrelateInput,
  now: Date,
): Promise<EmailMessage[]> {
  if (input.messageIds) {
    if (input.messageIds.length === 0) return []
    return em.find(EmailMessage, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      id: { $in: input.messageIds },
      direction: 'inbound',
      deletedAt: null,
    })
  }
  const sinceMinutes = input.sinceMinutes && input.sinceMinutes > 0 ? input.sinceMinutes : 24 * 60
  const since = new Date(now.getTime() - sinceMinutes * 60 * 1000)
  const limit = input.limit && input.limit > 0 ? Math.min(input.limit, 2000) : DEFAULT_SWEEP_LIMIT
  const rows = await (em as unknown as BoundedFindEm).find(EmailMessage, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    direction: 'inbound',
    deletedAt: null,
    createdAt: { $gte: since },
    ...(input.mailboxConnectionId ? { accountId: input.mailboxConnectionId } : {}),
  }, { orderBy: { createdAt: 'desc' }, limit })
  // Process oldest first so a thread's events land in order.
  return [...rows].sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0))
}

export async function correlateReplies(
  em: ExecutionEm,
  ctx: GtmCtx,
  input: CorrelateInput = {},
): Promise<CorrelateResult> {
  const now = input.clock?.now() ?? new Date()
  const messages = await loadMessages(em, ctx, input, now)

  const matched: CorrelatedReply[] = []
  let systemEvents = 0
  let unmatched = 0
  let failed = 0
  let quarantined = 0
  for (const message of messages) {
    if (await isMailboxOriginatedMessage(em, ctx, message)) {
      continue
    }
    // Correlate first: the disposition depends on WHO the message is from
    // relative to the enrollment and on whether it references our message.
    let correlation: AttemptCorrelation
    let enrollment: GtmEnrollment | null = null
    let counterpartyAddress: string | null = null
    try {
      correlation = await correlateAttempt(em, ctx, message)
      if (correlation.attempt) {
        enrollment = await em.findOne(GtmEnrollment, {
          id: correlation.attempt.enrollmentId,
          organizationId: ctx.organizationId,
          tenantId: ctx.tenantId,
          deletedAt: null,
        })
        counterpartyAddress = enrollment ? await resolveAttemptAddress(em, correlation.attempt) : null
      }
    } catch (error) {
      // Correlation reads only; a failure here is recorded on the event once
      // it exists below, so fall through with no match.
      correlation = { attempt: null, method: null, confidence: 'none', alternates: [] }
      void error
    }
    const authentication = authenticationVerdict(message)
    const kind = detectInboundEventKind(message, {
      counterpartyAddress,
      referencesOurMessage: correlation.method === 'header',
    })
    const event = await persistInboundEvent(em, ctx, message, kind, authentication, now)
    if (event.processingState === 'failed' && event.processingFence >= MAX_EVENT_ATTEMPTS) {
      quarantined += 1
      continue
    }
    const claim = await claimInboundEvent(em, event, now)
    if (!claim) continue
    try {
      event.correlationMethod = correlation.method
      event.correlationConfidence = correlation.confidence
      if (!correlation.attempt || !enrollment) {
        em.persist(event)
        await em.flush()
        await finishInboundEvent(em, event, claim, { state: 'unmatched', now })
        unmatched += 1
        continue
      }
      const attempt = correlation.attempt
      event.sendAttemptId = attempt.id
      event.enrollmentId = enrollment.id
      event.addressHash = counterpartyAddress ? hashAddress(counterpartyAddress) : null
      const allowed = !DESTRUCTIVE_KINDS.has(kind) || destructiveAllowed(kind, correlation, authentication)
      if (!allowed) event.correlationConfidence = 'unauthenticated'
      em.persist(event)
      await em.flush()

      const replyConfidence: NonNullable<AtomicStopInput['correlationConfidence']> =
        !allowed
          ? 'unauthenticated'
          : correlation.confidence === 'ambiguous'
            ? 'ambiguous'
            : correlation.confidence === 'none'
              ? 'mailbox_counterparty'
              : correlation.confidence
      let healthRefresh = false

      if (kind === 'delivered') {
        await em.nativeUpdate(
          GtmSendAttempt,
          {
            id: attempt.id,
            organizationId: ctx.organizationId,
            tenantId: ctx.tenantId,
            state: 'accepted',
          },
          { state: 'delivered', deliveredAt: now, updatedAt: now },
        )
        systemEvents += 1
        healthRefresh = true
      } else if (kind === 'hard_bounce' || kind === 'complaint' || kind === 'unsubscribe') {
        if (allowed) {
          await stopForSystemEvent(em, enrollment, attempt, event, kind, now)
          await surfaceSystemEvent(em, ctx, {
            enrollment,
            attempt,
            message,
            event,
            eventKind: kind,
            correlationConfidence: replyConfidence,
          })
          healthRefresh = true
        } else {
          // Unverifiable destructive claim: stop the enrollment (safe
          // direction), surface for a human, write NO suppression, count
          // NOTHING toward mailbox health.
          const existing = await em.findOne(GtmReply, {
            organizationId: ctx.organizationId,
            tenantId: ctx.tenantId,
            emailMessageId: message.id,
          })
          if (!existing) {
            await atomicStopWithReply(em, {
              enrollment,
              stopReason: 'email_reply',
              channel: 'email',
              sendAttemptId: attempt.id,
              emailMessageId: message.id,
              inboundEventId: event.id,
              eventKind: `unauthenticated_${kind}`,
              correlationConfidence: 'unauthenticated',
              alsoStop: correlation.alternates,
              requestId: ctx.requestId ?? null,
              now,
            })
          }
        }
        systemEvents += 1
      } else if (kind === 'out_of_office' || kind === 'auto_reply') {
        const priorDeferrals = await countAutomatedDeferrals(em, enrollment, event.id)
        if (priorDeferrals >= MAX_AUTOMATED_RESPONSE_DEFERRALS) {
          await stopEnrollmentQuietly(em, enrollment, 'auto_responder', event, now)
        } else {
          await deferAutomatedResponse(em, enrollment, now, 7)
        }
        systemEvents += 1
      } else if (kind === 'soft_bounce') {
        // One transient failure does not permanently suppress; apply a
        // bounded one-day deferral, surface it, and retain the event for
        // the threshold policy.
        await deferAutomatedResponse(em, enrollment, now, 1)
        await surfaceSystemEvent(em, ctx, {
          enrollment,
          attempt,
          message,
          event,
          eventKind: 'soft_bounce',
          correlationConfidence: replyConfidence,
        })
        systemEvents += 1
        healthRefresh = true
      } else if (kind === 'unknown') {
        await finishInboundEvent(em, event, claim, { state: 'unmatched', now })
        unmatched += 1
        continue
      } else {
        let reply = await em.findOne(GtmReply, {
          organizationId: ctx.organizationId,
          tenantId: ctx.tenantId,
          inboundEventId: event.id,
        })
        if (!reply) {
          reply = await atomicStopWithReply(em, {
            enrollment,
            stopReason: 'email_reply',
            channel: 'email',
            sendAttemptId: attempt.id,
            emailMessageId: message.id,
            inboundEventId: event.id,
            eventKind: 'human_reply',
            correlationConfidence: replyConfidence,
            alsoStop: correlation.alternates,
            requestId: ctx.requestId ?? null,
            now,
          })
          await em.nativeUpdate(
            GtmSendAttempt,
            {
              id: attempt.id,
              organizationId: ctx.organizationId,
              tenantId: ctx.tenantId,
              state: { $in: ['accepted', 'delivered'] },
            },
            { state: 'replied', repliedAt: now, updatedAt: now },
          )
          await classifyReply(
            em,
            ctx,
            { replyId: reply.id },
            { classifier: input.classifier ?? keywordClassifier, clock: input.clock },
          )
        }
        matched.push({
          reply,
          matchedBy: correlation.method === 'fallback' ? 'fallback' : 'header',
          attemptId: attempt.id,
          enrollmentId: enrollment.id,
          emailMessageId: message.id,
          inboundEventId: event.id,
          eventKind: kind,
        })
      }
      // Mark processed BEFORE the health refresh so the refresh (which only
      // counts processed, attempt-linked events) sees this one.
      await finishInboundEvent(em, event, claim, { state: 'processed', now })
      if (healthRefresh && message.accountId) {
        await refreshMailboxHealth(em, ctx, message.accountId, { clock: input.clock })
      }
    } catch (error) {
      failed += 1
      await finishInboundEvent(em, event, claim, {
        state: 'failed',
        now,
        error: error instanceof Error ? error.message : 'inbound_event_failed',
      })
    }
  }

  return { scanned: messages.length, matched, systemEvents, unmatched, failed, quarantined }
}

async function fallbackMatch(
  em: ExecutionEm,
  ctx: GtmCtx,
  message: EmailMessage,
): Promise<{ attempt: GtmSendAttempt | null; ambiguous: boolean; enrollments: GtmEnrollment[] }> {
  const address = message.fromAddress.trim().toLowerCase()
  if (!address) return { attempt: null, ambiguous: false, enrollments: [] }
  const points = (
    await em.find(GtmContactPoint, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      channel: 'email',
      verificationState: 'verified',
      deletedAt: null,
    })
  ).filter((point) => point.value.trim().toLowerCase() === address)
  if (points.length === 0) return { attempt: null, ambiguous: false, enrollments: [] }
  const candidateIds = [...new Set(points.map((point) => point.candidateId))]
  const enrollments = (
    await em.find(GtmEnrollment, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      candidateId: { $in: candidateIds },
      deletedAt: null,
    })
  ).filter((row) => row.status === 'active')
  if (enrollments.length === 0) return { attempt: null, ambiguous: false, enrollments: [] }
  const enrollmentIds = enrollments.map((row) => row.id)
  const attempts = (
    await em.find(GtmSendAttempt, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      enrollmentId: { $in: enrollmentIds },
      state: { $in: PROVIDER_CONTACTED_STATES },
      deletedAt: null,
    })
  ).filter((row) => row.mailboxConnectionId === message.accountId)
  if (attempts.length === 0) return { attempt: null, ambiguous: false, enrollments: [] }
  attempts.sort(
    (a, b) =>
      (b.sentAt?.getTime() ?? b.updatedAt?.getTime() ?? 0) -
      (a.sentAt?.getTime() ?? a.updatedAt?.getTime() ?? 0),
  )
  const contacted = new Set(attempts.map((row) => row.enrollmentId))
  const liveContacted = enrollments.filter((row) => contacted.has(row.id))
  return {
    attempt: attempts[0],
    ambiguous: liveContacted.length > 1,
    enrollments: liveContacted,
  }
}

// -----------------------------------------------------------------------
// User-recorded social replies (section 9: identical transaction path)
// -----------------------------------------------------------------------

export type RecordSocialReplyResult = {
  reply: GtmReply
  alreadyRecorded: boolean
}

export async function recordSocialReply(
  em: ExecutionEm,
  ctx: GtmCtx,
  input: { enrollmentId: string; stepId: string; note?: string | null },
  deps: { clock?: Clock } = {},
): Promise<RecordSocialReplyResult> {
  const now = deps.clock?.now() ?? new Date()
  const enrollment = await em.findOne(GtmEnrollment, {
    id: input.enrollmentId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  if (!enrollment) throw new GtmExecutionError('enrollment_not_found', 'Enrollment not found')
  const step = await em.findOne(GtmStep, {
    id: input.stepId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  if (!step) throw new GtmExecutionError('step_not_found', 'Step not found')
  if (step.mode !== 'manual_social') {
    throw new GtmExecutionError(
      'invalid_state',
      'Social replies can only be recorded on manual social steps',
    )
  }

  // Idempotent per (enrollment, step).
  const existing = await em.findOne(GtmReply, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    enrollmentId: enrollment.id,
    stepId: step.id,
  })
  if (existing) return { reply: existing, alreadyRecorded: true }

  const reply = await atomicStopWithReply(em, {
    enrollment,
    stopReason: 'social_reply',
    channel: step.channel === 'x' ? 'x' : 'linkedin',
    stepId: step.id,
    note: input.note ?? null,
    actorUserId: ctx.userId,
    requestId: ctx.requestId ?? null,
    now,
  })
  return { reply, alreadyRecorded: false }
}
