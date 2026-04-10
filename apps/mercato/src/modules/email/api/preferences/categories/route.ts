export const metadata = { GET: { requireAuth: true }, POST: { requireAuth: true }, DELETE: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

const DEFAULT_CATEGORIES = [
  { name: 'Product Updates', slug: 'product-updates', description: 'New features and product announcements' },
  { name: 'Newsletter', slug: 'newsletter', description: 'Regular newsletter and company news' },
  { name: 'Promotions', slug: 'promotions', description: 'Special offers, discounts, and deals' },
  { name: 'Event Invitations', slug: 'event-invitations', description: 'Webinars, meetups, and event invitations' },
  { name: 'Tips & Education', slug: 'tips-education', description: 'How-to guides, tips, and educational content' },
]

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    let categories = await knex('email_preference_categories')
      .where('organization_id', auth.orgId)
      .orderBy('created_at', 'asc')

    if (categories.length === 0) {
      const crypto = require('crypto')
      const now = new Date()
      const rows = DEFAULT_CATEGORIES.map((cat) => ({
        id: crypto.randomUUID(),
        tenant_id: auth.tenantId,
        organization_id: auth.orgId,
        name: cat.name,
        slug: cat.slug,
        description: cat.description,
        is_default: true,
        created_at: now,
      }))
      await knex('email_preference_categories').insert(rows)
      categories = rows
    }

    return NextResponse.json({ ok: true, data: categories })
  } catch (error) {
    console.error('[email.preferences.categories]', error)
    return NextResponse.json({ ok: false, error: 'Failed to load categories' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const body = await req.json()
    const { name, description } = body
    if (!name || typeof name !== 'string') {
      return NextResponse.json({ ok: false, error: 'Name is required' }, { status: 400 })
    }

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const slug = slugify(name)

    const existing = await knex('email_preference_categories')
      .where('organization_id', auth.orgId)
      .where('slug', slug)
      .first()

    if (existing) {
      return NextResponse.json({ ok: false, error: 'A category with this name already exists' }, { status: 409 })
    }

    const crypto = require('crypto')
    const category = {
      id: crypto.randomUUID(),
      tenant_id: auth.tenantId,
      organization_id: auth.orgId,
      name: name.trim(),
      slug,
      description: description?.trim() || null,
      is_default: false,
      created_at: new Date(),
    }

    await knex('email_preference_categories').insert(category)
    return NextResponse.json({ ok: true, data: category })
  } catch (error) {
    console.error('[email.preferences.categories.create]', error)
    return NextResponse.json({ ok: false, error: 'Failed to create category' }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const { searchParams } = new URL(req.url)
    const id = searchParams.get('id')
    if (!id) return NextResponse.json({ ok: false, error: 'Missing id parameter' }, { status: 400 })

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const deleted = await knex('email_preference_categories')
      .where('id', id)
      .where('organization_id', auth.orgId)
      .del()

    if (!deleted) return NextResponse.json({ ok: false, error: 'Category not found' }, { status: 404 })

    // Clean up any preferences referencing this category
    const category = await knex('email_preference_categories').where('id', id).first()
    if (category) {
      await knex('email_preferences')
        .where('organization_id', auth.orgId)
        .where('category_slug', category.slug)
        .del()
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[email.preferences.categories.delete]', error)
    return NextResponse.json({ ok: false, error: 'Failed to delete category' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Email', summary: 'Email preference categories',
  methods: {
    GET: { summary: 'List email preference categories', tags: ['Email'] },
    POST: { summary: 'Create an email preference category', tags: ['Email'] },
    DELETE: { summary: 'Delete an email preference category', tags: ['Email'] },
  },
}
