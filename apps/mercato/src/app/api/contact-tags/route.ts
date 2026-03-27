import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { checkSequenceTriggers } from '@/modules/sequences/services/sequence-triggers'
import { dispatchWebhook } from '@/app/api/webhooks/dispatch'
import { executeAutomationRules } from '@/app/api/automation-rules/execute'

export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const url = new URL(req.url)
    const contactId = url.searchParams.get('contactId')

    if (contactId) {
      // Get tags for a specific contact
      const tags = await knex('customer_tag_assignments as cta')
        .join('customer_tags as ct', 'ct.id', 'cta.tag_id')
        .where('cta.entity_id', contactId)
        .select('ct.id', 'ct.name', 'ct.slug', 'ct.color')
      return NextResponse.json({ ok: true, data: tags })
    } else {
      // Get all tags for the org
      const tags = await knex('customer_tags')
        .where('tenant_id', auth.tenantId)
        .where('organization_id', auth.orgId)
        .whereNull('deleted_at')
        .orderBy('name')
      return NextResponse.json({ ok: true, data: tags })
    }
  } catch (error) {
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const body = await req.json()
    const { contactId, tagName, action } = body

    if (action === 'remove' && contactId && body.tagId) {
      // Remove tag from contact
      await knex('customer_tag_assignments').where('entity_id', contactId).where('tag_id', body.tagId).del()
      return NextResponse.json({ ok: true })
    }

    if (!contactId || !tagName?.trim()) {
      return NextResponse.json({ ok: false, error: 'contactId and tagName required' }, { status: 400 })
    }

    // Find or create tag
    const slug = tagName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
    let tag = await knex('customer_tags')
      .where('organization_id', auth.orgId)
      .where('slug', slug)
      .whereNull('deleted_at')
      .first()

    if (!tag) {
      const tagId = require('crypto').randomUUID()
      const colors = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#06B6D4', '#F97316']
      const color = colors[Math.floor(Math.random() * colors.length)]
      await knex('customer_tags').insert({
        id: tagId,
        tenant_id: auth.tenantId,
        organization_id: auth.orgId,
        name: tagName.trim(),
        slug,
        color,
        created_at: new Date(),
        updated_at: new Date(),
      })
      tag = await knex('customer_tags').where('id', tagId).first()
    }

    // Assign tag to contact (ignore if already assigned)
    const existing = await knex('customer_tag_assignments')
      .where('entity_id', contactId).where('tag_id', tag.id).first()
    if (!existing) {
      await knex('customer_tag_assignments').insert({
        id: require('crypto').randomUUID(),
        tenant_id: auth.tenantId,
        organization_id: auth.orgId,
        entity_id: contactId,
        tag_id: tag.id,
        created_at: new Date(),
      })
    }

    // Check sequence triggers for tag assignment
    if (!existing) {
      checkSequenceTriggers(knex, auth.orgId, auth.tenantId, 'tag_added', {
        contactId, tagSlug: slug,
      }).catch(() => {})
    }

    // Fire automation rules for tag addition
    if (!existing) {
      executeAutomationRules(knex, auth.orgId, auth.tenantId, 'tag_added', {
        contactId, tagSlug: slug, tagName: tag.name,
      }).catch(() => {})
    }

    // Dispatch webhook for contact update (tag assigned)
    dispatchWebhook(knex, auth.orgId, 'contact.updated', {
      contactId,
      action: 'tag_assigned',
      tagName: tag.name,
      tagSlug: tag.slug,
    }).catch(() => {})

    return NextResponse.json({ ok: true, data: tag })
  } catch (error) {
    console.error('[contact-tags]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
