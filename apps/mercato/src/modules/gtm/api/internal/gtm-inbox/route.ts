import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { gtmInternalOpenApi } from '../../openapi'

export const openApi = gtmInternalOpenApi('Manage the scoped GTM reply inbox')
import type { EntityManager } from '@mikro-orm/postgresql'
import { gtmEnabled } from '../../../lib/flags'
import { gtmInboxBodySchema } from '../../../data/validators'
import { isUuid } from '../../../lib/play-shape'
import { GtmExecutionError, type ExecutionEm } from '../../../lib/execute/schedule'
import type { GtmReply } from '../../../data/entities'
import { EmailMessage } from '../../../../email/data/schema'

/*
 * Internal GTM inbox (SPEC-066 sections 5, 6, 8, 9, 14; inbox completeness).
 *
 * Ops (body.op):
 * - 'list'                replies with enrollment context + an inbound summary
 *                         (filter: all | unread | interested; unread = not yet
 *                         classified). Optional `query` is a self-scoped,
 *                         case-insensitive match over the reply + counterparty
 *                         fields.
 * - 'thread'              the full correlated conversation for one reply: the
 *                         reply, the linked inbound email_messages, and the
 *                         enrollment's outbound GTM sends, chronologically
 *                         ordered (lib/replies/thread.ts)
 * - 'classify'            user override of a reply classification;
 *                         'unsubscribe' also suppresses in-transaction
 * - 'record-social-reply' user-recorded LinkedIn/X reply; takes the SAME
 *                         atomic-stop transaction path as correlated email
 *                         replies (section 9)
 * - 'draft-response'      store a manual draft answer (draft_status 'drafted')
 * - 'draft-response-ai'   AI-suggested reply grounded in the thread +
 *                         classification + locked voice, metered once, with an
 *                         honest template fallback (lib/replies/ai-reply.ts)
 * - 'approve-draft'       'drafted' -> 'approved' AND send the approved reply as
 *                         a durable one-off GtmSendAttempt through the full send
 *                         machine (lib/replies/send.ts). Honors the
 *                         GTM_EXECUTION_ENABLED double-lock (dry-run when off)
 *                         and is fully idempotent.
 *
 * Auth/identity mirrors internal/campaigns: shared-secret bearer, noliUserId
 * re-resolved server-side, every query self-scoped by org + tenant.
 */
export const metadata = {
  path: '/internal/gtm/inbox',
  POST: { requireAuth: false },
}

function opaqueNotFound() {
  return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
}

function replyShape(reply: GtmReply) {
  return {
    id: reply.id,
    enrollment_id: reply.enrollmentId,
    send_attempt_id: reply.sendAttemptId ?? null,
    step_id: reply.stepId ?? null,
    channel: reply.channel,
    email_message_id: reply.emailMessageId ?? null,
    inbound_event_id: reply.inboundEventId ?? null,
    event_kind: reply.eventKind ?? null,
    correlation_confidence: reply.correlationConfidence ?? null,
    classification: reply.classification ?? null,
    classification_source: reply.classificationSource ?? null,
    draft_status: reply.draftStatus,
    draft_response: reply.draftResponse ?? null,
    created_at: reply.createdAt ?? null,
  }
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
  const parsed = gtmInboxBodySchema.safeParse(raw)
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
    const { hasGtmFeature, inboxFeatureForOp } = await import('../../../lib/authorize')
    if (!(await hasGtmFeature(container, ctx, inboxFeatureForOp(body.op)))) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })
    }
    const em = container.resolve('em') as EntityManager as unknown as ExecutionEm
    const entities = await import('../../../data/entities')

    if (body.op === 'list') {
      const filter = body.filter ?? 'all'
      const query = (body.query ?? '').trim().toLowerCase()
      let replies = (
        await em.find(entities.GtmReply, {
          organizationId: ctx.organizationId,
          tenantId: ctx.tenantId,
          deletedAt: null,
        })
      )
        .filter((reply) => {
          if (filter === 'unread') return reply.classification == null
          if (filter === 'interested') return reply.classification === 'interested'
          return true
        })
        .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))
      const enrollmentIds = [...new Set(replies.map((reply) => reply.enrollmentId))]
      const enrollments = enrollmentIds.length
        ? await em.find(entities.GtmEnrollment, {
            organizationId: ctx.organizationId,
            tenantId: ctx.tenantId,
            id: { $in: enrollmentIds },
          })
        : []
      const enrollmentById = new Map(enrollments.map((row) => [row.id, row]))

      // Linked inbound emails power both the search haystack and the per-reply
      // summary; loaded once, org+tenant scoped.
      const emailIds = [
        ...new Set(replies.map((reply) => reply.emailMessageId).filter((id): id is string => !!id)),
      ]
      const emails = emailIds.length
        ? await em.find(EmailMessage, {
            organizationId: ctx.organizationId,
            tenantId: ctx.tenantId,
            id: { $in: emailIds },
            deletedAt: null,
          })
        : []
      const emailById = new Map(emails.map((row) => [row.id, row]))
      const emailFor = (reply: GtmReply) =>
        reply.emailMessageId ? emailById.get(reply.emailMessageId) ?? null : null

      const { replyMatchesQuery, inboundSummary } = await import('../../../lib/replies/search')
      if (query) {
        replies = replies.filter((reply) =>
          replyMatchesQuery(reply, enrollmentById.get(reply.enrollmentId), emailFor(reply), query),
        )
      }

      return NextResponse.json({
        ok: true,
        replies: replies.map((reply) => {
          const enrollment = enrollmentById.get(reply.enrollmentId)
          return {
            ...replyShape(reply),
            inbound: inboundSummary(reply, emailFor(reply)),
            enrollment: enrollment
              ? {
                  id: enrollment.id,
                  campaign_id: enrollment.campaignId,
                  candidate_id: enrollment.candidateId,
                  contact_id: enrollment.contactId ?? null,
                  status: enrollment.status,
                  stop_reason: enrollment.stopReason ?? null,
                }
              : null,
          }
        }),
      })
    }

    if (body.op === 'thread') {
      if (!isUuid(body.replyId)) return opaqueNotFound()
      const { buildThread } = await import('../../../lib/replies/thread')
      const result = await buildThread(em, ctx, { replyId: body.replyId })
      return NextResponse.json({
        ok: true,
        reply: replyShape(result.reply),
        enrollment: {
          id: result.enrollment.id,
          campaign_id: result.enrollment.campaignId,
          candidate_id: result.enrollment.candidateId,
          contact_id: result.enrollment.contactId ?? null,
          status: result.enrollment.status,
          stop_reason: result.enrollment.stopReason ?? null,
        },
        messages: result.messages,
      })
    }

    if (body.op === 'classify') {
      if (!isUuid(body.replyId)) return opaqueNotFound()
      const { classifyReply } = await import('../../../lib/replies/classify')
      const result = await classifyReply(em, ctx, {
        replyId: body.replyId,
        classification: body.classification,
      })
      return NextResponse.json({
        ok: true,
        reply: replyShape(result.reply),
        suppressed: result.suppressed,
      })
    }

    if (body.op === 'record-social-reply') {
      if (!isUuid(body.enrollmentId) || !isUuid(body.stepId)) return opaqueNotFound()
      const { recordSocialReply } = await import('../../../lib/replies/correlate')
      const result = await recordSocialReply(em, ctx, {
        enrollmentId: body.enrollmentId,
        stepId: body.stepId,
        note: body.note ?? null,
      })
      return NextResponse.json({
        ok: true,
        reply: replyShape(result.reply),
        already_recorded: result.alreadyRecorded,
      })
    }

    if (body.op === 'draft-response') {
      if (!isUuid(body.replyId)) return opaqueNotFound()
      const { draftResponse } = await import('../../../lib/replies/classify')
      const reply = await draftResponse(em, ctx, {
        replyId: body.replyId,
        draft: { subject: body.draft.subject ?? null, body: body.draft.body },
      })
      return NextResponse.json({ ok: true, reply: replyShape(reply) })
    }

    if (body.op === 'draft-response-ai') {
      if (!isUuid(body.replyId)) return opaqueNotFound()
      // Grounded reply drafting through the existing CRM AI usage path; the
      // library returns an honest template fallback when there is no locked
      // voice or the model call/parse fails (never a hard failure).
      const { checkCustomersAiAllowance } = await import('@/lib/usage/allowance')
      const { meterCustomersAi } = await import('@/lib/usage/meter')
      const gate = await checkCustomersAiAllowance({ orgId: ctx.organizationId })
      if (!gate.allowed) {
        return NextResponse.json({ ok: false, error: gate.message, code: 'ai_allowance' }, { status: 402 })
      }
      const apiKey = gate.byoApiKey || process.env.GOOGLE_GENERATIVE_AI_API_KEY
      if (!apiKey) {
        return NextResponse.json({ ok: false, error: 'AI is not configured', code: 'ai_unconfigured' }, { status: 400 })
      }
      const { createGeminiDraftModel } = await import('../../../lib/ai/model')
      const { draftReplyWithAi } = await import('../../../lib/replies/ai-reply')
      const model = createGeminiDraftModel(apiKey)
      const canonicalMeter = async (usage: {
        model: string
        tokensIn: number
        tokensOut: number
        tokenUsageKnown?: boolean
        feature: string
        status?: 'succeeded' | 'failed'
        failureCode?: string | null
        retryCount?: number
      }) => {
        await meterCustomersAi({ orgId: ctx.organizationId }, {
          model: usage.model,
          tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut,
          feature: usage.feature,
          byoKey: !!gate.byoApiKey,
          idempotencyKey: body.idempotency_key
            ? `gtm:reply-draft:${ctx.organizationId}:${body.replyId}:${body.idempotency_key}`
            : null,
          metadata: {
            status: usage.status === 'failed' ? 'failed' : 'completed',
            attempt: 1,
            token_usage_known: usage.tokenUsageKnown !== false,
            failure_code: usage.failureCode ?? null,
            retry_count: usage.retryCount ?? 0,
          },
        })
      }
      const { createGtmTelemetryMeter } = await import('../../../lib/ai/telemetry')
      const meter = createGtmTelemetryMeter({
        em,
        ctx,
        surface: 'reply_draft',
        operationKey: body.idempotency_key
          ? `gtm:reply-draft:${ctx.organizationId}:${body.replyId}:${body.idempotency_key}`
          : `gtm:reply-draft:${ctx.organizationId}:${body.replyId}:${crypto.randomUUID()}`,
        canonicalMeter,
      })
      const result = await draftReplyWithAi(em, ctx, { model, meter }, {
        replyId: body.replyId,
        idempotencyKey: body.idempotency_key ?? null,
      })
      return NextResponse.json({
        ok: true,
        reply: replyShape(result.reply),
        provenance: result.provenance,
        reason: result.provenance === 'ai' ? null : result.reason,
      })
    }

    // approve-draft: approve AND send the reply as a durable one-off attempt
    // through the full send machine (dry-run when execution is disabled).
    if (!isUuid(body.replyId)) return opaqueNotFound()
    const executionEnabled = process.env.GTM_EXECUTION_ENABLED === 'true'
    const { approveAndSendReply } = await import('../../../lib/replies/send')
    let transport
    if (executionEnabled) {
      const { smtpTransport } = await import('../../../lib/execute/transport')
      transport = smtpTransport
    }
    const result = await approveAndSendReply(em, ctx, { replyId: body.replyId }, { executionEnabled, transport })
    return NextResponse.json({
      ok: true,
      reply: replyShape(result.reply),
      dry_run: result.dryRun,
      already_sent: result.alreadySent,
      outcome: result.outcome,
      attempt_id: result.attempt?.id ?? null,
    })
  } catch (err) {
    if (err instanceof GtmExecutionError) {
      if (
        err.code === 'reply_not_found' ||
        err.code === 'enrollment_not_found' ||
        err.code === 'step_not_found'
      ) {
        return opaqueNotFound()
      }
      return NextResponse.json({ ok: false, error: err.message, code: err.code }, { status: 422 })
    }
    console.error('[internal.gtm.inbox]', err)
    return NextResponse.json({ ok: false, error: 'Inbox operation failed' }, { status: 500 })
  }
}
