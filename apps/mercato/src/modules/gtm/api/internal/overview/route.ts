import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { gtmInternalOpenApi } from '../../openapi'

export const openApi = gtmInternalOpenApi('Read the scoped GTM overview')
import type { EntityManager } from '@mikro-orm/postgresql'
import { gtmEnabled } from '../../../lib/flags'
import { gtmOverviewBodySchema } from '../../../data/validators'
import { shapePlaySummary, buildPlayCounts } from '../../../lib/play-shape'

/*
 * Internal GTM overview (SPEC-066 section 5).
 *
 * The Noli hub calls this server-to-server - proven by the shared
 * NOLI_INTERNAL_SERVICE_SECRET - to render the user's GTM workspace summary.
 * Identity is re-resolved at this boundary (noliUserId -> Clerk -> Mercato
 * auth context, gated on the 'crm' entitlement); the caller's claims about
 * org/tenant ownership are never trusted. Read-only: no rows are written.
 *
 * Public at the dispatcher level (requireAuth: false) - we authenticate with
 * the shared secret instead of a Clerk/JWT session, mirroring
 * internal/import-audience-play.
 */
export const metadata = {
  path: '/internal/gtm/overview',
  POST: { requireAuth: false },
}

const PLAYS_CAP = 50

export async function POST(req: Request) {
  // 0. Feature gate: the GTM Engineer ships dark; flag-off fails closed.
  if (!gtmEnabled()) {
    return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
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
  const parsed = gtmOverviewBodySchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const where = first?.path?.length ? `${first.path.join('.')}: ` : ''
    return NextResponse.json({ ok: false, error: `${where}${first?.message ?? 'Invalid body'}` }, { status: 400 })
  }

  try {
    // 3. noli-core user -> Clerk id
    const { findNoliUserById } = await import('@open-mercato/shared/lib/noli/core-client')
    const noliUser = await findNoliUserById(parsed.data.noliUserId)
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
    if (!(await hasGtmFeature(container, { organizationId, tenantId, userId }, 'gtm.view'))) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })
    }
    const em = container.resolve('em') as EntityManager
    const { GtmWorkspace, GtmPlay } = await import('../../../data/entities')

    // 5. Self-scoped reads: organization_id + tenant_id on every query,
    //    soft-deleted rows excluded. The org's default workspace is the
    //    oldest live one (same rule the import route uses to pick it).
    const workspace = await em.findOne(
      GtmWorkspace,
      { organizationId, tenantId, deletedAt: null },
      { orderBy: { createdAt: 'asc' } },
    )

    const plays = await em.find(
      GtmPlay,
      { organizationId, tenantId, deletedAt: null },
      { orderBy: { createdAt: 'desc' }, limit: PLAYS_CAP },
    )

    // Counts cover ALL live plays, not just the capped list.
    const allEligibilities = await em.find(
      GtmPlay,
      { organizationId, tenantId, deletedAt: null },
      { fields: ['id', 'executionEligibility'] },
    )

    const { readWorkspacePostalAddress } = await import('../../../lib/workspace-settings')
    const postalAddress = readWorkspacePostalAddress(workspace)

    return NextResponse.json({
      ok: true,
      workspace: workspace
        ? {
            id: workspace.id,
            name: workspace.name,
            status: workspace.status,
            // The signed-in customer's own sender address. The Hub uses this
            // to make the workspace-level compliance setting editable before
            // campaign creation; it is never replaced with a Noli default.
            postal_address: postalAddress,
            postal_address_set: postalAddress != null,
          }
        : null,
      plays: plays.map((play) => shapePlaySummary(play)),
      counts: buildPlayCounts(allEligibilities.map((row) => row.executionEligibility)),
    })
  } catch (err) {
    console.error('[internal.gtm.overview]', err)
    return NextResponse.json({ ok: false, error: 'Overview failed' }, { status: 500 })
  }
}
