import { NextResponse } from 'next/server'
import { internalServiceBearerAuthorized } from '../../../lib/authorize'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { gtmInternalOpenApi } from '../../openapi'
import { gtmConsumerResearchReleaseState, gtmEnabled } from '../../../lib/flags'
import { gtmReconciliationBodySchema } from '../../../data/validators'
import type { CampaignEm } from '../../../lib/campaign/build'
import { isUuid } from '../../../lib/play-shape'
import {
  GtmProviderReconciliationError,
  listProviderOperationsForReconciliation,
  type GtmOperatorReconciliationResult,
  type GtmResearchRunSummaryRepairResult,
} from '../../../lib/reconciliation/operator'
import type {
  ReconcileProviderOperationCommandInput,
  RepairResearchRunSummariesCommandInput,
} from '../../../commands/reconciliation'

export const openApi = gtmInternalOpenApi('List, catalog, or reconcile GTM provider operations')

export const metadata = {
  path: '/internal/gtm/reconciliation',
  POST: { requireAuth: false },
}

const notFound = () => NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })

export async function POST(req: Request) {
  if (!gtmEnabled()) return notFound()
  // Byte-length guarded constant-time compare (lib/authorize.ts).
  if (!internalServiceBearerAuthorized(req)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  const parsed = gtmReconciliationBodySchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'Invalid body' }, { status: 400 })
  }
  if (
    (parsed.data.op === 'apply' || parsed.data.op === 'replay-parked-output')
    && !isUuid(parsed.data.operationId)
  ) return notFound()
  if (
    parsed.data.op === 'repair-run-summaries'
    && parsed.data.runIds.some((runId) => !isUuid(runId))
  ) return notFound()

  try {
    const { findNoliUserById, findPrimaryOrgIdForUser } = await import(
      '@open-mercato/shared/lib/noli/core-client'
    )
    const noliUser = await findNoliUserById(parsed.data.noliUserId)
    if (!noliUser?.clerk_user_id) return notFound()
    const noliOrgId = await findPrimaryOrgIdForUser(noliUser.id)
    if (!noliOrgId) {
      return NextResponse.json(
        { ok: false, error: 'Noli organization is not available' },
        { status: 503 },
      )
    }
    const { resolveClerkUserToAuthContext } = await import('@open-mercato/shared/lib/auth/clerk')
    const auth = await resolveClerkUserToAuthContext(noliUser.clerk_user_id)
    if (!auth?.userId || !auth.orgId || !auth.tenantId) return notFound()
    const ctx = {
      userId: auth.userId as string,
      organizationId: auth.orgId as string,
      tenantId: auth.tenantId as string,
      requestId: req.headers.get('x-request-id') || null,
    }
    const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
    const container = await createRequestContainer()
    const { hasGtmFeature, reconciliationFeatureForOp } = await import('../../../lib/authorize')
    if (!(await hasGtmFeature(container, ctx, reconciliationFeatureForOp(parsed.data.op)))) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })
    }
    if (parsed.data.op === 'catalog') {
      const { selectedProviderCatalog } = await import('../../../lib/adapters/provider-catalog')
      return NextResponse.json({ ok: true, catalog: selectedProviderCatalog() })
    }
    const em = container.resolve('em') as EntityManager as unknown as CampaignEm
    if (parsed.data.op === 'list') {
      const operations = await listProviderOperationsForReconciliation(em, ctx)
      return NextResponse.json({ ok: true, operations })
    }
    if (parsed.data.op === 'history') {
      const { getProviderHistoryDiagnostics } = await import(
        '../../../lib/diagnostics/provider-history'
      )
      const history = await getProviderHistoryDiagnostics(em, ctx)
      return NextResponse.json({ ok: true, history })
    }
    if (parsed.data.op === 'ai-telemetry') {
      const { getAiTelemetryDiagnostics } = await import(
        '../../../lib/diagnostics/ai-telemetry'
      )
      const telemetry = await getAiTelemetryDiagnostics(em, ctx)
      return NextResponse.json({ ok: true, telemetry })
    }
    if (parsed.data.op === 'opportunity-quality') {
      const { getOpportunityQualityDiagnostics } = await import(
        '../../../lib/diagnostics/opportunity-quality'
      )
      const quality = await getOpportunityQualityDiagnostics(em, ctx)
      return NextResponse.json({
        ok: true,
        quality,
        consumer_release: gtmConsumerResearchReleaseState(),
      })
    }

    const commandBus = container.resolve('commandBus') as CommandBus
    if (parsed.data.op === 'repair-run-summaries') {
      const executed = await commandBus.execute<
        RepairResearchRunSummariesCommandInput,
        GtmResearchRunSummaryRepairResult
      >('gtm.provider-operations.repair-run-summaries', {
        input: { runIds: parsed.data.runIds },
        ctx: {
          container,
          auth,
          organizationScope: null,
          selectedOrganizationId: ctx.organizationId,
          organizationIds: [ctx.organizationId],
          request: req,
        },
      })
      return NextResponse.json({
        ok: true,
        requested_run_ids: executed.result.requestedRunIds,
        repaired_run_ids: executed.result.repairedRunIds,
        unchanged_run_ids: executed.result.unchangedRunIds,
      })
    }
    const commandCtx = {
      container,
      auth,
      organizationScope: null,
      selectedOrganizationId: ctx.organizationId,
      organizationIds: [ctx.organizationId],
      request: req,
    }
    if (parsed.data.op === 'replay-settlements') {
      const executed = await commandBus.execute<
        { limit?: number },
        import('../../../lib/reconciliation/operator').ReplayPendingSettlementsResult
      >('gtm.reconciliation.replay-settlements', {
        input: { limit: parsed.data.limit },
        ctx: commandCtx,
      })
      return NextResponse.json({
        ok: true,
        scanned: executed.result.scanned,
        settled: executed.result.settled,
        failed: executed.result.failed,
        skipped: executed.result.skipped,
      })
    }
    if (parsed.data.op === 'replay-parked-output') {
      const executed = await commandBus.execute<
        { operationId: string },
        import('../../../lib/reconciliation/operator').ReplayParkedOutputResult
      >('gtm.reconciliation.replay-parked-output', {
        input: { operationId: parsed.data.operationId },
        ctx: commandCtx,
      })
      return NextResponse.json({ ok: true, replay: executed.result })
    }
    const executed = await commandBus.execute<
      ReconcileProviderOperationCommandInput,
      GtmOperatorReconciliationResult
    >('gtm.provider-operations.reconcile', {
      input: {
        canonicalIdentity: {
          organizationId: noliOrgId,
          userId: noliUser.id,
        },
        operationId: parsed.data.operationId,
        idempotencyKey: parsed.data.idempotencyKey,
        decision: parsed.data.decision,
        evidence: parsed.data.evidence,
      },
      ctx: {
        container,
        auth,
        organizationScope: null,
        selectedOrganizationId: ctx.organizationId,
        organizationIds: [ctx.organizationId],
        request: req,
      },
    })
    return NextResponse.json({
      ok: true,
      operation_id: executed.result.operation.id,
      canonical_status: executed.result.canonicalStatus,
      idempotent: executed.result.idempotent,
    })
  } catch (error) {
    if (error instanceof GtmProviderReconciliationError) {
      if (error.code === 'operation_not_found') return notFound()
      const status =
        error.code === 'already_reconciled' || error.code === 'canonical_status_conflict'
          ? 409
          : 422
      return NextResponse.json({ ok: false, error: error.message, code: error.code }, { status })
    }
    console.error(
      '[internal.gtm.reconciliation]',
      error instanceof Error ? error.message : 'failed',
    )
    return NextResponse.json(
      { ok: false, error: 'Canonical reconciliation unavailable' },
      { status: 503 },
    )
  }
}
