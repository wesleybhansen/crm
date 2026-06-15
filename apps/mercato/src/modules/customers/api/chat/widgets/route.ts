// ORM-SKIP: complex business logic beyond simple CRUD — convert when touched
export const metadata = { path: '/chat/widgets', GET: { requireAuth: true }, POST: { requireAuth: true }, PUT: { requireAuth: true }, DELETE: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import crypto from 'crypto'

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const widgets = await knex('chat_widgets')
      .where('organization_id', auth.orgId)
      .orderBy('created_at', 'desc')
    const origin = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')

    // Get conversation counts per widget
    const convCounts = await knex('chat_conversations')
      .where('organization_id', auth.orgId)
      .groupBy('widget_id')
      .select('widget_id')
      .count('* as count')

    const countMap: Record<string, number> = {}
    for (const row of convCounts) {
      countMap[row.widget_id] = Number(row.count) || 0
    }

    const data = widgets.map((w: Record<string, unknown>) => ({
      ...w,
      embedCode: `<script src="${origin}/api/chat/widget/${w.id}" async></script>`,
      conversation_count: countMap[w.id as string] || 0,
    }))
    return NextResponse.json({ ok: true, data })
  } catch (error) {
    console.error('[chat.widgets.list]', error)
    return NextResponse.json({ ok: false, error: 'Failed to load widgets' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    // Appearance-only fields. The standalone widget bot has been retired: chat is
    // now powered by Customer Service (grounded auto-answer + flag-escalate), so
    // any legacy bot_* fields in the body are intentionally ignored here.
    const { name, greetingMessage, config, slug, description, brandColor, welcomeMessage, businessName, publicPageEnabled } = body
    if (!name?.trim()) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 })

    // Generate slug from name if not provided
    let finalSlug = slug?.trim() ? slugify(slug.trim()) : slugify(name.trim())

    // Check for slug uniqueness within the org
    const existingSlug = await knex('chat_widgets')
      .where('organization_id', auth.orgId)
      .andWhere('slug', finalSlug)
      .first()
    if (existingSlug) {
      finalSlug = `${finalSlug}-${crypto.randomUUID().substring(0, 6)}`
    }

    const id = crypto.randomUUID()
    const row: Record<string, unknown> = {
      id,
      tenant_id: auth.tenantId,
      organization_id: auth.orgId,
      name: name.trim(),
      slug: finalSlug,
      created_at: new Date(),
      updated_at: new Date(),
    }
    if (greetingMessage !== undefined) row.greeting_message = greetingMessage
    if (welcomeMessage !== undefined) row.welcome_message = welcomeMessage
    if (config !== undefined) row.config = JSON.stringify(config)
    if (description !== undefined) row.description = description
    if (brandColor !== undefined) row.brand_color = brandColor
    if (businessName !== undefined) row.business_name = businessName
    if (publicPageEnabled !== undefined) row.public_page_enabled = publicPageEnabled

    await knex('chat_widgets').insert(row)

    // Setting up website chat means the org wants chat handled. Ensure the org's
    // Customer Service drafter owns it: turn on cs_chat_enabled so this widget
    // routes through the CS brain (grounded answers + flag-escalate) out of the
    // box. Self-scoped by auth.orgId; never trust a client org. Best-effort so a
    // CS-settings hiccup never blocks widget creation.
    try {
      const existingCs = await knex('customer_service_settings').where('organization_id', auth.orgId).first()
      if (existingCs) {
        if (!existingCs.cs_chat_enabled) {
          await knex('customer_service_settings')
            .where('id', existingCs.id)
            .update({ cs_chat_enabled: true, enabled: true, updated_at: new Date() })
        }
      } else {
        await knex('customer_service_settings').insert({
          id: crypto.randomUUID(),
          tenant_id: auth.tenantId,
          organization_id: auth.orgId,
          enabled: true,
          cs_chat_enabled: true,
          reply_mode: 'draft',
          created_at: new Date(),
          updated_at: new Date(),
        })
      }
    } catch (csErr) {
      console.error('[chat.widgets.create.cs-enable]', csErr)
    }

    const widget = await knex('chat_widgets').where('id', id).first()
    return NextResponse.json({ ok: true, data: widget }, { status: 201 })
  } catch (error) {
    console.error('[chat.widgets.create]', error)
    return NextResponse.json({ ok: false, error: 'Failed to create widget' }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    if (!id) return NextResponse.json({ ok: false, error: 'id query param required' }, { status: 400 })

    const body = await req.json()
    const updates: Record<string, unknown> = { updated_at: new Date() }
    if (body.name !== undefined) updates.name = body.name.trim()
    if (body.greetingMessage !== undefined) updates.greeting_message = body.greetingMessage
    if (body.config !== undefined) updates.config = JSON.stringify(body.config)
    if (body.isActive !== undefined) updates.is_active = body.isActive
    if (body.slug !== undefined) updates.slug = slugify(body.slug)
    if (body.description !== undefined) updates.description = body.description
    if (body.brandColor !== undefined) updates.brand_color = body.brandColor
    if (body.welcomeMessage !== undefined) updates.welcome_message = body.welcomeMessage
    if (body.businessName !== undefined) updates.business_name = body.businessName
    if (body.publicPageEnabled !== undefined) updates.public_page_enabled = body.publicPageEnabled
    // Legacy bot_* fields are intentionally ignored: website chat is now powered by
    // Customer Service (set up answers, knowledge, and escalation in CS settings).

    await knex('chat_widgets').where('id', id).andWhere('organization_id', auth.orgId).update(updates)
    // Org-scope the read-back too: an id from another tenant produces a 0-row
    // update (good) but an unscoped read would still return that tenant's widget
    // config (cross-tenant disclosure). Scoping returns null instead.
    const widget = await knex('chat_widgets').where('id', id).andWhere('organization_id', auth.orgId).first()
    if (!widget) return NextResponse.json({ ok: false, error: 'Widget not found' }, { status: 404 })
    return NextResponse.json({ ok: true, data: widget })
  } catch (error) {
    console.error('[chat.widgets.update]', error)
    return NextResponse.json({ ok: false, error: 'Failed to update widget' }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    if (!id) return NextResponse.json({ ok: false, error: 'id query param required' }, { status: 400 })

    // Verify the widget belongs to the caller's org BEFORE cascading. Without
    // this, a widget id from another tenant would 0-row the final widget delete
    // (good) but the cascade above would still wipe that tenant's conversations
    // and messages for the widget (cross-tenant data destruction).
    const owned = await knex('chat_widgets')
      .where('id', id)
      .andWhere('organization_id', auth.orgId)
      .first()
    if (!owned) return NextResponse.json({ ok: false, error: 'Widget not found' }, { status: 404 })

    // Delete related data before deleting widget. The cascade is also org-scoped
    // for defense in depth.
    const convIds = await knex('chat_conversations')
      .where('widget_id', id)
      .andWhere('organization_id', auth.orgId)
      .pluck('id')
    if (convIds.length > 0) {
      await knex('chat_messages').whereIn('conversation_id', convIds).delete()
      await knex('chat_conversations').whereIn('id', convIds).delete()
    }
    await knex('chat_widgets').where('id', id).andWhere('organization_id', auth.orgId).delete()
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[chat.widgets.delete]', error)
    return NextResponse.json({ ok: false, error: 'Failed to delete widget' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Chat',
  summary: 'Manage chat widgets',
  methods: {
    GET: { summary: 'List chat widgets', tags: ['Chat'] },
    POST: { summary: 'Create a chat widget', tags: ['Chat'] },
    PUT: { summary: 'Update a chat widget', tags: ['Chat'] },
    DELETE: { summary: 'Delete a chat widget', tags: ['Chat'] },
  },
}
