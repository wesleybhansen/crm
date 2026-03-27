import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export const metadata = { POST: { requireAuth: false } }

function decodeToken(token: string): { contactId: string; orgId: string } | null {
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf-8')
    const [contactId, orgId] = decoded.split(':')
    if (!contactId || !orgId) return null
    return { contactId, orgId }
  } catch {
    return null
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const { token, categorySlug, optedIn, unsubscribeAll, resubscribe } = body

    if (!token) return NextResponse.json({ ok: false, error: 'Missing token' }, { status: 400 })

    const parsed = decodeToken(token)
    if (!parsed) return NextResponse.json({ ok: false, error: 'Invalid token' }, { status: 400 })

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const contact = await knex('customer_entities').where('id', parsed.contactId).first()
    if (!contact || contact.organization_id !== parsed.orgId) {
      return NextResponse.json({ ok: false, error: 'Contact not found' }, { status: 404 })
    }

    const crypto = require('crypto')
    const now = new Date()

    if (resubscribe) {
      // Remove from global unsubscribes
      await knex('email_unsubscribes')
        .where('contact_id', parsed.contactId)
        .where('organization_id', parsed.orgId)
        .del()

      // Also remove by email
      if (contact.primary_email) {
        await knex('email_unsubscribes')
          .where('email', contact.primary_email)
          .where('organization_id', parsed.orgId)
          .del()
      }

      // Set all category preferences to opted_in
      const categories = await knex('email_preference_categories')
        .where('organization_id', parsed.orgId)

      for (const cat of categories) {
        await knex('email_preferences')
          .insert({
            id: crypto.randomUUID(),
            contact_id: parsed.contactId,
            organization_id: parsed.orgId,
            category_slug: cat.slug,
            opted_in: true,
            updated_at: now,
          })
          .onConflict(['contact_id', 'organization_id', 'category_slug'])
          .merge({ opted_in: true, updated_at: now })
      }

      return NextResponse.json({ ok: true })
    }

    if (unsubscribeAll) {
      // Set all categories to opted_in=false
      const categories = await knex('email_preference_categories')
        .where('organization_id', parsed.orgId)

      for (const cat of categories) {
        await knex('email_preferences')
          .insert({
            id: crypto.randomUUID(),
            contact_id: parsed.contactId,
            organization_id: parsed.orgId,
            category_slug: cat.slug,
            opted_in: false,
            updated_at: now,
          })
          .onConflict(['contact_id', 'organization_id', 'category_slug'])
          .merge({ opted_in: false, updated_at: now })
      }

      // Also add to global unsubscribes
      const existing = await knex('email_unsubscribes')
        .where('email', contact.primary_email)
        .where('organization_id', parsed.orgId)
        .first()

      if (!existing) {
        await knex('email_unsubscribes').insert({
          id: crypto.randomUUID(),
          tenant_id: contact.tenant_id,
          organization_id: parsed.orgId,
          email: contact.primary_email,
          contact_id: parsed.contactId,
          created_at: now,
        })
      }

      return NextResponse.json({ ok: true })
    }

    // Single category update
    if (!categorySlug || typeof optedIn !== 'boolean') {
      return NextResponse.json({ ok: false, error: 'Missing categorySlug or optedIn' }, { status: 400 })
    }

    await knex('email_preferences')
      .insert({
        id: crypto.randomUUID(),
        contact_id: parsed.contactId,
        organization_id: parsed.orgId,
        category_slug: categorySlug,
        opted_in: optedIn,
        updated_at: now,
      })
      .onConflict(['contact_id', 'organization_id', 'category_slug'])
      .merge({ opted_in: optedIn, updated_at: now })

    // If opting back in to any category, remove from global unsubscribes
    if (optedIn) {
      await knex('email_unsubscribes')
        .where('contact_id', parsed.contactId)
        .where('organization_id', parsed.orgId)
        .del()

      if (contact.primary_email) {
        await knex('email_unsubscribes')
          .where('email', contact.primary_email)
          .where('organization_id', parsed.orgId)
          .del()
      }
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[email.preferences.update]', error)
    return NextResponse.json({ ok: false, error: 'Failed to update preference' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Email', summary: 'Update email preferences',
  methods: {
    POST: { summary: 'Update a contact email preference or unsubscribe from all', tags: ['Email'] },
  },
}
