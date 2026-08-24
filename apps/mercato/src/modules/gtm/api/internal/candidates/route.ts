import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { gtmInternalOpenApi } from '../../openapi'

export const openApi = gtmInternalOpenApi('List scoped GTM candidates and evidence')
import type { EntityManager } from '@mikro-orm/postgresql'
import { gtmEnabled } from '../../../lib/flags'
import { gtmCandidatesBodySchema } from '../../../data/validators'
import { isUuid } from '../../../lib/play-shape'
import type { GtmCandidate, GtmCandidateMatch } from '../../../data/entities'

/*
 * Internal GTM candidates (SPEC-066 sections 5 and 14 Tranche 3).
 *
 * The Noli hub calls this server-to-server - proven by the shared
 * NOLI_INTERNAL_SERVICE_SECRET - to list sourced candidates and record
 * manual review overrides. Identity is re-resolved at this boundary
 * (noliUserId -> Clerk -> Mercato auth context, gated on the 'crm'
 * entitlement); the caller's claims about org/tenant ownership are never
 * trusted and every query self-scopes by organization_id + tenant_id.
 *
 * Ops (body.op, default 'list'):
 * - 'list'   filtered by runId and/or workspaceId and/or fitStatus, capped at
 *            100 rows, ordered fit_score desc. Each row also carries
 *            has_verified_email, exact best email_verification_state,
 *            email_contact_count, and evidence_count, computed via two grouped
 *            queries over the page's candidate ids (lib/listing.ts; never one
 *            query per candidate)
 * - 'review' manual verdict override for one candidate; the change writes a
 *            gtm_audit_events row in the same transaction
 * - 'export' explicit, audited reviewed-lead export: latest play-contextual
 *            accepted people only, verified + unsuppressed email only, and
 *            explicit evidence-export permission (lib/candidate-export.ts)
 *
 * Public at the dispatcher level (requireAuth: false) - we authenticate with
 * the shared secret instead of a Clerk/JWT session, mirroring
 * internal/import-audience-play.
 */
export const metadata = {
  path: '/internal/gtm/candidates',
  POST: { requireAuth: false },
}

const LIST_CAP = 100

function opaqueNotFound() {
  return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
}

function shapeCandidate(candidate: GtmCandidate, match?: GtmCandidateMatch | null) {
  return {
    id: candidate.id,
    match_id: match?.id ?? null,
    researchRunId: match?.researchRunId ?? candidate.researchRunId,
    play_id: match?.playId ?? null,
    workspaceId: candidate.workspaceId,
    entity_kind: candidate.entityKind,
    identity: candidate.identity,
    dedupe_key: candidate.dedupeKey,
    fit_status: match?.fitStatus ?? candidate.fitStatus,
    fit_score: (match?.fitScore ?? candidate.fitScore) != null
      ? Number(match?.fitScore ?? candidate.fitScore)
      : null,
    reject_reason: match ? match.rejectReason ?? null : candidate.rejectReason ?? null,
    quality_status: match ? match.qualityStatus ?? null : candidate.qualityStatus ?? null,
    quality_score: (match?.qualityScore ?? candidate.qualityScore) != null
      ? Number(match?.qualityScore ?? candidate.qualityScore)
      : null,
    qualification: match ? match.qualification ?? null : candidate.qualification ?? null,
    qualification_version: match ? match.qualificationVersion ?? null : candidate.qualificationVersion ?? null,
    promoted_contact_id: candidate.promotedContactId ?? null,
    retention_expires_at: candidate.retentionExpiresAt ?? null,
    created_at: candidate.createdAt,
    matched_at: match?.createdAt ?? null,
  }
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
  const parsed = gtmCandidatesBodySchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const where = first?.path?.length ? `${first.path.join('.')}: ` : ''
    return NextResponse.json({ ok: false, error: `${where}${first?.message ?? 'Invalid body'}` }, { status: 400 })
  }
  const body = parsed.data

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
    const { candidateFeatureForOp, hasGtmFeature } = await import('../../../lib/authorize')
    if (!(await hasGtmFeature(container, { organizationId, tenantId, userId }, candidateFeatureForOp(body.op)))) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })
    }
    const em = container.resolve('em') as EntityManager
    const { GtmCandidate, GtmCandidateMatch } = await import('../../../data/entities')

    if (body.op === 'review') {
      if (!body.candidateId || !body.verdict) {
        return NextResponse.json(
          { ok: false, error: 'review requires candidateId and verdict' },
          { status: 400 },
        )
      }
      // Opaque 404 for malformed, missing, foreign, or soft-deleted rows.
      if (!isUuid(body.candidateId)) return opaqueNotFound()
      const candidate = await em.findOne(GtmCandidate, {
        id: body.candidateId,
        organizationId,
        tenantId,
        deletedAt: null,
      })
      if (!candidate) return opaqueNotFound()

      const { reviewCandidate, reviewCandidateMatch } = await import('../../../lib/research/review')
      if (body.matchId) {
        if (!isUuid(body.matchId)) return opaqueNotFound()
        const match = await em.findOne(GtmCandidateMatch, {
          id: body.matchId,
          candidateId: candidate.id,
          organizationId,
          tenantId,
          deletedAt: null,
        })
        if (!match) return opaqueNotFound()
        const result = await reviewCandidateMatch({
          em: em as unknown as import('../../../lib/research/execute').ResearchEm,
          candidate,
          match,
          verdict: body.verdict,
          reason: body.reason ?? null,
          userId,
          requestId: req.headers.get('x-request-id'),
        })
        return NextResponse.json({
          ok: true,
          candidate: shapeCandidate(result.candidate, result.match),
        })
      }
      const result = await reviewCandidate({
        em: em as unknown as import('../../../lib/research/execute').ResearchEm,
        candidate,
        verdict: body.verdict,
        reason: body.reason ?? null,
        userId,
        requestId: req.headers.get('x-request-id'),
      })

      return NextResponse.json({ ok: true, candidate: shapeCandidate(result.candidate) })
    }

    if (body.op === 'detail') {
      // Full provenance for one person: every evidence row and contact point.
      // This is the customer's own sourced data, and it is what answers a
      // data-subject request without an investigation.
      if (!body.candidateId || !isUuid(body.candidateId)) return opaqueNotFound()
      const candidate = await em.findOne(GtmCandidate, {
        id: body.candidateId,
        organizationId,
        tenantId,
        deletedAt: null,
      })
      if (!candidate) return opaqueNotFound()

      const match = body.matchId
        ? isUuid(body.matchId)
          ? await em.findOne(GtmCandidateMatch, {
              id: body.matchId,
              candidateId: candidate.id,
              organizationId,
              tenantId,
              deletedAt: null,
            })
          : null
        : null
      if (body.matchId && !match) return opaqueNotFound()

      const { GtmEvidence, GtmContactPoint } = await import('../../../data/entities')
      const scope = { organizationId, tenantId, candidateId: candidate.id, deletedAt: null }
      const [evidence, contactPoints] = await Promise.all([
        em.find(
          GtmEvidence,
          match ? { ...scope, researchRunId: match.researchRunId } : scope,
          { orderBy: { observedAt: 'desc' }, limit: LIST_CAP },
        ),
        em.find(GtmContactPoint, scope, { orderBy: { createdAt: 'desc' }, limit: LIST_CAP }),
      ])

      return NextResponse.json({
        ok: true,
        candidate: shapeCandidate(candidate, match),
        evidence: evidence.map((row) => ({
          id: row.id,
          claim: row.claim,
          source_url: row.sourceUrl ?? null,
          provider_ref: row.providerRef ?? null,
          observed_at: row.observedAt?.toISOString() ?? null,
          confidence: row.confidence ?? null,
          license: row.license ?? null,
          retrieved_at: row.retrievedAt?.toISOString() ?? null,
          quality_status: row.qualityStatus ?? null,
          quality_issues: row.qualityIssues ?? null,
          evidence_type: row.evidenceType ?? null,
        })),
        contact_points: contactPoints.map((point) => ({
          id: point.id,
          channel: point.channel,
          value: point.value,
          verification_state: point.verificationState,
          provider_operation_id: point.providerOperationId ?? null,
          provenance: point.provenance ?? null,
        })),
        cap: LIST_CAP,
      })
    }

    if (body.op === 'export') {
      if (
        !body.workspaceId ||
        !body.playId ||
        !body.idempotency_key ||
        !isUuid(body.workspaceId) ||
        !isUuid(body.playId)
      ) return opaqueNotFound()
      const exportLib = await import('../../../lib/candidate-export')
      try {
        const result = await exportLib.buildReviewedLeadExport(
          em as unknown as import('../../../lib/campaign/build').CampaignEm,
          { organizationId, tenantId, userId, requestId: req.headers.get('x-request-id') },
          { workspaceId: body.workspaceId, playId: body.playId },
        )
        await exportLib.auditReviewedLeadExport(
          em as unknown as import('../../../lib/campaign/build').CampaignEm,
          { organizationId, tenantId, userId, requestId: req.headers.get('x-request-id') },
          {
            workspaceId: body.workspaceId,
            playId: body.playId,
            idempotencyKey: body.idempotency_key,
            result,
          },
        )
        return NextResponse.json({
          ok: true,
          export: {
            schema_version: result.schema_version,
            considered: result.considered,
            exported: result.exported,
            skipped_by_reason: result.skipped_by_reason,
            truncated: result.truncated,
            rows: result.rows,
          },
        })
      } catch (err) {
        if (err instanceof exportLib.ReviewedLeadExportError) {
          if (err.code === 'scope_not_found') return opaqueNotFound()
          return NextResponse.json(
            { ok: false, error: err.message, code: err.code },
            { status: err.code === 'idempotency_conflict' ? 409 : 422 },
          )
        }
        throw err
      }
    }

    // list. Candidate identity is workspace-wide, while qualification is
    // contextual to a frozen play/run. Contextual lists therefore project the
    // latest match for each identity; legacy candidate fields remain the
    // fallback until old rows have been backfilled.
    if (body.runId != null && !isUuid(body.runId)) return opaqueNotFound()
    if (body.playId != null && !isUuid(body.playId)) return opaqueNotFound()
    if (body.workspaceId != null && !isUuid(body.workspaceId)) return opaqueNotFound()

    let rows: { candidate: GtmCandidate; match: GtmCandidateMatch | null }[] = []
    let total = 0
    let accepted = 0
    let review = 0
    let rejected = 0
    let unscored = 0
    let qualification = {
      scored: 0,
      accepted: 0,
      review: 0,
      rejected: 0,
      unscored: 0,
      qualification_rate: 0,
      by_reason: {} as Record<string, number>,
    }

    if (body.runId || body.playId) {
      const matchWhere: Record<string, unknown> = { organizationId, tenantId, deletedAt: null }
      if (body.runId) matchWhere.researchRunId = body.runId
      if (body.playId) matchWhere.playId = body.playId
      if (body.workspaceId) matchWhere.workspaceId = body.workspaceId
      const allMatches = await em.find(GtmCandidateMatch, matchWhere, {
        orderBy: { createdAt: 'desc' },
        limit: 1000,
      })
      const latestMatches: GtmCandidateMatch[] = []
      const seen = new Set<string>()
      for (const match of allMatches) {
        if (seen.has(match.candidateId)) continue
        seen.add(match.candidateId)
        latestMatches.push(match)
      }
      total = latestMatches.length
      accepted = latestMatches.filter((row) => row.fitStatus === 'accepted').length
      review = latestMatches.filter((row) => row.fitStatus === 'review').length
      rejected = latestMatches.filter((row) => row.fitStatus === 'rejected').length
      unscored = latestMatches.filter((row) => row.fitStatus === 'unscored').length
      const { qualificationDiagnostics } = await import('../../../lib/candidate-export')
      qualification = qualificationDiagnostics(latestMatches)
      const filteredMatches = body.fitStatus
        ? latestMatches.filter((row) => row.fitStatus === body.fitStatus)
        : latestMatches
      const candidateIds = filteredMatches.map((row) => row.candidateId)
      const candidates = candidateIds.length
        ? await em.find(GtmCandidate, {
            organizationId,
            tenantId,
            id: { $in: candidateIds },
            deletedAt: null,
          })
        : []
      const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]))
      rows = filteredMatches
        .map((match) => ({ candidate: byId.get(match.candidateId), match }))
        .filter((row): row is { candidate: GtmCandidate; match: GtmCandidateMatch } => Boolean(row.candidate))
        .sort((a, b) => Number(b.match.fitScore ?? 0) - Number(a.match.fitScore ?? 0))
        .slice(0, LIST_CAP)
    } else {
      const where: Record<string, unknown> = { organizationId, tenantId, deletedAt: null }
      if (body.workspaceId) where.workspaceId = body.workspaceId
      const summaryWhere = { ...where }
      if (body.fitStatus) where.fitStatus = body.fitStatus
      const [candidates, countTotal, countAccepted, countReview, countRejected, countUnscored] = await Promise.all([
        em.find(GtmCandidate, where, {
          orderBy: { fitScore: 'desc', createdAt: 'desc' },
          limit: LIST_CAP,
        }),
        em.count(GtmCandidate, summaryWhere),
        em.count(GtmCandidate, { ...summaryWhere, fitStatus: 'accepted' }),
        em.count(GtmCandidate, { ...summaryWhere, fitStatus: 'review' }),
        em.count(GtmCandidate, { ...summaryWhere, fitStatus: 'rejected' }),
        em.count(GtmCandidate, { ...summaryWhere, fitStatus: 'unscored' }),
      ])
      rows = candidates.map((candidate) => ({ candidate, match: null }))
      total = countTotal
      accepted = countAccepted
      review = countReview
      rejected = countRejected
      unscored = countUnscored
      const scored = accepted + review + rejected
      qualification = {
        scored,
        accepted,
        review,
        rejected,
        unscored,
        qualification_rate: scored > 0 ? accepted / scored : 0,
        // Reason diagnostics are intentionally contextual. A workspace-wide
        // view can combine incompatible play criteria, so it returns no
        // invented aggregate reason story.
        by_reason: {},
      }
    }

    // Additive per-row rollup: verified-email presence + evidence count, one
    // grouped query per table over this page's candidate ids (no N+1).
    const { candidateEnrichment } = await import('../../../lib/listing')
    const rollup = await candidateEnrichment(
      em as unknown as import('../../../lib/listing').ListEm,
      { organizationId, tenantId },
      rows.map((row) => row.candidate.id),
      {
        researchRunByCandidate: new Map(
          rows
            .filter((row): row is { candidate: GtmCandidate; match: GtmCandidateMatch } => Boolean(row.match))
            .map((row) => [row.candidate.id, row.match.researchRunId]),
        ),
      },
    )

    return NextResponse.json({
      ok: true,
      candidates: rows.map(({ candidate, match }) => {
        const extra = rollup.get(candidate.id)
        return {
          ...shapeCandidate(candidate, match),
          has_verified_email: extra?.hasVerifiedEmail ?? false,
          email_verification_state: extra?.emailVerificationState ?? null,
          email_contact_count: extra?.emailContactCount ?? 0,
          evidence_count: extra?.evidenceCount ?? 0,
          // Provenance (privacy policy 3.2): where this record came from and
          // when it was observed. Derived from the evidence rows already
          // fetched above, so it adds no queries.
          sources: extra?.sources ?? [],
          sources_extra: extra?.sourcesExtra ?? 0,
          first_observed_at: extra?.firstObservedAt?.toISOString() ?? null,
          last_observed_at: extra?.lastObservedAt?.toISOString() ?? null,
          confidence: extra?.confidence ?? null,
        }
      }),
      summary: {
        total,
        by_fit_status: { accepted, review, rejected, unscored },
        qualification,
      },
      cap: LIST_CAP,
    })
  } catch (err) {
    console.error('[internal.gtm.candidates]', err)
    return NextResponse.json({ ok: false, error: 'Candidates operation failed' }, { status: 500 })
  }
}
