import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { NextResponse } from 'next/server'
import { internalServiceBearerAuthorized } from '../../../lib/authorize'
import { gtmInternalOpenApi } from '../../openapi'
import { gtmAutoRefillBodySchema } from '../../../data/validators'
import { gtmEnabled } from '../../../lib/flags'
import { isUuid } from '../../../lib/play-shape'
import { usdFromCredits } from '../../../lib/credits/markup'
import {
  getAutoRefillStatus,
  planAutoRefill,
  type ActivateAutoRefillResult,
  type AutoRefillEm,
} from '../../../lib/auto-refill/policy'
import { GtmAutoRefillError } from '../../../lib/auto-refill/contract'
import type {
  ActivateAutoRefillCommandInput,
  PauseAutoRefillCommandInput,
} from '../../../commands/auto-refill'

export const openApi = gtmInternalOpenApi('Plan and control bounded GTM campaign auto-refill')

export const metadata = {
  path: '/internal/gtm/auto-refill',
  POST: { requireAuth: false },
}

function opaqueNotFound() {
  return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
}

function errorResponse(error: GtmAutoRefillError) {
  if (error.code === 'campaign_not_found' || error.code === 'policy_not_found') {
    return opaqueNotFound()
  }
  const status = error.code === 'stale_campaign' || error.code === 'plan_changed'
    ? 409
    : error.code === 'scheduler_unavailable' ? 503 : 422
  return NextResponse.json({ ok: false, error: error.message, code: error.code }, { status })
}

export async function POST(req: Request) {
  if (!gtmEnabled()) return opaqueNotFound()

  // Byte-length guarded constant-time compare (lib/authorize.ts).
  if (!internalServiceBearerAuthorized(req)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const raw = await req.json().catch(() => ({}))
  const parsed = gtmAutoRefillBodySchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const where = first?.path?.length ? `${first.path.join('.')}: ` : ''
    return NextResponse.json(
      { ok: false, error: `${where}${first?.message ?? 'Invalid body'}` },
      { status: 400 },
    )
  }
  const body = parsed.data
  if (!isUuid(body.campaignId)) return opaqueNotFound()

  try {
    const { findNoliUserById, findPrimaryOrgIdForUser } = await import(
      '@open-mercato/shared/lib/noli/core-client'
    )
    const noliUser = await findNoliUserById(body.noliUserId)
    if (!noliUser?.clerk_user_id) return opaqueNotFound()
    const noliOrganizationId = await findPrimaryOrgIdForUser(noliUser.id)
    if (!noliOrganizationId) {
      return NextResponse.json(
        { ok: false, error: 'Noli organization is not available' },
        { status: 503 },
      )
    }

    const { resolveClerkUserToAuthContext } = await import('@open-mercato/shared/lib/auth/clerk')
    const auth = await resolveClerkUserToAuthContext(noliUser.clerk_user_id)
    if (!auth?.userId || !auth.orgId || !auth.tenantId) {
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
    const { autoRefillFeatureForOp, hasGtmFeature } = await import('../../../lib/authorize')
    if (!(await hasGtmFeature(container, ctx, autoRefillFeatureForOp(body.op)))) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })
    }
    const em = container.resolve('em') as EntityManager as unknown as AutoRefillEm

    if (body.op === 'plan') {
      const { sourceAdapterList } = await import('../../../lib/adapters/registry')
      const result = await planAutoRefill(em, ctx, {
        campaignId: body.campaignId,
        limits: body.limits,
        runHourLocal: body.run_hour_local,
      }, sourceAdapterList())
      return NextResponse.json({
        ok: true,
        plan: {
          plan_hash: result.plan.planHash,
          schema_version: result.plan.schemaVersion,
          adapter_plan: result.plan.adapterPlan,
          estimated_credits: result.plan.estimatedCredits,
          estimated_usd: usdFromCredits(result.plan.estimatedCredits),
          planned_raw_capacity: result.plan.plannedRawCapacity,
          limits: result.plan.limits,
          timezone: result.timezone,
          run_hour_local: result.runHourLocal,
          weekdays: [1, 2, 3, 4, 5],
        },
      })
    }

    if (body.op === 'status') {
      const result = await getAutoRefillStatus(em, ctx, body.campaignId)
      return NextResponse.json({
        ok: true,
        runtime_enabled: process.env.GTM_AUTO_REFILL_ENABLED === 'true',
        policy: result.policy ? {
          id: result.policy.id,
          status: result.policy.status,
          campaign_version_id: result.policy.campaignVersionId,
          policy_hash: result.policy.policyHash,
          plan_hash: result.policy.planHash,
          target_accepted_per_day: result.policy.targetAcceptedPerDay,
          max_raw_candidates_per_day: result.policy.maxRawCandidatesPerDay,
          max_credits_per_day: result.policy.maxCreditsPerDay,
          max_usd_per_day: usdFromCredits(result.policy.maxCreditsPerDay),
          run_hour_local: result.policy.runHourLocal,
          timezone: result.policy.timezone,
          blocked_reason: result.policy.blockedReason ?? null,
          last_cycle_local_date: result.policy.lastCycleLocalDate ?? null,
          last_cycle_at: result.policy.lastCycleAt ?? null,
          last_success_at: result.policy.lastSuccessAt ?? null,
        } : null,
        latest_cycle: result.latestCycle ? {
          id: result.latestCycle.id,
          local_date: result.latestCycle.localDate,
          status: result.latestCycle.status,
          research_run_id: result.latestCycle.researchRunId ?? null,
          failure_code: result.latestCycle.failureCode ?? null,
          result: result.latestCycle.result ?? null,
          started_at: result.latestCycle.startedAt ?? null,
          completed_at: result.latestCycle.completedAt ?? null,
        } : null,
      })
    }

    const commandBus = container.resolve('commandBus') as CommandBus
    const commandCtx = {
      container,
      auth,
      organizationScope: null,
      selectedOrganizationId: ctx.organizationId,
      organizationIds: [ctx.organizationId],
      request: req,
    }
    if (body.op === 'activate') {
      const executed = await commandBus.execute<ActivateAutoRefillCommandInput, ActivateAutoRefillResult>(
        'gtm.auto-refill.activate',
        {
          input: {
            campaignId: body.campaignId,
            expectedContentHash: body.expected_content_hash,
            expectedPlanHash: body.expected_plan_hash,
            representedNoliUserId: body.noliUserId,
            noliOrganizationId,
          },
          ctx: commandCtx,
        },
      )
      return NextResponse.json({
        ok: true,
        policy: {
          id: executed.result.policy.id,
          status: executed.result.policy.status,
          policy_hash: executed.result.policy.policyHash,
          plan_hash: executed.result.policy.planHash,
          scheduled: true,
          runtime_enabled: process.env.GTM_AUTO_REFILL_ENABLED === 'true',
          already_active: executed.result.alreadyActive,
        },
      })
    }

    const executed = await commandBus.execute<
      PauseAutoRefillCommandInput,
      { policy: { id: string; status: string; policyHash: string }; alreadyPaused: boolean }
    >('gtm.auto-refill.pause', {
      input: { campaignId: body.campaignId },
      ctx: commandCtx,
    })
    return NextResponse.json({
      ok: true,
      policy: {
        id: executed.result.policy.id,
        status: executed.result.policy.status,
        policy_hash: executed.result.policy.policyHash,
        scheduled: false,
        already_paused: executed.result.alreadyPaused,
      },
    })
  } catch (error) {
    if (error instanceof GtmAutoRefillError) return errorResponse(error)
    console.error('[internal.gtm.auto-refill]', error)
    return NextResponse.json({ ok: false, error: 'Internal error' }, { status: 500 })
  }
}
