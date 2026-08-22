import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { gtmInternalOpenApi } from '../../openapi'

export const openApi = gtmInternalOpenApi('List scoped GTM plays')
import type { EntityManager } from '@mikro-orm/postgresql'
import { gtmEnabled } from '../../../lib/flags'
import { gtmPlayDetailBodySchema } from '../../../data/validators'
import { shapePlayDetail, isUuid } from '../../../lib/play-shape'

/*
 * Internal GTM play detail (SPEC-066 section 5).
 *
 * The Noli hub calls this server-to-server - proven by the shared
 * NOLI_INTERNAL_SERVICE_SECRET - to render one full typed play. Identity is
 * re-resolved at this boundary (noliUserId -> Clerk -> Mercato auth context,
 * gated on the 'crm' entitlement); the caller's claims about org/tenant
 * ownership are never trusted. Read-only: no rows are written.
 *
 * Opaque 404: a missing, foreign-org, soft-deleted, or malformed playId all
 * produce the identical response, so callers cannot probe other orgs' rows.
 *
 * Public at the dispatcher level (requireAuth: false) - we authenticate with
 * the shared secret instead of a Clerk/JWT session, mirroring
 * internal/import-audience-play.
 */
export const metadata = {
  path: '/internal/gtm/plays',
  POST: { requireAuth: false },
}

function opaqueNotFound() {
  return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
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
  const parsed = gtmPlayDetailBodySchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const where = first?.path?.length ? `${first.path.join('.')}: ` : ''
    return NextResponse.json({ ok: false, error: `${where}${first?.message ?? 'Invalid body'}` }, { status: 400 })
  }

  // A malformed playId can never match a row: answer with the same opaque 404
  // (and skip the DB round-trip / uuid cast error).
  const playId = parsed.data.playId
  if (!isUuid(playId)) {
    return opaqueNotFound()
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
    const { GtmPlay } = await import('../../../data/entities')

    // 5. Self-scoped read: id AND organization_id AND tenant_id AND live.
    //    A foreign or soft-deleted row is indistinguishable from a missing one.
    const play = await em.findOne(GtmPlay, {
      id: playId,
      organizationId,
      tenantId,
      deletedAt: null,
    })
    if (!play) {
      return opaqueNotFound()
    }

    return NextResponse.json({ ok: true, play: shapePlayDetail(play) })
  } catch (err) {
    console.error('[internal.gtm.plays]', err)
    return NextResponse.json({ ok: false, error: 'Play lookup failed' }, { status: 500 })
  }
}
