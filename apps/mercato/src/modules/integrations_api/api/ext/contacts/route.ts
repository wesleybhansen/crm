import { NextResponse } from 'next/server'
import { createPersonContact } from '@/modules/customers/lib/contact-write'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { TenantDataEncryptionService } from '@open-mercato/shared/lib/encryption/tenantDataEncryptionService'
import { isTenantDataEncryptionEnabled } from '@open-mercato/shared/lib/encryption/toggles'
import { createKmsService } from '@open-mercato/shared/lib/encryption/kms'
import { decryptRowFields, CONTACT_ENTITY_KEY } from '@open-mercato/shared/lib/encryption/decryptRows'
import { whereContactEmail } from '@/modules/customers/lib/contact-lookup'
import { decryptRowsForDisplay } from '@/modules/customers/lib/display-decrypt'
import { CONTACT_SEARCH_CANDIDATE_LIMIT, contactMatchesSearch } from '@/modules/customers/lib/contact-search'

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

/**
 * display_name/primary_email/primary_phone/description/next_interaction_name are encrypted at rest for contacts
 * written through the ORM path. This route reads via raw knex, which skips the
 * subscriber that decrypts them. Unreadable fields come back as null, never
 * ciphertext.
 */
async function decryptContactsForResponse(em: EntityManager, contacts: any[], tenantId: string, orgId: string) {
  if (!contacts.length || !isTenantDataEncryptionEnabled() || !tenantId) return
  await decryptRowsForDisplay(
    em, CONTACT_ENTITY_KEY, contacts,
    {
      display_name: 'display_name', primary_email: 'primary_email', primary_phone: 'primary_phone',
      description: 'description', next_interaction_name: 'next_interaction_name',
    },
    tenantId, orgId,
  )
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

    if (status) query = query.where('status', status)

    // Name and email are encrypted at rest, so SQL ILIKE can never match an
    // encrypted row. With a search term, load the org's recent contacts
    // (bounded), decrypt, filter and paginate in memory.
    let count: number | string
    let contacts: any[]
    let searchTruncated = false
    if (search) {
      const candidates = await query.clone().select('*').orderBy('created_at', 'desc').limit(CONTACT_SEARCH_CANDIDATE_LIMIT)
      searchTruncated = candidates.length >= CONTACT_SEARCH_CANDIDATE_LIMIT
      await decryptContactsForResponse(em, candidates, scope.tenantId, scope.orgId)
      const matches = candidates.filter((c: any) => contactMatchesSearch(c, search))
      count = matches.length
      contacts = matches.slice((page - 1) * pageSize, page * pageSize)
    } else {
      ;[{ count }] = await query.clone().count() as any
      contacts = await query.select('*').orderBy('created_at', 'desc').limit(pageSize).offset((page - 1) * pageSize)
      await decryptContactsForResponse(em, contacts, scope.tenantId, scope.orgId)
    }

    return NextResponse.json({
      ok: true,
      data: contacts,
      pagination: { page, pageSize, total: Number(count) },
      ...(searchTruncated ? { searchScope: `most recent ${CONTACT_SEARCH_CANDIDATE_LIMIT} contacts` } : {}),
    })
  } catch (error) {
    console.error('[ext.contacts.list]', error)
    return NextResponse.json({ ok: false, error: 'Failed to list contacts' }, { status: 500 })
  }
}

/** Contact columns encrypted at rest that this API returns. */
const EXT_CONTACT_FIELDS = ['display_name', 'primary_email', 'primary_phone', 'description', 'next_interaction_name'] as const

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

    // Dedupe on the email lookup hash: primary_email is ciphertext for every
    // contact written through the encrypting path, so the old plaintext
    // equality never matched and each retry created a duplicate.
    if (email) {
      const existing = await whereContactEmail(knex('customer_entities'), email)
        .where('organization_id', scope.orgId)
        .whereNull('deleted_at')
        .first()
      if (existing) {
        await decryptRowFields(em, CONTACT_ENTITY_KEY, [existing], EXT_CONTACT_FIELDS, scope.tenantId, scope.orgId)
        return NextResponse.json({ ok: true, data: existing, existed: true })
      }
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

    const extName = displayName || email
    // ORM path: encrypted at rest, lookup hashes written.
    const id = await createPersonContact(em, {
      organizationId: scope.orgId, tenantId: scope.tenantId,
      displayName: extName, primaryEmail: email || null, primaryPhone: phone || null,
      source: source || 'api', description: description || null, lifecycleStage: 'prospect',
    })

    // Tag with source:api:<key name> so attribution reports reflect the
    // integration origin instead of a generic "api" bucket.
    try {
      const { tagContactSource } = await import('@open-mercato/core/modules/customers/lib/sourceTagging')
      const keyName = (ctx?.auth?.keyName || '').toString().trim()
      await tagContactSource(knex, { tenantId: scope.tenantId, organizationId: scope.orgId }, id, 'api', keyName || undefined)
    } catch {}

    const contact = await knex('customer_entities').where('id', id).first()
    if (contact) await decryptRowFields(em, CONTACT_ENTITY_KEY, [contact], EXT_CONTACT_FIELDS, scope.tenantId, scope.orgId)
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
