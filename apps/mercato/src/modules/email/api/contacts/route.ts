/**
 * Email contacts picker — returns org contacts with decrypted names.
 *
 * Replaces legacy /api/email-lists/contacts which used raw knex without
 * decryption (encrypted display_name values leaked to the UI).
 *
 * New URL: /api/email/contacts
 */
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CustomerEntity } from '@open-mercato/core/modules/customers/data/entities'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { z } from 'zod'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['email.lists.view'] },
}

export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const url = new URL(req.url)
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '500', 10), 1000)

    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()

    const contacts = await findWithDecryption(
      em,
      CustomerEntity,
      {
        organizationId: auth.orgId,
        tenantId: auth.tenantId,
        kind: 'person',
        primaryEmail: { $ne: null },
        deletedAt: null,
      },
      {
        fields: ['id', 'displayName', 'primaryEmail'],
        orderBy: { displayName: 'asc' },
        limit,
      },
      { tenantId: auth.tenantId, organizationId: auth.orgId },
    )

    const data = contacts.map(c => ({
      id: c.id,
      display_name: c.displayName,
      primary_email: c.primaryEmail,
    }))

    return NextResponse.json({ ok: true, data })
  } catch (error) {
    console.error('[email.contacts.list]', error)
    return NextResponse.json({ ok: false, error: 'Failed to fetch contacts' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Email contacts picker',
  description: 'Returns org contacts (people with email) for the email list builder. Decrypts encrypted display names.',
  methods: {
    GET: {
      summary: 'List contacts for email list picker',
      tags: ['Email'],
      responses: [
        {
          status: 200,
          description: 'Contact list',
          schema: z.object({
            ok: z.literal(true),
            data: z.array(z.object({
              id: z.string().uuid(),
              display_name: z.string(),
              primary_email: z.string().email().nullable(),
            })),
          }),
        },
      ],
    },
  },
}
