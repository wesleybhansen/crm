// ORM-SKIP: complex JOINs with encryption handling — convert when touched
export const metadata = { path: '/crm-contact-tags', GET: { requireAuth: true }, POST: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies, getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { checkSequenceTriggers } from '@/modules/sequences/services/sequence-triggers'
import { dispatchWebhook } from '@/modules/customers/api/webhooks/dispatch'
import { executeAutomationRules } from '@/modules/sequences/lib/automation-execute'


export async function GET(req: Request) {
  const auth = (await getAuthFromCookies()) || (await getAuthFromRequest(req))
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
        .select('ct.id', 'ct.label as name', 'ct.slug', 'ct.color')
      return NextResponse.json({ ok: true, data: tags })
    } else {
      // Get all tags for the org
      const tags = await knex('customer_tags')
        .where('tenant_id', auth.tenantId)
        .where('organization_id', auth.orgId)
        .select('id', 'label as name', 'slug', 'color')
        .orderBy('label')
      return NextResponse.json({ ok: true, data: tags })
    }
  } catch (error) {
    console.error('[crm-contact-tags.get]', error)
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const auth = (await getAuthFromCookies()) || (await getAuthFromRequest(req))
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
      .first()

    if (!tag) {
      const tagId = require('crypto').randomUUID()
      const colors = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#06B6D4', '#F97316']
      const color = colors[Math.floor(Math.random() * colors.length)]
      await knex('customer_tags').insert({
        id: tagId,
        tenant_id: auth.tenantId,
        organization_id: auth.orgId,
        label: tagName.trim(),
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
        contactId, tagSlug: slug, tagName: tag.label || tag.name,
      }).catch(() => {})
    }

    // Dispatch webhook for contact update (tag assigned)
    dispatchWebhook(knex, auth.orgId, 'contact.updated', {
      contactId,
      action: 'tag_assigned',
      tagName: tag.label || tag.name,
      tagSlug: tag.slug,
    }).catch(() => {})

    // Auto-add to email lists with source_type 'tag_added'
    if (contactId) {
      try {
        const autoLists = await knex('email_lists')
          .where('organization_id', auth.orgId)
          .where('source_type', 'tag_added')
        for (const list of autoLists) {
          const desc = list.description || ''
          const triggerMatch = desc.match(/\[auto_trigger:(.+?)\]/)
          if (triggerMatch) {
            try {
              const targetIds = JSON.parse(triggerMatch[1])
              if (Array.isArray(targetIds) && targetIds.length > 0 && !targetIds.includes(tag.id)) continue
            } catch {}
          }
          await knex.raw('INSERT INTO email_list_members (id, list_id, contact_id, added_at) VALUES (?, ?, ?, ?) ON CONFLICT (list_id, contact_id) DO NOTHING',
            [require('crypto').randomUUID(), list.id, contactId, new Date()])
          const [{ count }] = await knex('email_list_members').where('list_id', list.id).count()
          await knex('email_lists').where('id', list.id).update({ member_count: Number(count), updated_at: new Date() })
        }
      } catch {}
    }

    return NextResponse.json({ ok: true, data: { id: tag.id, name: tag.label || tag.name, slug: tag.slug, color: tag.color } })
  } catch (error) {
    console.error('[crm-contact-tags]', error)
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}
