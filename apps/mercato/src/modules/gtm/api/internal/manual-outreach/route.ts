import crypto from 'crypto'
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { gtmInternalOpenApi } from '../../openapi'
import { gtmEnabled } from '../../../lib/flags'
import { gtmManualOutreachBodySchema } from '../../../data/validators'
import { isUuid } from '../../../lib/play-shape'
import type { CampaignEm } from '../../../lib/campaign/build'

export const openApi = gtmInternalOpenApi('Prepare and record manual-only consumer outreach')

export const metadata = {
  path: '/internal/gtm/manual-outreach',
  POST: { requireAuth: false },
}

function opaqueNotFound() {
  return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
}

export async function POST(req: Request) {
  if (!gtmEnabled()) return opaqueNotFound()

  const secret = process.env.NOLI_INTERNAL_SERVICE_SECRET
  const authHeader = (req.headers.get('authorization') || '').trim()
  const expected = secret ? `Bearer ${secret}` : ''
  if (
    !secret
    || authHeader.length !== expected.length
    || !crypto.timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))
  ) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const raw = await req.json().catch(() => ({})) as Record<string, unknown>
  const parsed = gtmManualOutreachBodySchema.safeParse({
    ...raw,
    ...(raw.op === 'create' ? { idempotency_key: req.headers.get('idempotency-key') ?? '' } : {}),
  })
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
    const { candidateFeatureForOp, hasGtmFeature } = await import('../../../lib/authorize')
    if (!(await hasGtmFeature(container, ctx, candidateFeatureForOp(body.op)))) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })
    }
    const em = container.resolve('em') as EntityManager as unknown as CampaignEm
    const manual = await import('../../../lib/manual-outreach')

    if (body.op === 'list') {
      if (
        !isUuid(body.workspaceId)
        || (body.playId && !isUuid(body.playId))
        || (body.candidateId && !isUuid(body.candidateId))
      ) return opaqueNotFound()
      const drafts = await manual.listManualOutreachDrafts(em, ctx, {
        workspaceId: body.workspaceId,
        playId: body.playId ?? null,
        candidateId: body.candidateId ?? null,
      })
      return NextResponse.json({ ok: true, drafts, cap: 100 })
    }

    if (body.op === 'mark') {
      if (!isUuid(body.draftId)) return opaqueNotFound()
      const draft = await manual.markManualOutreachDraft(em, ctx, {
        draftId: body.draftId,
        action: body.action,
      })
      return NextResponse.json({ ok: true, draft })
    }

    if (
      !isUuid(body.workspaceId)
      || !isUuid(body.playId)
      || !isUuid(body.candidateId)
      || !isUuid(body.matchId)
    ) return opaqueNotFound()

    const context = await manual.prepareManualOutreachDraft(em, ctx, {
      workspaceId: body.workspaceId,
      playId: body.playId,
      candidateId: body.candidateId,
      matchId: body.matchId,
      channel: body.channel,
      idempotencyKey: body.idempotency_key,
    })
    if (context.existing) {
      const result = await manual.storeManualOutreachDraft(em, ctx, context, {
        bodyText: context.existing.bodyText,
        model: context.existing.model ?? 'unknown',
        provenance: context.existing.provenance ?? {},
      })
      return NextResponse.json({ ok: true, ...result })
    }

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
    const operationKey = `gtm:manual-draft:${ctx.organizationId}:${body.idempotency_key}`
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
        idempotencyKey: operationKey,
        metadata: {
          status: usage.status === 'failed' ? 'failed' : 'completed',
          attempt: 1,
          token_usage_known: usage.tokenUsageKnown !== false,
          failure_code: usage.failureCode ?? null,
          retry_count: usage.retryCount ?? 0,
          outreach_mode: 'manual_only',
        },
      })
    }
    const { createGeminiDraftModel } = await import('../../../lib/ai/model')
    const { createGtmTelemetryMeter } = await import('../../../lib/ai/telemetry')
    const drafted = await manual.draftManualOutreachMessage({
      model: createGeminiDraftModel(apiKey),
      meter: createGtmTelemetryMeter({
        em,
        ctx,
        surface: 'manual_outreach_draft',
        operationKey,
        canonicalMeter,
      }),
    }, context)
    const result = await manual.storeManualOutreachDraft(em, ctx, context, drafted)
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    const manual = await import('../../../lib/manual-outreach')
    if (error instanceof manual.GtmManualOutreachError) {
      if (error.code === 'scope_not_found') return opaqueNotFound()
      return NextResponse.json({ ok: false, error: error.message, code: error.code }, { status: 422 })
    }
    console.error('[internal.gtm.manual-outreach]', error)
    return NextResponse.json({ ok: false, error: 'Manual outreach operation failed' }, { status: 500 })
  }
}
