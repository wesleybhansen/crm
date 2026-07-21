import crypto from 'crypto'
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
  const expected = secret ? `Bearer ${secret}` : ''
  if (
    !secret ||
    authHeader.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))
  ) {
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
  if (!noliUserId || noliUserId.length > 256) {
    return NextResponse.json({ ok: false, error: 'noliUserId required' }, { status: 400 })
  }
  if (source.length > 128) {
    return NextResponse.json({ ok: false, error: 'source is too long' }, { status: 400 })
  }

  try {
    // 3. Establish a positive entitlement result before invoking the existing
    //    resolver. That resolver intentionally collapses denial and transient
    //    provisioning failures to null, which is not a durable removal signal.
    const { findNoliUserById, findPrimaryOrgIdForUser, isEntitled } =
      await import('@open-mercato/shared/lib/noli/core-client')
    const noliUser = await findNoliUserById(noliUserId)
    if (!noliUser?.clerk_user_id) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Noli identity is not available',
          code: 'noli_identity_unavailable',
        },
        { status: 503 },
      )
    }
    const entitled = await isEntitled(noliUser.id, 'crm')
    if (!entitled) {
      return NextResponse.json(
        {
          ok: false,
          error: 'CRM entitlement is inactive',
          code: 'entitlement_lapsed',
          remove: true,
        },
        { status: 403 },
      )
    }
    const noliOrgId = await findPrimaryOrgIdForUser(noliUser.id)
    if (!noliOrgId) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Noli organization link is not available',
          code: 'noli_org_unavailable',
        },
        { status: 503 },
      )
    }

    // 4. Resolve to a Mercato auth context. This provisions the Mercato
    //    user+org on first contact. A null here is indeterminate because the
    //    resolver also returns null on noli-core and local provisioning errors.
    const { resolveClerkUserToAuthContext } = await import('@open-mercato/shared/lib/auth/clerk')
    const auth = await resolveClerkUserToAuthContext(noliUser.clerk_user_id)
    if (
      !auth ||
      !auth.userId ||
      !auth.orgId ||
      (typeof auth.noliUserId === 'string' && auth.noliUserId !== noliUser.id)
    ) {
      return NextResponse.json(
        {
          ok: false,
          error: 'CRM identity provisioning is not available',
          code: 'crm_identity_unavailable',
        },
        { status: 503 },
      )
    }

    const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const { User, UserRole } = await import('@open-mercato/core/modules/auth/data/entities')
    const { Organization } = await import('@open-mercato/core/modules/directory/data/entities')

    const localUser = await em.findOne(User, {
      id: auth.userId as string,
      tenantId: (auth.tenantId as string | null) ?? null,
      organizationId: auth.orgId as string,
      clerkUserId: noliUser.clerk_user_id,
      isConfirmed: true,
      deletedAt: null,
    })
    const localOrg = await em.findOne(Organization, {
      id: auth.orgId as string,
      isActive: true,
      deletedAt: null,
    })
    if (!localUser || !localOrg || localOrg.noliOrgId !== noliOrgId) {
      return NextResponse.json(
        {
          ok: false,
          error: 'CRM organization link is not available',
          code: 'crm_org_unavailable',
        },
        { status: 503 },
      )
    }

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

    // 6. A dedicated HMAC secret makes the credential recoverable but keeps
    //    plaintext out of the database. It must be present before rollout.
    const derivationSecret = process.env.NOLI_COS_CREDENTIAL_DERIVATION_SECRET?.trim()
    if (!derivationSecret) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Credential provisioning is not configured',
          code: 'credential_config_unavailable',
        },
        { status: 503 },
      )
    }

    // 7. Same user+source+version requests are stable. A version increase is
    //    serialized and gives only that user's previous key bounded overlap.
    const {
      getPlatformAutoCredentialVersion,
      getPlatformAutoOverlapSeconds,
      provisionPlatformAutoApiKey,
    } = await import('@open-mercato/core/modules/api_keys/services/platformAutoKeyService')
    const version = getPlatformAutoCredentialVersion(process.env.NOLI_COS_CRM_KEY_VERSION)
    const overlapSeconds = getPlatformAutoOverlapSeconds(
      process.env.NOLI_COS_CRM_KEY_OVERLAP_SECONDS,
    )
    const provisioned = await provisionPlatformAutoApiKey(em, {
      noliUserId: noliUser.id,
      source,
      version,
      derivationSecret,
      overlapSeconds,
      tenantId: (auth.tenantId as string | null) ?? null,
      organizationId: auth.orgId as string,
      roles: roleIds,
      createdBy: auth.userId as string,
    })

    // Role IDs live on the managed API-key rows and RBAC caches their expanded
    // ACL. Best-effort invalidation after commit normally makes a role downgrade
    // immediate; if the cache is unavailable, its normal five-minute TTL is the
    // bound. Tenant-scoped invalidation also reaches a predecessor retained for
    // the short rotation overlap.
    const tenantId = (auth.tenantId as string | null) ?? null
    try {
      const rbacService = container.resolve('rbacService') as {
        invalidateTenantCache: (tenantId: string) => Promise<void>
        invalidateAllCache: () => Promise<void>
      }
      if (tenantId) await rbacService.invalidateTenantCache(tenantId)
      else await rbacService.invalidateAllCache()
    } catch {
      // The credential transaction is already committed. Withholding its
      // deterministic secret here could let the predecessor expire before the
      // Hub ever receives the replacement. RBAC cache entries have a bounded
      // TTL, while entitlement and org membership still fail closed per use.
      console.warn('[internal.provision-key] RBAC cache invalidation failed')
    }

    const baseUrl = (process.env.APP_URL || 'https://crm.noliai.com').replace(/\/$/, '')
    return NextResponse.json({
      ok: true,
      data: {
        key: provisioned.secret,
        keyPrefix: provisioned.record.keyPrefix,
        baseUrl,
        credentialVersion: provisioned.version,
        overlapSeconds: provisioned.overlapSeconds,
        reused: provisioned.reused,
      },
    })
  } catch (err) {
    console.error('[internal.provision-key]', err)
    return NextResponse.json({ ok: false, error: 'Provision failed' }, { status: 500 })
  }
}
