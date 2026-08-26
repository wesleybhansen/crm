import crypto from 'crypto'
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import {
  buildCrmFirstValueDraft,
  buildNoliOnboardingSeed,
  gtmBusinessContext,
  gtmIcpStarter,
  gtmVoiceStarter,
  isLegacyNoliFirstValueTemplate,
  NOLI_FIRST_VALUE_TEMPLATE_MARKER,
  type NoliOnboardingSeed,
} from '../../../lib/onboarding-seed'

/*
 * Internal connectivity endpoint (Noli U-1: one scan, five configured products).
 *
 * The Noli hub calls this server-to-server — proven by the shared
 * NOLI_INTERNAL_SERVICE_SECRET — after the customer completes the one-time
 * platform setup scan. It pre-seeds the org's CRM business profile (pipeline
 * stages, brand, socials, services) so the CRM welcome flow opens already
 * configured instead of empty.
 *
 * Merge semantics: never clobber what the user already set. Empty CRM fields
 * are filled once, while confirmed Intel Hub context can refresh the GTM
 * starter without overwriting customer-authored ICP or voice versions.
 */
export const metadata = {
  path: '/internal/seed-profile',
  POST: { requireAuth: false },
}

type GtmSeedReceipt = {
  status: 'ready' | 'not_entitled' | 'disabled' | 'failed'
  workspaceId?: string
  workspaceCreated?: boolean
  icpDraftCreated?: boolean
  voiceDraftCreated?: boolean
}

async function ensureGtmStarter(
  container: { resolve: (name: string) => unknown },
  em: EntityManager,
  auth: { orgId?: unknown; tenantId?: unknown; userId?: unknown },
  seed: NoliOnboardingSeed,
  requestId: string | null,
): Promise<GtmSeedReceipt> {
  try {
    const { gtmEnabled } = await import('@/modules/gtm/lib/flags')
    if (!gtmEnabled()) return { status: 'disabled' }
    const organizationId = auth.orgId as string
    const tenantId = auth.tenantId as string
    const userId = auth.userId as string
    const { hasGtmFeature } = await import('@/modules/gtm/lib/authorize')
    if (!(await hasGtmFeature(container as never, { organizationId, tenantId, userId }, 'gtm.edit'))) {
      return { status: 'not_entitled' }
    }

    const { GtmWorkspace, GtmAuditEvent } = await import('@/modules/gtm/data/entities')
    let workspace = await em.findOne(
      GtmWorkspace,
      { organizationId, tenantId, deletedAt: null },
      { orderBy: { createdAt: 'asc' } },
    )
    const workspaceCreated = !workspace
    if (!workspace) {
      workspace = em.create(GtmWorkspace, {
        id: crypto.randomUUID(),
        organizationId,
        tenantId,
        name: seed.businessName ? `${seed.businessName} growth` : 'Growth workspace',
        status: 'active',
        settings: { default: true },
      })
      em.persist(workspace)
      em.persist(em.create(GtmAuditEvent, {
        id: crypto.randomUUID(), organizationId, tenantId, actor: 'agent',
        action: 'gtm.workspace.onboarding_seeded', objectType: 'gtm_workspace', objectId: workspace.id,
        requestId, metadata: { source: 'noli_intel_hub', context_version: seed.contextVersion },
      }))
    }
    workspace.businessContext = {
      ...(workspace.businessContext ?? {}),
      ...gtmBusinessContext(seed),
    }
    await em.flush()

    const { listVersions, createVersion } = await import('@/modules/gtm/lib/versions')
    const ctx = { organizationId, tenantId, userId }
    const provenance = { source: 'noli_intel_hub', status: 'unverified', context_version: seed.contextVersion }
    const icpExisting = await listVersions(em as never, ctx, 'icp', workspace.id)
    const voiceExisting = await listVersions(em as never, ctx, 'voice', workspace.id)
    let icpDraftCreated = false
    let voiceDraftCreated = false
    if (icpExisting.length === 0) {
      await createVersion(em as never, ctx, 'icp', {
        workspaceId: workspace.id,
        content: gtmIcpStarter(seed),
        author: 'agent',
        provenance,
      })
      icpDraftCreated = true
    }
    if (voiceExisting.length === 0) {
      await createVersion(em as never, ctx, 'voice', {
        workspaceId: workspace.id,
        content: gtmVoiceStarter(seed),
        author: 'agent',
        provenance,
        derivedFrom: { source: 'noli_intel_hub', context_version: seed.contextVersion },
      })
      voiceDraftCreated = true
    }
    return { status: 'ready', workspaceId: workspace.id, workspaceCreated, icpDraftCreated, voiceDraftCreated }
  } catch (error) {
    console.error('[internal.seed-profile] GTM starter failed', error)
    return { status: 'failed' }
  }
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
  const onboardingSeed = buildNoliOnboardingSeed(body)

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
    // 4. Build the upsert input: incoming values fill only EMPTY fields.
    const has = (v: unknown) =>
      Array.isArray(v) ? v.length > 0 : v && typeof v === 'object' ? Object.keys(v).length > 0 : Boolean(v)
    const input: Record<string, unknown> = {
      tenantId: auth.tenantId,
      organizationId: auth.orgId,
    }
    if (!existing?.onboardingComplete) input.onboardingComplete = true
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

    // U-52: the audit's drafted follow-up email becomes a real, reusable
    // email template (idempotent by name; never duplicates).
    let templateCreated = false
    let templateUpdated = false
    let templateReady = false
    const firstValueDraft = buildCrmFirstValueDraft(onboardingSeed)
    const hasFirstValueContext = Boolean(
      onboardingSeed.businessName || onboardingSeed.businessDescription || onboardingSeed.idealClients,
    )
    if (hasFirstValueContext) {
      try {
        const { EmailTemplate } = await import('@/modules/email/data/schema')
        const name = 'Follow-up: new inquiry (drafted by your Noli team)'
        const prior = await em.findOne(EmailTemplate, {
          organizationId: auth.orgId as string,
          tenantId: auth.tenantId as string,
          name,
          deletedAt: null,
        })
        const esc = (value: string) =>
          value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        const bodyHtml = [
          NOLI_FIRST_VALUE_TEMPLATE_MARKER,
          ...firstValueDraft.body
            .split(/\n{2,}/)
            .map((paragraph) => `<p>${esc(paragraph).replace(/\n/g, '<br>')}</p>`),
        ].join('\n')
        if (prior) {
          if (isLegacyNoliFirstValueTemplate(prior.subject, prior.bodyHtml)) {
            prior.subject = firstValueDraft.subject
            prior.bodyHtml = bodyHtml
            await em.flush()
            templateUpdated = true
          }
          templateReady = true
        } else {
          const tpl = new EmailTemplate()
          tpl.tenantId = auth.tenantId as string
          tpl.organizationId = auth.orgId as string
          tpl.name = name
          tpl.subject = firstValueDraft.subject
          tpl.bodyHtml = bodyHtml
          tpl.category = 'sequence'
          await em.persistAndFlush(tpl)
          templateCreated = true
          templateReady = true
        }
      } catch (err) {
        console.error('[internal.seed-profile] template create failed', err)
      }
    }

    // 5. Upsert through the same command the authed PUT route uses.
    let profileSeeded = false
    if (Object.keys(input).length > 2) {
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
      profileSeeded = true
    }

    const gtm = await ensureGtmStarter(
      container as { resolve: (name: string) => unknown },
      em,
      auth,
      onboardingSeed,
      req.headers.get('x-request-id'),
    )
    return NextResponse.json({
      ok: true,
      seeded: true,
      created: profileSeeded || templateCreated || Boolean(gtm.workspaceCreated || gtm.icpDraftCreated || gtm.voiceDraftCreated),
      updated: templateUpdated,
      template: templateReady,
      firstValue: {
        crm: {
          status: templateReady ? 'ready' : 'context_seeded',
          onboardingComplete: true,
          pipelineConfigured: has(existing?.pipelineStages) || has(input.pipelineStages),
          followUpDraftReady: templateReady,
        },
        gtm,
      },
    })
  } catch (err) {
    console.error('[internal.seed-profile]', err)
    return NextResponse.json({ ok: false, error: 'Seed failed' }, { status: 500 })
  }
}
