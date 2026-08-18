import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { TenantDataEncryptionService } from '@open-mercato/shared/lib/encryption/tenantDataEncryptionService'
import { isTenantDataEncryptionEnabled } from '@open-mercato/shared/lib/encryption/toggles'
import { createKmsService } from '@open-mercato/shared/lib/encryption/kms'

export const metadata = {
  path: '/ext/contacts',
  GET: { requireAuth: true, requireFeatures: ['integrations_api.access'] },
  POST: { requireAuth: true, requireFeatures: ['integrations_api.access'] },
}

function getScope(ctx: any) {
  const auth = ctx?.auth
  if (!auth?.tenantId || !auth?.orgId) return null
  return { tenantId: auth.tenantId, orgId: auth.orgId, userId: auth.sub }
}

export async function GET(req: Request, ctx: any) {
  const scope = getScope(ctx)
  if (!scope) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const url = new URL(req.url)

    const search = url.searchParams.get('search')
    const status = url.searchParams.get('status')
    const page = parseInt(url.searchParams.get('page') || '1')
    const pageSize = Math.min(parseInt(url.searchParams.get('pageSize') || '50'), 100)

    let query = knex('customer_entities')
      .where('tenant_id', scope.tenantId)
      .where('organization_id', scope.orgId)
      .whereNull('deleted_at')

    if (search) {
      query = query.where(function() {
        this.where('display_name', 'ilike', `%${search}%`).orWhere('primary_email', 'ilike', `%${search}%`)
      })
    }
    if (status) query = query.where('status', status)

    const [{ count }] = await query.clone().count()
    const contacts = await query.select('*').orderBy('created_at', 'desc').limit(pageSize).offset((page - 1) * pageSize)

    // display_name/primary_email/primary_phone are encrypted at rest for contacts
    // written through the ORM path. This route reads via raw knex, which skips the
    // subscriber that decrypts them, so without this some rows come back as
    // `iv:ct:tag:v1` ciphertext while others look fine.
    if (isTenantDataEncryptionEnabled() && scope.tenantId) {
      const svc = new TenantDataEncryptionService(em as any, { kms: createKmsService() })
      for (const contact of contacts) {
        try {
          const dec = await svc.decryptEntityPayload(
            'customers:customer_entity',
            {
              display_name: contact.display_name,
              primary_email: contact.primary_email,
              primary_phone: contact.primary_phone,
            },
            scope.tenantId,
            scope.orgId,
          )
          contact.display_name = dec.display_name ?? contact.display_name
          contact.primary_email = dec.primary_email ?? contact.primary_email
          contact.primary_phone = dec.primary_phone ?? contact.primary_phone
        } catch {
          /* leave the stored value alone: one unreadable row must not fail the page */
        }
      }
    }

    return NextResponse.json({ ok: true, data: contacts, pagination: { page, pageSize, total: Number(count) } })
  } catch (error) {
    console.error('[ext.contacts.list]', error)
    return NextResponse.json({ ok: false, error: 'Failed to list contacts' }, { status: 500 })
  }
}

export async function POST(req: Request, ctx: any) {
  const scope = getScope(ctx)
  if (!scope) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const body = await req.json()

    const { displayName, email, phone, source, attribution, channel } = body
    if (!displayName && !email) {
      return NextResponse.json({ ok: false, error: 'displayName or email required' }, { status: 400 })
    }

    if (email) {
      const existing = await knex('customer_entities')
        .where('primary_email', email)
        .where('organization_id', scope.orgId)
        .whereNull('deleted_at')
        .first()
      if (existing) return NextResponse.json({ ok: true, data: existing, existed: true })
    }

    // Marketing attribution (pushed by the Noli AMS): keep the human channel
    // line + utm specifics on the contact description so origin survives on a
    // schema without utm columns.
    let description: string | null = null
    if (channel && typeof channel === 'string') {
      description = `Came from: ${channel.replace(/[\r\n\t\u0000-\u001f\u007f]+/g, ' ').slice(0, 160)}`
    }
    if (attribution && typeof attribution === 'object') {
      const clean = (t: string) => t.replace(/[\r\n\t\u0000-\u001f\u007f]+/g, ' ').trim()
      const parts = Object.entries(attribution as Record<string, unknown>)
        .filter(([, v]) => typeof v === 'string' && v)
        .slice(0, 10)
        .map(([k, v]) => `${clean(k).slice(0, 40)}=${clean(String(v)).slice(0, 160)}`)
      if (parts.length > 0) {
        description = `${description ? description + '\n' : ''}Attribution: ${parts.join(' · ')}`
      }
    }

    const id = require('crypto').randomUUID()
    const extName = displayName || email
    await knex('customer_entities').insert({
      id,
      tenant_id: scope.tenantId,
      organization_id: scope.orgId,
      kind: 'person',
      display_name: extName,
      primary_email: email || null,
      primary_phone: phone || null,
      source: source || 'api',
      description,
      status: 'active',
      lifecycle_stage: 'prospect',
      created_at: new Date(),
      updated_at: new Date(),
    })
    const extParts = (extName || '').split(' ')
    await knex('customer_people').insert({
      id: require('crypto').randomUUID(), tenant_id: scope.tenantId, organization_id: scope.orgId,
      entity_id: id, first_name: extParts[0] || '', last_name: extParts.slice(1).join(' ') || '',
      created_at: new Date(), updated_at: new Date(),
    }).catch(() => {})

    // Tag with source:api:<key name> so attribution reports reflect the
    // integration origin instead of a generic "api" bucket.
    try {
      const { tagContactSource } = await import('@open-mercato/core/modules/customers/lib/sourceTagging')
      const keyName = (ctx?.auth?.keyName || '').toString().trim()
      await tagContactSource(knex, { tenantId: scope.tenantId, organizationId: scope.orgId }, id, 'api', keyName || undefined)
    } catch {}

    const contact = await knex('customer_entities').where('id', id).first()
    return NextResponse.json({ ok: true, data: contact, existed: false }, { status: 201 })
  } catch (error) {
    console.error('[ext.contacts.create]', error)
    return NextResponse.json({ ok: false, error: 'Failed to create contact' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'External API', summary: 'Contacts (external)',
  methods: {
    GET: { summary: 'List contacts', tags: ['External API'] },
    POST: { summary: 'Create or find contact', tags: ['External API'] },
  },
}
