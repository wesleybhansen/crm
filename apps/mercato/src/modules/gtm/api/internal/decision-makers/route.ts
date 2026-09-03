import crypto from 'crypto'
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { gtmInternalOpenApi } from '../../openapi'
import { gtmDecisionMakersBodySchema } from '../../../data/validators'
import { linkedInCompanyIdsFromEvidence } from '../../../lib/adapters/apify/company-employees'
import { gtmEnabled } from '../../../lib/flags'
import { isUuid } from '../../../lib/play-shape'
import { normalizeCompanyWebsite } from '../../../lib/enrich/company-domain'

export const openApi = gtmInternalOpenApi(
  'Plan, execute, and inspect accepted-company decision-maker resolution',
)

export const metadata = {
  path: '/internal/gtm/decision-makers',
  POST: { requireAuth: false },
}

function opaqueNotFound() {
  return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
}

function linkedInCompanyUrl(identity: Record<string, unknown>): string | null {
  const values = Array.isArray(identity.urls) ? identity.urls : []
  for (const value of values) {
    if (typeof value !== 'string') continue
    try {
      const url = new URL(value)
      if (!/^(?:www\.)?linkedin\.com$/i.test(url.hostname)) continue
      if (!url.pathname.toLowerCase().startsWith('/company/')) continue
      return url.toString()
    } catch {
      continue
    }
  }
  return null
}

export async function POST(req: Request) {
  if (!gtmEnabled()) return opaqueNotFound()

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

  const raw = await req.json().catch(() => ({}))
  const parsed = gtmDecisionMakersBodySchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const where = first?.path?.length ? `${first.path.join('.')}: ` : ''
    return NextResponse.json(
      { ok: false, error: `${where}${first?.message ?? 'Invalid body'}` },
      { status: 400 },
    )
  }
  const body = parsed.data
  if (!isUuid(body.runId)) return opaqueNotFound()

  try {
    const { findNoliUserById, findPrimaryOrgIdForUser } = await import(
      '@open-mercato/shared/lib/noli/core-client'
    )
    const noliUser = await findNoliUserById(body.noliUserId)
    if (!noliUser?.clerk_user_id) {
      return NextResponse.json({ ok: false, error: 'Noli user not found' }, { status: 404 })
    }
    const { resolveClerkUserToAuthContext } = await import('@open-mercato/shared/lib/auth/clerk')
    const auth = await resolveClerkUserToAuthContext(noliUser.clerk_user_id)
    if (!auth?.userId || !auth.orgId || !auth.tenantId) {
      return NextResponse.json({ ok: false, error: 'User has no CRM access' }, { status: 403 })
    }
    const organizationId = auth.orgId as string
    const tenantId = auth.tenantId as string
    const userId = auth.userId as string

    const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
    const container = await createRequestContainer()
    const { decisionMakerFeatureForOp, hasGtmFeature } = await import('../../../lib/authorize')
    if (!(await hasGtmFeature(
      container,
      { organizationId, tenantId, userId },
      decisionMakerFeatureForOp(body.op),
    ))) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })
    }
    const em = container.resolve('em') as EntityManager
    const {
      GtmAuditEvent,
      GtmCandidate,
      GtmCandidateMatch,
      GtmCandidateRelation,
      GtmEvidence,
      GtmPlay,
      GtmProviderOperation,
      GtmResearchRun,
    } = await import('../../../data/entities')
    const run = await em.findOne(GtmResearchRun, {
      id: body.runId,
      organizationId,
      tenantId,
      deletedAt: null,
    })
    if (!run) return opaqueNotFound()
    const play = await em.findOne(GtmPlay, {
      id: run.playId,
      organizationId,
      tenantId,
      workspaceId: run.workspaceId,
      deletedAt: null,
    })
    if (!play) return opaqueNotFound()
    if (body.op !== 'status') {
      // Same policy gate as the enrichment route: decision-maker resolution
      // feeds email enrichment, so a play that may not automate email may
      // not spend on resolving people to email either.
      const { computeGtmPolicy, policyInputFromPlay } = await import('../../../lib/policy')
      const policy = computeGtmPolicy(policyInputFromPlay(play))
      if (policy.outreach_mode !== 'automated_email') {
        return NextResponse.json(
          {
            ok: false,
            error: 'Decision-maker resolution is unavailable for manual-only outreach',
            code: 'manual_outreach_only',
          },
          { status: 422 },
        )
      }
    }

    const acceptedMatches = await em.find(GtmCandidateMatch, {
      organizationId,
      tenantId,
      researchRunId: run.id,
      playId: run.playId,
      fitStatus: 'accepted',
      deletedAt: null,
    }, { orderBy: { fitScore: 'desc', createdAt: 'desc', id: 'asc' }, limit: 100 })
    const candidateIds = acceptedMatches.map((match) => match.candidateId)
    const candidates = candidateIds.length > 0
      ? await em.find(GtmCandidate, {
          organizationId,
          tenantId,
          workspaceId: run.workspaceId,
          id: { $in: candidateIds },
          entityKind: 'company',
          deletedAt: null,
        }, { limit: 100 })
      : []
    const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]))
    const baseCompanies = acceptedMatches.flatMap((match, selectionRank) => {
      const candidate = candidateById.get(match.candidateId)
      if (!candidate) return []
      const linkedinUrl = linkedInCompanyUrl(candidate.identity)
      const name = typeof candidate.identity.name === 'string'
        ? candidate.identity.name.trim()
        : ''
      if (!linkedinUrl || !name) return []
      return [{
        candidate_id: candidate.id,
        match_id: match.id,
        name,
        linkedin_url: linkedinUrl,
        domain: normalizeCompanyWebsite(candidate.identity.domain)?.companyDomain ?? null,
        selection_rank: selectionRank,
      }]
    })
    const operations = await em.find(GtmProviderOperation, {
      organizationId,
      tenantId,
      researchRunId: run.id,
      kind: 'decision_maker_resolution',
    }, { orderBy: { requestedAt: 'desc' }, limit: 500 })
    const {
      buildDecisionMakerPlan,
      decisionMakerAttemptForCompany,
      hasUnresolvedDecisionMakerOperations,
      processedDecisionMakerCompanyIds,
    } = await import('../../../lib/decision-makers/plan')
    const processedCompanyIds = processedDecisionMakerCompanyIds(operations)
    const unresolvedOperationCount = operations.filter((operation) => (
      operation.localStatusMirror === 'reconciliation_required'
      || operation.localStatusMirror === 'provider_started'
    )).length

    if (body.op === 'status') {
      const relations = await em.find(GtmCandidateRelation, {
        organizationId,
        tenantId,
        researchRunId: run.id,
        deletedAt: null,
      }, { orderBy: { createdAt: 'desc' }, limit: 500 })
      const childIds = [...new Set(relations.map((relation) => relation.childCandidateId))]
      const matches = childIds.length > 0
        ? await em.find(GtmCandidateMatch, {
            organizationId,
            tenantId,
            researchRunId: run.id,
            candidateId: { $in: childIds },
            deletedAt: null,
          }, { limit: 500 })
        : []
      const eligibleCompanyIds = new Set(baseCompanies.map((company) => company.candidate_id))
      const processedCompanyCount = [...processedCompanyIds]
        .filter((candidateId) => eligibleCompanyIds.has(candidateId)).length
      return NextResponse.json({
        ok: true,
        status: {
          companies_with_people: new Set(relations.map((relation) => relation.parentCandidateId)).size,
          people: childIds.length,
          accepted: matches.filter((match) => match.fitStatus === 'accepted').length,
          review: matches.filter((match) => match.fitStatus === 'review').length,
          rejected: matches.filter((match) => match.fitStatus === 'rejected').length,
          eligible_companies: eligibleCompanyIds.size,
          processed_companies: processedCompanyCount,
          remaining_companies: Math.max(0, eligibleCompanyIds.size - processedCompanyCount),
          operations: operations.length,
          reconciliation_required: unresolvedOperationCount,
          latest_operation_status: operations[0]?.localStatusMirror ?? null,
        },
      })
    }

    if (run.status !== 'completed') {
      return NextResponse.json(
        { ok: false, error: 'Decision-maker resolution requires a completed research run' },
        { status: 409 },
      )
    }
    if (hasUnresolvedDecisionMakerOperations(operations)) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Reconcile the previous provider result before checking another company',
          code: 'reconciliation_required',
        },
        { status: 409 },
      )
    }

    const selectedCompanyCandidateId = [...baseCompanies]
      .filter((company) => !processedCompanyIds.has(company.candidate_id))
      .sort((left, right) => (
        left.selection_rank - right.selection_rank
        || left.candidate_id.localeCompare(right.candidate_id)
      ))[0]?.candidate_id
    const evidenceRows = selectedCompanyCandidateId
      ? await em.find(GtmEvidence, {
          organizationId,
          tenantId,
          researchRunId: run.id,
          candidateId: selectedCompanyCandidateId,
          deletedAt: null,
        }, { orderBy: { createdAt: 'desc' }, limit: 50 })
      : []
    const companies = baseCompanies.map((company) => ({
      ...company,
      linkedin_company_ids: company.candidate_id === selectedCompanyCandidateId
        ? linkedInCompanyIdsFromEvidence(evidenceRows)
        : [],
    }))
    const attempt = decisionMakerAttemptForCompany(operations, selectedCompanyCandidateId ?? null)

    const { decisionMakerAdapter } = await import('../../../lib/adapters/registry')
    const selectedAdapter = decisionMakerAdapter()
    const adapter = selectedAdapter ?? (await import(
      '../../../lib/adapters/apify/company-employees'
    )).createApifyCompanyEmployeesAdapter()
    const plan = buildDecisionMakerPlan({
      run,
      play,
      companies,
      adapter,
      jobTitles: body.jobTitles,
      maxProfiles: body.maxProfiles,
      processedCompanyIds,
      attempt,
    })
    if (body.op === 'plan') return NextResponse.json({ ok: true, plan })

    if (body.expectedPlanHash !== plan.plan_hash) {
      return NextResponse.json(
        {
          ok: false,
          error: 'The decision-maker quote changed; review the refreshed plan before continuing',
          code: 'plan_changed',
          plan,
        },
        { status: 409 },
      )
    }
    if (!selectedAdapter || !plan.available || plan.maximum_credits <= 0) {
      return NextResponse.json(
        { ok: false, error: 'No approved decision-maker provider contract is available' },
        { status: 422 },
      )
    }
    if (body.maxCredits != null && body.maxCredits < plan.maximum_credits) {
      return NextResponse.json(
        {
          ok: false,
          error: 'The confirmed credit ceiling is lower than the current maximum quote',
          code: 'budget_too_low',
          plan,
        },
        { status: 409 },
      )
    }

    let noliOrgId = await findPrimaryOrgIdForUser(noliUser.id)
    if (!noliOrgId) {
      return NextResponse.json(
        { ok: false, error: 'Noli organization is not available' },
        { status: 503 },
      )
    }
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

    const { executeDecisionMakerPlan } = await import('../../../lib/decision-makers/execute')
    const { getLedger } = await import('../../../lib/credits/noli-core-ledger')
    const result = await executeDecisionMakerPlan({
      em: em as unknown as import('../../../lib/decision-makers/execute').DecisionMakerEm,
      ledger: getLedger(),
      adapter: selectedAdapter,
      run,
      plan,
      noliOrgId,
      noliUserId: body.noliUserId,
    })
    await em.transactional(async (tem) => {
      const audit = tem.create(GtmAuditEvent, {
        organizationId,
        tenantId,
        actor: 'user_id',
        actorUserId: userId,
        action: 'gtm.decision_makers.executed',
        objectType: 'gtm_research_run',
        objectId: run.id,
        requestId: req.headers.get('x-request-id') || null,
        metadata: {
          plan_hash: plan.plan_hash,
          company_count: plan.company_count,
          max_profiles: plan.max_profiles,
          operation_id: result.operation_id,
          outcome: result.outcome,
          charged_credits: result.charged_credits,
          people_created: result.people_created,
          people_reused: result.people_reused,
          relations_created: result.relations_created,
          accepted: result.accepted,
          review: result.review,
          rejected: result.rejected,
          reconciliation_required: result.reconciliation_required,
        },
      })
      tem.persist(audit)
      await tem.flush()
    })
    return NextResponse.json({ ok: true, result })
  } catch (error) {
    const { GtmCreditLedgerError } = await import('../../../lib/credits/ledger')
    if (error instanceof GtmCreditLedgerError && error.code === 'insufficient_credits') {
      return NextResponse.json(
        { ok: false, error: 'Insufficient credits for the confirmed decision-maker quote' },
        { status: 402 },
      )
    }
    console.error('[internal.gtm.decision-makers]', error)
    return NextResponse.json(
      { ok: false, error: 'Decision-maker operation failed' },
      { status: 500 },
    )
  }
}
