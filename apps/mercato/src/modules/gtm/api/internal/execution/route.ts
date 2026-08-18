import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { gtmInternalOpenApi } from '../../openapi'

export const openApi = gtmInternalOpenApi('Launch or tick gated GTM execution')
import type { EntityManager } from '@mikro-orm/postgresql'
import { gtmEnabled } from '../../../lib/flags'
import { gtmExecutionBodySchema } from '../../../data/validators'
import { isUuid } from '../../../lib/play-shape'
import { GtmExecutionError, type ExecutionEm, type LaunchResult } from '../../../lib/execute/schedule'
import type { CommandBus } from '@open-mercato/shared/lib/commands'

/*
 * Internal GTM execution (SPEC-066 sections 5, 6, 9, 14 Tranche 6).
 *
 * Ops (body.op):
 * - 'launch'            flips an approved campaign to 'active' and
 *                       materializes the send attempts in one transaction
 *                       (idempotent under double-click and concurrency)
 * - 'tick'              claim due attempts (DB-time CAS + lease + fence) and
 *                       execute them through the production SMTP transport.
 *                       HARD SAFETY: unless GTM_EXECUTION_ENABLED === 'true'
 *                       (on top of the module flag) the tick REFUSES to
 *                       touch the real transport and returns a dry-run
 *                       report of what is due - no claim, no send.
 * - 'recover-stuck'     lease-expired provider_started rows -> 'ambiguous'
 *                       (never re-sent, section 6 rule 5)
 * - 'correlate-replies' scan recent inbound email_messages, atomic-stop +
 *                       reply rows (section 9)
 * - 'cursor-status'     redacted mailbox cursor health (never cursor values)
 * - 'status'            per-state send-attempt counts for a campaign
 *
 * Auth/identity mirrors internal/campaigns: shared-secret bearer, noliUserId
 * re-resolved server-side, every query self-scoped by org + tenant.
 */
export const metadata = {
  path: '/internal/gtm/execution',
  POST: { requireAuth: false },
}

function opaqueNotFound() {
  return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
}

function executionErrorResponse(err: GtmExecutionError) {
  if (err.code === 'campaign_not_found' || err.code === 'reply_not_found') {
    return opaqueNotFound()
  }
  return NextResponse.json({ ok: false, error: err.message, code: err.code }, { status: 422 })
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
  const parsed = gtmExecutionBodySchema.safeParse(raw)
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
    const { executionFeatureForOp, hasGtmFeature } = await import('../../../lib/authorize')
    if (!(await hasGtmFeature(container, ctx, executionFeatureForOp(body.op)))) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })
    }
    const em = container.resolve('em') as EntityManager as unknown as ExecutionEm

    if (body.op === 'launch') {
      if (!isUuid(body.campaignId)) return opaqueNotFound()
      const commandBus = container.resolve('commandBus') as CommandBus
      const executed = await commandBus.execute<
        { campaignId: string; expectedContentHash: string },
        LaunchResult
      >('gtm.campaigns.launch', {
        input: {
          campaignId: body.campaignId,
          expectedContentHash: body.expectedContentHash,
        },
        ctx: {
          container,
          auth,
          organizationScope: null,
          selectedOrganizationId: ctx.organizationId,
          organizationIds: [ctx.organizationId],
          request: req,
        },
      })
      const result = executed.result
      return NextResponse.json({
        ok: true,
        campaign_id: result.campaign.id,
        status: result.campaign.status,
        campaign_version_id: result.version.id,
        attempts: result.attempts.length,
        already_launched: result.alreadyLaunched,
      })
    }

    if (body.op === 'tick') {
      const { claimDueAttempts, resolveNow } = await import('../../../lib/execute/claim')
      // Execution kill switch: the real transport is reachable ONLY when the
      // operator explicitly enabled execution. Otherwise: dry-run report.
      if (process.env.GTM_EXECUTION_ENABLED !== 'true') {
        const entities = await import('../../../data/entities')
        const now = await resolveNow(em)
        const due = (
          await em.find(entities.GtmSendAttempt, {
            organizationId: ctx.organizationId,
            tenantId: ctx.tenantId,
            state: 'approved',
            scheduledFor: { $lte: now },
            deletedAt: null,
          })
        ).length
        return NextResponse.json({
          ok: true,
          dry_run: true,
          reason: 'GTM_EXECUTION_ENABLED is not true; no attempts were claimed or sent',
          due,
        })
      }
      const { executeClaimedAttempt } = await import('../../../lib/execute/send')
      const { mailboxTransport } = await import('../../../lib/execute/transport')
      const claimResult = await claimDueAttempts(em, ctx, { limit: body.limit })
      const outcomes = []
      for (const claimed of claimResult.claimed) {
        outcomes.push(
          await executeClaimedAttempt(em, ctx, claimed.attempt, { transport: mailboxTransport }),
        )
      }
      return NextResponse.json({
        ok: true,
        dry_run: false,
        due: claimResult.due,
        claimed: claimResult.claimed.length,
        outcomes,
      })
    }

    if (body.op === 'recover-stuck') {
      const { recoverStuckAttempts } = await import('../../../lib/execute/claim')
      const result = await recoverStuckAttempts(em, ctx)
      return NextResponse.json({ ok: true, ambiguous: result.ambiguous })
    }

    if (body.op === 'correlate-replies') {
      const { correlateReplies } = await import('../../../lib/replies/correlate')
      const result = await correlateReplies(em, ctx, { sinceMinutes: body.sinceMinutes })
      return NextResponse.json({
        ok: true,
        scanned: result.scanned,
        matched: result.matched.map((row) => ({
          reply_id: row.reply.id,
          enrollment_id: row.enrollmentId,
          send_attempt_id: row.attemptId,
          email_message_id: row.emailMessageId,
          matched_by: row.matchedBy,
          inbound_event_id: row.inboundEventId,
          event_kind: row.eventKind,
          correlation_confidence: row.reply.correlationConfidence ?? null,
        })),
        system_events: result.systemEvents,
        unmatched: result.unmatched,
        failed: result.failed,
      })
    }

    if (body.op === 'cursor-status') {
      if (body.mailboxConnectionId && !isUuid(body.mailboxConnectionId)) return opaqueNotFound()
      const entities = await import('../../../data/entities')
      const cursors = await em.find(entities.GtmMailboxCursor, {
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        ...(body.mailboxConnectionId
          ? { mailboxConnectionId: body.mailboxConnectionId }
          : {}),
        deletedAt: null,
      })
      const health = await em.find(entities.GtmMailboxHealth, {
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        ...(body.mailboxConnectionId
          ? { mailboxConnectionId: body.mailboxConnectionId }
          : {}),
        deletedAt: null,
      })
      return NextResponse.json({
        ok: true,
        cursors: cursors.map((cursor) => ({
          id: cursor.id,
          mailbox_connection_id: cursor.mailboxConnectionId,
          provider: cursor.provider,
          cursor_kind: cursor.cursorKind,
          status: cursor.status,
          fence: cursor.fence,
          has_cursor: Boolean(cursor.cursorHash),
          last_occurred_at: cursor.lastOccurredAt ?? null,
          last_success_at: cursor.lastSuccessAt ?? null,
          last_error: cursor.lastError ?? null,
          lease_expires_at: cursor.leaseExpiresAt ?? null,
        })),
        mailbox_health: health.map((row) => ({
          mailbox_connection_id: row.mailboxConnectionId,
          policy_version: row.policyVersion,
          status: row.status,
          rolling_window_started_at: row.rollingWindowStartedAt,
          accepted_count: row.acceptedCount,
          delivered_count: row.deliveredCount,
          soft_bounce_count: row.softBounceCount,
          hard_bounce_count: row.hardBounceCount,
          complaint_count: row.complaintCount,
          pause_reason: row.pauseReason ?? null,
          pause_until: row.pauseUntil ?? null,
          last_event_at: row.lastEventAt ?? null,
          fence: row.fence,
        })),
      })
    }

    // status
    if (!isUuid(body.campaignId)) return opaqueNotFound()
    const entities = await import('../../../data/entities')
    const campaign = await em.findOne(entities.GtmCampaign, {
      id: body.campaignId,
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      deletedAt: null,
    })
    if (!campaign) return opaqueNotFound()
    const versions = await em.find(entities.GtmCampaignVersion, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      campaignId: campaign.id,
    })
    const versionIds = versions.map((row) => row.id)
    const attempts = versionIds.length
      ? await em.find(entities.GtmSendAttempt, {
          organizationId: ctx.organizationId,
          tenantId: ctx.tenantId,
          campaignVersionId: { $in: versionIds },
          deletedAt: null,
        })
      : []
    const byState: Record<string, number> = {}
    for (const attempt of attempts) {
      byState[attempt.state] = (byState[attempt.state] ?? 0) + 1
    }
    return NextResponse.json({
      ok: true,
      campaign_id: campaign.id,
      status: campaign.status,
      current_version_id: campaign.currentVersionId ?? null,
      attempts: { total: attempts.length, by_state: byState },
    })
  } catch (err) {
    if (err instanceof GtmExecutionError) {
      return executionErrorResponse(err)
    }
    console.error('[internal.gtm.execution]', err)
    return NextResponse.json({ ok: false, error: 'Execution operation failed' }, { status: 500 })
  }
}
