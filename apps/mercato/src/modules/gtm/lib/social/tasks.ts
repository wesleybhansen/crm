import { UniqueConstraintViolationException } from '@mikro-orm/core'
import type { GtmCtx } from '../campaign/build'
import type { Clock, ExecutionEm } from '../execute/schedule'
import { recordSocialReply, type RecordSocialReplyResult } from '../replies/correlate'
import {
  GtmAuditEvent,
  GtmCampaign,
  GtmCampaignVersion,
  GtmCandidate,
  GtmContactPoint,
  GtmEnrollment,
  GtmSendAttempt,
  GtmStep,
} from '../../data/entities'

/*
 * Manual social tasks (SPEC-066 section 10, Tranche 7).
 *
 * TASK-STATE STORAGE - DELIBERATE REUSE OF gtm_send_attempts. READ THIS
 * BEFORE TOUCHING EITHER THE TASK CODE OR THE EMAIL EXECUTION MACHINE:
 *
 * Tasks are DERIVED, not stored: the task list is the cross product of the
 * approved version's mode='manual_social' GtmStep rows and the version's
 * ACTIVE enrollments. Only the per-task USER-RECORDED STATE needs a durable
 * home, and no entity has a per-(enrollment, step) jsonb slot for it
 * (GtmEnrollment has no jsonb column; GtmStep.send_window is per-step, not
 * per-enrollment). The decision (frozen for this tranche): task state is
 * persisted as rows in gtm_send_attempts with
 *
 *   - idempotency_key   `task:{versionId}:{enrollmentId}:{stepId}` under the
 *                       existing (organization_id, idempotency_key) unique
 *                       index, which makes concurrent marks race-safe. Email
 *                       rows use the disjoint `send:` namespace
 *                       (buildSendIdempotencyKey).
 *   - state             task vocabulary ONLY: 'task_pending' (implicit,
 *                       row absent) -> user-recorded 'task_requested' /
 *                       'task_accepted' (connection requests) /
 *                       'task_sent' / 'task_skipped'. A 'replied' mark never
 *                       writes a task state: it delegates to
 *                       recordSocialReply, whose atomic stop (section 9) is
 *                       the terminal path for the whole enrollment.
 *
 * Why this is invisible to the email machine: every email-side query is an
 * explicit state allowlist that no task_* value can match. The claimer
 * selects state in ('approved','claimed') (claim.ts), the executor's fenced
 * writes require state 'claimed'/'provider_started' (send.ts), the daily cap
 * counts CAP_COUNTED_STATES (send.ts), the atomic stop and unsubscribe
 * cancel state in ('planned','rendered','reviewed','approved')
 * (correlate.ts, unsubscribe.ts), and stuck-recovery matches
 * 'provider_started' (claim.ts). A guard test in social-tasks.test.ts
 * proves the claimer never touches task:* rows. Do not add a query over
 * gtm_send_attempts with a state wildcard.
 *
 * Manual task rows have no rendered email or sender mailbox, so both columns
 * remain null. This matters now that rendered_message_id is a real FK: using
 * a step UUID as a placeholder would violate the domain graph at insert time.
 * Email execution fails closed when either binding is absent.
 *
 * UI truth rule (section 10): every serialized task carries
 * recorded_by: 'user' and NEVER any synchronized/auto flag - the UI must not
 * imply LinkedIn/X synchronization that does not exist. No browser
 * automation, no Zernio.
 *
 * Connect-first gating: a step with depends_on_step_id +
 * dependency_kind='linkedin_connection_accepted' stays LOCKED until the
 * dependency task records 'task_accepted' OR an explicit user override is
 * recorded as a gtm_audit_events row (action 'gtm.task.dependency_override').
 *
 * Enrollment stop semantics: enrollment.status != 'active' is the durable
 * cancel marker (see lib/execute/schedule.ts) - stopped enrollments produce
 * no tasks and reject marks.
 */

export const TASK_KEY_PREFIX = 'task:'

export const TASK_STATES = [
  'task_pending',
  'task_requested',
  'task_accepted',
  'task_sent',
  'task_skipped',
] as const

export type TaskOutcome = 'sent' | 'skipped' | 'replied' | 'requested' | 'accepted'

export const DEPENDENCY_OVERRIDE_ACTION = 'gtm.task.dependency_override'
export const TASK_MARKED_ACTION = 'gtm.task.marked'

export class GtmTaskError extends Error {
  constructor(
    public code:
      | 'campaign_not_found'
      | 'enrollment_not_found'
      | 'task_not_found'
      | 'task_locked'
      | 'invalid_outcome'
      | 'enrollment_stopped'
      | 'stale_version',
    message: string,
  ) {
    super(message)
    this.name = 'GtmTaskError'
  }
}

export function buildTaskKey(versionId: string, enrollmentId: string, stepId: string): string {
  return `${TASK_KEY_PREFIX}${versionId}:${enrollmentId}:${stepId}`
}

export function isTaskIdempotencyKey(key: string | null | undefined): boolean {
  return typeof key === 'string' && key.startsWith(TASK_KEY_PREFIX)
}

export function parseTaskKey(
  key: string,
): { versionId: string; enrollmentId: string; stepId: string } | null {
  if (!key.startsWith(TASK_KEY_PREFIX)) return null
  const parts = key.slice(TASK_KEY_PREFIX.length).split(':')
  if (parts.length !== 3 || parts.some((part) => !part)) return null
  return { versionId: parts[0], enrollmentId: parts[1], stepId: parts[2] }
}

function stepSocialAction(step: GtmStep): string | null {
  const window = (step.sendWindow ?? {}) as Record<string, unknown>
  return typeof window.social_action === 'string' ? (window.social_action as string) : null
}

function snapshotTemplate(version: GtmCampaignVersion): { subject: string | null; body: string | null } {
  const snapshot = (version.snapshot ?? {}) as Record<string, unknown>
  const template = (snapshot.template ?? {}) as Record<string, unknown>
  return {
    subject: typeof template.subject === 'string' ? (template.subject as string) : null,
    body: typeof template.body === 'string' ? (template.body as string) : null,
  }
}

// The serialized task shape. Section 10 truth rule: user-recorded state
// only; recorded_by is the literal 'user' and no synchronized/auto flag
// exists on this type.
export type ManualTask = {
  task_key: string
  campaign_id: string
  campaign_version_id: string
  enrollment_id: string
  candidate_id: string
  candidate_name: string | null
  contact_id: string | null
  step_id: string
  step_order: number
  channel: string
  social_action: string | null
  delay_days: number
  state: (typeof TASK_STATES)[number]
  recorded_by: 'user'
  note: string | null
  recorded_at: string | null
  planned_for: string | null
  locked: boolean
  lock_reason: 'awaiting_connection_accepted' | null
  depends_on_task_key: string | null
  dependency_overridden: boolean
  profile_url: string | null
  // The exact approved message copy (frozen template of the version).
  message: { subject: string | null; body: string | null }
}

export type ListManualTasksResult = {
  campaignId: string
  campaignVersionId: string | null
  tasks: ManualTask[]
}

type TaskDerivationContext = {
  campaign: GtmCampaign
  version: GtmCampaignVersion
  manualSteps: GtmStep[]
  enrollments: GtmEnrollment[]
  taskRowsByKey: Map<string, GtmSendAttempt>
  overriddenKeys: Set<string>
  candidateById: Map<string, GtmCandidate>
  profileByCandidateChannel: Map<string, string>
}

async function loadDerivationContext(
  em: ExecutionEm,
  ctx: GtmCtx,
  campaign: GtmCampaign,
  version: GtmCampaignVersion,
): Promise<TaskDerivationContext> {
  const steps = (
    await em.find(GtmStep, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      campaignVersionId: version.id,
      deletedAt: null,
    })
  ).sort((a, b) => a.order - b.order)
  const manualSteps = steps.filter((step) => step.mode === 'manual_social')

  const enrollments = await em.find(GtmEnrollment, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    campaignId: campaign.id,
    campaignVersionId: version.id,
    deletedAt: null,
  })

  // Task-state rows: the version's task:* rows in gtm_send_attempts.
  const attemptRows = await em.find(GtmSendAttempt, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    campaignVersionId: version.id,
    deletedAt: null,
  })
  const taskRowsByKey = new Map<string, GtmSendAttempt>()
  for (const row of attemptRows) {
    if (isTaskIdempotencyKey(row.idempotencyKey)) taskRowsByKey.set(row.idempotencyKey, row)
  }

  const overrides = await em.find(GtmAuditEvent, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    action: DEPENDENCY_OVERRIDE_ACTION,
  })
  const overriddenKeys = new Set<string>()
  for (const event of overrides) {
    const key = (event.metadata ?? {}) as Record<string, unknown>
    if (typeof key.task_key === 'string') overriddenKeys.add(key.task_key as string)
  }

  const candidateIds = [...new Set(enrollments.map((row) => row.candidateId))]
  const candidates = candidateIds.length
    ? await em.find(GtmCandidate, {
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        id: { $in: candidateIds },
      })
    : []
  const candidateById = new Map(candidates.map((row) => [row.id, row]))

  const points = candidateIds.length
    ? await em.find(GtmContactPoint, {
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        candidateId: { $in: candidateIds },
        deletedAt: null,
      })
    : []
  const profileByCandidateChannel = new Map<string, string>()
  for (const point of points) {
    if (point.channel === 'linkedin' || point.channel === 'x') {
      profileByCandidateChannel.set(`${point.candidateId}:${point.channel}`, point.value)
    }
  }

  return {
    campaign,
    version,
    manualSteps,
    enrollments,
    taskRowsByKey,
    overriddenKeys,
    candidateById,
    profileByCandidateChannel,
  }
}

function taskStateFromRow(row: GtmSendAttempt | undefined): (typeof TASK_STATES)[number] {
  if (!row) return 'task_pending'
  return (TASK_STATES as readonly string[]).includes(row.state)
    ? (row.state as (typeof TASK_STATES)[number])
    : 'task_pending'
}

function taskNoteFromRow(row: GtmSendAttempt | undefined): string | null {
  if (!row) return null
  const receipt = (row.providerReceipt ?? {}) as Record<string, unknown>
  return typeof receipt.note === 'string' ? (receipt.note as string) : null
}

function computeLock(
  derivation: TaskDerivationContext,
  enrollment: GtmEnrollment,
  step: GtmStep,
): { locked: boolean; lockReason: 'awaiting_connection_accepted' | null; dependsOnTaskKey: string | null; overridden: boolean } {
  if (!step.dependsOnStepId || step.dependencyKind !== 'linkedin_connection_accepted') {
    return { locked: false, lockReason: null, dependsOnTaskKey: null, overridden: false }
  }
  const dependsOnTaskKey = buildTaskKey(derivation.version.id, enrollment.id, step.dependsOnStepId)
  const taskKey = buildTaskKey(derivation.version.id, enrollment.id, step.id)
  const overridden = derivation.overriddenKeys.has(taskKey)
  const dependencyRow = derivation.taskRowsByKey.get(dependsOnTaskKey)
  const accepted = taskStateFromRow(dependencyRow) === 'task_accepted'
  const locked = !accepted && !overridden
  return {
    locked,
    lockReason: locked ? 'awaiting_connection_accepted' : null,
    dependsOnTaskKey,
    overridden,
  }
}

function serializeTask(
  derivation: TaskDerivationContext,
  enrollment: GtmEnrollment,
  step: GtmStep,
): ManualTask {
  const taskKey = buildTaskKey(derivation.version.id, enrollment.id, step.id)
  const row = derivation.taskRowsByKey.get(taskKey)
  const lock = computeLock(derivation, enrollment, step)
  const candidate = derivation.candidateById.get(enrollment.candidateId)
  const identity = (candidate?.identity ?? {}) as Record<string, unknown>
  const approvedAt = derivation.version.approvedAt ?? derivation.version.createdAt ?? null
  const plannedFor = approvedAt
    ? new Date(approvedAt.getTime() + step.delayDays * 24 * 3600 * 1000)
    : null
  return {
    task_key: taskKey,
    campaign_id: derivation.campaign.id,
    campaign_version_id: derivation.version.id,
    enrollment_id: enrollment.id,
    candidate_id: enrollment.candidateId,
    candidate_name: typeof identity.name === 'string' ? (identity.name as string) : null,
    contact_id: enrollment.contactId ?? null,
    step_id: step.id,
    step_order: step.order,
    channel: step.channel,
    social_action: stepSocialAction(step),
    delay_days: step.delayDays,
    state: taskStateFromRow(row),
    // Section 10: user-recorded truth only. Never a synchronized/auto flag.
    recorded_by: 'user',
    note: taskNoteFromRow(row),
    recorded_at: row ? (row.updatedAt ?? row.createdAt ?? null)?.toISOString() ?? null : null,
    planned_for: plannedFor ? plannedFor.toISOString() : null,
    locked: lock.locked,
    lock_reason: lock.lockReason,
    depends_on_task_key: lock.dependsOnTaskKey,
    dependency_overridden: lock.overridden,
    profile_url:
      derivation.profileByCandidateChannel.get(`${enrollment.candidateId}:${step.channel}`) ?? null,
    message: snapshotTemplate(derivation.version),
  }
}

async function loadCampaignScoped(
  em: ExecutionEm,
  ctx: GtmCtx,
  campaignId: string,
): Promise<GtmCampaign> {
  const campaign = await em.findOne(GtmCampaign, {
    id: campaignId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  if (!campaign) throw new GtmTaskError('campaign_not_found', 'Campaign not found')
  return campaign
}

// ---------------------------------------------------------------------------
// listManualTasks
// ---------------------------------------------------------------------------

export async function listManualTasks(
  em: ExecutionEm,
  ctx: GtmCtx,
  input: { campaignId: string },
): Promise<ListManualTasksResult> {
  const campaign = await loadCampaignScoped(em, ctx, input.campaignId)
  if (!campaign.currentVersionId) {
    // No approved version: nothing is actionable yet (drafts have no frozen
    // steps and no enrollments).
    return { campaignId: campaign.id, campaignVersionId: null, tasks: [] }
  }
  const version = await em.findOne(GtmCampaignVersion, {
    id: campaign.currentVersionId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
  })
  if (!version || version.invalidatedAt) {
    return { campaignId: campaign.id, campaignVersionId: null, tasks: [] }
  }

  const derivation = await loadDerivationContext(em, ctx, campaign, version)
  const tasks: ManualTask[] = []
  for (const enrollment of derivation.enrollments) {
    // A stopped enrollment cancels/hides every one of its tasks (section 9:
    // status != 'active' is the durable cancel marker).
    if (enrollment.status !== 'active') continue
    for (const step of derivation.manualSteps) {
      tasks.push(serializeTask(derivation, enrollment, step))
    }
  }
  tasks.sort((a, b) =>
    a.enrollment_id < b.enrollment_id
      ? -1
      : a.enrollment_id > b.enrollment_id
        ? 1
        : a.step_order - b.step_order,
  )
  return { campaignId: campaign.id, campaignVersionId: version.id, tasks }
}

// ---------------------------------------------------------------------------
// markTask
// ---------------------------------------------------------------------------

type ResolvedTask = {
  campaign: GtmCampaign
  version: GtmCampaignVersion
  enrollment: GtmEnrollment
  step: GtmStep
  taskKey: string
}

async function resolveTask(
  em: ExecutionEm,
  ctx: GtmCtx,
  taskKey: string,
): Promise<ResolvedTask> {
  const parsed = parseTaskKey(taskKey)
  if (!parsed) throw new GtmTaskError('task_not_found', 'Task not found')

  const version = await em.findOne(GtmCampaignVersion, {
    id: parsed.versionId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
  })
  if (!version) throw new GtmTaskError('task_not_found', 'Task not found')

  const campaign = await em.findOne(GtmCampaign, {
    id: version.campaignId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  if (!campaign) throw new GtmTaskError('task_not_found', 'Task not found')
  if (campaign.currentVersionId !== version.id || version.invalidatedAt) {
    throw new GtmTaskError(
      'stale_version',
      'The task belongs to a version that is no longer current; reload the task list',
    )
  }

  const enrollment = await em.findOne(GtmEnrollment, {
    id: parsed.enrollmentId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    campaignId: campaign.id,
    deletedAt: null,
  })
  if (!enrollment) throw new GtmTaskError('task_not_found', 'Task not found')

  const step = await em.findOne(GtmStep, {
    id: parsed.stepId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    campaignVersionId: version.id,
    deletedAt: null,
  })
  if (!step || step.mode !== 'manual_social') {
    throw new GtmTaskError('task_not_found', 'Task not found')
  }
  return { campaign, version, enrollment, step, taskKey }
}

export type MarkTaskResult = {
  taskKey: string
  outcome: TaskOutcome
  state: (typeof TASK_STATES)[number] | 'replied'
  reply: RecordSocialReplyResult | null
}

export async function markTask(
  em: ExecutionEm,
  ctx: GtmCtx,
  input: { taskKey: string; outcome: TaskOutcome; note?: string | null },
  deps: { clock?: Clock } = {},
): Promise<MarkTaskResult> {
  const now = deps.clock?.now() ?? new Date()
  const resolved = await resolveTask(em, ctx, input.taskKey)
  const { campaign, version, enrollment, step, taskKey } = resolved

  if (enrollment.status !== 'active') {
    throw new GtmTaskError(
      'enrollment_stopped',
      'The enrollment is stopped; its tasks are cancelled',
    )
  }

  // Connect-first gating (section 10): a dependency-locked task rejects
  // every mark until the dependency records 'task_accepted' or an explicit
  // override audit exists.
  const derivation = await loadDerivationContext(em, ctx, campaign, version)
  const lock = computeLock(derivation, enrollment, step)
  if (lock.locked) {
    throw new GtmTaskError(
      'task_locked',
      'This task is locked until the connection request is recorded as accepted (or explicitly overridden)',
    )
  }

  // 'requested'/'accepted' are intermediate states of connection-request
  // tasks only.
  if (
    (input.outcome === 'requested' || input.outcome === 'accepted') &&
    stepSocialAction(step) !== 'connection_request'
  ) {
    throw new GtmTaskError(
      'invalid_outcome',
      `Outcome '${input.outcome}' applies only to connection-request tasks`,
    )
  }

  if (input.outcome === 'replied') {
    // Terminal via the reply path: the existing atomic stop (section 9)
    // stops the enrollment and cancels every remaining step in ONE
    // transaction. No task row is written - the stopped enrollment hides
    // every task of this prospect.
    const reply = await recordSocialReply(
      em,
      ctx,
      { enrollmentId: enrollment.id, stepId: step.id, note: input.note ?? null },
      { clock: deps.clock },
    )
    return { taskKey, outcome: 'replied', state: 'replied', reply }
  }

  const nextState = `task_${input.outcome}` as (typeof TASK_STATES)[number]
  const note = input.note?.trim() ? input.note.trim() : null

  const state = await em.transactional(async (tem) => {
    let row = await tem.findOne(GtmSendAttempt, {
      organizationId: ctx.organizationId,
      idempotencyKey: taskKey,
    })
    const historyEntry = {
      outcome: input.outcome,
      note,
      recorded_by: 'user',
      user_id: ctx.userId,
      at: now.toISOString(),
    }
    if (!row) {
      try {
        row = tem.create(GtmSendAttempt, {
          organizationId: ctx.organizationId,
          tenantId: ctx.tenantId,
          enrollmentId: enrollment.id,
          stepId: step.id,
          // Manual task rows have no rendered email and no sender mailbox.
          renderedMessageId: null,
          mailboxConnectionId: null,
          campaignVersionId: version.id,
          state: nextState,
          claimToken: null,
          claimExpiresAt: null,
          fence: 0,
          attemptNo: 1,
          idempotencyKey: taskKey,
          rfcMessageId: null,
          // Task rows are never due for the email claimer; scheduled_for
          // stays null on top of the disjoint state vocabulary.
          scheduledFor: null,
          providerReceipt: {
            kind: 'manual_task',
            recorded_by: 'user',
            note,
            history: [historyEntry],
          },
          createdAt: now,
          updatedAt: now,
        })
        tem.persist(row)
        await tem.flush()
      } catch (err) {
        if (!(err instanceof UniqueConstraintViolationException)) throw err
        // A concurrent mark created the row first; update that durable row.
        row = await tem.findOne(GtmSendAttempt, {
          organizationId: ctx.organizationId,
          idempotencyKey: taskKey,
        })
        if (!row) throw err
      }
    }
    if (row.state !== nextState || taskNoteFromRow(row) !== note) {
      const receipt = (row.providerReceipt ?? {}) as Record<string, unknown>
      const history = Array.isArray(receipt.history) ? (receipt.history as unknown[]) : []
      row.state = nextState
      row.providerReceipt = {
        kind: 'manual_task',
        recorded_by: 'user',
        note,
        history: [...history, historyEntry],
      }
      row.updatedAt = now
      tem.persist(row)
    }
    tem.persist(
      tem.create(GtmAuditEvent, {
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        actor: 'user_id',
        actorUserId: ctx.userId,
        action: TASK_MARKED_ACTION,
        objectType: 'gtm_send_attempt',
        objectId: row.id,
        requestId: ctx.requestId ?? null,
        metadata: {
          task_key: taskKey,
          outcome: input.outcome,
          state: nextState,
          enrollment_id: enrollment.id,
          step_id: step.id,
          note,
        },
      }),
    )
    await tem.flush()
    return nextState
  })

  return { taskKey, outcome: input.outcome, state, reply: null }
}

// ---------------------------------------------------------------------------
// overrideTaskDependency
// ---------------------------------------------------------------------------

export type OverrideDependencyResult = {
  taskKey: string
  overridden: boolean
  alreadyOverridden: boolean
}

export async function overrideTaskDependency(
  em: ExecutionEm,
  ctx: GtmCtx,
  input: { taskKey: string; reason: string },
): Promise<OverrideDependencyResult> {
  const resolved = await resolveTask(em, ctx, input.taskKey)
  const { enrollment, step, version, campaign, taskKey } = resolved
  if (enrollment.status !== 'active') {
    throw new GtmTaskError(
      'enrollment_stopped',
      'The enrollment is stopped; its tasks are cancelled',
    )
  }
  if (!step.dependsOnStepId || step.dependencyKind !== 'linkedin_connection_accepted') {
    throw new GtmTaskError('invalid_outcome', 'This task has no dependency to override')
  }
  const derivation = await loadDerivationContext(em, ctx, campaign, version)
  if (derivation.overriddenKeys.has(taskKey)) {
    return { taskKey, overridden: true, alreadyOverridden: true }
  }
  await em.transactional(async (tem) => {
    tem.persist(
      tem.create(GtmAuditEvent, {
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        actor: 'user_id',
        actorUserId: ctx.userId,
        action: DEPENDENCY_OVERRIDE_ACTION,
        objectType: 'gtm_step',
        objectId: step.id,
        requestId: ctx.requestId ?? null,
        metadata: {
          task_key: taskKey,
          enrollment_id: enrollment.id,
          depends_on_step_id: step.dependsOnStepId,
          reason: input.reason,
        },
      }),
    )
    await tem.flush()
  })
  return { taskKey, overridden: true, alreadyOverridden: false }
}
