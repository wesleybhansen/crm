import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()

    const profile = await knex('business_profiles').where('organization_id', auth.orgId).first()
    return NextResponse.json({ ok: true, data: profile || null })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const body = await req.json()

    const existing = await knex('business_profiles').where('organization_id', auth.orgId).first()

    const data: Record<string, any> = {
      updated_at: new Date(),
    }
    if (body.businessName !== undefined) data.business_name = body.businessName
    if (body.businessType !== undefined) data.business_type = body.businessType
    if (body.businessDescription !== undefined) data.business_description = body.businessDescription
    if (body.mainOffer !== undefined) data.main_offer = body.mainOffer
    if (body.idealClients !== undefined) data.ideal_clients = body.idealClients
    if (body.teamSize !== undefined) data.team_size = body.teamSize
    if (body.clientSources !== undefined) data.client_sources = JSON.stringify(body.clientSources)
    if (body.pipelineStages !== undefined) data.pipeline_stages = JSON.stringify(body.pipelineStages)
    if (body.aiPersonaName !== undefined) data.ai_persona_name = body.aiPersonaName
    if (body.aiPersonaStyle !== undefined) data.ai_persona_style = body.aiPersonaStyle
    if (body.aiCustomInstructions !== undefined) data.ai_custom_instructions = body.aiCustomInstructions
    if (body.websiteUrl !== undefined) data.website_url = body.websiteUrl
    if (body.brandColors !== undefined) data.brand_colors = JSON.stringify(body.brandColors)
    if (body.socialLinks !== undefined) data.social_links = JSON.stringify(body.socialLinks)
    if (body.detectedServices !== undefined) data.detected_services = JSON.stringify(body.detectedServices)
    if (body.pipelineMode !== undefined) data.pipeline_mode = body.pipelineMode
    if (body.emailIntakeMode !== undefined) data.email_intake_mode = body.emailIntakeMode
    if (body.interfaceMode !== undefined) data.interface_mode = body.interfaceMode
    if (body.onboardingComplete !== undefined) data.onboarding_complete = body.onboardingComplete

    if (existing) {
      await knex('business_profiles').where('id', existing.id).update(data)
    } else {
      await knex('business_profiles').insert({
        id: require('crypto').randomUUID(),
        tenant_id: auth.tenantId,
        organization_id: auth.orgId,
        ...data,
        created_at: new Date(),
      })
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
