/**
 * Email list members — bulk add/remove/list contacts on a mailing list.
 *
 * Replaces legacy /api/email-lists/[id]/members which used raw knex
 * and was missing tenant_id/organization_id on inserts (broke after
 * Stage A migration added NOT NULL constraints).
 *
 * New URL: /api/email/list-members?listId=<uuid>
 *
 * Uses direct ORM operations (not single-member commands) because the
 * frontend sends bulk contactIds arrays. The single-member commands
 * (email.list_members.add/remove) remain available for API consumers.
 */
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CustomerEntity } from '@open-mercato/core/modules/customers/data/entities'
import { EmailList, EmailListMember } from '../../data/schema'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { z } from 'zod'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['email.lists.view'] },
  POST: { requireAuth: true, requireFeatures: ['email.lists.manage'] },
  DELETE: { requireAuth: true, requireFeatures: ['email.lists.manage'] },
}

/** Verify list exists and belongs to the caller's org+tenant. */
async function resolveList(em: EntityManager, listId: string, auth: { tenantId: string; orgId: string }) {
  const list = await em.findOne(EmailList, {
    id: listId,
    tenantId: auth.tenantId,
    organizationId: auth.orgId,
    deletedAt: null,
  })
  return list
}

/** Sync email_lists.member_count from actual member rows. */
async function syncMemberCount(em: EntityManager, listId: string) {
  const count = await em.count(EmailListMember, { listId, deletedAt: null })
  await em.nativeUpdate(EmailList, { id: listId }, { memberCount: count, updatedAt: new Date() })
  return count
}

// ── GET: list members for a given list ──────────────────────────────

export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const url = new URL(req.url)
    const listId = url.searchParams.get('listId')
    if (!listId) return NextResponse.json({ ok: false, error: 'listId is required' }, { status: 400 })

    const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10), 500)
    const offset = parseInt(url.searchParams.get('offset') || '0', 10)

    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()

    const list = await resolveList(em, listId, auth)
    if (!list) return NextResponse.json({ ok: false, error: 'List not found' }, { status: 404 })

    // Get member rows
    const members = await em.find(
      EmailListMember,
      { listId, deletedAt: null },
      { limit, offset, orderBy: { addedAt: 'desc' } },
    )

    // Decrypt contact names for display
    const contactIds = members.map(m => m.contactId)
    const contacts = contactIds.length > 0
      ? await findWithDecryption(
          em,
          CustomerEntity,
          { id: { $in: contactIds } },
          { fields: ['id', 'displayName', 'primaryEmail'] },
          { tenantId: auth.tenantId, organizationId: auth.orgId },
        )
      : []

    const contactMap = new Map(contacts.map(c => [c.id, c]))

    const data = members.map(m => {
      const c = contactMap.get(m.contactId)
      return {
        contact_id: m.contactId,
        display_name: c?.displayName ?? null,
        primary_email: c?.primaryEmail ?? null,
        added_at: m.addedAt,
      }
    })

    return NextResponse.json({ ok: true, data })
  } catch (error) {
    console.error('[email.list-members.list]', error)
    return NextResponse.json({ ok: false, error: 'Failed to fetch members' }, { status: 500 })
  }
}

// ── POST: bulk add contacts to a list ───────────────────────────────

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const body = await req.json()
    const listId = body.listId
    const contactIds: string[] = body.contactIds

    if (!listId || !Array.isArray(contactIds) || contactIds.length === 0) {
      return NextResponse.json({ ok: false, error: 'listId and contactIds[] are required' }, { status: 400 })
    }

    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()

    const list = await resolveList(em, listId, auth)
    if (!list) return NextResponse.json({ ok: false, error: 'List not found' }, { status: 404 })

    // Use knex for bulk upsert (ON CONFLICT IGNORE) — more efficient than ORM for bulk
    const knex = em.getKnex()
    const now = new Date()
    const rows = contactIds.map((contactId: string) => ({
      id: require('crypto').randomUUID(),
      list_id: listId,
      contact_id: contactId,
      added_at: now,
      tenant_id: auth.tenantId,
      organization_id: auth.orgId,
      created_at: now,
      updated_at: now,
    }))

    await knex('email_list_members')
      .insert(rows)
      .onConflict(['list_id', 'contact_id'])
      .ignore()

    const memberCount = await syncMemberCount(em, listId)

    return NextResponse.json({ ok: true, added: memberCount })
  } catch (error) {
    console.error('[email.list-members.add]', error)
    return NextResponse.json({ ok: false, error: 'Failed to add members' }, { status: 500 })
  }
}

// ── DELETE: bulk remove contacts from a list ────────────────────────

export async function DELETE(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const body = await req.json()
    const listId = body.listId
    const contactIds: string[] = body.contactIds

    if (!listId || !Array.isArray(contactIds) || contactIds.length === 0) {
      return NextResponse.json({ ok: false, error: 'listId and contactIds[] are required' }, { status: 400 })
    }

    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()

    const list = await resolveList(em, listId, auth)
    if (!list) return NextResponse.json({ ok: false, error: 'List not found' }, { status: 404 })

    // Soft-delete matching members
    await em.nativeUpdate(
      EmailListMember,
      { listId, contactId: { $in: contactIds }, deletedAt: null },
      { deletedAt: new Date(), updatedAt: new Date() },
    )

    await syncMemberCount(em, listId)

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[email.list-members.remove]', error)
    return NextResponse.json({ ok: false, error: 'Failed to remove members' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Email list members (bulk)',
  description: 'Add, remove, and list contacts on a mailing list. Bulk operations via contactIds arrays.',
  methods: {
    GET: {
      summary: 'List members of a mailing list',
      tags: ['Email'],
      responses: [{ status: 200, description: 'Member list', schema: z.object({ ok: z.literal(true), data: z.array(z.object({ contact_id: z.string(), display_name: z.string().nullable(), primary_email: z.string().nullable(), added_at: z.string() })) }) }],
    },
    POST: {
      summary: 'Bulk add contacts to a list',
      tags: ['Email'],
      requestBody: { contentType: 'application/json', schema: z.object({ listId: z.string().uuid(), contactIds: z.array(z.string().uuid()) }) },
      responses: [{ status: 200, description: 'Members added', schema: z.object({ ok: z.literal(true), added: z.number() }) }],
    },
    DELETE: {
      summary: 'Bulk remove contacts from a list',
      tags: ['Email'],
      requestBody: { contentType: 'application/json', schema: z.object({ listId: z.string().uuid(), contactIds: z.array(z.string().uuid()) }) },
      responses: [{ status: 200, description: 'Members removed', schema: z.object({ ok: z.literal(true) }) }],
    },
  },
}
