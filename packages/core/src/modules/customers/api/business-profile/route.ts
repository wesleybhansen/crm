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
    return NextResponse.json({ ok: true, data: serializeProfile(bp) })
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
    const bp = await em.findOne(CustomerBusinessProfile, {
      id: result.businessProfileId,
    })
    return NextResponse.json({ ok: true, data: serializeProfile(bp) })
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
