import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { gtmInternalOpenApi } from '../../openapi'

export const openApi = gtmInternalOpenApi('Manage scoped manual GTM tasks')
import type { EntityManager } from '@mikro-orm/postgresql'
import { gtmEnabled } from '../../../lib/flags'
import { gtmTasksBodySchema } from '../../../data/validators'
import { isUuid } from '../../../lib/play-shape'
import type { ExecutionEm } from '../../../lib/execute/schedule'
import { GtmExecutionError } from '../../../lib/execute/schedule'

/*
 * Internal GTM manual social tasks + campaign timeline (SPEC-066 sections 5,
 * 9, 10, 14 Tranche 7).
 *
 * Ops (body.op):
 * - 'list'                 manual tasks of the campaign's current approved
 *                          version x active enrollments; user-recorded state
 *                          only, connect-first locks computed server-side
 * - 'mark'                 record a user outcome: sent | skipped |
 *                          requested | accepted (connection requests) |
 *                          replied (delegates to the section 9 atomic stop)
 * - 'override-dependency'  explicit user override of a connect-first lock;
 *                          recorded as a gtm_audit_events row
 * - 'timeline'             one merged chronological feed per enrollment:
 *                          email attempts, manual tasks, replies,
 *                          suppression/stop events
 *
 * Auth/identity mirrors internal/campaigns: shared-secret bearer, noliUserId
 * re-resolved server-side, every query self-scoped by org + tenant.
 */
export const metadata = {
  path: '/internal/gtm/tasks',
  POST: { requireAuth: false },
}

function opaqueNotFound() {
  return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
}

export async function POST(req: Request) {
  if (!gtmEnabled()) {
    return opaqueNotFound()
  }

  const secret = process.env.NOLI_INTERNAL_SERVICE_SECRET
  const authHeader = (req.headers.get('authorization') || '').trim()
  const expected = secret ? `Bearer ${secret}` : ''
  if (
    !secret ||
    authHeader.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))
  ) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const raw = await req.json().catch(() => ({}))
  const parsed = gtmTasksBodySchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const where = first?.path?.length ? `${first.path.join('.')}: ` : ''
    return NextResponse.json(
      { ok: false, error: `${where}${first?.message ?? 'Invalid body'}` },
      { status: 400 },
    )
  }
  const body = parsed.data

  try {
    const { findNoliUserById } = await import('@open-mercato/shared/lib/noli/core-client')
    const noliUser = await findNoliUserById(body.noliUserId)
    if (!noliUser?.clerk_user_id) {
      return NextResponse.json({ ok: false, error: 'Noli user not found' }, { status: 404 })
    }
    const { resolveClerkUserToAuthContext } = await import('@open-mercato/shared/lib/auth/clerk')
    const auth = await resolveClerkUserToAuthContext(noliUser.clerk_user_id)
    if (!auth || !auth.userId || !auth.orgId || !auth.tenantId) {
      return NextResponse.json({ ok: false, error: 'User has no CRM access' }, { status: 403 })
    }
    const ctx = {
      organizationId: auth.orgId as string,
      tenantId: auth.tenantId as string,
      userId: auth.userId as string,
      requestId: req.headers.get('x-request-id') || null,
    }

    const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager as unknown as ExecutionEm
    const tasksLib = await import('../../../lib/social/tasks')

    if (body.op === 'list') {
      if (!isUuid(body.campaignId)) return opaqueNotFound()
      const result = await tasksLib.listManualTasks(em, ctx, { campaignId: body.campaignId })
      return NextResponse.json({
        ok: true,
        campaign_id: result.campaignId,
        campaign_version_id: result.campaignVersionId,
        tasks: result.tasks,
      })
    }

    if (body.op === 'mark') {
      const result = await tasksLib.markTask(em, ctx, {
        taskKey: body.taskKey,
        outcome: body.outcome,
        note: body.note ?? null,
      })
      return NextResponse.json({
        ok: true,
        task_key: result.taskKey,
        outcome: result.outcome,
        state: result.state,
        reply: result.reply
          ? {
              reply_id: result.reply.reply.id,
              already_recorded: result.reply.alreadyRecorded,
            }
          : null,
      })
    }

    if (body.op === 'override-dependency') {
      const result = await tasksLib.overrideTaskDependency(em, ctx, {
        taskKey: body.taskKey,
        reason: body.reason,
      })
      return NextResponse.json({
        ok: true,
        task_key: result.taskKey,
        overridden: result.overridden,
        already_overridden: result.alreadyOverridden,
      })
    }

    // timeline
    if (!isUuid(body.campaignId)) return opaqueNotFound()
    if (body.enrollmentId && !isUuid(body.enrollmentId)) return opaqueNotFound()
    const { getCampaignTimeline } = await import('../../../lib/timeline')
    const timeline = await getCampaignTimeline(em, ctx, {
      campaignId: body.campaignId,
      enrollmentId: body.enrollmentId ?? null,
    })
    return NextResponse.json({ ok: true, timeline })
  } catch (err) {
    const tasksLib = await import('../../../lib/social/tasks')
    if (err instanceof tasksLib.GtmTaskError) {
      if (
        err.code === 'campaign_not_found' ||
        err.code === 'task_not_found' ||
        err.code === 'enrollment_not_found'
      ) {
        return opaqueNotFound()
      }
      return NextResponse.json({ ok: false, error: err.message, code: err.code }, { status: 422 })
    }
    if (err instanceof GtmExecutionError) {
      if (err.code === 'enrollment_not_found' || err.code === 'step_not_found') {
        return opaqueNotFound()
      }
      return NextResponse.json({ ok: false, error: err.message, code: err.code }, { status: 422 })
    }
    console.error('[internal.gtm.tasks]', err)
    return NextResponse.json({ ok: false, error: 'Task operation failed' }, { status: 500 })
  }
}
