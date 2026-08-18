import crypto from 'crypto'
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { gtmInternalOpenApi } from '../../openapi'
import { gtmEnabled } from '../../../lib/flags'
import { gtmPrivacyBodySchema } from '../../../data/validators'
import { GtmDeletionRequest, GtmDsrOperation } from '../../../data/entities'
import type { ExecutionEm } from '../../../lib/execute/schedule'
import { GLOBAL_SUPPRESSION_ORG_ID } from '../../../lib/privacy/constants'
import { isUuid } from '../../../lib/play-shape'

export const openApi = gtmInternalOpenApi('Read redacted GTM removal and DSR status')

export const metadata = {
  path: '/internal/gtm/privacy',
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
  const parsed = gtmPrivacyBodySchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'Invalid body' }, { status: 400 })
  }
  if (!isUuid(parsed.data.requestId)) return notFound()

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
    }
    const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
    const container = await createRequestContainer()
    const { hasGtmFeature } = await import('../../../lib/authorize')
    if (!(await hasGtmFeature(container, ctx, 'gtm.view'))) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })
    }
    const em = container.resolve('em') as EntityManager as unknown as ExecutionEm
    let request = await em.findOne(GtmDeletionRequest, {
      id: parsed.data.requestId,
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      deletedAt: null,
    })
    if (!request) {
      // The public removal endpoint returns an opaque global intake id only
      // to its trusted caller. Resolve it to this operator's tenant without
      // exposing whether any other tenant was affected.
      const intake = await em.findOne(GtmDeletionRequest, {
        id: parsed.data.requestId,
        organizationId: GLOBAL_SUPPRESSION_ORG_ID,
        deletedAt: null,
      })
      if (intake) {
        request = await em.findOne(GtmDeletionRequest, {
          organizationId: ctx.organizationId,
          tenantId: ctx.tenantId,
          addressHash: intake.addressHash,
          scope: 'tenant_email',
          deletedAt: null,
        })
      }
    }
    if (!request) return notFound()
    const operations = await em.find(GtmDsrOperation, {
      deletionRequestId: request.id,
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      deletedAt: null,
    })
    return NextResponse.json({
      ok: true,
      request: {
        id: request.id,
        status: request.status,
        scope: request.scope,
        legal_hold: request.legalHold,
        requested_at: request.requestedAt,
        due_at: request.dueAt ?? null,
        completed_at: request.completedAt ?? null,
        result_counts: request.resultCounts ?? null,
      },
      operations: operations.map((operation) => ({
        id: operation.id,
        provider: operation.provider,
        kind: operation.kind,
        status: operation.status,
        attempt_count: operation.attemptCount,
        next_attempt_at: operation.nextAttemptAt ?? null,
        completed_at: operation.completedAt ?? null,
      })),
    })
  } catch (error) {
    console.error('[internal.gtm.privacy]', error instanceof Error ? error.message : 'failed')
    return NextResponse.json({ ok: false, error: 'Privacy status failed' }, { status: 500 })
  }
}
