export const metadata = { path: '/inbox/ai-settings', GET: { requireAuth: true }, PUT: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { InboxAiSettings } from '../../../data/schema'

function serialize(s: InboxAiSettings) {
  return {
    id: s.id, tenant_id: s.tenantId, organization_id: s.organizationId,
    enabled: s.enabled, knowledge_base: s.knowledgeBase, tone: s.tone,
    instructions: s.instructions, business_name: s.businessName,
    business_description: s.businessDescription,
    created_at: s.createdAt, updated_at: s.updatedAt,
  }
}

export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
    const settings = await em.findOne(InboxAiSettings, { organizationId: auth.orgId, tenantId: auth.tenantId })
    return NextResponse.json({ ok: true, data: settings ? serialize(settings) : null })
  } catch (error) {
    console.error('[inbox.ai-settings.get]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
    const body = await req.json()

    let settings = await em.findOne(InboxAiSettings, { organizationId: auth.orgId, tenantId: auth.tenantId })

    if (settings) {
      if (body.enabled !== undefined) settings.enabled = body.enabled
      if (body.knowledgeBase !== undefined) settings.knowledgeBase = body.knowledgeBase
      if (body.tone !== undefined) settings.tone = body.tone
      if (body.instructions !== undefined) settings.instructions = body.instructions
      if (body.businessName !== undefined) settings.businessName = body.businessName
      if (body.businessDescription !== undefined) settings.businessDescription = body.businessDescription
    } else {
      settings = em.create(InboxAiSettings, {
        tenantId: auth.tenantId,
        organizationId: auth.orgId,
        enabled: body.enabled ?? false,
        knowledgeBase: body.knowledgeBase ?? '',
        tone: body.tone ?? 'professional',
        instructions: body.instructions ?? '',
        businessName: body.businessName ?? '',
        businessDescription: body.businessDescription ?? '',
      })
      em.persist(settings)
    }

    await em.flush()
    return NextResponse.json({ ok: true, data: serialize(settings) })
  } catch (error) {
    console.error('[inbox.ai-settings.save]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
