import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { internalServiceBearerAuthorized } from '../../../lib/authorize'
import type { EntityManager } from '@mikro-orm/postgresql'
import { GtmAiMeteringError } from '../../../lib/ai/telemetry'
import { gtmInternalOpenApi } from '../../openapi'
import { gtmEnabled } from '../../../lib/flags'
import { gtmPostRepliesBodySchema } from '../../../data/validators'
import { isUuid } from '../../../lib/play-shape'
import type { PostReplyEm } from '../../../lib/post-replies'

export const openApi = gtmInternalOpenApi('Draft replies to public post leads; post owner-approved replies on Threads')

export const metadata = {
  path: '/internal/gtm/post-replies',
  POST: { requireAuth: false },
}

function opaqueNotFound() {
  return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
}

const READ_OPS = new Set(['list'])

export async function POST(req: Request) {
  if (!gtmEnabled()) return opaqueNotFound()
  if (!internalServiceBearerAuthorized(req)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const raw = await req.json().catch(() => ({})) as Record<string, unknown>
  const parsed = gtmPostRepliesBodySchema.safeParse({
    ...raw,
    ...(req.headers.get('idempotency-key') ? { idempotency_key: req.headers.get('idempotency-key') } : {}),
  })
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const where = first?.path?.length ? `${first.path.join('.')}: ` : ''
    return NextResponse.json({ ok: false, error: `${where}${first?.message ?? 'Invalid body'}` }, { status: 400 })
  }
  const body = parsed.data

  try {
    const { findNoliUserById } = await import('@open-mercato/shared/lib/noli/core-client')
    const noliUser = await findNoliUserById(body.noliUserId)
    if (!noliUser?.clerk_user_id) return NextResponse.json({ ok: false, error: 'Noli user not found' }, { status: 404 })
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
    const { hasGtmFeature } = await import('../../../lib/authorize')
    // Posting speaks for the owner in public, so it needs launch rights; drafting needs edit.
    const feature = READ_OPS.has(body.op) ? 'gtm.view' : body.op === 'post' ? 'gtm.launch' : 'gtm.edit'
    if (!(await hasGtmFeature(container, ctx, feature))) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })
    }
    const rawEm = container.resolve('em') as EntityManager
    const em = rawEm as unknown as PostReplyEm
    const replies = await import('../../../lib/post-replies')
    const { threadsRepliesEnabled } = await import('../../../lib/adapters/threads/connection')

    if (body.op === 'list') {
      if (!isUuid(body.workspaceId) || (body.playId && !isUuid(body.playId))) return opaqueNotFound()
      await replies.reconcileStalePostingReplies(em, ctx)
      const rows = await replies.listPostReplies(em, ctx, { workspaceId: body.workspaceId, playId: body.playId ?? null })
      return NextResponse.json({ ok: true, replies: rows, posting_available: threadsRepliesEnabled(), daily_cap: replies.POST_REPLY_DAILY_CAP })
    }

    if (body.op === 'edit') {
      if (!isUuid(body.replyId)) return opaqueNotFound()
      return NextResponse.json({ ok: true, reply: await replies.editPostReply(em, ctx, { replyId: body.replyId, bodyText: body.bodyText }) })
    }

    if (body.op === 'mark') {
      if (!isUuid(body.replyId)) return opaqueNotFound()
      return NextResponse.json({ ok: true, reply: await replies.markPostReplyCopied(em, ctx, { replyId: body.replyId }) })
    }

    if (body.op === 'dismiss') {
      if (!isUuid(body.replyId)) return opaqueNotFound()
      return NextResponse.json({ ok: true, reply: await replies.dismissPostReply(em, ctx, { replyId: body.replyId }) })
    }

    if (body.op === 'post') {
      if (!isUuid(body.replyId)) return opaqueNotFound()
      const { resolveSourceAdapterContext } = await import('../../../lib/adapters/context')
      const adapterContext = await resolveSourceAdapterContext(
        container,
        rawEm,
        { organizationId: ctx.organizationId, tenantId: ctx.tenantId },
      )
      const reply = await replies.postThreadsReply(em, ctx, { replyId: body.replyId, bodyText: body.bodyText ?? null }, {
        connection: adapterContext.threadsConnection ?? null,
      })
      return NextResponse.json({ ok: true, reply })
    }

    // op === 'draft'
    if (!isUuid(body.workspaceId) || !isUuid(body.playId) || !isUuid(body.candidateId)) return opaqueNotFound()
    const context = await replies.preparePostReply(em, ctx, {
      workspaceId: body.workspaceId,
      playId: body.playId,
      candidateId: body.candidateId,
    })
    if (context.existing && context.existing.status !== 'dismissed') {
      return NextResponse.json({ ok: true, reply: await replies.storePostReply(em, ctx, context, { bodyText: context.existing.bodyText, model: context.existing.model ?? 'unknown' }), replayed: true })
    }

    const { checkCustomersAiAllowance } = await import('@/lib/usage/allowance')
    const { meterCustomersAiStrict } = await import('@/lib/usage/meter')
    const gate = await checkCustomersAiAllowance({ orgId: ctx.organizationId }, 'google', { failureMode: 'closed' })
    if (!gate.allowed) {
      const code = gate.code ?? 'ai_allowance'
      return NextResponse.json({ ok: false, error: gate.message, code }, { status: code === 'ai_metering_unavailable' ? 503 : 402 })
    }
    const apiKey = gate.byoApiKey || process.env.GOOGLE_GENERATIVE_AI_API_KEY
    if (!apiKey) return NextResponse.json({ ok: false, error: 'AI is not configured', code: 'ai_unconfigured' }, { status: 400 })
    // One key per drafting pass. A stored draft is replayed above without a
    // model call, so reaching this point always means fresh model calls; a
    // retry after draft_failed with the same idempotency_key used to reuse
    // the key and its calls were dropped as duplicates by the canonical meter
    // (2026-09-25 review, H4).
    const operationKey = `gtm:post-reply:${ctx.organizationId}:${body.idempotency_key}:pass:${randomUUID()}`
    const canonicalMeter = async (usage: {
      model: string
      tokensIn: number
      tokensOut: number
      tokenUsageKnown?: boolean
      feature: string
      status?: 'succeeded' | 'failed'
      failureCode?: string | null
      retryCount?: number
    }, invocationKey: string) => {
      await meterCustomersAiStrict({ orgId: ctx.organizationId }, {
        noliUserId: body.noliUserId,
        model: usage.model,
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
        feature: usage.feature,
        byoKey: !!gate.byoApiKey,
        idempotencyKey: invocationKey,
        metadata: {
          status: usage.status === 'failed' ? 'failed' : 'completed',
          attempt: 1,
          token_usage_known: usage.tokenUsageKnown !== false,
          failure_code: usage.failureCode ?? null,
          retry_count: usage.retryCount ?? 0,
          surface: 'post_reply',
        },
      })
    }
    const { createGeminiDraftModel } = await import('../../../lib/ai/model')
    const { createGtmTelemetryMeter } = await import('../../../lib/ai/telemetry')
    const drafted = await replies.draftPostReply({
      model: createGeminiDraftModel(apiKey),
      meter: createGtmTelemetryMeter({ em: rawEm as never, ctx, surface: 'post_reply_draft', operationKey, canonicalMeter }),
    }, context)
    return NextResponse.json({ ok: true, reply: await replies.storePostReply(em, ctx, context, drafted) })
  } catch (error) {
    const replies = await import('../../../lib/post-replies')
    if (error instanceof GtmAiMeteringError) {
      return NextResponse.json(
        { ok: false, error: 'AI usage is temporarily unavailable. Please try again shortly.', code: 'ai_metering_unavailable' },
        { status: 503 },
      )
    }
    if (error instanceof replies.GtmPostReplyError) {
      if (error.code === 'scope_not_found') return opaqueNotFound()
      return NextResponse.json({ ok: false, error: error.message, code: error.code }, { status: 422 })
    }
    console.error('[internal.gtm.post-replies]', error)
    return NextResponse.json({ ok: false, error: 'Threads reply operation failed' }, { status: 500 })
  }
}
