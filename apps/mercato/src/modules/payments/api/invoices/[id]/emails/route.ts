export const metadata = { GET: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

// GET email history for a specific invoice
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const { id: invoiceId } = await params
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // Verify invoice belongs to this org
    const invoice = await knex('invoices')
      .where('id', invoiceId)
      .where('organization_id', auth.orgId)
      .first()
    if (!invoice) return NextResponse.json({ ok: false, error: 'Invoice not found' }, { status: 404 })

    // Fetch emails related to this invoice:
    // 1. Emails with invoiceId in metadata
    // 2. Emails with invoice number in subject (as fallback for older records)
    const emails = await knex('email_messages')
      .where('organization_id', auth.orgId)
      .where(function () {
        this.whereRaw("metadata::text LIKE ?", [`%"invoiceId":"${invoiceId}"%`])
          .orWhere(function () {
            if (invoice.invoice_number) {
              this.where('subject', 'like', `%${invoice.invoice_number}%`)
            }
          })
      })
      .orderBy('created_at', 'desc')
      .limit(50)

    // Gather outbound message IDs to find replies
    const outboundMessageIds = emails
      .filter((e: any) => e.direction === 'outbound' && e.message_id)
      .map((e: any) => e.message_id)

    let replies: any[] = []
    if (outboundMessageIds.length > 0) {
      replies = await knex('email_messages')
        .where('organization_id', auth.orgId)
        .where('direction', 'inbound')
        .whereIn('in_reply_to', outboundMessageIds)
        .orderBy('created_at', 'desc')
        .limit(50)
    }

    // Merge and deduplicate
    const allEmailIds = new Set(emails.map((e: any) => e.id))
    for (const reply of replies) {
      if (!allEmailIds.has(reply.id)) {
        emails.push(reply)
        allEmailIds.add(reply.id)
      }
    }

    // Sort all by created_at descending
    emails.sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

    const result = emails.map((e: any) => ({
      id: e.id,
      direction: e.direction,
      from_address: e.from_address,
      to_address: e.to_address,
      cc: e.cc || null,
      bcc: e.bcc || null,
      subject: e.subject,
      body_html: e.body_html,
      status: e.status,
      sent_at: e.sent_at || e.created_at,
      opened_at: e.opened_at || null,
      clicked_at: e.clicked_at || null,
      created_at: e.created_at,
    }))

    return NextResponse.json({ ok: true, data: result })
  } catch (error) {
    console.error('[invoice.emails]', error)
    return NextResponse.json({ ok: false, error: 'Failed to fetch email history' }, { status: 500 })
  }
}
