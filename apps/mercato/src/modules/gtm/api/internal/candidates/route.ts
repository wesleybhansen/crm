import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { gtmInternalOpenApi } from '../../openapi'

export const openApi = gtmInternalOpenApi('List scoped GTM candidates and evidence')
import type { EntityManager } from '@mikro-orm/postgresql'
import { gtmEnabled } from '../../../lib/flags'
import { gtmCandidatesBodySchema } from '../../../data/validators'
import { isUuid } from '../../../lib/play-shape'
import type { GtmCandidate } from '../../../data/entities'

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
 *            has_verified_email (a verified email contact point exists) and
 *            evidence_count, computed via two grouped queries over the page's
 *            candidate ids (lib/listing.ts; never one query per candidate)
 * - 'review' manual verdict override for one candidate; the change writes a
 *            gtm_audit_events row in the same transaction
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

function shapeCandidate(candidate: GtmCandidate) {
  return {
    id: candidate.id,
    researchRunId: candidate.researchRunId,
    workspaceId: candidate.workspaceId,
    entity_kind: candidate.entityKind,
    identity: candidate.identity,
    dedupe_key: candidate.dedupeKey,
    fit_status: candidate.fitStatus,
    fit_score: candidate.fitScore != null ? Number(candidate.fitScore) : null,
    reject_reason: candidate.rejectReason ?? null,
    quality_status: candidate.qualityStatus ?? null,
    quality_score: candidate.qualityScore != null ? Number(candidate.qualityScore) : null,
    qualification: candidate.qualification ?? null,
    qualification_version: candidate.qualificationVersion ?? null,
    promoted_contact_id: candidate.promotedContactId ?? null,
    retention_expires_at: candidate.retentionExpiresAt ?? null,
    created_at: candidate.createdAt,
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
    const { GtmCandidate } = await import('../../../data/entities')

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

      const { reviewCandidate } = await import('../../../lib/research/review')
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

      const { GtmEvidence, GtmContactPoint } = await import('../../../data/entities')
      const scope = { organizationId, tenantId, candidateId: candidate.id, deletedAt: null }
      const [evidence, contactPoints] = await Promise.all([
        em.find(GtmEvidence, scope, { orderBy: { observedAt: 'desc' }, limit: LIST_CAP }),
        em.find(GtmContactPoint, scope, { orderBy: { createdAt: 'desc' }, limit: LIST_CAP }),
      ])

      return NextResponse.json({
        ok: true,
        candidate: shapeCandidate(candidate),
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

    // list
    const where: Record<string, unknown> = { organizationId, tenantId, deletedAt: null }
    if (body.runId != null) {
      if (!isUuid(body.runId)) return opaqueNotFound()
      where.researchRunId = body.runId
    }
    if (body.workspaceId != null) {
      if (!isUuid(body.workspaceId)) return opaqueNotFound()
      where.workspaceId = body.workspaceId
    }
    const summaryWhere = { ...where }
    if (body.fitStatus) {
      where.fitStatus = body.fitStatus
    }

    const [candidates, total, accepted, review, rejected, unscored] = await Promise.all([
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

    // Additive per-row rollup: verified-email presence + evidence count, one
    // grouped query per table over this page's candidate ids (no N+1).
    const { candidateEnrichment } = await import('../../../lib/listing')
    const rollup = await candidateEnrichment(
      em as unknown as import('../../../lib/listing').ListEm,
      { organizationId, tenantId },
      candidates.map((candidate) => candidate.id),
    )

    return NextResponse.json({
      ok: true,
      candidates: candidates.map((candidate) => {
        const extra = rollup.get(candidate.id)
        return {
          ...shapeCandidate(candidate),
          has_verified_email: extra?.hasVerifiedEmail ?? false,
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
      },
      cap: LIST_CAP,
    })
  } catch (err) {
    console.error('[internal.gtm.candidates]', err)
    return NextResponse.json({ ok: false, error: 'Candidates operation failed' }, { status: 500 })
  }
}
