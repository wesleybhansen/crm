import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { gtmInternalOpenApi } from '../../openapi'

export const openApi = gtmInternalOpenApi('Plan and execute gated GTM enrichment')
import type { EntityManager } from '@mikro-orm/postgresql'
import { gtmEnabled } from '../../../lib/flags'
import { gtmEnrichBodySchema } from '../../../data/validators'
import { isUuid } from '../../../lib/play-shape'
import type { GtmCandidate } from '../../../data/entities'

/*
 * Internal GTM enrichment + verification (SPEC-066 sections 4, 5, 11.2, 14
 * Tranche 4).
 *
 * The Noli hub calls this server-to-server - proven by the shared
 * NOLI_INTERNAL_SERVICE_SECRET - to enrich accepted candidates with email
 * contact points and verify them. Identity is re-resolved at this boundary
 * (noliUserId -> Clerk -> Mercato auth context, gated on the 'crm'
 * entitlement); the caller's claims about org/tenant ownership are never
 * trusted and every query self-scopes by organization_id + tenant_id.
 *
 * Ops (body.op):
 * - 'plan'   returns an immutable maximum-credit quote without spending.
 * - 'run'    executes the enrichment waterfall over ACCEPTED candidates of a
 *            research run or a workspace (exactly one of runId | workspaceId).
 *            Optional maxCredits caps this run's spend BEFORE each reserve.
 *            Idempotent per candidate: already-verified candidates are
 *            skipped, and the `enrich:{candidateId}:{adapter_id}` /
 *            `verify:{contactPointId}:{adapter_id}` idempotency keys make a
 *            re-run reuse (not re-reserve) earlier operations.
 * - 'status' returns the contact-point verification-state distribution for
 *            the same scope.
 *
 * The ledger is selected via getLedger(): fixture credits are test-only by
 * default, and non-test environments require canonical noli-core credits.
 * Adapters are independently gated; production never registers fixtures.
 *
 * Public at the dispatcher level (requireAuth: false) - we authenticate with
 * the shared secret instead of a Clerk/JWT session, mirroring
 * internal/import-audience-play.
 */
export const metadata = {
  path: '/internal/gtm/enrich',
  POST: { requireAuth: false },
}

// One call processes at most this many accepted candidates (budget still
// bounds spend; re-running continues where the idempotency keys left off).
const CANDIDATE_CAP = 100

function opaqueNotFound() {
  return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
}

export async function POST(req: Request) {
  // 0. Feature gate: the GTM Engineer ships dark; flag-off fails closed.
  if (!gtmEnabled()) {
    return opaqueNotFound()
  }

  // 1. Shared-secret auth (length-guarded constant-time compare)
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

  // 2. Body
  const raw = await req.json().catch(() => ({}))
  const parsed = gtmEnrichBodySchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const where = first?.path?.length ? `${first.path.join('.')}: ` : ''
    return NextResponse.json({ ok: false, error: `${where}${first?.message ?? 'Invalid body'}` }, { status: 400 })
  }
  const body = parsed.data
  if (!body.runId && !body.workspaceId) {
    return NextResponse.json(
      { ok: false, error: 'runId or workspaceId is required' },
      { status: 400 },
    )
  }

  try {
    // 3. noli-core user -> Clerk id
    const { findNoliUserById } = await import('@open-mercato/shared/lib/noli/core-client')
    const noliUser = await findNoliUserById(body.noliUserId)
    if (!noliUser?.clerk_user_id) {
      return NextResponse.json({ ok: false, error: 'Noli user not found' }, { status: 404 })
    }

    // 4. Resolve to a Mercato auth context (provisions on first contact and
    //    gates on the 'crm' entitlement - same path a Clerk session takes).
    const { resolveClerkUserToAuthContext } = await import('@open-mercato/shared/lib/auth/clerk')
    const auth = await resolveClerkUserToAuthContext(noliUser.clerk_user_id)
    if (!auth || !auth.userId || !auth.orgId || !auth.tenantId) {
      return NextResponse.json({ ok: false, error: 'User has no CRM access' }, { status: 403 })
    }
    const organizationId = auth.orgId as string
    const tenantId = auth.tenantId as string
    const userId = auth.userId as string

    const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
    const container = await createRequestContainer()
    const { enrichmentFeatureForOp, hasGtmFeature } = await import('../../../lib/authorize')
    if (!(await hasGtmFeature(container, { organizationId, tenantId, userId }, enrichmentFeatureForOp(body.op)))) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })
    }
    const em = container.resolve('em') as EntityManager
    const entities = await import('../../../data/entities')
    const { GtmResearchRun, GtmCandidate, GtmContactPoint, GtmAuditEvent } = entities

    // 5. Resolve the scope: exactly one of runId | workspaceId, self-scoped.
    //    Opaque 404 for malformed, missing, foreign, or soft-deleted rows.
    const candidateWhere: Record<string, unknown> = {
      organizationId,
      tenantId,
      deletedAt: null,
    }
    let runId: string | null = null
    if (body.runId) {
      if (!isUuid(body.runId)) return opaqueNotFound()
      const run = await em.findOne(GtmResearchRun, {
        id: body.runId,
        organizationId,
        tenantId,
        deletedAt: null,
      })
      if (!run) return opaqueNotFound()
      runId = run.id
      candidateWhere.researchRunId = run.id
    } else if (body.workspaceId) {
      if (!isUuid(body.workspaceId)) return opaqueNotFound()
      candidateWhere.workspaceId = body.workspaceId
    }

    // Spec 4.1 step 6: enrichment considers accepted candidates only.
    const candidates: GtmCandidate[] = await em.find(
      GtmCandidate,
      { ...candidateWhere, fitStatus: 'accepted' },
      { orderBy: { fitScore: 'desc', createdAt: 'asc' }, limit: CANDIDATE_CAP },
    )
    const candidateIds = candidates.map((candidate) => candidate.id)
    const contactPoints = candidateIds.length
      ? await em.find(GtmContactPoint, {
          organizationId,
          tenantId,
          candidateId: { $in: candidateIds },
          deletedAt: null,
        })
      : []

    if (body.op === 'status') {
      const distribution: Record<string, number> = {
        found: 0,
        verified: 0,
        risky: 0,
        catch_all: 0,
        not_found: 0,
        unknown: 0,
        provider_ambiguous: 0,
      }
      for (const point of contactPoints) {
        distribution[point.verificationState] = (distribution[point.verificationState] ?? 0) + 1
      }
      return NextResponse.json({
        ok: true,
        counts: {
          acceptedCandidates: candidates.length,
          contactPoints: contactPoints.length,
          byVerificationState: distribution,
        },
      })
    }

    const { enrichAdapterList, verifyAdapterList } = await import('../../../lib/adapters/registry')
    const enrichAdapters = enrichAdapterList()
    const verifyAdapters = verifyAdapterList()
    const { buildEnrichmentPlan } = await import('../../../lib/enrich/plan')
    const plan = buildEnrichmentPlan(candidates, contactPoints, enrichAdapters, verifyAdapters)
    if (body.op === 'plan') {
      return NextResponse.json({ ok: true, plan })
    }

    if (body.expectedPlanHash !== plan.plan_hash) {
      return NextResponse.json(
        {
          ok: false,
          error: 'The enrichment quote changed; review the refreshed plan before continuing',
          code: 'plan_changed',
          plan,
        },
        { status: 409 },
      )
    }
    if (plan.providers.length === 0 || plan.maximum_credits <= 0) {
      return NextResponse.json(
        { ok: false, error: 'No approved enrichment and verification provider is available' },
        { status: 422 },
      )
    }

    // op === 'run'
    const { runEnrichmentWaterfall } = await import('../../../lib/enrich/waterfall')
    const { getLedger } = await import('../../../lib/credits/noli-core-ledger')

    const summary = await runEnrichmentWaterfall({
      em: em as unknown as import('../../../lib/research/execute').ResearchEm,
      ledger: getLedger(),
      enrichAdapters,
      verifyAdapters,
      candidates,
      contactPoints,
      userId,
      runId,
      maxCredits: Math.min(body.maxCredits ?? plan.maximum_credits, plan.maximum_credits),
    })

    await em.transactional(async (tem) => {
      const audit = tem.create(GtmAuditEvent, {
        organizationId,
        tenantId,
        actor: 'user_id',
        actorUserId: userId,
        action: 'gtm.enrichment.executed',
        objectType: runId ? 'gtm_research_run' : 'gtm_workspace',
        objectId: runId ?? body.workspaceId ?? null,
        requestId: req.headers.get('x-request-id') || null,
        metadata: {
          enriched: summary.enriched,
          verified: summary.verified,
          risky: summary.risky,
          catch_all: summary.catch_all,
          not_found: summary.not_found,
          unknown: summary.unknown,
          ambiguous: summary.ambiguous,
          credits: summary.credits,
          stopped: summary.stopped,
        },
      })
      tem.persist(audit)
      await tem.flush()
    })

    return NextResponse.json({ ok: true, summary })
  } catch (err) {
    console.error('[internal.gtm.enrich]', err)
    return NextResponse.json({ ok: false, error: 'Enrichment operation failed' }, { status: 500 })
  }
}
