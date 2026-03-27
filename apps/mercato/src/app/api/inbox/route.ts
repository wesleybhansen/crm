import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const url = new URL(req.url)

    const search = url.searchParams.get('search')?.trim() || ''
    const channel = url.searchParams.get('channel') || 'all'

    // Build a union of email and sms messages with contact_id
    const emailQuery = knex('email_messages')
      .select(
        'contact_id',
        knex.raw("'email' as channel"),
        knex.raw('LEFT(COALESCE(subject, body_text, body_html), 120) as preview'),
        'direction',
        'created_at',
        knex.raw("CASE WHEN direction = 'inbound' AND status NOT IN ('opened', 'clicked') THEN false ELSE true END as is_read"),
      )
      .where('organization_id', auth.orgId)
      .where('tenant_id', auth.tenantId)
      .whereNotNull('contact_id')

    const smsQuery = knex('sms_messages')
      .select(
        'contact_id',
        knex.raw("'sms' as channel"),
        knex.raw('LEFT(body, 120) as preview'),
        'direction',
        'created_at',
        knex.raw('true as is_read'),
      )
      .where('organization_id', auth.orgId)
      .where('tenant_id', auth.tenantId)
      .whereNotNull('contact_id')

    let messagesUnion
    if (channel === 'email') {
      messagesUnion = emailQuery
    } else if (channel === 'sms') {
      messagesUnion = smsQuery
    } else {
      messagesUnion = emailQuery.unionAll(smsQuery)
    }

    // Get the latest message per contact and aggregate counts
    const conversations = await knex
      .with('all_messages', messagesUnion)
      .with('ranked', (qb: any) => {
        qb.select('*')
          .select(knex.raw('ROW_NUMBER() OVER (PARTITION BY contact_id ORDER BY created_at DESC) as rn'))
          .from('all_messages')
      })
      .with('latest', (qb: any) => {
        qb.select('*').from('ranked').where('rn', 1)
      })
      .with('counts', (qb: any) => {
        qb.select('contact_id')
          .count('* as message_count')
          .select(knex.raw("SUM(CASE WHEN is_read = false THEN 1 ELSE 0 END)::int as unread_count"))
          .from('all_messages')
          .groupBy('contact_id')
      })
      .select(
        'latest.contact_id',
        'latest.channel',
        'latest.preview',
        'latest.direction',
        'latest.created_at as last_message_at',
        'latest.is_read as last_is_read',
        'ce.display_name as contact_name',
        'ce.primary_email as contact_email',
        'ce.primary_phone as contact_phone',
      )
      .select(knex.raw('COALESCE(counts.message_count, 0)::int as message_count'))
      .select(knex.raw('COALESCE(counts.unread_count, 0)::int as unread_count'))
      .from('latest')
      .join('customer_entities as ce', function (this: any) {
        this.on('ce.id', '=', 'latest.contact_id')
          .andOn('ce.organization_id', '=', knex.raw('?', [auth.orgId]))
          .andOnNull('ce.deleted_at')
      })
      .leftJoin('counts', 'counts.contact_id', 'latest.contact_id')
      .modify((qb: any) => {
        if (search) {
          qb.where(function (this: any) {
            this.whereILike('ce.display_name', `%${search}%`)
              .orWhereILike('ce.primary_email', `%${search}%`)
          })
        }
      })
      .orderBy('latest.created_at', 'desc')
      .limit(50)

    const data = conversations.map((row: any) => ({
      contactId: row.contact_id,
      contactName: row.contact_name,
      contactEmail: row.contact_email,
      contactPhone: row.contact_phone,
      lastMessage: {
        channel: row.channel,
        preview: row.preview,
        timestamp: row.last_message_at,
        direction: row.direction,
        isRead: row.last_is_read,
      },
      unreadCount: row.unread_count,
      messageCount: row.message_count,
    }))

    return NextResponse.json({ ok: true, data })
  } catch (error) {
    console.error('[inbox.list]', error)
    return NextResponse.json({ ok: false, error: 'Failed to load inbox' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Inbox',
  summary: 'Unified inbox conversations',
  methods: {
    GET: { summary: 'List threaded conversations grouped by contact', tags: ['Inbox'] },
  },
}
