import { NextResponse } from 'next/server'
import { internalServiceBearerAuthorized } from '../../../lib/authorize'
import type { EntityManager } from '@mikro-orm/postgresql'
import { gtmInternalOpenApi } from '../../openapi'
import { gtmEnabled } from '../../../lib/flags'
import { gtmPrivacyBodySchema } from '../../../data/validators'
import { GtmDeletionRequest, GtmDsrOperation } from '../../../data/entities'
import type { ExecutionEm } from '../../../lib/execute/schedule'
import { GLOBAL_SUPPRESSION_ORG_ID } from '../../../lib/privacy/constants'
import { isUuid } from '../../../lib/play-shape'

export const openApi = gtmInternalOpenApi('Read redacted GTM removal and DSR status')

/*
 * Ops (body.op):
 * - 'status'                         redacted status of one deletion request
 * - 'list-partial'                   partial requests whose due_at is within
 *                                    within_days (default 7) or already past
 * - 'complete-crm-contact-deletion'  anonymize the promoted CRM contact(s)
 *                                    recorded in the 'crm_customers' DSR op
 *                                    receipt and close that op (gtm.approve)
 * - 'set-legal-hold' / 'clear-legal-hold'  audited hold on a request; the
 *                                    retention sweep and anonymization both
 *                                    honour it (gtm.approve)
 */

export const metadata = {
  path: '/internal/gtm/privacy',
  POST: { requireAuth: false },
}

const notFound = () => NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })

export async function POST(req: Request) {
  if (!gtmEnabled()) return notFound()
  // Byte-length guarded constant-time compare (lib/authorize.ts).
  if (!internalServiceBearerAuthorized(req)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  const parsed = gtmPrivacyBodySchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'Invalid body' }, { status: 400 })
  }
  const body = parsed.data
  if (body.op !== 'list-partial' && !isUuid(body.requestId)) return notFound()

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
    const { hasGtmFeature, privacyFeatureForOp } = await import('../../../lib/authorize')
    if (!(await hasGtmFeature(container, ctx, privacyFeatureForOp(body.op)))) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })
    }
    const em = container.resolve('em') as EntityManager as unknown as ExecutionEm

    if (body.op === 'list-partial') {
      const withinDays = body.within_days ?? 7
      const horizon = new Date(Date.now() + withinDays * 24 * 60 * 60 * 1000)
      const rows = await em.find(GtmDeletionRequest, {
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        status: { $in: ['partial', 'blocked_legal_hold', 'processing', 'pending'] },
        dueAt: { $lte: horizon },
        deletedAt: null,
      })
      return NextResponse.json({
        ok: true,
        within_days: withinDays,
        requests: rows
          .sort((a, b) => (a.dueAt?.getTime() ?? 0) - (b.dueAt?.getTime() ?? 0))
          .slice(0, 100)
          .map((row) => ({
            id: row.id,
            status: row.status,
            scope: row.scope,
            legal_hold: row.legalHold,
            requested_at: row.requestedAt,
            due_at: row.dueAt ?? null,
            overdue: row.dueAt ? row.dueAt.getTime() < Date.now() : false,
          })),
        cap: 100,
      })
    }

    if (body.op === 'complete-crm-contact-deletion') {
      const { completeCrmContactDeletion } = await import('../../../lib/privacy/deletion')
      const { CustomerEntity, CustomerPersonProfile } = await import(
        '@open-mercato/core/modules/customers/data/entities'
      )
      const result = await completeCrmContactDeletion(
        em,
        ctx,
        { contact: CustomerEntity as never, person: CustomerPersonProfile as never },
        { requestId: body.requestId },
      )
      if (!result) return notFound()
      if (result.request.legalHold && !result.alreadyCompleted) {
        return NextResponse.json(
          { ok: false, error: 'Request is under legal hold', code: 'legal_hold' },
          { status: 422 },
        )
      }
      return NextResponse.json({
        ok: true,
        request: { id: result.request.id, status: result.request.status },
        operation: { id: result.operation.id, status: result.operation.status },
        contacts_anonymized: result.contactsAnonymized,
        already_completed: result.alreadyCompleted,
      })
    }

    if (body.op === 'set-legal-hold' || body.op === 'clear-legal-hold') {
      const { setLegalHold } = await import('../../../lib/privacy/deletion')
      const updated = await setLegalHold(em, ctx, {
        requestId: body.requestId,
        hold: body.op === 'set-legal-hold',
        reason: body.reason,
      })
      if (!updated) return notFound()
      return NextResponse.json({
        ok: true,
        request: { id: updated.id, status: updated.status, legal_hold: updated.legalHold },
      })
    }

    let request = await em.findOne(GtmDeletionRequest, {
      id: body.requestId,
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      deletedAt: null,
    })
    if (!request) {
      // The public removal endpoint returns an opaque global intake id only
      // to its trusted caller. Resolve it to this operator's tenant without
      // exposing whether any other tenant was affected.
      const intake = await em.findOne(GtmDeletionRequest, {
        id: body.requestId,
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
