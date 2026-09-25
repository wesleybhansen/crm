import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { gtmInternalOpenApi } from '../../openapi'

export const openApi = gtmInternalOpenApi('Plan and execute gated GTM research')
import type { EntityManager } from '@mikro-orm/postgresql'
import {
  gtmConsumerOwnerProbeEnabled,
  gtmConsumerResearchReleaseState,
  gtmEnabled,
} from '../../../lib/flags'
import { gtmResearchRunsBodySchema } from '../../../data/validators'
import { isUuid } from '../../../lib/play-shape'
import {
  buildSourcePlan,
  canonicalEntityKind,
  type OpportunitySourceRoutingInput,
} from '../../../lib/research/plan'
import type { GtmResearchRun } from '../../../data/entities'
import type { GtmCreditLedger } from '../../../lib/credits/ledger'
import { usdFromCredits } from '../../../lib/credits/markup'

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
 * - 'summary' read-only run summary for the hub: sources searched, funnel
 *             counts, quote vs settled spend in cents, qualification rate,
 *             top reject reasons with labels (lib/research/summary.ts).
 *             { runId } or { playId } (= that play's most recent run)
 * - 'requalify' deterministically rescores stored output from the frozen run
 *               snapshot, with no provider or billing call
 * - 'sweep-stale-runs' (gtm.launch) marks runs stuck in 'running' past a
 *               threshold as failed and parks their provider_started
 *               operations for reconciliation (lib/research/stale-runs.ts)
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

// Local schema for the stale-run sweep op. It is validated here rather than in
// data/validators.ts so this route owns its own operational op; fold it into
// gtmResearchRunsBodySchema when that file is next touched.
const staleSweepBodySchema = z.object({
  op: z.literal('sweep-stale-runs'),
  noliUserId: z.string().min(1),
  olderThanMinutes: z.number().int().min(5).max(24 * 60).optional(),
})

function opaqueNotFound() {
  return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
}

function consumerResearchHold() {
  const release = gtmConsumerResearchReleaseState()
  return NextResponse.json(
    {
      ok: false,
      error: 'Consumer research has not passed every environment release gate',
      code: 'consumer_research_disabled',
      hold_reasons: release.holdReasons,
    },
    { status: 422 },
  )
}

/*
 * The "usually about" figure frozen on the run when it was created (from real
 * spend history, lib/research/typical-spend). estimated_credits stays the hard
 * cap the customer approved; this is only what to expect.
 */
function storedTypical(plan: Record<string, unknown>): { typical_credits: number | null; typical_usd: number | null } {
  const t = plan.typical as { credits?: unknown; usd?: unknown } | undefined
  const credits = typeof t?.credits === 'number' && Number.isFinite(t.credits) ? t.credits : null
  const usd = typeof t?.usd === 'number' && Number.isFinite(t.usd) ? t.usd : null
  return { typical_credits: credits, typical_usd: usd }
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
    ...storedTypical(plan),
    reconciled_credits: run.reconciledCredits != null ? Number(run.reconciledCredits) : null,
    started_at: run.startedAt ?? null,
    completed_at: run.completedAt ?? null,
    execution: (plan.execution as Record<string, unknown> | undefined) ?? null,
    policy: (plan.policy as Record<string, unknown> | undefined) ?? null,
  }
}

export async function POST(req: Request) {
  // 0. Operational kill switch: customer release is live; flag-off fails closed.
  if (!gtmEnabled()) {
    return opaqueNotFound()
  }

  // 1. Shared-secret auth (byte-length-guarded constant-time compare). Both
  //    Buffers are built first: a UTF-16 length check let a multibyte header
  //    of equal string length reach timingSafeEqual with a different byte
  //    length, which throws a 500 instead of denying.
  const secret = process.env.NOLI_INTERNAL_SERVICE_SECRET
  const authHeader = (req.headers.get('authorization') || '').trim()
  const provided = Buffer.from(authHeader, 'utf8')
  const expected = Buffer.from(secret ? `Bearer ${secret}` : '', 'utf8')
  if (
    !secret ||
    provided.length !== expected.length ||
    !crypto.timingSafeEqual(provided, expected)
  ) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  // 2. Body
  const raw = await req.json().catch(() => ({}))
  const parsed = (raw as { op?: unknown })?.op === 'sweep-stale-runs'
    ? staleSweepBodySchema.safeParse(raw)
    : gtmResearchRunsBodySchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const where = first?.path?.length ? `${first.path.join('.')}: ` : ''
    return NextResponse.json({ ok: false, error: `${where}${first?.message ?? 'Invalid body'}` }, { status: 400 })
  }
  const body = parsed.data

  try {
    // 3. noli-core user -> Clerk id
    const { findNoliUserById, findPrimaryOrgIdForUser } = await import(
      '@open-mercato/shared/lib/noli/core-client'
    )
    const noliUser = await findNoliUserById(body.noliUserId)
    if (!noliUser?.clerk_user_id) {
      return NextResponse.json({ ok: false, error: 'Noli user not found' }, { status: 404 })
    }
    const noliOrgId = await findPrimaryOrgIdForUser(noliUser.id)
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
    const { hasGtmFeature, researchFeatureForOp } = await import('../../../lib/authorize')
    // The stale sweep fails runs and parks operations, so it needs the same
    // launch feature as execute.
    const requiredFeature = body.op === 'sweep-stale-runs' ? 'gtm.launch' : researchFeatureForOp(body.op)
    if (!(await hasGtmFeature(container, { organizationId, tenantId, userId }, requiredFeature))) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })
    }
    const em = container.resolve('em') as EntityManager
    const entities = await import('../../../data/entities')
    const {
      GtmPlay,
      GtmResearchRun,
      GtmCandidate,
      GtmCandidateMatch,
      GtmProviderOperation,
      GtmAuditEvent,
    } = entities
    const { sourceAdapterList, sourceAdapterRegistry } = await import('../../../lib/adapters/registry')
    // Customer-grant-backed sources (Threads) are resolved once per request
    // for the exact org/tenant being served; absent grants simply mean those
    // sources are not in the plan.
    const { resolveSourceAdapterContext } = await import('../../../lib/adapters/context')
    const adapterContext = await resolveSourceAdapterContext(container, em, { organizationId, tenantId })
    const requestId = req.headers.get('x-request-id')

    if (body.op === 'sweep-stale-runs') {
      const { failStaleResearchRuns } = await import('../../../lib/research/stale-runs')
      const sweep = await failStaleResearchRuns(
        em as unknown as import('../../../lib/research/stale-runs').StaleRunEm,
        { organizationId, tenantId },
        { olderThanMinutes: body.olderThanMinutes, actorUserId: userId, requestId },
      )
      return NextResponse.json({ ok: true, sweep })
    }

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
          ...storedTypical((run.providerPlan ?? {}) as Record<string, unknown>),
          reconciled_credits: run.reconciledCredits != null ? Number(run.reconciledCredits) : null,
          execution: shapeRun(run).execution,
          created_at: run.createdAt,
        })),
        cap: GTM_LIST_CAP,
      })
    }

    if (body.op === 'summary') {
      if (!body.runId && !body.playId) {
        return NextResponse.json({ ok: false, error: 'runId or playId is required' }, { status: 400 })
      }
      // Opaque 404 for malformed ids, same as a missing or foreign row.
      if (body.runId != null && !isUuid(body.runId)) return opaqueNotFound()
      if (body.playId != null && !isUuid(body.playId)) return opaqueNotFound()
      const { summarizeResearchRun } = await import('../../../lib/research/summary')
      const summary = await summarizeResearchRun(
        em as unknown as import('../../../lib/research/summary').ResearchSummaryEm,
        { organizationId, tenantId },
        { runId: body.runId ?? null, playId: body.playId ?? null },
      )
      if (!summary) return opaqueNotFound()
      return NextResponse.json({ ok: true, summary })
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

    if (body.op === 'plan' || body.op === 'create' || body.op === 'preview') {
      // Opaque 404 for malformed, missing, foreign, or soft-deleted plays.
      if (!isUuid(body.playId)) return opaqueNotFound()
      const play = await em.findOne(GtmPlay, {
        id: body.playId,
        organizationId,
        tenantId,
        deletedAt: null,
      })
      if (!play) return opaqueNotFound()

      let opportunityRouting: OpportunitySourceRoutingInput = { evidenceScope: 'none', signals: [] }
      if (canonicalEntityKind(play.entityUnit ?? '') === 'opportunity') {
        try {
          const { getOpportunityQualityDiagnostics } = await import(
            '../../../lib/diagnostics/opportunity-quality'
          )
          const diagnostics = await getOpportunityQualityDiagnostics(
            em as unknown as import('../../../lib/campaign/build').CampaignEm,
            { organizationId, tenantId },
          )
          opportunityRouting = {
            evidenceScope: 'organization_recent',
            signals: diagnostics.sources.map((source) => ({
              adapterId: source.source,
              opportunities: source.opportunities,
              accepted: source.accepted,
              humanUsefulAccepted: source.humanUsefulAccepted,
              chargedCredits: source.chargedCredits,
              deadDestinationRate: source.deadDestinationRate,
              staleDestinationRate: source.staleDestinationRate,
              duplicateRate: source.duplicateRate,
            })),
          }
        } catch (error) {
          console.error('[internal.gtm.research-runs] source quality history unavailable', error)
        }
      }
      // A preview carries no limits of its own: it samples the play's own
      // priced plan, capped to three rows inside lib/research/preview.ts, so
      // the lane it shows is the lane a run would use.
      const requestedLimits = 'limits' in body ? body.limits ?? null : null
      const plan = buildSourcePlan(
        play,
        sourceAdapterList(adapterContext),
        requestedLimits,
        undefined,
        opportunityRouting,
      )
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

      if (
        plan.policy.lead_mode !== 'business'
        && !gtmConsumerResearchReleaseState().enabled
        && !gtmConsumerOwnerProbeEnabled(body.noliUserId, plan.limits)
      ) {
        return consumerResearchHold()
      }

      // What runs like this were actually charged (real spend history), shown
      // beside the cap on every plan-bearing response. Never blocks: history
      // failures fall back inside typicalFields.
      const typical = body.op === 'preview'
        ? null
        : await (async () => {
          const { loadSpendHistory, typicalFields } = await import('../../../lib/research/typical-spend')
          return typicalFields(plan.adapterPlan, await loadSpendHistory(em as never))
        })()

      if (body.op === 'preview') {
        /*
         * Dry lane: three real public rows from ONE lane of this exact priced
         * plan. No run row, no candidates, no enrollment. It calls a
         * provider, so it is gated three ways before any money moves: the
         * play must be researchable (the plan above already proved that), the
         * workspace must have a preview left today, and the ledger must have
         * the credits. `quoteOnly` stops before the first of those spends
         * anything, so the button can quote itself on hover.
         */
        const previewLib = await import('../../../lib/research/preview')
        const settingsLib = await import('../../../lib/workspace-settings')
        const { GtmWorkspace } = entities
        const workspace = await em.findOne(GtmWorkspace, {
          id: play.workspaceId,
          organizationId,
          tenantId,
          deletedAt: null,
        })
        if (!workspace) return opaqueNotFound()

        const batch = previewLib.choosePreviewLane(plan)
        const adapter = batch ? sourceAdapterRegistry(adapterContext)[batch.adapter_id] : undefined
        if (!batch || !adapter) {
          return NextResponse.json(
            {
              ok: false,
              error: 'This play has no source Noli can sample on its own right now',
              code: 'no_previewable_lane',
            },
            { status: 422 },
          )
        }
        const typicalLib = await import('../../../lib/research/typical-spend')
        const previewHistory = await typicalLib.loadPreviewHistory(em as never)
        const withTypical = <Q extends { adapterId: string; estimatedCredits: number }>(q: Q) => {
          const typicalCredits = typicalLib.typicalPreviewCredits(q.adapterId, q.estimatedCredits, previewHistory)
          return {
            ...q,
            typicalCredits,
            typicalUsd: typicalCredits != null ? usdFromCredits(typicalCredits) : null,
          }
        }
        const quote = withTypical(previewLib.quotePreviewLane(adapter, batch, plan.query))

        if (body.quoteOnly) {
          return NextResponse.json({
            ok: true,
            quote,
            quota: settingsLib.readPlayPreviewQuota(workspace),
          })
        }

        const claim = await settingsLib.consumePlayPreview(
          em as unknown as import('../../../lib/campaign/build').CampaignEm,
          { organizationId, tenantId, userId, requestId },
          workspace.id,
        )
        if (!claim.allowed) {
          return NextResponse.json(
            {
              ok: false,
              error: `Previews are limited to ${claim.quota.limit} per day for this workspace. Research the play to see the full list.`,
              code: 'preview_limit_reached',
              quota: claim.quota,
              quote,
            },
            { status: 429 },
          )
        }

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

        try {
          const preview = await previewLib.previewLane({
            em: em as unknown as import('../../../lib/research/preview').PreviewEm,
            ledger,
            adapters: sourceAdapterRegistry(adapterContext),
            plan,
            organizationId,
            tenantId,
            noliOrgId,
            noliUserId: body.noliUserId,
            workspaceId: workspace.id,
            playId: play.id,
            claim: { day: claim.quota.day, slot: claim.quota.used },
            fitPlay: {
              entityUnit: play.entityUnit ?? null,
              geography: play.geography ?? null,
              audience: play.audience ?? null,
              signal: play.signal ?? null,
              recencyWindow: play.recencyWindow ?? null,
              providerQuery: play.providerQuery ?? null,
            },
          })
          await em.transactional(async (tem) => {
            const audit = tem.create(GtmAuditEvent, {
              organizationId,
              tenantId,
              actor: 'user_id',
              actorUserId: userId,
              action: 'gtm.play.previewed',
              objectType: 'gtm_play',
              objectId: play.id,
              requestId: requestId || null,
              metadata: {
                adapter_id: preview.adapterId,
                status: preview.status,
                rows: preview.rows.length,
                charged_credits: preview.chargedCredits,
                provider_operation_id: preview.providerOperationId,
                preview_day: claim.quota.day,
                preview_slot: claim.quota.used,
              },
            })
            tem.persist(audit)
          })
          return NextResponse.json({ ok: true, preview: { ...preview, quote: withTypical(preview.quote) }, quota: claim.quota })
        } catch (error) {
          if (error instanceof previewLib.GtmPreviewError) {
            const status = error.code === 'insufficient_credits' ? 402 : 422
            return NextResponse.json({ ok: false, error: error.message, code: error.code, quota: claim.quota }, { status })
          }
          throw error
        }
      }

      if (body.op === 'plan') {
        // Priced plan only; no run row is created. typical_credits is what runs
        // like this were actually charged (history), shown beside the cap.
        return NextResponse.json({
          ok: true,
          plan: {
            adapterPlan: plan.adapterPlan,
            estimated_credits: plan.estimatedCredits,
            ...typical,
            planned_raw_capacity: plan.plannedRawCapacity,
            unsupportedDimensions: plan.unsupportedDimensions,
            limits: plan.limits,
            qualificationProfile: plan.qualificationProfile,
            destinationValidation: plan.destinationValidation,
            sourceRouting: plan.sourceRouting,
            policy: plan.policy,
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
              ...typical,
              planned_raw_capacity: plan.plannedRawCapacity,
              limits: plan.limits,
              qualificationProfile: plan.qualificationProfile,
              destinationValidation: plan.destinationValidation,
              sourceRouting: plan.sourceRouting,
              policy: plan.policy,
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
              name: play.name ?? null,
              signal: play.signal ?? null,
              entity_unit: play.entityUnit ?? null,
              geography: play.geography ?? null,
              market_type: play.marketType ?? null,
              audience: play.audience ?? null,
              provider_query: play.providerQuery ?? null,
              recency_window: play.recencyWindow ?? null,
              execution_eligibility: play.executionEligibility,
              lead_mode: plan.policy.lead_mode,
              research_eligibility: plan.policy.research_eligibility,
              outreach_mode: plan.policy.outreach_mode,
              policy_flags: plan.policy.policy_flags,
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
            destinationValidation: plan.destinationValidation,
            sourceRouting: plan.sourceRouting,
            policy: plan.policy,
            query: plan.query,
            typical: typical && typical.typical_credits != null
              ? { credits: typical.typical_credits, usd: typical.typical_usd, basis: typical.typical_basis }
              : null,
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
          ...typical,
          planned_raw_capacity: plan.plannedRawCapacity,
          unsupportedDimensions: plan.unsupportedDimensions,
          limits: plan.limits,
          qualificationProfile: plan.qualificationProfile,
          destinationValidation: plan.destinationValidation,
          sourceRouting: plan.sourceRouting,
          policy: plan.policy,
          schema_version: plan.schemaVersion,
          plan_hash: plan.planHash,
        },
      })
    }

    // execute | requalify | status
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
      const frozenPolicy = frozenProviderPlan.policy as Record<string, unknown> | undefined
      if (
        frozenPolicy
        && frozenPolicy.lead_mode !== 'business'
        && !gtmConsumerResearchReleaseState().enabled
        && !gtmConsumerOwnerProbeEnabled(body.noliUserId, run.limits as Record<string, unknown>)
      ) {
        return consumerResearchHold()
      }

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
      const adapters = sourceAdapterRegistry(adapterContext)
      // Every adapter the frozen plan names must still be enabled BEFORE the
      // priced->running claim. Discovering a disabled adapter after the claim
      // leaves a failed run that cannot be re-executed without a new quote.
      const frozenAdapterPlan = Array.isArray(frozenProviderPlan.adapterPlan)
        ? (frozenProviderPlan.adapterPlan as Array<{ adapter_id?: unknown; dependentHydration?: { adapter_id?: unknown } | null }>)
        : []
      const missingAdapters = [...new Set(
        frozenAdapterPlan
          .flatMap((batch) => [batch?.adapter_id, batch?.dependentHydration?.adapter_id])
          .filter((id): id is string => typeof id === 'string' && !(id in adapters)),
      )]
      if (missingAdapters.length > 0) {
        return NextResponse.json(
          {
            ok: false,
            error: 'A provider in the confirmed plan is no longer enabled; create a new run from a refreshed plan',
            code: 'plan_changed',
            missing_adapters: missingAdapters,
          },
          { status: 409 },
        )
      }

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
      const frozenSourceRouting = frozenProviderPlan.sourceRouting as OpportunitySourceRoutingInput | undefined
      const currentPlan = buildSourcePlan(
        play,
        Object.values(adapters),
        limits,
        undefined,
        frozenSourceRouting,
      )
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
        noliOrgId,
        // The canonical ledger meters into Noli Core ai_usage, so it must use
        // the represented Noli user UUID, never the provisioned CRM UUID.
        noliUserId: body.noliUserId,
      })

      // The AI lead check reads the post leads and business listings the rules kept and rejects the ones
      // that do not fit (billed to the customer's AI allowance; skipped, never failing, when unavailable).
      const { runLeadCheck } = await import('../../../lib/research/judge-runner')
      const leadCheck = await runLeadCheck({
        em,
        run,
        play: { audience: play.audience ?? null, signal: play.signal ?? null, geography: play.geography ?? null },
        noliUserId: body.noliUserId,
        requestId: requestId || null,
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
            lead_check: leadCheck.status === 'checked'
              ? { checked: leadCheck.checked, rejected: leadCheck.rejected }
              : { skipped: leadCheck.reason },
          },
        })
        tem.persist(audit)
      })

      return NextResponse.json({ ok: true, run: shapeRun(run), result })
    }

    if (body.op === 'requalify') {
      const run = await em.findOne(GtmResearchRun, {
        id: body.runId,
        organizationId,
        tenantId,
        deletedAt: null,
      })
      if (!run) return opaqueNotFound()
      if (run.status !== 'completed' && run.status !== 'failed') {
        return NextResponse.json(
          { ok: false, error: 'Only finished research runs can be requalified' },
          { status: 409 },
        )
      }
      const { requalifyResearchRun } = await import('../../../lib/research/requalify')
      const result = await requalifyResearchRun({
        em: em as unknown as import('../../../lib/research/requalify').RequalifyEm,
        run,
        actorUserId: userId,
        requestId,
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

    // A finished run scored under an older rule revision is re-scored before
    // it is shown, so a lead the current rules reject never still reads as
    // accepted (2026-09-24 audit: 79 of 85 accepted opportunity leads were on
    // old revisions). Stored output only: no provider call, no spend, manual
    // decisions preserved. Best-effort: the status still returns on failure.
    if (run.status === 'completed' || run.status === 'failed') {
      const { FIT_SCORER_REVISION, FIT_SCORER_VERSION } = await import('../../../lib/research/qualify')
      const execution = ((run.providerPlan ?? {}) as Record<string, unknown>).execution as Record<string, unknown> | undefined
      const prior = (execution?.requalification ?? {}) as Record<string, unknown>
      if (prior.scorer_version !== FIT_SCORER_VERSION || prior.scorer_revision !== FIT_SCORER_REVISION) {
        try {
          const { requalifyResearchRun } = await import('../../../lib/research/requalify')
          await requalifyResearchRun({
            em: em as unknown as import('../../../lib/research/requalify').RequalifyEm,
            run,
            actorUserId: userId,
            requestId,
          })
        } catch (error) {
          console.error('[internal.gtm.research-runs] automatic requalify failed', run.id, error)
        }
      }
    }

    const scope = { organizationId, tenantId, researchRunId: run.id, deletedAt: null }
    const matchTotal = await em.count(GtmCandidateMatch, scope)
    const CountEntity = matchTotal > 0 ? GtmCandidateMatch : GtmCandidate
    const [accepted, review, rejected, unscored, providerOperations] = await Promise.all([
      em.count(CountEntity, { ...scope, fitStatus: 'accepted' }),
      em.count(CountEntity, { ...scope, fitStatus: 'review' }),
      em.count(CountEntity, { ...scope, fitStatus: 'rejected' }),
      em.count(CountEntity, { ...scope, fitStatus: 'unscored' }),
      em.count(GtmProviderOperation, scope),
    ])
    const total = matchTotal > 0 ? matchTotal : await em.count(GtmCandidate, scope)

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
