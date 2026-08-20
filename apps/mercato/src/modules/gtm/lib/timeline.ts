import type { GtmCtx } from './campaign/build'
import type { ExecutionEm } from './execute/schedule'
import {
  GtmAuditEvent,
  GtmCampaign,
  GtmEnrollment,
  GtmReply,
  GtmSendAttempt,
} from '../data/entities'
import {
  GtmTaskError,
  isTaskIdempotencyKey,
  listManualTasks,
  type ManualTask,
} from './social/tasks'

/*
 * Campaign timeline (SPEC-066 sections 9, 10, Tranche 7): ONE merged
 * chronological feed per campaign (optionally narrowed to one enrollment):
 *
 *   - email send attempts   state + timestamps from gtm_send_attempts
 *                           (task:* rows are excluded here and surface as
 *                           manual tasks instead)
 *   - manual tasks          user-recorded states via listManualTasks (the
 *                           section 10 truth rule rides along: recorded_by
 *                           'user', no synchronization implied)
 *   - replies               channel + classification from gtm_replies
 *   - suppression/stop      gtm_audit_events rows (reply-recorded stops,
 *                           unsubscribes, dependency overrides)
 *
 * Pure shaping over existing tables: no writes, no derived state stored.
 * The feed is capped at 200 entries (most recent kept, `truncated` set).
 */

export const TIMELINE_CAP = 200

const TIMELINE_AUDIT_ACTIONS = [
  'gtm.reply.recorded',
  'gtm.enrollment.unsubscribed',
  'gtm.task.dependency_override',
] as const

export type TimelineEntry = {
  type: 'email_attempt' | 'manual_task' | 'reply' | 'event'
  at: string | null
  enrollment_id: string | null
  detail: Record<string, unknown>
}

export type CampaignTimeline = {
  campaign_id: string
  enrollment_id: string | null
  total: number
  truncated: boolean
  entries: TimelineEntry[]
}

function emailAttemptEntry(row: GtmSendAttempt): TimelineEntry {
  const at = row.sentAt ?? row.scheduledFor ?? row.createdAt ?? null
  return {
    type: 'email_attempt',
    at: at ? at.toISOString() : null,
    enrollment_id: row.enrollmentId,
    detail: {
      send_attempt_id: row.id,
      step_id: row.stepId,
      state: row.state,
      scheduled_for: row.scheduledFor ? row.scheduledFor.toISOString() : null,
      sent_at: row.sentAt ? row.sentAt.toISOString() : null,
      failed_at: row.failedAt ? row.failedAt.toISOString() : null,
      failure_reason: row.failureReason ?? null,
      replied_at: row.repliedAt ? row.repliedAt.toISOString() : null,
    },
  }
}

function manualTaskEntry(task: ManualTask): TimelineEntry {
  return {
    type: 'manual_task',
    at: task.recorded_at ?? task.planned_for,
    enrollment_id: task.enrollment_id,
    detail: {
      task_key: task.task_key,
      step_id: task.step_id,
      channel: task.channel,
      social_action: task.social_action,
      state: task.state,
      recorded_by: task.recorded_by,
      locked: task.locked,
      note: task.note,
    },
  }
}

function replyEntry(row: GtmReply): TimelineEntry {
  return {
    type: 'reply',
    at: row.createdAt ? row.createdAt.toISOString() : null,
    enrollment_id: row.enrollmentId,
    detail: {
      reply_id: row.id,
      channel: row.channel,
      classification: row.classification ?? null,
      classification_source: row.classificationSource ?? null,
      send_attempt_id: row.sendAttemptId ?? null,
      step_id: row.stepId ?? null,
    },
  }
}

function auditEntry(event: GtmAuditEvent, enrollmentId: string | null): TimelineEntry {
  return {
    type: 'event',
    at: event.createdAt ? event.createdAt.toISOString() : null,
    enrollment_id: enrollmentId,
    detail: {
      action: event.action,
      object_type: event.objectType,
      object_id: event.objectId ?? null,
      metadata: event.metadata ?? null,
    },
  }
}

function auditEnrollmentId(event: GtmAuditEvent): string | null {
  if (event.action === 'gtm.enrollment.unsubscribed') return event.objectId ?? null
  const metadata = (event.metadata ?? {}) as Record<string, unknown>
  return typeof metadata.enrollment_id === 'string' ? (metadata.enrollment_id as string) : null
}

export async function getCampaignTimeline(
  em: ExecutionEm,
  ctx: GtmCtx,
  input: { campaignId: string; enrollmentId?: string | null },
): Promise<CampaignTimeline> {
  const campaign = await em.findOne(GtmCampaign, {
    id: input.campaignId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  if (!campaign) throw new GtmTaskError('campaign_not_found', 'Campaign not found')

  let enrollments = await em.find(GtmEnrollment, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    campaignId: campaign.id,
    deletedAt: null,
  })
  if (input.enrollmentId) {
    enrollments = enrollments.filter((row) => row.id === input.enrollmentId)
    if (enrollments.length === 0) {
      throw new GtmTaskError('enrollment_not_found', 'Enrollment not found in this campaign')
    }
  }
  const enrollmentIds = new Set(enrollments.map((row) => row.id))

  const entries: TimelineEntry[] = []

  // 1. Email send attempts (task:* rows excluded; they surface as tasks).
  if (enrollmentIds.size > 0) {
    const attempts = await em.find(GtmSendAttempt, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      enrollmentId: { $in: [...enrollmentIds] },
      deletedAt: null,
    })
    for (const row of attempts) {
      if (isTaskIdempotencyKey(row.idempotencyKey)) continue
      entries.push(emailAttemptEntry(row))
    }
  }

  // 2. Manual tasks (user-recorded states of the current approved version).
  const taskList = await listManualTasks(em, ctx, { campaignId: campaign.id })
  for (const task of taskList.tasks) {
    if (input.enrollmentId && task.enrollment_id !== input.enrollmentId) continue
    entries.push(manualTaskEntry(task))
  }

  // 3. Replies (email correlated + user-recorded social).
  if (enrollmentIds.size > 0) {
    const replies = await em.find(GtmReply, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      enrollmentId: { $in: [...enrollmentIds] },
      deletedAt: null,
    })
    for (const row of replies) entries.push(replyEntry(row))
  }

  // 4. Suppression/stop events from the audit trail.
  const events = await em.find(GtmAuditEvent, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    action: { $in: [...TIMELINE_AUDIT_ACTIONS] },
  })
  for (const event of events) {
    const enrollmentId = auditEnrollmentId(event)
    // Keep only events attributable to this campaign's enrollments; a
    // campaign-wide feed drops foreign-enrollment events, an enrollment feed
    // narrows further.
    if (!enrollmentId || !enrollmentIds.has(enrollmentId)) continue
    entries.push(auditEntry(event, enrollmentId))
  }

  entries.sort((a, b) => {
    const ta = a.at ? Date.parse(a.at) : Number.MAX_SAFE_INTEGER
    const tb = b.at ? Date.parse(b.at) : Number.MAX_SAFE_INTEGER
    return ta - tb
  })

  const total = entries.length
  const truncated = total > TIMELINE_CAP
  return {
    campaign_id: campaign.id,
    enrollment_id: input.enrollmentId ?? null,
    total,
    truncated,
    // Most recent entries win when the feed exceeds the cap.
    entries: truncated ? entries.slice(total - TIMELINE_CAP) : entries,
  }
}
