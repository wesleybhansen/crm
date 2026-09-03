import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { gtmInternalOpenApi } from '../../openapi'

export const openApi = gtmInternalOpenApi('Manage scoped GTM strategy and voice')
import type { EntityManager } from '@mikro-orm/postgresql'
import { gtmEnabled } from '../../../lib/flags'
import { gtmStrategyBodySchema } from '../../../data/validators'
import { isUuid } from '../../../lib/play-shape'
import { GtmVersionError, versionShape, type VersionKind } from '../../../lib/versions'
import { GtmDraftError } from '../../../lib/campaign/ai-draft'
import { GtmAiMeteringError } from '../../../lib/ai/telemetry'

/*
 * Internal GTM strategy: ICP + Voice Profile version CRUD, locks, revert, and
 * AI voice derivation (SPEC-066 sections 4, 4.3, 5).
 *
 * Same server-to-server contract as the other internal GTM routes: the Noli
 * hub calls this with the shared NOLI_INTERNAL_SERVICE_SECRET, identity is
 * re-resolved (noliUserId -> Clerk -> Mercato auth context, gated on the 'crm'
 * entitlement), and every query self-scopes by organization_id + tenant_id.
 *
 * Ops (body.op):
 *   icp-list / voice-list       version history (newest first)
 *   icp-get / voice-get         one version
 *   icp-create / voice-create   next immutable version (edit = new version)
 *   icp-lock / voice-lock       lock/unlock a version
 *   icp-revert / voice-revert   NEW version copying an older one's content
 *   voice-derive                metered AI draft Voice Profile from sources
 *
 * Public at the dispatcher level (requireAuth: false): authentication is the
 * shared secret, mirroring internal/gtm/campaigns.
 */
export const metadata = {
  path: '/internal/gtm/strategy',
  POST: { requireAuth: false },
}

function opaqueNotFound() {
  return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
}

function kindOf(op: string): VersionKind {
  return op.startsWith('voice') ? 'voice' : 'icp'
}

export async function POST(req: Request) {
  // 0. Feature gate: fail closed when the GTM Engineer flag is off.
  if (!gtmEnabled()) return opaqueNotFound()

  // 1. Shared-secret auth (length-guarded constant-time compare).
  // Both sides are compared as BYTES: a multibyte header of the same UTF-16
  // length would otherwise make timingSafeEqual throw (an unauthenticated
  // 500) instead of denying.
  const secret = process.env.NOLI_INTERNAL_SERVICE_SECRET
  const authHeader = Buffer.from((req.headers.get('authorization') || '').trim(), 'utf8')
  const expected = Buffer.from(secret ? `Bearer ${secret}` : '', 'utf8')
  if (
    !secret ||
    authHeader.length !== expected.length ||
    !crypto.timingSafeEqual(authHeader, expected)
  ) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  // 2. Body.
  const raw = await req.json().catch(() => ({}))
  const parsed = gtmStrategyBodySchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const where = first?.path?.length ? `${first.path.join('.')}: ` : ''
    return NextResponse.json({ ok: false, error: `${where}${first?.message ?? 'Invalid body'}` }, { status: 400 })
  }
  const body = parsed.data

  try {
    // 3. noli-core user -> Clerk id.
    const { findNoliUserById } = await import('@open-mercato/shared/lib/noli/core-client')
    const noliUser = await findNoliUserById(body.noliUserId)
    if (!noliUser?.clerk_user_id) {
      return NextResponse.json({ ok: false, error: 'Noli user not found' }, { status: 404 })
    }

    // 4. Resolve to a Mercato auth context (gates on the 'crm' entitlement).
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
    const { hasGtmFeature, strategyFeatureForOp } = await import('../../../lib/authorize')
    if (!(await hasGtmFeature(container, ctx, strategyFeatureForOp(body.op)))) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })
    }
    const em = container.resolve('em') as EntityManager as unknown as import('../../../lib/campaign/build').CampaignEm

    // Malformed workspace id -> opaque 404 (same as a missing/foreign row).
    if (!isUuid(body.workspaceId)) return opaqueNotFound()

    const versions = await import('../../../lib/versions')

    if (body.op === 'icp-list' || body.op === 'voice-list') {
      const kind = kindOf(body.op)
      const rows = await versions.listVersions(em, ctx, kind, body.workspaceId)
      return NextResponse.json({ ok: true, versions: rows.map((row) => versionShape(kind, row)) })
    }

    if (body.op === 'icp-get' || body.op === 'voice-get') {
      if (!isUuid(body.versionId)) return opaqueNotFound()
      const kind = kindOf(body.op)
      const row = await versions.getVersion(em, ctx, kind, body.workspaceId, body.versionId)
      return NextResponse.json({ ok: true, version: versionShape(kind, row) })
    }

    if (body.op === 'icp-create' || body.op === 'voice-create') {
      const kind = kindOf(body.op)
      const row = await versions.createVersion(em, ctx, kind, {
        workspaceId: body.workspaceId,
        content: body.content,
        author: body.author,
        provenance: body.provenance,
        derivedFrom: body.op === 'voice-create' ? body.derivedFrom ?? null : undefined,
      })
      return NextResponse.json({ ok: true, version: versionShape(kind, row) })
    }

    if (body.op === 'icp-lock' || body.op === 'voice-lock') {
      if (!isUuid(body.versionId)) return opaqueNotFound()
      const kind = kindOf(body.op)
      const row = await versions.setVersionLock(em, ctx, kind, {
        workspaceId: body.workspaceId,
        versionId: body.versionId,
        locked: body.locked,
      })
      return NextResponse.json({ ok: true, version: versionShape(kind, row) })
    }

    if (body.op === 'icp-revert' || body.op === 'voice-revert') {
      if (!isUuid(body.sourceVersionId)) return opaqueNotFound()
      const kind = kindOf(body.op)
      const row = await versions.revertVersion(em, ctx, kind, {
        workspaceId: body.workspaceId,
        sourceVersionId: body.sourceVersionId,
        author: body.author,
      })
      return NextResponse.json({ ok: true, version: versionShape(kind, row) })
    }

    // voice-derive: metered AI draft through the existing CRM AI usage path.
    const website = body.sources.website ?? null
    const samples = (body.sources.samples ?? []).filter((s) => s && s.trim())
    if (!website && samples.length === 0) {
      return NextResponse.json(
        { ok: false, error: 'Provide a website or at least one writing sample to derive a voice from', code: 'no_sources' },
        { status: 400 },
      )
    }

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
    const { deriveVoiceDraft } = await import('../../../lib/voice-derive')
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
    // The idempotency key is what makes a retry a no-op instead of a second
    // metered model call; without one the request fails closed rather than
    // minting a fresh random key per attempt.
    const idempotencyKey = typeof body.idempotency_key === 'string' ? body.idempotency_key.trim() : ''
    if (!idempotencyKey) {
      return NextResponse.json(
        { ok: false, error: 'idempotency_key is required for voice-derive', code: 'idempotency_key_required' },
        { status: 400 },
      )
    }
    const { createGtmTelemetryMeter } = await import('../../../lib/ai/telemetry')
    const meter = createGtmTelemetryMeter({
      em,
      ctx,
      surface: 'voice_derive',
      operationKey: `gtm:voice-derive:${ctx.organizationId}:${body.workspaceId}:${idempotencyKey}`,
      canonicalMeter,
    })

    const version = await deriveVoiceDraft(em, ctx, { model, meter }, {
      workspaceId: body.workspaceId,
      sources: { website, samples },
      idempotencyKey,
    })
    return NextResponse.json({ ok: true, version: versionShape('voice', version) })
  } catch (err) {
    if (err instanceof GtmVersionError) {
      if (err.code === 'workspace_not_found' || err.code === 'version_not_found') return opaqueNotFound()
      const status = err.code === 'locked_rejects_agent' ? 409 : 422
      return NextResponse.json({ ok: false, error: err.message, code: err.code }, { status })
    }
    if (err instanceof GtmDraftError) {
      return NextResponse.json({ ok: false, error: err.message, code: err.code }, { status: 502 })
    }
    if (err instanceof GtmAiMeteringError) {
      return NextResponse.json(
        { ok: false, error: 'AI usage is temporarily unavailable. Please try again shortly.', code: 'ai_metering_unavailable' },
        { status: 503 },
      )
    }
    console.error('[internal.gtm.strategy]', err)
    return NextResponse.json({ ok: false, error: 'Strategy operation failed' }, { status: 500 })
  }
}
