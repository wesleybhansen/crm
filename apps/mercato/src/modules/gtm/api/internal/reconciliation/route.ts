import crypto from 'crypto'
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { gtmInternalOpenApi } from '../../openapi'
import { gtmEnabled } from '../../../lib/flags'
import { gtmReconciliationBodySchema } from '../../../data/validators'
import type { CampaignEm } from '../../../lib/campaign/build'
import { isUuid } from '../../../lib/play-shape'
import {
  GtmProviderReconciliationError,
  listProviderOperationsForReconciliation,
  type GtmOperatorReconciliationResult,
} from '../../../lib/reconciliation/operator'
import type { ReconcileProviderOperationCommandInput } from '../../../commands/reconciliation'

export const openApi = gtmInternalOpenApi('List or reconcile ambiguous GTM provider operations')

export const metadata = {
  path: '/internal/gtm/reconciliation',
  POST: { requireAuth: false },
}

const notFound = () => NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })

export async function POST(req: Request) {
  if (!gtmEnabled()) return notFound()
  const secret = process.env.NOLI_INTERNAL_SERVICE_SECRET
  const authorization = (req.headers.get('authorization') || '').trim()
  const expected = secret ? `Bearer ${secret}` : ''
  if (
    !secret ||
    authorization.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))
  ) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  const parsed = gtmReconciliationBodySchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'Invalid body' }, { status: 400 })
  }
  if (parsed.data.op === 'apply' && !isUuid(parsed.data.operationId)) return notFound()

  try {
    const { findNoliUserById } = await import('@open-mercato/shared/lib/noli/core-client')
    const noliUser = await findNoliUserById(parsed.data.noliUserId)
    if (!noliUser?.clerk_user_id) return notFound()
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
    const em = container.resolve('em') as EntityManager as unknown as CampaignEm
    if (parsed.data.op === 'list') {
      const operations = await listProviderOperationsForReconciliation(em, ctx)
      return NextResponse.json({ ok: true, operations })
    }

    const commandBus = container.resolve('commandBus') as CommandBus
    const executed = await commandBus.execute<
      ReconcileProviderOperationCommandInput,
      GtmOperatorReconciliationResult
    >('gtm.provider-operations.reconcile', {
      input: {
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
