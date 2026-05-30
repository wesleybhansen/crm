import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'

/*
 * Internal connectivity endpoint (Noli App-Connectivity, Option A).
 *
 * A sibling Noli app (e.g. AMS) calls this server-to-server — proven by the
 * shared NOLI_INTERNAL_SERVICE_SECRET — to mint a CRM API key for one of its
 * users, so the user never has to hand-paste a CRM key. The minted key is a
 * normal Mercato `api_keys` row scoped to the user's (team-shared) org with the
 * user's own roles, so it works against the existing `/api/ext/*` surface.
 *
 * Public at the dispatcher level (requireAuth: false) — we authenticate with
 * the shared secret instead of a Clerk/JWT session.
 */
export const metadata = {
  path: '/internal/provision-key',
  POST: { requireAuth: false },
}

export async function POST(req: Request) {
  // 1. Shared-secret auth (constant prefix compare; the secret is high-entropy)
  const secret = process.env.NOLI_INTERNAL_SERVICE_SECRET
  const authHeader = (req.headers.get('authorization') || '').trim()
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  // 2. Body
  const body = (await req.json().catch(() => ({}))) as {
    noliUserId?: unknown
    source?: unknown
  }
  const noliUserId = typeof body.noliUserId === 'string' ? body.noliUserId.trim() : ''
  const source =
    typeof body.source === 'string' && body.source.trim() ? body.source.trim() : 'platform'
  if (!noliUserId) {
    return NextResponse.json({ ok: false, error: 'noliUserId required' }, { status: 400 })
  }

  try {
    // 3. noli-core user → Clerk id
    const { findNoliUserById } = await import('@open-mercato/shared/lib/noli/core-client')
    const noliUser = await findNoliUserById(noliUserId)
    if (!noliUser?.clerk_user_id) {
      return NextResponse.json({ ok: false, error: 'Noli user not found' }, { status: 404 })
    }

    // 4. Resolve to a Mercato auth context. This provisions the Mercato
    //    user+org on first contact and gates on the 'crm' entitlement (returns
    //    null if the user has no CRM access) — same path a Clerk session takes.
    const { resolveClerkUserToAuthContext } = await import(
      '@open-mercato/shared/lib/auth/clerk'
    )
    const auth = await resolveClerkUserToAuthContext(noliUser.clerk_user_id)
    if (!auth || !auth.userId || !auth.orgId) {
      return NextResponse.json(
        { ok: false, error: 'User has no CRM access' },
        { status: 403 },
      )
    }

    const { createRequestContainer } = await import(
      '@open-mercato/shared/lib/di/container'
    )
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const { UserRole } = await import('@open-mercato/core/modules/auth/data/entities')
    const { ApiKey } = await import('@open-mercato/core/modules/api_keys/data/entities')

    // 5. Mirror the user's own roles onto the key (admin → integrations_api.*),
    //    so the key has exactly the access the user does — nothing more.
    const roleLinks = await em.find(
      UserRole,
      { user: auth.userId as string, deletedAt: null },
      { populate: ['role'] },
    )
    const roleIds = roleLinks
      .map((l) => l.role?.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)

    // 6. Idempotent re-mint: revoke any prior auto-minted key for this org+source
    //    (soft delete) so re-provisioning never accumulates live keys.
    const keyName = `platform-auto:${source}`
    const prior = await em.find(ApiKey, {
      organizationId: auth.orgId as string,
      name: keyName,
      deletedAt: null,
    })
    if (prior.length) {
      const now = new Date()
      for (const k of prior) k.deletedAt = now
      await em.persistAndFlush(prior)
    }

    // 7. Mint
    const { createApiKey } = await import(
      '@open-mercato/core/modules/api_keys/services/apiKeyService'
    )
    const { record, secret: mintedKey } = await createApiKey(em, {
      name: keyName,
      description: `Auto-minted for Noli ${source} connectivity`,
      tenantId: (auth.tenantId as string | null) ?? null,
      organizationId: auth.orgId as string,
      roles: roleIds,
      createdBy: auth.userId as string,
    })

    const baseUrl = (process.env.APP_URL || 'https://crm.noliai.com').replace(/\/$/, '')
    return NextResponse.json({
      ok: true,
      data: { key: mintedKey, keyPrefix: record.keyPrefix, baseUrl },
    })
  } catch (err) {
    console.error('[internal.provision-key]', err)
    return NextResponse.json({ ok: false, error: 'Provision failed' }, { status: 500 })
  }
}
