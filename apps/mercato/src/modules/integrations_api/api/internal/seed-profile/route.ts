import crypto from 'crypto'
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'

/*
 * Internal connectivity endpoint (Noli U-1: one scan, five configured products).
 *
 * The Noli hub calls this server-to-server — proven by the shared
 * NOLI_INTERNAL_SERVICE_SECRET — after the customer completes the one-time
 * platform setup scan. It pre-seeds the org's CRM business profile (pipeline
 * stages, brand, socials, services) so the CRM welcome flow opens already
 * configured instead of empty.
 *
 * Merge semantics: never clobber what the user already set. If onboarding is
 * already complete this is a no-op; otherwise only currently-empty fields are
 * filled in.
 */
export const metadata = {
  path: '/internal/seed-profile',
  POST: { requireAuth: false },
}

export async function POST(req: Request) {
  // 1. Shared-secret auth (same pattern as /internal/provision-key)
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
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const str = (v: unknown, max = 600) =>
    typeof v === 'string' ? v.trim().slice(0, max) : ''
  const arr = (v: unknown, max = 10) =>
    (Array.isArray(v) ? v : [])
      .map((x) => (typeof x === 'string' ? x.trim().slice(0, 120) : ''))
      .filter(Boolean)
      .slice(0, max)
  const rec = (v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

  const noliUserId = str(body.noliUserId, 80)
  if (!noliUserId) {
    return NextResponse.json({ ok: false, error: 'noliUserId required' }, { status: 400 })
  }

  try {
    // 3. noli-core user → Clerk id → Mercato auth context (provisions user+org
    //    on first contact; gates on the 'crm' entitlement)
    const { findNoliUserById } = await import('@open-mercato/shared/lib/noli/core-client')
    const noliUser = await findNoliUserById(noliUserId)
    if (!noliUser?.clerk_user_id) {
      return NextResponse.json({ ok: false, error: 'Noli user not found' }, { status: 404 })
    }
    const { resolveClerkUserToAuthContext } = await import(
      '@open-mercato/shared/lib/auth/clerk'
    )
    const auth = await resolveClerkUserToAuthContext(noliUser.clerk_user_id)
    if (!auth || !auth.userId || !auth.orgId || !auth.tenantId) {
      return NextResponse.json({ ok: false, error: 'User has no CRM access' }, { status: 403 })
    }

    const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
    const { CustomerBusinessProfile } = await import(
      '@open-mercato/core/modules/customers/data/entities'
    )

    const existing = await em.findOne(CustomerBusinessProfile, {
      organizationId: auth.orgId as string,
      tenantId: auth.tenantId as string,
    })
    if (existing?.onboardingComplete) {
      return NextResponse.json({ ok: true, seeded: false, reason: 'onboarding already complete' })
    }

    // 4. Build the upsert input: incoming values fill only EMPTY fields.
    const has = (v: unknown) =>
      Array.isArray(v) ? v.length > 0 : v && typeof v === 'object' ? Object.keys(v).length > 0 : Boolean(v)
    const input: Record<string, unknown> = {
      tenantId: auth.tenantId,
      organizationId: auth.orgId,
    }
    const put = (key: string, existingVal: unknown, incoming: unknown) => {
      if (!has(existingVal) && has(incoming)) input[key] = incoming
    }
    put('businessName', existing?.businessName, str(body.businessName, 200))
    put('businessType', existing?.businessType, str(body.businessType, 40))
    put('businessDescription', existing?.businessDescription, str(body.businessDescription, 600))
    put('idealClients', existing?.idealClients, str(body.idealClients, 1200))
    put('websiteUrl', existing?.websiteUrl, str(body.websiteUrl, 300))
    put('detectedServices', existing?.detectedServices, arr(body.detectedServices, 10))
    put(
      'pipelineStages',
      existing?.pipelineStages,
      arr(body.pipelineStages, 6).map((name) => ({ name })),
    )
    put('pipelineMode', existing?.pipelineMode, body.pipelineMode === 'journey' ? 'journey' : body.pipelineMode === 'deals' ? 'deals' : '')
    put('brandColors', existing?.brandColors, rec(body.brandColors))
    put('socialLinks', existing?.socialLinks, rec(body.socialLinks))

    if (Object.keys(input).length <= 2) {
      return NextResponse.json({ ok: true, seeded: false, reason: 'nothing to fill' })
    }

    // 5. Upsert through the same command the authed PUT route uses.
    const { businessProfileUpsertSchema } = await import(
      '@open-mercato/core/modules/customers/data/validators'
    )
    const parsed = businessProfileUpsertSchema.parse(input)
    const commandBus = container.resolve('commandBus') as {
      execute: (name: string, payload: unknown) => Promise<unknown>
    }
    await commandBus.execute('customers.business_profile.upsert', {
      input: parsed,
      ctx: { container, auth, request: req },
    })

    return NextResponse.json({ ok: true, seeded: true })
  } catch (err) {
    console.error('[internal.seed-profile]', err)
    return NextResponse.json({ ok: false, error: 'Seed failed' }, { status: 500 })
  }
}
