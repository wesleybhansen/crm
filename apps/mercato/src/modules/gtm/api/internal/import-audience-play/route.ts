import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { gtmInternalOpenApi } from '../../openapi'

export const openApi = gtmInternalOpenApi('Import an Audience Play into GTM')
import type { EntityManager } from '@mikro-orm/postgresql'
import { UniqueConstraintViolationException } from '@mikro-orm/core'
import { gtmEnabled } from '../../../lib/flags'
import { parseImportAudiencePlayBody, buildImportedPlayValues } from '../../../lib/import-play'

/*
 * Internal Audience Plays import bridge (SPEC-066 section 5, GTM-SPEC-01
 * section 3.1(6)).
 *
 * The Noli hub calls this server-to-server - proven by the shared
 * NOLI_INTERNAL_SERVICE_SECRET - after a user imports an Audience Plays
 * report. Identity is re-resolved at this boundary (noliUserId -> Clerk ->
 * Mercato auth context, gated on the 'crm' entitlement); the caller's claims
 * about org/tenant ownership are never trusted. Execution eligibility is
 * recomputed server-side and the caller's value is discarded (section 7).
 *
 * Idempotent: re-importing the same play from the same report returns the
 * existing play (enforced by a partial unique index). Distinct plays in one
 * report remain distinct records.
 *
 * Public at the dispatcher level (requireAuth: false) - we authenticate with
 * the shared secret instead of a Clerk/JWT session, mirroring
 * integrations_api/api/internal/provision-key.
 */
export const metadata = {
  path: '/internal/gtm/import-audience-play',
  POST: { requireAuth: false },
}

export async function POST(req: Request) {
  // 0. Operational kill switch: customer release is live; flag-off fails closed.
  if (!gtmEnabled()) {
    return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
  }

  // 1. Shared-secret auth (length-guarded constant-time compare)
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

  // 2. Body
  const raw = await req.json().catch(() => ({}))
  const parsed = parseImportAudiencePlayBody(raw)
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 })
  }
  const body = parsed.body

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
    const { hasGtmFeature } = await import('../../../lib/authorize')
    if (!(await hasGtmFeature(container, { organizationId, tenantId, userId }, 'gtm.edit'))) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })
    }
    const em = container.resolve('em') as EntityManager
    const { GtmWorkspace, GtmPlay, GtmAuditEvent } = await import('../../../data/entities')

    const values = buildImportedPlayValues(body.play, body.likely_buyer ?? null, body.report_token_hash)
    const requestId = req.headers.get('x-request-id')

    // 5. Idempotent short-circuit: same report + stable play identity returns
    //    the existing play. Self-scoped by organization_id + tenant_id.
    const existing = await em.findOne(GtmPlay, {
      organizationId,
      tenantId,
      importedReportTokenHash: values.importedReportTokenHash,
      importedPlayKey: values.importedPlayKey,
      deletedAt: null,
    })
    if (existing) {
      return NextResponse.json({
        ok: true,
        data: {
          playId: existing.id,
          workspaceId: existing.workspaceId,
          execution_eligibility: existing.executionEligibility,
          eligibility_reason: existing.eligibilityReason ?? null,
          lead_mode: existing.leadMode ?? null,
          research_eligibility: existing.researchEligibility ?? null,
          research_eligibility_reason: existing.researchEligibilityReason ?? null,
          outreach_mode: existing.outreachMode ?? null,
          outreach_policy_reason: existing.outreachPolicyReason ?? null,
          policy_flags: existing.policyFlags ?? [],
          alreadyImported: true,
        },
      })
    }

    try {
      const result = await em.transactional(async (tem) => {
        // 6. Ensure the org's default GTM workspace (oldest live one wins).
        let workspace = await tem.findOne(
          GtmWorkspace,
          { organizationId, tenantId, deletedAt: null },
          { orderBy: { createdAt: 'asc' } },
        )
        if (!workspace) {
          workspace = tem.create(GtmWorkspace, {
            id: crypto.randomUUID(),
            organizationId,
            tenantId,
            name: 'Default workspace',
            status: 'active',
            settings: { default: true },
          })
          tem.persist(workspace)
        }

        // 7. Insert the imported play with server-side recomputed eligibility.
        const play = tem.create(GtmPlay, {
          id: crypto.randomUUID(),
          organizationId,
          tenantId,
          workspaceId: workspace.id,
          ...values,
        })
        tem.persist(play)

        // 8. Audit trail (redacted metadata: the token hash is already a hash).
        const audit = tem.create(GtmAuditEvent, {
          organizationId,
          tenantId,
          actor: 'user_id',
          actorUserId: userId,
          action: 'gtm.play.imported',
          objectType: 'gtm_play',
          objectId: play.id,
          requestId: requestId || null,
          metadata: {
            source: 'audience_plays_import',
            reportTokenHash: values.importedReportTokenHash,
            importedPlayKey: values.importedPlayKey,
            executionEligibility: values.executionEligibility,
            leadMode: values.leadMode,
            researchEligibility: values.researchEligibility,
            outreachMode: values.outreachMode,
            policyFlags: values.policyFlags,
          },
        })
        tem.persist(audit)

        return { play, workspace }
      })

      return NextResponse.json({
        ok: true,
        data: {
          playId: result.play.id,
          workspaceId: result.workspace.id,
          execution_eligibility: result.play.executionEligibility,
          eligibility_reason: result.play.eligibilityReason ?? null,
          lead_mode: result.play.leadMode ?? null,
          research_eligibility: result.play.researchEligibility ?? null,
          research_eligibility_reason: result.play.researchEligibilityReason ?? null,
          outreach_mode: result.play.outreachMode ?? null,
          outreach_policy_reason: result.play.outreachPolicyReason ?? null,
          policy_flags: result.play.policyFlags ?? [],
          alreadyImported: false,
        },
      })
    } catch (err) {
      // Concurrent duplicate import lost the unique-index race: return the winner.
      if (err instanceof UniqueConstraintViolationException) {
        const winner = await em.fork().findOne(GtmPlay, {
          organizationId,
          tenantId,
          importedReportTokenHash: values.importedReportTokenHash,
          importedPlayKey: values.importedPlayKey,
          deletedAt: null,
        })
        if (winner) {
          return NextResponse.json({
            ok: true,
            data: {
              playId: winner.id,
              workspaceId: winner.workspaceId,
              execution_eligibility: winner.executionEligibility,
              eligibility_reason: winner.eligibilityReason ?? null,
              lead_mode: winner.leadMode ?? null,
              research_eligibility: winner.researchEligibility ?? null,
              research_eligibility_reason: winner.researchEligibilityReason ?? null,
              outreach_mode: winner.outreachMode ?? null,
              outreach_policy_reason: winner.outreachPolicyReason ?? null,
              policy_flags: winner.policyFlags ?? [],
              alreadyImported: true,
            },
          })
        }
      }
      throw err
    }
  } catch (err) {
    console.error('[internal.gtm.import-audience-play]', err)
    return NextResponse.json({ ok: false, error: 'Import failed' }, { status: 500 })
  }
}
