import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { internalServiceBearerAuthorized } from '../../../lib/authorize'
import type { EntityManager } from '@mikro-orm/postgresql'
import { gtmInternalOpenApi } from '../../openapi'
import { gtmEnabled } from '../../../lib/flags'
import { gtmSocialConnectionsBodySchema } from '../../../data/validators'
import { isUuid } from '../../../lib/play-shape'
import {
  THREADS_PROVIDER,
  THREADS_REQUIRED_SCOPES,
  threadsAppConfig,
  threadsAuthorizeUrl,
} from '../../../lib/adapters/threads/connection'
import {
  threadsConnectionEnabled,
  threadsKeywordSearchEnabled,
} from '../../../lib/adapters/threads/keyword-search-opportunity-source'
import { threadsCallbackUrl, validatedReturnTo, THREADS_OAUTH_STATE_KIND } from '../../../lib/social/threads-oauth'

export const openApi = gtmInternalOpenApi('Manage official social-platform connections for GTM sources')

/*
 * Internal GTM social connections (official Threads keyword search).
 *
 * The Noli hub calls this server-to-server, proven by the shared
 * NOLI_INTERNAL_SERVICE_SECRET. Identity is re-resolved at this boundary
 * (noliUserId -> Clerk -> Mercato auth context); the caller's claims about
 * org/tenant ownership are never trusted.
 *
 * Ops (body.op):
 * - 'list'                  connections for the resolved org (no token material)
 * - 'threads-connect-start' mints a signed OAuth state and returns the Meta
 *                           authorization URL; the public callback finishes it
 * - 'disconnect'            soft-deletes one connection of the resolved org
 */
export const metadata = {
  path: '/internal/gtm/social-connections',
  POST: { requireAuth: false },
}

function opaqueNotFound() {
  return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
}

export async function POST(req: Request) {
  if (!gtmEnabled()) return opaqueNotFound()

  // Byte-length guarded constant-time compare (lib/authorize.ts).
  if (!internalServiceBearerAuthorized(req)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const raw = await req.json().catch(() => ({}))
  const parsed = gtmSocialConnectionsBodySchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const where = first?.path?.length ? `${first.path.join('.')}: ` : ''
    return NextResponse.json({ ok: false, error: `${where}${first?.message ?? 'Invalid body'}` }, { status: 400 })
  }
  const body = parsed.data

  try {
    const { findNoliUserById, findPrimaryOrgIdForUser } = await import(
      '@open-mercato/shared/lib/noli/core-client'
    )
    const noliUser = await findNoliUserById(body.noliUserId)
    if (!noliUser?.clerk_user_id) {
      return NextResponse.json({ ok: false, error: 'Noli user not found' }, { status: 404 })
    }
    const noliOrgId = await findPrimaryOrgIdForUser(noliUser.id)
    if (!noliOrgId) {
      return NextResponse.json({ ok: false, error: 'Noli organization is not available' }, { status: 503 })
    }
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
    const { hasGtmFeature, socialConnectionFeatureForOp } = await import('../../../lib/authorize')
    if (!(await hasGtmFeature(container, { organizationId, tenantId, userId }, socialConnectionFeatureForOp(body.op)))) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })
    }
    const em = container.resolve('em') as EntityManager
    const { GtmSocialConnection } = await import('../../../data/entities')

    if (body.op === 'list') {
      const rows = await em.find(
        GtmSocialConnection,
        { organizationId, tenantId, deletedAt: null },
        { orderBy: { createdAt: 'desc' }, limit: 20 },
      )
      return NextResponse.json({
        ok: true,
        threads_available: threadsConnectionEnabled(),
        threads_search_approved: threadsKeywordSearchEnabled(),
        connections: rows.map((row) => ({
          id: row.id,
          provider: row.provider,
          username: row.username ?? null,
          display_name: row.displayName ?? null,
          status: row.status,
          status_reason: row.statusReason ?? null,
          scopes: Array.isArray(row.scopes) ? row.scopes : [],
          keyword_search_granted: Array.isArray(row.scopes) && row.scopes.includes('threads_keyword_search'),
          token_expires_at: row.tokenExpiresAt ?? null,
          last_used_at: row.lastUsedAt ?? null,
          connected_at: row.createdAt,
        })),
      })
    }

    if (body.op === 'threads-connect-start') {
      if (!threadsConnectionEnabled()) {
        return NextResponse.json(
          { ok: false, error: 'Threads connections are not enabled for this deployment', code: 'threads_disabled' },
          { status: 422 },
        )
      }
      const app = threadsAppConfig()
      if (!app) {
        return NextResponse.json({ ok: false, error: 'Threads app is not configured' }, { status: 503 })
      }
      const returnTo = validatedReturnTo(body.return_to)
      if (!returnTo) {
        return NextResponse.json({ ok: false, error: 'return_to must be an https URL on a Noli domain' }, { status: 400 })
      }
      const { signOAuthState } = await import('@/lib/oauth-state')
      const state = signOAuthState({
        kind: THREADS_OAUTH_STATE_KIND,
        organizationId,
        tenantId,
        userId,
        returnTo,
        nonce: crypto.randomBytes(12).toString('base64url'),
      })
      return NextResponse.json({
        ok: true,
        authorize_url: threadsAuthorizeUrl({ appId: app.appId, redirectUri: threadsCallbackUrl(), state }),
        scopes: [...THREADS_REQUIRED_SCOPES],
      })
    }

    if (body.op === 'disconnect') {
      if (!isUuid(body.connectionId)) return opaqueNotFound()
      const row = await em.findOne(GtmSocialConnection, {
        id: body.connectionId,
        organizationId,
        tenantId,
        provider: THREADS_PROVIDER,
        deletedAt: null,
      })
      if (!row) return opaqueNotFound()
      row.status = 'disconnected'
      row.statusReason = 'disconnected_by_customer'
      row.deletedAt = new Date()
      // Drop the sealed token immediately; the row stays only as an audit stub.
      row.accessTokenSealed = ''
      await em.persistAndFlush(row)
      return NextResponse.json({ ok: true, connection: { id: row.id, status: row.status } })
    }

    return NextResponse.json({ ok: false, error: 'Unsupported op' }, { status: 400 })
  } catch (error) {
    console.error('[internal.gtm.social-connections] failed', error)
    return NextResponse.json({ ok: false, error: 'Internal error' }, { status: 500 })
  }
}
