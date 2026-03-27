import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

// Send invoice via email to contact
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const invoice = await knex('invoices')
      .where('id', params.id).where('organization_id', auth.orgId).first()
    if (!invoice) return NextResponse.json({ ok: false, error: 'Invoice not found' }, { status: 404 })

    // Get contact email
    let email = null
    if (invoice.contact_id) {
      const contact = await knex('customer_entities').where('id', invoice.contact_id).first()
      email = contact?.primary_email
    }

    const body = await req.json().catch(() => ({}))
    email = body.email || email
    if (!email) return NextResponse.json({ ok: false, error: 'No email address. Set contact or provide email.' }, { status: 400 })

    const items = typeof invoice.line_items === 'string' ? JSON.parse(invoice.line_items) : invoice.line_items
    const baseUrl = process.env.APP_URL || 'http://localhost:3000'

    // Build invoice email HTML
    const itemsHtml = items.map((item: any) =>
      `<tr><td style="padding:8px;border-bottom:1px solid #eee">${item.name}</td>
       <td style="padding:8px;border-bottom:1px solid #eee;text-align:center">${item.quantity || 1}</td>
       <td style="padding:8px;border-bottom:1px solid #eee;text-align:right">$${Number(item.price).toFixed(2)}</td></tr>`
    ).join('')

    const emailHtml = `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#1a1a1a">
      <h2 style="margin-bottom:4px">Invoice ${invoice.invoice_number}</h2>
      <p style="color:#666;margin-bottom:24px">Total: <strong>$${Number(invoice.total).toFixed(2)}</strong>${invoice.due_date ? ` · Due: ${new Date(invoice.due_date).toLocaleDateString()}` : ''}</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
        <thead><tr style="background:#f5f5f5">
          <th style="padding:8px;text-align:left;font-size:12px;text-transform:uppercase;color:#888">Item</th>
          <th style="padding:8px;text-align:center;font-size:12px;text-transform:uppercase;color:#888">Qty</th>
          <th style="padding:8px;text-align:right;font-size:12px;text-transform:uppercase;color:#888">Price</th>
        </tr></thead>
        <tbody>${itemsHtml}</tbody>
        <tfoot><tr>
          <td colspan="2" style="padding:8px;font-weight:700;text-align:right">Total</td>
          <td style="padding:8px;font-weight:700;text-align:right">$${Number(invoice.total).toFixed(2)}</td>
        </tr></tfoot>
      </table>
      ${invoice.stripe_payment_link ? `<a href="${invoice.stripe_payment_link}" style="display:inline-block;padding:12px 24px;background:#3B82F6;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Pay Now</a>` : ''}
      ${invoice.notes ? `<p style="margin-top:24px;color:#888;font-size:14px">${invoice.notes}</p>` : ''}
    </body></html>`

    // Store and "send" the email
    await knex('email_messages').insert({
      id: require('crypto').randomUUID(),
      tenant_id: auth.tenantId, organization_id: auth.orgId,
      direction: 'outbound', from_address: process.env.EMAIL_FROM || 'noreply@localhost',
      to_address: email, subject: `Invoice ${invoice.invoice_number} — $${Number(invoice.total).toFixed(2)}`,
      body_html: emailHtml, contact_id: invoice.contact_id || null,
      status: 'queued', tracking_id: require('crypto').randomUUID(),
      created_at: new Date(),
    })

    // Send via Resend if configured
    const apiKey = process.env.RESEND_API_KEY
    if (apiKey) {
      try {
        const { Resend } = await import('resend')
        const resend = new Resend(apiKey)
        await resend.emails.send({
          from: process.env.EMAIL_FROM || 'noreply@localhost',
          to: [email],
          subject: `Invoice ${invoice.invoice_number} — $${Number(invoice.total).toFixed(2)}`,
          html: emailHtml,
        })
      } catch (err) {
        console.error('[invoice.send] Email send failed:', err)
      }
    }

    // Update invoice status
    await knex('invoices').where('id', params.id).update({
      status: 'sent', sent_at: new Date(), updated_at: new Date(),
    })

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[invoice.send]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
