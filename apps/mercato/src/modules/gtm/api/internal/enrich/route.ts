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
  // 0. Operational kill switch: customer release is live; flag-off fails closed.
  if (!gtmEnabled()) {
    return opaqueNotFound()
  }

  // 1. Shared-secret auth (length-guarded constant-time compare)
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
    const { findNoliUserById, findPrimaryOrgIdForUser } = await import(
      '@open-mercato/shared/lib/noli/core-client'
    )
    const noliUser = await findNoliUserById(body.noliUserId)
    if (!noliUser?.clerk_user_id) {
      return NextResponse.json({ ok: false, error: 'Noli user not found' }, { status: 404 })
    }
    let noliOrgId = await findPrimaryOrgIdForUser(noliUser.id)
    if (!noliOrgId) {
      return NextResponse.json(
        { ok: false, error: 'Noli organization is not available' },
        { status: 503 },
      )
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
    // Billing organisation: the Mercato org carries the noli-core org it was
    // provisioned from. When that link exists it is the billing org, and the
    // represented user must actually be a member of it; the "earliest
    // membership" helper alone can drift for multi-org Noli users.
    const { Organization } = await import('@open-mercato/core/modules/directory/data/entities')
    const mercatoOrg = await em.findOne(Organization, { id: organizationId, deletedAt: null })
    const linkedNoliOrgId = mercatoOrg?.noliOrgId ?? null
    if (linkedNoliOrgId) {
      if (linkedNoliOrgId !== noliOrgId) {
        const { hasNoliOrgMembership } = await import('@open-mercato/shared/lib/noli/core-client')
        if (!(await hasNoliOrgMembership(noliUser.id, linkedNoliOrgId))) {
          return NextResponse.json(
            { ok: false, error: 'User is not a member of the billing organization' },
            { status: 403 },
          )
        }
        noliOrgId = linkedNoliOrgId
      }
    }
    // TODO(billing-org): an Organization without a noli_org_id link falls back
    // to the user's earliest noli-core membership; backfill the link for every
    // provisioned org so this fallback can be removed.
    const entities = await import('../../../data/entities')
    const {
      GtmPlay,
      GtmResearchRun,
      GtmCandidate,
      GtmCandidateMatch,
      GtmCandidateRelation,
      GtmContactPoint,
      GtmProviderOperation,
      GtmAuditEvent,
    } = entities

    // 5. Resolve the scope: exactly one of runId | workspaceId, self-scoped.
    //    Opaque 404 for malformed, missing, foreign, or soft-deleted rows.
    const candidateWhere: Record<string, unknown> = {
      organizationId,
      tenantId,
      deletedAt: null,
    }
    let runId: string | null = null
    let scopedPlay: import('../../../data/entities').GtmPlay | null = null
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
      scopedPlay = await em.findOne(GtmPlay, {
        id: run.playId,
        organizationId,
        tenantId,
        deletedAt: null,
      })
      if (!scopedPlay) return opaqueNotFound()
    } else if (body.workspaceId) {
      if (!isUuid(body.workspaceId)) return opaqueNotFound()
      candidateWhere.workspaceId = body.workspaceId
    }
    if (body.playId) {
      if (!isUuid(body.playId)) return opaqueNotFound()
      const play = await em.findOne(GtmPlay, {
        id: body.playId,
        organizationId,
        tenantId,
        ...(body.workspaceId ? { workspaceId: body.workspaceId } : {}),
        deletedAt: null,
      })
      if (!play) return opaqueNotFound()
      if (scopedPlay && scopedPlay.id !== play.id) return opaqueNotFound()
      scopedPlay = play
    }
    if (body.op !== 'status') {
      if (!scopedPlay) {
        return NextResponse.json(
          {
            ok: false,
            error: 'Choose one play before planning email enrichment',
            code: 'play_scope_required',
          },
          { status: 422 },
        )
      }
      const { computeGtmPolicy, policyInputFromPlay } = await import('../../../lib/policy')
      const policy = computeGtmPolicy(policyInputFromPlay(scopedPlay))
      if (policy.outreach_mode !== 'automated_email') {
        return NextResponse.json(
          {
            ok: false,
            error: 'Email enrichment is unavailable for manual-only outreach',
            code: 'manual_outreach_only',
          },
          { status: 422 },
        )
      }
    }

    // Spec 4.1 step 6: enrichment considers candidates accepted in the
    // selected frozen run, or accepted by the latest match of any workspace
    // play. Candidate-level verdicts are only the legacy fallback.
    const matchWhere: Record<string, unknown> = { organizationId, tenantId, deletedAt: null }
    if (runId) matchWhere.researchRunId = runId
    else if (body.workspaceId) matchWhere.workspaceId = body.workspaceId
    if (body.playId) matchWhere.playId = body.playId
    const matches = await em.find(GtmCandidateMatch, matchWhere, {
      orderBy: { createdAt: 'desc' },
      limit: 5000,
    })
    const latestByContext = new Map<string, typeof matches[number]>()
    for (const match of matches) {
      const contextKey = runId ? match.candidateId : `${match.playId}:${match.candidateId}`
      if (!latestByContext.has(contextKey)) latestByContext.set(contextKey, match)
    }
    const acceptedCandidateIds = new Set(
      [...latestByContext.values()]
        .filter((match) => match.fitStatus === 'accepted')
        .map((match) => match.candidateId),
    )
    const contextualScopeRequested = Boolean(runId || body.playId)
    const candidates: GtmCandidate[] = matches.length > 0
      ? acceptedCandidateIds.size > 0
        ? await em.find(
            GtmCandidate,
            { organizationId, tenantId, id: { $in: [...acceptedCandidateIds] }, deletedAt: null },
            { orderBy: { createdAt: 'asc' }, limit: CANDIDATE_CAP },
          )
        : []
      : contextualScopeRequested
        ? []
        : await em.find(
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
    let enrichmentCandidates = candidates
    const { APIFY_WEBSITE_EMAIL_ADAPTER_ID } = await import(
      '../../../lib/adapters/apify/website-email'
    )
    if (
      candidateIds.length > 0
      && enrichAdapters.some((adapter) => adapter.descriptor.adapter_id === APIFY_WEBSITE_EMAIL_ADAPTER_ID)
    ) {
      const relations = await em.find(GtmCandidateRelation, {
        organizationId,
        tenantId,
        childCandidateId: { $in: candidateIds },
        relationshipKind: 'current_employee',
        ...(runId ? { researchRunId: runId } : {}),
        ...(body.playId ? { playId: body.playId } : {}),
        deletedAt: null,
      }, { limit: 501 })
      // An incomplete relation set could hide a conflicting parent domain.
      // In that case derive nothing and spend nothing through this adapter.
      const completeRelations = relations.length <= 500 ? relations : []
      const parentIds = [...new Set(completeRelations.map((relation) => relation.parentCandidateId))]
      const parentCandidates = parentIds.length > 0
        ? await em.find(GtmCandidate, {
            organizationId,
            tenantId,
            id: { $in: parentIds },
            entityKind: 'company',
            deletedAt: null,
          }, { limit: 500 })
        : []
      const { inheritUnambiguousCompanyDomains } = await import(
        '../../../lib/enrich/company-domain'
      )
      enrichmentCandidates = inheritUnambiguousCompanyDomains(
        candidates,
        completeRelations,
        parentCandidates,
      )
    }
    const { buildEnrichmentPlan } = await import('../../../lib/enrich/plan')
    const existingEnrichmentOperations = candidateIds.length
      ? await em.find(GtmProviderOperation, {
          organizationId,
          tenantId,
          candidateId: { $in: candidateIds },
          kind: 'contact_enrich',
          deletedAt: null,
        }, { orderBy: { createdAt: 'desc' }, limit: 1000 })
      : []
    const plan = buildEnrichmentPlan(
      enrichmentCandidates,
      contactPoints,
      enrichAdapters,
      verifyAdapters,
      undefined,
      existingEnrichmentOperations,
    )
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
      candidates: enrichmentCandidates,
      acceptedCandidateIds: matches.length > 0 ? acceptedCandidateIds : undefined,
      contactPoints,
      // The same prior operations the plan quoted by: a candidate whose
      // earlier lookup still needs reconciliation is parked, not re-bought.
      existingEnrichmentOperations: existingEnrichmentOperations,
      noliOrgId,
      // Canonical provider metering is keyed to the represented Noli user.
      noliUserId: body.noliUserId,
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
