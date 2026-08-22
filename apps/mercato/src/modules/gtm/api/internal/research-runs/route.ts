import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { gtmInternalOpenApi } from '../../openapi'

export const openApi = gtmInternalOpenApi('Plan and execute gated GTM research')
import type { EntityManager } from '@mikro-orm/postgresql'
import { gtmEnabled } from '../../../lib/flags'
import { gtmResearchRunsBodySchema } from '../../../data/validators'
import { isUuid } from '../../../lib/play-shape'
import { buildSourcePlan } from '../../../lib/research/plan'
import type { GtmResearchRun } from '../../../data/entities'
import type { GtmCreditLedger } from '../../../lib/credits/ledger'

/*
 * Internal GTM research runs (SPEC-066 sections 5, 11.2, 14 Tranche 3).
 *
 * The Noli hub calls this server-to-server - proven by the shared
 * NOLI_INTERNAL_SERVICE_SECRET - to price, create, execute, and inspect
 * sourcing runs. Identity is re-resolved at this boundary (noliUserId ->
 * Clerk -> Mercato auth context, gated on the 'crm' entitlement); the
 * caller's claims about org/tenant ownership are never trusted.
 *
 * Ops (body.op):
 * - 'list'    workspace-wide run history (optionally filtered by workspaceId
 *             and/or playId), org+tenant self-scoped, soft-deleted excluded,
 *             capped at 50, newest first (lib/listing.ts)
 * - 'plan'    prices a source plan for a play WITHOUT creating a run
 * - 'create'  persists a GtmResearchRun in status 'priced' with the frozen
 *             input snapshot, provider plan, limits, and estimated credits
 * - 'execute' runs the priced plan against the environment-gated adapter
 *             registry and canonical noli-core credit ledger. Idempotent: a
 *             non-'priced' run returns its current status; the
 *             priced->running claim is a conditional UPDATE so two
 *             concurrent executes cannot double-run.
 * - 'status'  returns the run plus candidate/operation counts
 *
 * Fail-closed: flag-off 404; a strategy_only play can never be priced,
 * created, or executed (section 7 ladder boundary 1, recomputed in
 * buildSourcePlan); insufficient credits fail the run before any
 * adapter call (execute.ts).
 *
 * Public at the dispatcher level (requireAuth: false) - we authenticate with
 * the shared secret instead of a Clerk/JWT session, mirroring
 * internal/import-audience-play.
 */
export const metadata = {
  path: '/internal/gtm/research-runs',
  POST: { requireAuth: false },
}

function opaqueNotFound() {
  return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
}

function shapeRun(run: GtmResearchRun) {
  const plan = (run.providerPlan ?? {}) as Record<string, unknown>
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    playId: run.playId,
    status: run.status,
    limits: run.limits ?? null,
    estimated_credits: run.estimatedCredits != null ? Number(run.estimatedCredits) : null,
    reconciled_credits: run.reconciledCredits != null ? Number(run.reconciledCredits) : null,
    started_at: run.startedAt ?? null,
    completed_at: run.completedAt ?? null,
    execution: (plan.execution as Record<string, unknown> | undefined) ?? null,
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
  const parsed = gtmResearchRunsBodySchema.safeParse(raw)
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
    const { hasGtmFeature, researchFeatureForOp } = await import('../../../lib/authorize')
    if (!(await hasGtmFeature(container, { organizationId, tenantId, userId }, researchFeatureForOp(body.op)))) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })
    }
    const em = container.resolve('em') as EntityManager
    const entities = await import('../../../data/entities')
    const { GtmPlay, GtmResearchRun, GtmCandidate, GtmProviderOperation, GtmAuditEvent } = entities
    const { sourceAdapterList, sourceAdapterRegistry } = await import('../../../lib/adapters/registry')
    const requestId = req.headers.get('x-request-id')

    if (body.op === 'list') {
      // Opaque 404 for malformed filters, same as a missing row.
      if (body.workspaceId != null && !isUuid(body.workspaceId)) return opaqueNotFound()
      if (body.playId != null && !isUuid(body.playId)) return opaqueNotFound()
      const { listResearchRuns, GTM_LIST_CAP } = await import('../../../lib/listing')
      const runs = await listResearchRuns(
        em as unknown as import('../../../lib/listing').ListEm,
        { organizationId, tenantId },
        { workspaceId: body.workspaceId ?? null, playId: body.playId ?? null },
      )
      return NextResponse.json({
        ok: true,
        runs: runs.map((run) => ({
          id: run.id,
          play_id: run.playId,
          status: run.status,
          estimated_credits: run.estimatedCredits != null ? Number(run.estimatedCredits) : null,
          reconciled_credits: run.reconciledCredits != null ? Number(run.reconciledCredits) : null,
          execution: shapeRun(run).execution,
          created_at: run.createdAt,
        })),
        cap: GTM_LIST_CAP,
      })
    }

    if (body.op === 'retention-sweep') {
      // Tranche 4 retention sweep (SPEC-066 section 4): hard-deletes expired
      // never-promoted, never-enrolled candidates plus their evidence and
      // contact points, one audit event per swept batch. Self-scoped to the
      // resolved org; service callers trigger it on whatever cadence they
      // like - the sweep is idempotent. Exposed here instead of a queue
      // worker because apps/mercato modules have no worker convention (see
      // lib/retention/sweep.ts).
      const { sweepExpiredCandidates } = await import('../../../lib/retention/sweep')
      const sweep = await sweepExpiredCandidates(
        em as unknown as import('../../../lib/retention/sweep').RetentionEm,
        { orgId: organizationId },
      )
      return NextResponse.json({ ok: true, sweep })
    }

    if (body.op === 'plan' || body.op === 'create') {
      // Opaque 404 for malformed, missing, foreign, or soft-deleted plays.
      if (!isUuid(body.playId)) return opaqueNotFound()
      const play = await em.findOne(GtmPlay, {
        id: body.playId,
        organizationId,
        tenantId,
        deletedAt: null,
      })
      if (!play) return opaqueNotFound()

      const plan = buildSourcePlan(play, sourceAdapterList(), body.limits ?? null)
      if (!plan.ok) {
        // Fail-closed plan error (non-executable play or empty adapter plan).
        return NextResponse.json(
          {
            ok: false,
            error: plan.reason,
            code: plan.code,
            unsupportedDimensions: plan.unsupportedDimensions,
          },
          { status: 422 },
        )
      }

      if (body.op === 'plan') {
        // Priced plan only; no run row is created.
        return NextResponse.json({
          ok: true,
          plan: {
            adapterPlan: plan.adapterPlan,
            estimated_credits: plan.estimatedCredits,
            planned_raw_capacity: plan.plannedRawCapacity,
            unsupportedDimensions: plan.unsupportedDimensions,
            limits: plan.limits,
            qualificationProfile: plan.qualificationProfile,
            schema_version: plan.schemaVersion,
            plan_hash: plan.planHash,
          },
        })
      }

      // The user confirms the exact quote they saw. A create request without
      // the same immutable plan hash can never silently accept provider,
      // pricing, terms, targeting, or limit drift.
      if (body.expectedPlanHash !== plan.planHash) {
        return NextResponse.json(
          {
            ok: false,
            error: 'Provider quote changed; review the refreshed plan before continuing',
            code: 'plan_changed',
            plan: {
              adapterPlan: plan.adapterPlan,
              estimated_credits: plan.estimatedCredits,
              planned_raw_capacity: plan.plannedRawCapacity,
              limits: plan.limits,
              qualificationProfile: plan.qualificationProfile,
              schema_version: plan.schemaVersion,
              plan_hash: plan.planHash,
            },
          },
          { status: 409 },
        )
      }

      const run = await em.transactional(async (tem) => {
        const row = tem.create(GtmResearchRun, {
          id: crypto.randomUUID(),
          organizationId,
          tenantId,
          workspaceId: play.workspaceId,
          playId: play.id,
          status: 'priced',
          inputSnapshot: {
            play: {
              id: play.id,
              signal: play.signal ?? null,
              entity_unit: play.entityUnit ?? null,
              geography: play.geography ?? null,
              market_type: play.marketType ?? null,
              audience: play.audience ?? null,
              provider_query: play.providerQuery ?? null,
              recency_window: play.recencyWindow ?? null,
              execution_eligibility: play.executionEligibility,
            },
            requested_limits: body.limits ?? null,
            query: plan.query,
          },
          providerPlan: {
            schemaVersion: plan.schemaVersion,
            planHash: plan.planHash,
            adapterPlan: plan.adapterPlan,
            plannedRawCapacity: plan.plannedRawCapacity,
            unsupportedDimensions: plan.unsupportedDimensions,
            qualificationProfile: plan.qualificationProfile,
            query: plan.query,
          },
          limits: plan.limits,
          estimatedCredits: String(plan.estimatedCredits),
        })
        tem.persist(row)
        const audit = tem.create(GtmAuditEvent, {
          organizationId,
          tenantId,
          actor: 'user_id',
          actorUserId: userId,
          action: 'gtm.research_run.created',
          objectType: 'gtm_research_run',
          objectId: row.id,
          requestId: requestId || null,
          metadata: {
            play_id: play.id,
            estimated_credits: plan.estimatedCredits,
            limits: plan.limits,
          },
        })
        tem.persist(audit)
        return row
      })

      return NextResponse.json({
        ok: true,
        run: shapeRun(run),
        plan: {
          adapterPlan: plan.adapterPlan,
          estimated_credits: plan.estimatedCredits,
          planned_raw_capacity: plan.plannedRawCapacity,
          unsupportedDimensions: plan.unsupportedDimensions,
          limits: plan.limits,
          qualificationProfile: plan.qualificationProfile,
          schema_version: plan.schemaVersion,
          plan_hash: plan.planHash,
        },
      })
    }

    // execute | status
    if (!isUuid(body.runId)) return opaqueNotFound()

    if (body.op === 'execute') {
      let run = await em.findOne(GtmResearchRun, {
        id: body.runId,
        organizationId,
        tenantId,
        deletedAt: null,
      })
      if (!run) return opaqueNotFound()
      if (run.status !== 'priced') {
        return NextResponse.json({ ok: true, run: shapeRun(run), alreadyExecuted: true })
      }


      const frozenProviderPlan = (run.providerPlan ?? {}) as Record<string, unknown>
      const frozenPlanHash = typeof frozenProviderPlan.planHash === 'string'
        ? frozenProviderPlan.planHash
        : null
      if (!frozenPlanHash || body.expectedPlanHash !== frozenPlanHash) {
        return NextResponse.json(
          {
            ok: false,
            error: 'The confirmed provider plan does not match this run',
            code: 'plan_hash_mismatch',
          },
          { status: 409 },
        )
      }

      // Resolve every spend dependency before claiming the run. A missing
      // canonical ledger must not strand a priced run in `running`.
      let ledger: GtmCreditLedger
      try {
        const { getLedger } = await import('../../../lib/credits/noli-core-ledger')
        ledger = getLedger()
      } catch (error) {
        console.error('[internal.gtm.research-runs] credit ledger unavailable', error)
        return NextResponse.json(
          { ok: false, error: 'Provider billing is not configured' },
          { status: 503 },
        )
      }
      const adapters = sourceAdapterRegistry()

      const play = await em.findOne(GtmPlay, {
        id: run.playId,
        organizationId,
        tenantId,
        deletedAt: null,
      })
      if (!play) {
        return NextResponse.json({ ok: false, error: 'Play no longer available' }, { status: 422 })
      }

      // Re-price from the current adapter descriptors before claiming the run.
      // Any terms, price, provider, play, targeting, or capability drift makes
      // the old quote stale and requires a new explicit confirmation.
      const limits = (run.limits ?? {}) as {
        targetAccepted?: number
        maxRawCandidates?: number
        maxCandidates?: number
        maxCredits?: number
      }
      const currentPlan = buildSourcePlan(play, Object.values(adapters), limits)
      if (!currentPlan.ok || currentPlan.planHash !== frozenPlanHash) {
        return NextResponse.json(
          {
            ok: false,
            error: currentPlan.ok
              ? 'Provider quote changed; create a new run from a refreshed plan'
              : currentPlan.reason,
            code: currentPlan.ok ? 'plan_changed' : currentPlan.code,
          },
          { status: currentPlan.ok ? 409 : 422 },
        )
      }

      // Idempotent claim: only a 'priced' run may start; the conditional
      // UPDATE guarantees exactly one of two concurrent executes wins.
      const claimed = await em.nativeUpdate(
        GtmResearchRun,
        { id: body.runId, organizationId, tenantId, status: 'priced', deletedAt: null },
        { status: 'running', startedAt: new Date() },
      )
      const refreshed = await em.findOne(GtmResearchRun, {
        id: body.runId,
        organizationId,
        tenantId,
        deletedAt: null,
      }, { refresh: true })
      if (!refreshed) return opaqueNotFound()
      run = refreshed
      if (claimed === 0) {
        // Non-priced run (already running, completed, failed, cancelled, or
        // planned): return the current state instead of re-running.
        return NextResponse.json({ ok: true, run: shapeRun(run), alreadyExecuted: true })
      }

      const { executeResearchRun } = await import('../../../lib/research/execute')
      const result = await executeResearchRun({
        em: em as unknown as import('../../../lib/research/execute').ResearchEm,
        ledger,
        adapters,
        run,
        play,
        userId,
      })

      await em.transactional(async (tem) => {
        const audit = tem.create(GtmAuditEvent, {
          organizationId,
          tenantId,
          actor: 'user_id',
          actorUserId: userId,
          action: 'gtm.research_run.executed',
          objectType: 'gtm_research_run',
          objectId: run.id,
          requestId: requestId || null,
          metadata: {
            status: result.status,
            reconciled_credits: result.reconciledCredits,
            candidates_inserted: result.candidatesInserted,
            duplicates_skipped: result.duplicatesSkipped,
            target_accepted: result.funnel.targetAccepted,
            accepted: result.funnel.accepted,
            target_met: result.funnel.targetMet,
            stop_reason: result.funnel.stopReason,
            reconciliation_required: result.reconciliationRequired,
          },
        })
        tem.persist(audit)
      })

      return NextResponse.json({ ok: true, run: shapeRun(run), result })
    }

    // status
    const run = await em.findOne(GtmResearchRun, {
      id: body.runId,
      organizationId,
      tenantId,
      deletedAt: null,
    })
    if (!run) return opaqueNotFound()

    const scope = { organizationId, tenantId, researchRunId: run.id, deletedAt: null }
    const [total, accepted, review, rejected, unscored, providerOperations] = await Promise.all([
      em.count(GtmCandidate, scope),
      em.count(GtmCandidate, { ...scope, fitStatus: 'accepted' }),
      em.count(GtmCandidate, { ...scope, fitStatus: 'review' }),
      em.count(GtmCandidate, { ...scope, fitStatus: 'rejected' }),
      em.count(GtmCandidate, { ...scope, fitStatus: 'unscored' }),
      em.count(GtmProviderOperation, scope),
    ])

    return NextResponse.json({
      ok: true,
      run: shapeRun(run),
      counts: {
        candidates: { total, accepted, review, rejected, unscored },
        providerOperations,
      },
    })
  } catch (err) {
    console.error('[internal.gtm.research-runs]', err)
    return NextResponse.json({ ok: false, error: 'Research run operation failed' }, { status: 500 })
  }
}
