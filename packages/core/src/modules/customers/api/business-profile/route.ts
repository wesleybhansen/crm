/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Business profile API — single-resource (1:1 with organization).
 *
 * Not built with makeCrudRoute because the resource is functionally always-
 * present once an org exists, so it's an upsert flow rather than CRUD. The
 * old raw route at apps/mercato/src/app/api/business-profile/route.ts is
 * deleted by the tier 0 cleanup phase; this is its mercato-native replacement.
 */
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { CustomerBusinessProfile } from '../../data/entities'
import { businessProfileUpsertSchema } from '../../data/validators'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { z } from 'zod'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['customers.business_profile.view'] },
  PUT: { requireAuth: true, requireFeatures: ['customers.business_profile.manage'] },
}

const REVIEW_PLATFORMS = ['google', 'facebook', 'yelp', 'other'] as const

/**
 * Reputation settings (review_url / review_platform) live as raw columns on
 * business_profiles (added by scripts/sql/reputation.sql) and are intentionally
 * not on the ORM entity or upsert command: they are read/written here with knex
 * so this route stays the single touch point. Reads are resilient to the
 * columns not existing yet.
 */
async function readReviewSettings(em: EntityManager, orgId: string): Promise<{ review_url: string | null; review_platform: string | null }> {
  try {
    const row = await em.getKnex()('business_profiles').where('organization_id', orgId).first()
    return {
      review_url: (row as any)?.review_url ?? null,
      review_platform: (row as any)?.review_platform ?? null,
    }
  } catch {
    return { review_url: null, review_platform: null }
  }
}

function extractReviewPatch(body: Record<string, any>): Record<string, string | null> {
  const patch: Record<string, string | null> = {}
  if ('review_url' in body) {
    const v = typeof body.review_url === 'string' ? body.review_url.trim() : ''
    // Only http(s) — this URL is embedded in emails and rendered on the
    // reputation page, so javascript:/data: must never be stored.
    patch.review_url = v && /^https?:\/\//i.test(v) ? v.slice(0, 2048) : null
  }
  if ('review_platform' in body) {
    const v = typeof body.review_platform === 'string' ? body.review_platform.trim().toLowerCase() : ''
    patch.review_platform = (REVIEW_PLATFORMS as readonly string[]).includes(v) ? v : null
  }
  return patch
}

function serializeProfile(bp: CustomerBusinessProfile | null) {
  if (!bp) return null
  return {
    id: bp.id,
    tenant_id: bp.tenantId,
    organization_id: bp.organizationId,
    business_name: bp.businessName,
    business_type: bp.businessType,
    business_description: bp.businessDescription,
    main_offer: bp.mainOffer,
    ideal_clients: bp.idealClients,
    team_size: bp.teamSize,
    client_sources: bp.clientSources,
    pipeline_stages: bp.pipelineStages,
    ai_persona_name: bp.aiPersonaName,
    ai_persona_style: bp.aiPersonaStyle,
    ai_custom_instructions: bp.aiCustomInstructions,
    website_url: bp.websiteUrl,
    brand_colors: bp.brandColors,
    social_links: bp.socialLinks,
    detected_services: bp.detectedServices,
    pipeline_mode: bp.pipelineMode,
    digest_frequency: bp.digestFrequency,
    digest_day: bp.digestDay,
    email_intake_mode: bp.emailIntakeMode,
    interface_mode: bp.interfaceMode,
    onboarding_complete: bp.onboardingComplete,
    brand_voice_profile: bp.brandVoiceProfile,
    brand_voice_updated_at: bp.brandVoiceUpdatedAt,
    brand_voice_source: bp.brandVoiceSource,
    created_at: bp.createdAt,
    updated_at: bp.updatedAt,
  }
}

export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
    const bp = await em.findOne(CustomerBusinessProfile, {
      organizationId: auth.orgId,
      tenantId: auth.tenantId,
    })
    const serialized = serializeProfile(bp)
    if (!serialized) return NextResponse.json({ ok: true, data: null })
    const review = await readReviewSettings(em, auth.orgId)
    return NextResponse.json({ ok: true, data: { ...serialized, ...review } })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const body = await req.json().catch(() => ({}))
    const input = businessProfileUpsertSchema.parse({
      ...body,
      tenantId: auth.tenantId,
      organizationId: auth.orgId,
    })
    const container = await createRequestContainer()
    const commandBus = container.resolve('commandBus') as CommandBus
    const { result } = await commandBus.execute<typeof input, { businessProfileId: string }>(
      'customers.business_profile.upsert',
      {
        input,
        ctx: { container, auth, request: req },
      },
    )
    const em = (container.resolve('em') as EntityManager).fork()

    // Reputation settings ride alongside the zod-validated upsert (which strips
    // unknown keys). The upsert command guarantees the profile row exists.
    const reviewPatch = extractReviewPatch(body)
    if (Object.keys(reviewPatch).length > 0) {
      try {
        await em.getKnex()('business_profiles').where('id', result.businessProfileId).update(reviewPatch)
      } catch (patchErr) {
        console.error('[business-profile] Failed to save review settings (is scripts/sql/reputation.sql applied?):', patchErr)
      }
    }

    const bp = await em.findOne(CustomerBusinessProfile, {
      id: result.businessProfileId,
    })
    const serialized = serializeProfile(bp)
    if (!serialized) return NextResponse.json({ ok: true, data: null })
    const review = await readReviewSettings(em, auth.orgId)
    return NextResponse.json({ ok: true, data: { ...serialized, ...review } })
  } catch (err: any) {
    if (err?.issues) {
      return NextResponse.json({ ok: false, error: 'Validation failed', details: err.issues }, { status: 400 })
    }
    return NextResponse.json({ ok: false, error: err?.message ?? 'Failed' }, { status: 500 })
  }
}

const businessProfileResponseSchema = z.object({
  ok: z.literal(true),
  data: z.unknown().nullable(),
})

const businessProfileErrorSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
})

export const openApi: OpenApiRouteDoc = {
  summary: 'Business profile',
  description: 'Read or upsert the business profile for the authenticated organization. The profile is 1:1 with the organization.',
  methods: {
    GET: {
      summary: 'Read business profile',
      tags: ['Customers'],
      responses: [
        { status: 200, description: 'Returns the business profile (or null if not yet created)', schema: businessProfileResponseSchema },
      ],
      errors: [
        { status: 401, description: 'Unauthorized', schema: businessProfileErrorSchema },
      ],
    },
    PUT: {
      summary: 'Upsert business profile',
      tags: ['Customers'],
      requestBody: {
        contentType: 'application/json',
        schema: businessProfileUpsertSchema.omit({ tenantId: true, organizationId: true }),
        description: 'Fields to set on the business profile. Omitted fields are left unchanged.',
      },
      responses: [
        { status: 200, description: 'Returns the upserted business profile', schema: businessProfileResponseSchema },
      ],
      errors: [
        { status: 400, description: 'Validation failed', schema: businessProfileErrorSchema },
        { status: 401, description: 'Unauthorized', schema: businessProfileErrorSchema },
      ],
    },
  },
}
