import crypto from 'crypto'
import { LockMode, UniqueConstraintViolationException } from '@mikro-orm/core'
import type { CampaignEm, GtmCtx, SendWindow } from '../campaign/build'
import {
  DAILY_CAP_CEILING,
  isValidTimeZone,
} from '../campaign/build'
import { approvalEnvelopeMatches, canonicalHash } from '../campaign/approve'
import {
  GtmAuditEvent,
  GtmCampaign,
  GtmCampaignVersion,
  GtmEnrollment,
  GtmRenderedMessage,
  GtmSendAttempt,
  GtmStep,
} from '../../data/entities'
import { EmailConnection } from '../../../email/data/schema'

/*
 * Send-attempt materialization + launch (SPEC-066 sections 4, 6 rule 6,
 * 14 Tranche 6).
 *
 * On launch (campaign 'approved' -> 'active') one gtm_send_attempts row is
 * created per (active enrollment x automated email step) of the frozen
 * version, state 'approved', with:
 *
 *   - scheduled_for   launch time + step delay_days, jittered by a
 *                     DETERMINISTIC per-(enrollment, step) offset (sha256 of
 *                     the ids, no Math.random) and clamped into the frozen
 *                     send window: timezone-aware business window, weekends
 *                     roll forward to Monday, past-end rolls to the next
 *                     day's window start
 *   - idempotency_key `send:{versionId}:{enrollmentId}:{stepId}:1` under the
 *                     (organization_id, idempotency_key) unique index, which
 *                     is what makes double-launch (including a concurrent
 *                     one) idempotent at the database
 *   - rfc_message_id  null (minted at claim time, send.ts rule 3)
 *   - fence 0, attempt_no 1
 *
 * mode='manual_social' steps get NO send attempts: they are user-recorded
 * tasks (SPEC-066 section 10, Tranche 7) and are cancelled by the enrollment
 * stop itself (status != 'active' is the durable marker Tranche 7 reads).
 */

// EntityManager slice for the execution layer: the campaign slice plus
// MikroORM's conditional-update primitive (`nativeUpdate`), which is the
// CAS/fencing building block of SPEC-066 section 6.
export interface ExecutionEm {
  transactional<T>(cb: (tem: ExecutionEm) => Promise<T>): Promise<T>
  create<T extends object>(entityClass: new () => T, data: object): T
  persist(entity: object): unknown
  flush(): Promise<void>
  find<T extends object>(entityClass: new () => T, where: Record<string, unknown>): Promise<T[]>
  findOne<T extends object>(
    entityClass: new () => T,
    where: Record<string, unknown>,
    options?: { lockMode?: LockMode },
  ): Promise<T | null>
  nativeUpdate<T extends object>(
    entityClass: new () => T,
    where: Record<string, unknown>,
    data: Record<string, unknown>,
  ): Promise<number>
}

// Injected clock for tests. Production callers omit it; claim/recover then
// resolve time from the database (claim.ts), never from an application clock.
export type Clock = { now(): Date }

export class GtmExecutionError extends Error {
  constructor(
    public code:
      | 'campaign_not_found'
      | 'not_approved'
      | 'version_missing'
      | 'version_invalidated'
      | 'stale_approval'
      | 'no_sender'
      | 'sender_changed'
      | 'attempt_not_claimed'
      | 'enrollment_not_found'
      | 'step_not_found'
      | 'reply_not_found'
      | 'invalid_state'
      | 'invalid_token'
      | 'not_configured',
    message: string,
  ) {
    super(message)
    this.name = 'GtmExecutionError'
  }
}

/*
 * Deliberately keyed on the enrollment and the step's STABLE key, NOT on the
 * campaign version or the per-version GtmStep uuid.
 *
 * Approving mints brand-new GtmStep rows every time, so a key carrying either
 * of those changed on every re-approval and the (organization_id,
 * idempotency_key) unique index stopped deduping. Editing a typo on day 2 and
 * relaunching therefore materialised a second full set of attempts with
 * byte-identical content and mailed step 1 to every still-active recipient
 * again.
 *
 * Keyed this way, a logical step can be sent to an enrollment exactly once no
 * matter how many times the campaign is invalidated, edited, re-approved and
 * relaunched. Re-approving a campaign that was never launched is unaffected -
 * no attempts exist yet, so nothing collides.
 */
export function buildSendIdempotencyKey(
  enrollmentId: string,
  stepKey: string,
  attemptNo: number,
): string {
  return `send:${enrollmentId}:${stepKey}:${attemptNo}`
}

// The stable per-step identity, written by approveCampaign into
// sendWindow.step_key. Falls back to the row id only for defensive safety on
// legacy rows written before step_key existed.
export function readStepKey(step: { id: string; sendWindow?: unknown }): string {
  const key = (step.sendWindow as Record<string, unknown> | null | undefined)?.step_key
  return typeof key === 'string' && key.trim() ? key.trim() : step.id
}

// ---------------------------------------------------------------------------
// Frozen version settings (the approval snapshot is the source of truth)
// ---------------------------------------------------------------------------

export type FrozenSendSettings = {
  daily_cap: number
  send_window: SendWindow
  jitter_minutes: number
  sender_mailbox_id: string | null
}

export function parseVersionSettings(version: GtmCampaignVersion): FrozenSendSettings {
  const snapshot = (version.snapshot ?? {}) as Record<string, unknown>
  const settings = (snapshot.settings ?? {}) as Record<string, unknown>
  const windowRaw = (settings.send_window ?? {}) as Record<string, unknown>
  const parsed: FrozenSendSettings = {
    daily_cap:
      typeof settings.daily_cap === 'number' && Number.isInteger(settings.daily_cap)
        ? (settings.daily_cap as number)
        : Number.NaN,
    send_window: {
      start_hour:
        typeof windowRaw.start_hour === 'number'
          ? (windowRaw.start_hour as number)
          : Number.NaN,
      end_hour:
        typeof windowRaw.end_hour === 'number'
          ? (windowRaw.end_hour as number)
          : Number.NaN,
      timezone:
        typeof windowRaw.timezone === 'string' && windowRaw.timezone
          ? (windowRaw.timezone as string)
          : '',
    },
    jitter_minutes:
      typeof settings.jitter_minutes === 'number' && Number.isInteger(settings.jitter_minutes)
        ? (settings.jitter_minutes as number)
        : Number.NaN,
    sender_mailbox_id:
      typeof settings.sender_mailbox_id === 'string' && settings.sender_mailbox_id
        ? (settings.sender_mailbox_id as string)
        : null,
  }
  if (
    !Number.isInteger(parsed.daily_cap)
    || parsed.daily_cap < 1
    || parsed.daily_cap > DAILY_CAP_CEILING
    || !Number.isInteger(parsed.send_window.start_hour)
    || !Number.isInteger(parsed.send_window.end_hour)
    || parsed.send_window.start_hour < 0
    || parsed.send_window.end_hour > 24
    || parsed.send_window.end_hour <= parsed.send_window.start_hour
    || !Number.isInteger(parsed.jitter_minutes)
    || parsed.jitter_minutes < 0
    || parsed.jitter_minutes > 120
    || !isValidTimeZone(parsed.send_window.timezone)
  ) {
    throw new GtmExecutionError('stale_approval', 'The approved capacity envelope is invalid')
  }
  return parsed
}

// ---------------------------------------------------------------------------
// Timezone-aware scheduling math (deterministic, no Math.random)
// ---------------------------------------------------------------------------

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone)
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        weekday: 'short',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      })
    } catch {
      // Unknown zone in the frozen snapshot: fall back to UTC rather than
      // failing the whole launch (the window is a courtesy, not a guard).
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC',
        hourCycle: 'h23',
        weekday: 'short',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      })
    }
    formatterCache.set(timeZone, fmt)
  }
  return fmt
}

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

export function zonedParts(
  date: Date,
  timeZone: string,
): { hour: number; minute: number; second: number; weekday: number } {
  const parts = zoneFormatter(timeZone).formatToParts(date)
  const out = { hour: 0, minute: 0, second: 0, weekday: 1 }
  for (const part of parts) {
    if (part.type === 'hour') out.hour = Number(part.value) % 24
    else if (part.type === 'minute') out.minute = Number(part.value)
    else if (part.type === 'second') out.second = Number(part.value)
    else if (part.type === 'weekday') out.weekday = WEEKDAYS[part.value] ?? 1
  }
  return out
}

export function zonedDayKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const values = new Map(parts.map((part) => [part.type, part.value]))
  return `${values.get('year')}-${values.get('month')}-${values.get('day')}`
}

export function isWithinBusinessWindow(date: Date, window: SendWindow): boolean {
  const parts = zonedParts(date, window.timezone)
  return (
    parts.weekday >= 1
    && parts.weekday <= 5
    && parts.hour >= window.start_hour
    && parts.hour < window.end_hour
  )
}

// Deterministic jitter in [0, maxMinutes], seeded from the enrollment and
// step ids (sha256, no Math.random) so re-materialization is reproducible.
export function deterministicJitterMinutes(seed: string, maxMinutes: number): number {
  if (!Number.isInteger(maxMinutes) || maxMinutes <= 0) return 0
  const digest = crypto.createHash('sha256').update(seed).digest()
  return digest.readUInt32BE(0) % (maxMinutes + 1)
}

// Clamp a candidate instant into the business send window: weekday only,
// local hour in [start_hour, end_hour). Each iteration re-reads the local
// wall clock after the arithmetic step, so DST shifts are self-correcting.
export function clampToBusinessWindow(date: Date, window: SendWindow): Date {
  let current = date
  for (let i = 0; i < 16; i += 1) {
    const p = zonedParts(current, window.timezone)
    if (p.weekday === 0 || p.weekday === 6 || p.hour >= window.end_hour) {
      // Advance to the next local midnight; the next iteration clamps to the
      // window start (and skips further weekend days).
      const seconds = (24 - p.hour) * 3600 - p.minute * 60 - p.second
      current = new Date(current.getTime() + Math.max(seconds, 1) * 1000)
      continue
    }
    if (p.hour < window.start_hour) {
      const seconds = (window.start_hour - p.hour) * 3600 - p.minute * 60 - p.second
      current = new Date(current.getTime() + Math.max(seconds, 1) * 1000)
      continue
    }
    return current
  }
  return current
}

export function computeScheduledFor(
  launchAt: Date,
  delayDays: number,
  window: SendWindow,
  jitterMinutes: number,
  jitterSeed: string,
): Date {
  const jitter = deterministicJitterMinutes(jitterSeed, jitterMinutes)
  const base = new Date(
    launchAt.getTime() + delayDays * 24 * 3600 * 1000 + jitter * 60 * 1000,
  )
  return clampToBusinessWindow(base, window)
}

export function allocateDailyCapacitySlot(
  candidate: Date,
  settings: Pick<FrozenSendSettings, 'daily_cap' | 'send_window'>,
  reservationsByDay: Map<string, number>,
): Date {
  let slot = clampToBusinessWindow(candidate, settings.send_window)
  for (let day = 0; day < 370; day += 1) {
    const key = zonedDayKey(slot, settings.send_window.timezone)
    const reserved = reservationsByDay.get(key) ?? 0
    if (reserved < settings.daily_cap) {
      reservationsByDay.set(key, reserved + 1)
      return slot
    }
    slot = clampToBusinessWindow(
      new Date(slot.getTime() + 24 * 3600 * 1000),
      settings.send_window,
    )
  }
  throw new GtmExecutionError('invalid_state', 'No mailbox capacity is available in the scheduling horizon')
}

export const CAPACITY_RESERVED_STATES = [
  'approved',
  'claimed',
  'provider_started',
  'accepted',
  'delivered',
  'bounced',
  'complained',
  'replied',
  'ambiguous',
] as const

export function capacityTimestamp(attempt: GtmSendAttempt): Date | null {
  if (
    attempt.state === 'provider_started'
    || attempt.state === 'accepted'
    || attempt.state === 'delivered'
    || attempt.state === 'bounced'
    || attempt.state === 'complained'
    || attempt.state === 'replied'
    || attempt.state === 'ambiguous'
  ) {
    return attempt.sentAt ?? attempt.ambiguousAt ?? attempt.updatedAt ?? attempt.scheduledFor ?? null
  }
  return attempt.scheduledFor ?? null
}

export function buildCapacityReservations(
  attempts: GtmSendAttempt[],
  timezone: string,
  excludeAttemptId?: string,
): Map<string, number> {
  const reservations = new Map<string, number>()
  for (const attempt of attempts) {
    if (attempt.id === excludeAttemptId) continue
    const timestamp = capacityTimestamp(attempt)
    if (!timestamp) continue
    const key = zonedDayKey(timestamp, timezone)
    reservations.set(key, (reservations.get(key) ?? 0) + 1)
  }
  return reservations
}

const CAPACITY_SLOT_SCHEMA = 'v1'

/**
 * Allocate one durable ordinal within a mailbox-local day. The mailbox row is
 * locked by launch/send callers before this helper runs; the database unique
 * constraint is the final fence if a caller ever violates that lock order.
 * Legacy rows without keys consume the lowest available ordinals so they
 * cannot be ignored during an additive schema upgrade.
 */
export function allocateCapacitySlotKey(
  mailboxConnectionId: string,
  scheduledFor: Date,
  settings: Pick<FrozenSendSettings, 'daily_cap' | 'send_window'>,
  attempts: GtmSendAttempt[],
  options: { excludeAttemptId?: string; preferredKey?: string | null } = {},
): string {
  const day = zonedDayKey(scheduledFor, settings.send_window.timezone)
  const prefix = `${CAPACITY_SLOT_SCHEMA}:${mailboxConnectionId}:${day}:`
  const occupied = new Set<number>()
  let legacyRows = 0
  for (const attempt of attempts) {
    if (attempt.id === options.excludeAttemptId) continue
    const timestamp = capacityTimestamp(attempt)
    if (!timestamp || zonedDayKey(timestamp, settings.send_window.timezone) !== day) continue
    const raw = attempt.capacitySlotKey
    if (typeof raw === 'string' && raw.startsWith(prefix)) {
      const ordinal = Number(raw.slice(prefix.length))
      if (Number.isInteger(ordinal) && ordinal >= 1 && ordinal <= settings.daily_cap) {
        occupied.add(ordinal)
        continue
      }
    }
    legacyRows += 1
  }
  for (let ordinal = 1; ordinal <= settings.daily_cap && legacyRows > 0; ordinal += 1) {
    if (occupied.has(ordinal)) continue
    occupied.add(ordinal)
    legacyRows -= 1
  }
  if (options.preferredKey?.startsWith(prefix)) {
    const preferredOrdinal = Number(options.preferredKey.slice(prefix.length))
    if (
      Number.isInteger(preferredOrdinal)
      && preferredOrdinal >= 1
      && preferredOrdinal <= settings.daily_cap
      && !occupied.has(preferredOrdinal)
    ) {
      return options.preferredKey
    }
  }
  for (let ordinal = 1; ordinal <= settings.daily_cap; ordinal += 1) {
    if (!occupied.has(ordinal)) return `${prefix}${ordinal}`
  }
  throw new GtmExecutionError('invalid_state', 'No durable mailbox capacity slot is available')
}

// ---------------------------------------------------------------------------
// Materialization
// ---------------------------------------------------------------------------

export type MaterializeResult = {
  created: GtmSendAttempt[]
  existing: GtmSendAttempt[]
}

// Creates the 'approved' send-attempt rows for every (active enrollment x
// automated email step) of the version. Idempotent per row via the
// (organization_id, idempotency_key) unique index; rows that already exist
// are returned unchanged. Runs inside the caller's transaction (launch).
export async function materializeSendAttempts(
  em: ExecutionEm,
  ctx: GtmCtx,
  campaignVersion: GtmCampaignVersion,
  deps: { clock?: Clock; launchAt?: Date } = {},
): Promise<MaterializeResult> {
  const settings = parseVersionSettings(campaignVersion)
  if (!settings.sender_mailbox_id) {
    throw new GtmExecutionError(
      'no_sender',
      'The approved version has no sender mailbox; set mailbox_connection_id and re-approve',
    )
  }
  if (!approvalEnvelopeMatches(campaignVersion.snapshot, campaignVersion.contentHash)) {
    throw new GtmExecutionError('stale_approval', 'The approved campaign envelope no longer matches its hash')
  }
  const snapshot = campaignVersion.snapshot as Record<string, unknown>
  const snapshotSettings = (snapshot.settings ?? {}) as Record<string, unknown>
  const approvedSender = snapshotSettings.sender as Record<string, unknown> | null | undefined
  const connection = await em.findOne(
    EmailConnection,
    {
      id: settings.sender_mailbox_id,
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      deletedAt: null,
    },
    { lockMode: LockMode.PESSIMISTIC_WRITE },
  )
  if (!connection || !connection.isActive || !approvedSender) {
    throw new GtmExecutionError('no_sender', 'The approved sender is missing or inactive')
  }
  const senderMaterial = {
    mailbox_connection_id: connection.id,
    provider: connection.provider,
    email_address: connection.emailAddress.trim().toLowerCase(),
    user_id: connection.userId,
    purpose: connection.purpose ?? null,
    updated_at: connection.updatedAt.toISOString(),
  }
  if (
    approvedSender.mailbox_connection_id !== connection.id
    || approvedSender.fingerprint !== canonicalHash(senderMaterial)
  ) {
    throw new GtmExecutionError('sender_changed', 'The approved sender changed before launch')
  }
  const launchAt = deps.launchAt ?? deps.clock?.now() ?? new Date()

  const steps = (
    await em.find(GtmStep, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      campaignVersionId: campaignVersion.id,
      deletedAt: null,
    })
  ).sort((a, b) => a.order - b.order)
  // Manual social steps are tasks (Tranche 7), never send attempts.
  const emailSteps = steps.filter((step) => step.mode === 'automated_email')

  const enrollments = (await em.find(GtmEnrollment, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    campaignId: campaignVersion.campaignId,
    campaignVersionId: campaignVersion.id,
    status: 'active',
    deletedAt: null,
  })).sort((a, b) => a.id.localeCompare(b.id))

  const renderedRows = await em.find(GtmRenderedMessage, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    campaignVersionId: campaignVersion.id,
    deletedAt: null,
  })
  const renderedByEnrollmentStep = new Map(
    renderedRows.map((row) => [`${row.enrollmentId}:${row.stepId}`, row]),
  )

  const created: GtmSendAttempt[] = []
  const existing: GtmSendAttempt[] = []
  const reservedAttempts = await em.find(GtmSendAttempt, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    mailboxConnectionId: settings.sender_mailbox_id,
    state: { $in: [...CAPACITY_RESERVED_STATES] },
    deletedAt: null,
  })
  const reservations = buildCapacityReservations(
    reservedAttempts,
    settings.send_window.timezone,
  )
  const intents: Array<{
    enrollment: GtmEnrollment
    step: GtmStep
    rendered: GtmRenderedMessage
    idempotencyKey: string
    earliest: Date
  }> = []
  for (const enrollment of enrollments) {
    for (const step of emailSteps) {
      const rendered = renderedByEnrollmentStep.get(`${enrollment.id}:${step.id}`)
      if (!rendered) continue
      const idempotencyKey = buildSendIdempotencyKey(enrollment.id, readStepKey(step), 1)
      const already = await em.findOne(GtmSendAttempt, {
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        idempotencyKey,
      })
      if (already) {
        existing.push(already)
        continue
      }
      intents.push({
        enrollment,
        step,
        rendered,
        idempotencyKey,
        earliest: computeScheduledFor(
          launchAt,
          step.delayDays,
          settings.send_window,
          settings.jitter_minutes,
          `${enrollment.id}:${step.id}`,
        ),
      })
    }
  }
  intents.sort((left, right) =>
    left.earliest.getTime() - right.earliest.getTime()
    || left.idempotencyKey.localeCompare(right.idempotencyKey),
  )
  for (const intent of intents) {
    const scheduledFor = allocateDailyCapacitySlot(intent.earliest, settings, reservations)
    const capacitySlotKey = allocateCapacitySlotKey(
      settings.sender_mailbox_id,
      scheduledFor,
      settings,
      reservedAttempts,
    )
    const attempt = em.create(GtmSendAttempt, {
      id: crypto.randomUUID(),
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      enrollmentId: intent.enrollment.id,
      stepId: intent.step.id,
      renderedMessageId: intent.rendered.id,
      campaignVersionId: campaignVersion.id,
      mailboxConnectionId: settings.sender_mailbox_id,
      state: 'approved',
      claimToken: null,
      claimExpiresAt: null,
      fence: 0,
      attemptNo: 1,
      idempotencyKey: intent.idempotencyKey,
      rfcMessageId: null,
      scheduledFor,
      capacitySlotKey,
    })
    em.persist(attempt)
    created.push(attempt)
    reservedAttempts.push(attempt)
  }
  return { created, existing }
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

export type LaunchResult = {
  campaign: GtmCampaign
  version: GtmCampaignVersion
  attempts: GtmSendAttempt[]
  alreadyLaunched: boolean
}

async function loadVersionAttempts(
  em: ExecutionEm,
  ctx: GtmCtx,
  versionId: string,
): Promise<GtmSendAttempt[]> {
  return em.find(GtmSendAttempt, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    campaignVersionId: versionId,
    deletedAt: null,
  })
}

// Flips 'approved' -> 'active' and materializes the send attempts in ONE
// transaction. Double-launch is idempotent: an already-active campaign (or a
// concurrent launch losing the idempotency-key race) returns the existing
// attempts and the unchanged status.
export async function launchCampaign(
  em: ExecutionEm,
  ctx: GtmCtx,
  input: { campaignId: string; expectedContentHash: string },
  deps: { clock?: Clock } = {},
): Promise<LaunchResult> {
  const campaign = await em.findOne(GtmCampaign, {
    id: input.campaignId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  if (!campaign) throw new GtmExecutionError('campaign_not_found', 'Campaign not found')
  if (!campaign.currentVersionId) {
    throw new GtmExecutionError('not_approved', 'Campaign has no approved version to launch')
  }
  const version = await em.findOne(GtmCampaignVersion, {
    id: campaign.currentVersionId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
  })
  if (!version) throw new GtmExecutionError('version_missing', 'Approved version row missing')
  if (version.invalidatedAt) {
    throw new GtmExecutionError(
      'version_invalidated',
      'The current version was invalidated; re-approve before launching',
    )
  }
  if (!version.approvedAt) {
    throw new GtmExecutionError('not_approved', 'The current version was never approved')
  }
  if (input.expectedContentHash !== version.contentHash) {
    throw new GtmExecutionError(
      'stale_approval',
      'The approved campaign envelope changed; review the current approval before launching',
    )
  }

  if (campaign.status === 'active') {
    // Idempotent double-launch: status and attempts returned unchanged.
    const attempts = await loadVersionAttempts(em, ctx, version.id)
    return { campaign, version, attempts, alreadyLaunched: true }
  }
  if (campaign.status !== 'approved') {
    throw new GtmExecutionError(
      'not_approved',
      `Campaign status '${campaign.status}' cannot be launched`,
    )
  }

  try {
    const attempts = await em.transactional(async (tem) => {
      // Materialize BEFORE flipping status so a validation failure (for
      // example a missing sender) leaves the campaign 'approved' untouched.
      const result = await materializeSendAttempts(tem, ctx, version, deps)
      campaign.status = 'active'
      tem.persist(campaign)
      const audit = tem.create(GtmAuditEvent, {
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        actor: 'user_id',
        actorUserId: ctx.userId,
        action: 'gtm.campaign.launched',
        objectType: 'gtm_campaign',
        objectId: campaign.id,
        objectVersion: version.version,
        requestId: ctx.requestId ?? null,
        metadata: {
          campaign_version_id: version.id,
          attempts_created: result.created.length,
          attempts_existing: result.existing.length,
        },
      })
      tem.persist(audit)
      await tem.flush()
      return [...result.existing, ...result.created]
    })
    return { campaign, version, attempts, alreadyLaunched: false }
  } catch (err) {
    if (!(err instanceof UniqueConstraintViolationException)) throw err
    // A concurrent launch won the idempotency-key race: its rows are the
    // durable truth. Return them unchanged.
    campaign.status = 'active'
    const attempts = await loadVersionAttempts(em, ctx, version.id)
    return { campaign, version, attempts, alreadyLaunched: true }
  }
}
