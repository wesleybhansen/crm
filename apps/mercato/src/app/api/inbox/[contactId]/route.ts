import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ contactId: string }> },
) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const { contactId } = await params

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // Verify contact belongs to this org
    const contact = await knex('customer_entities')
      .where('id', contactId)
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .first()

    if (!contact) {
      return NextResponse.json({ ok: false, error: 'Contact not found' }, { status: 404 })
    }

    // Query email messages for this contact
    const emailMessages = await knex('email_messages')
      .select(
        'id',
        'direction',
        'subject',
        'body_html',
        'body_text',
        'from_address',
        'to_address',
        'status',
        'opened_at',
        'clicked_at',
        'created_at',
      )
      .where('contact_id', contactId)
      .where('organization_id', auth.orgId)
      .where('tenant_id', auth.tenantId)

    // Query sms messages for this contact
    const smsMessages = await knex('sms_messages')
      .select(
        'id',
        'direction',
        'body',
        'from_number',
        'to_number',
        'status',
        'created_at',
      )
      .where('contact_id', contactId)
      .where('organization_id', auth.orgId)
      .where('tenant_id', auth.tenantId)

    // Combine and sort chronologically
    const messages = [
      ...emailMessages.map((msg: any) => ({
        id: msg.id,
        channel: 'email' as const,
        direction: msg.direction,
        subject: msg.subject,
        body: msg.body_html || msg.body_text || '',
        bodyText: msg.body_text,
        fromAddress: msg.from_address,
        toAddress: msg.to_address,
        status: msg.status,
        openedAt: msg.opened_at,
        clickedAt: msg.clicked_at,
        createdAt: msg.created_at,
      })),
      ...smsMessages.map((msg: any) => ({
        id: msg.id,
        channel: 'sms' as const,
        direction: msg.direction,
        subject: null,
        body: msg.body,
        bodyText: msg.body,
        fromAddress: msg.from_number,
        toAddress: msg.to_number,
        status: msg.status,
        openedAt: null,
        clickedAt: null,
        createdAt: msg.created_at,
      })),
    ].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())

    return NextResponse.json({
      ok: true,
      data: {
        contact: {
          id: contact.id,
          displayName: contact.display_name,
          email: contact.primary_email,
          phone: contact.primary_phone,
        },
        messages,
      },
    })
  } catch (error) {
    console.error('[inbox.detail]', error)
    return NextResponse.json({ ok: false, error: 'Failed to load conversation' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Inbox',
  summary: 'Conversation detail for a contact',
  methods: {
    GET: { summary: 'Get all messages for a specific contact', tags: ['Inbox'] },
  },
}
