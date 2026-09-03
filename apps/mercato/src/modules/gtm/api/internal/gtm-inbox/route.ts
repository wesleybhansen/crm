import { NextResponse } from 'next/server'
import { internalServiceBearerAuthorized } from '../../../lib/authorize'
import { gtmInternalOpenApi } from '../../openapi'

export const openApi = gtmInternalOpenApi('Manage the scoped GTM reply inbox')
import type { EntityManager } from '@mikro-orm/postgresql'
import { GtmAiMeteringError } from '../../../lib/ai/telemetry'
import { gtmEnabled } from '../../../lib/flags'
import { gtmInboxBodySchema } from '../../../data/validators'
import { isUuid } from '../../../lib/play-shape'
import { GtmExecutionError, type ExecutionEm } from '../../../lib/execute/schedule'
import type { ListEm } from '../../../lib/listing'
import { canonicalHash } from '../../../lib/campaign/approve'
import type { GtmReply } from '../../../data/entities'
import { EmailConnection, EmailMessage } from '../../../../email/data/schema'
import { escapeLikePattern } from '@open-mercato/shared/lib/db/escapeLikePattern'

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
 *                         and is fully idempotent. Requires expected_draft_hash
 *                         to equal the stored draft_content_hash (409 otherwise)
 *                         so a draft rewritten after review can never ship.
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

const LIST_CAP = 100

// sha256 over exactly the draft content that approve-draft would send
// (subject + body), independent of drafting metadata such as timestamps.
export function draftContentHash(reply: Pick<GtmReply, 'draftResponse'>): string | null {
  const draft = (reply.draftResponse ?? null) as Record<string, unknown> | null
  if (!draft || typeof draft.body !== 'string' || !draft.body.trim()) return null
  return canonicalHash({
    subject: typeof draft.subject === 'string' ? draft.subject : null,
    body: draft.body,
  })
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
    // Echoed back by approve-draft as expected_draft_hash.
    draft_content_hash: draftContentHash(reply),
    created_at: reply.createdAt ?? null,
  }
}

export async function POST(req: Request) {
  if (!gtmEnabled()) {
    return opaqueNotFound()
  }

  // Byte-length guarded constant-time compare (lib/authorize.ts).
  if (!internalServiceBearerAuthorized(req)) {
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
      const listEm = em as unknown as ListEm
      // Filter, search, order, and cap are all pushed into the database: the
      // previous in-memory version loaded every reply in the org on each poll.
      const where: Record<string, unknown> = {
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        deletedAt: null,
      }
      if (filter === 'unread') where.classification = null
      if (filter === 'interested') where.classification = 'interested'
      if (query) {
        // Counterparty match (from / subject / body) resolves to a bounded set
        // of linked inbound message ids, org+tenant scoped; the reply side
        // matches its own enum fields. Pattern escaped for ILIKE.
        const pattern = `%${escapeLikePattern(query)}%`
        const matchedEmails = await listEm.find(
          EmailMessage,
          {
            organizationId: ctx.organizationId,
            tenantId: ctx.tenantId,
            deletedAt: null,
            $or: [
              { fromAddress: { $ilike: pattern } },
              { subject: { $ilike: pattern } },
              { bodyText: { $ilike: pattern } },
            ],
          },
          { orderBy: { createdAt: 'desc' }, limit: 500 },
        )
        where.$or = [
          { emailMessageId: { $in: matchedEmails.map((row) => row.id) } },
          { channel: { $ilike: pattern } },
          { classification: { $ilike: pattern } },
          { draftStatus: { $ilike: pattern } },
        ]
      }
      const replies = await listEm.find(entities.GtmReply, where, {
        orderBy: { createdAt: 'desc' },
        limit: LIST_CAP,
      })
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

      const { inboundSummary } = await import('../../../lib/replies/search')

      return NextResponse.json({
        ok: true,
        cap: LIST_CAP,
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
      const { meterCustomersAiStrict } = await import('@/lib/usage/meter')
      const gate = await checkCustomersAiAllowance(
        { orgId: ctx.organizationId },
        'google',
        { failureMode: 'closed' },
      )
      if (!gate.allowed) {
        const code = gate.code ?? 'ai_allowance'
        return NextResponse.json({ ok: false, error: gate.message, code }, { status: code === 'ai_metering_unavailable' ? 503 : 402 })
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
      }, operationKey: string) => {
        await meterCustomersAiStrict({ orgId: ctx.organizationId }, {
          noliUserId: body.noliUserId,
          model: usage.model,
          tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut,
          feature: usage.feature,
          byoKey: !!gate.byoApiKey,
          idempotencyKey: operationKey,
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
        // idempotency_key is required by the validator; no random fallback
        // (a relaxed schema must never turn a retry into a second metered
        // AI call).
        operationKey: `gtm:reply-draft:${ctx.organizationId}:${body.replyId}:${body.idempotency_key}`,
        canonicalMeter,
      })
      const result = await draftReplyWithAi(em, ctx, { model, meter }, {
        replyId: body.replyId,
        idempotencyKey: body.idempotency_key,
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
    const stored = await em.findOne(entities.GtmReply, {
      id: body.replyId,
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      deletedAt: null,
    })
    if (!stored) return opaqueNotFound()
    // The reviewer approves exactly the draft they saw: a stale or missing
    // hash is a conflict, never a send.
    const currentHash = draftContentHash(stored)
    if (!currentHash || currentHash !== body.expected_draft_hash) {
      return NextResponse.json(
        {
          ok: false,
          error: 'The draft changed since it was reviewed; reload the reply and approve again',
          code: 'stale_draft',
        },
        { status: 409 },
      )
    }
    const executionEnabled = process.env.GTM_EXECUTION_ENABLED === 'true'
    const { approveAndSendReply } = await import('../../../lib/replies/send')
    let transport
    if (executionEnabled) {
      // The mailbox transport routes gmail/microsoft connections through OAuth
      // exactly like the campaign tick (execution/route.ts). The SMTP-only
      // transport threw for every OAuth mailbox, and because the reply
      // idempotency key is fixed, that failure was permanent.
      const { createPersistingMailboxTransport } = await import('../../../lib/execute/transport')
      transport = createPersistingMailboxTransport(
        em as unknown as Parameters<typeof createPersistingMailboxTransport>[0],
        EmailConnection,
      )
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
    if (err instanceof GtmAiMeteringError) {
      return NextResponse.json(
        { ok: false, error: 'AI usage is temporarily unavailable. Please try again shortly.', code: 'ai_metering_unavailable' },
        { status: 503 },
      )
    }
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
