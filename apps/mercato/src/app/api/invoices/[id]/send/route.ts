import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { sendEmailByPurpose } from '@/modules/email/lib/email-router'

// Send invoice via email to contact — uses connected email provider first, falls back to Resend
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  await bootstrap()
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const { id: invoiceId } = await params
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const invoice = await knex('invoices')
      .where('id', invoiceId).where('organization_id', auth.orgId).first()
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

    // Auto-generate payment link if Stripe is connected and invoice doesn't have one
    if (!invoice.stripe_payment_link && body.autoGeneratePaymentLink !== false) {
      try {
        const stripeKey = process.env.STRIPE_SECRET_KEY
        const stripeConn = await knex('stripe_connections')
          .where('organization_id', auth.orgId).where('is_active', true).first()
        if (stripeKey && stripeConn) {
          const lineItems = (typeof invoice.line_items === 'string' ? JSON.parse(invoice.line_items) : invoice.line_items)
          const Stripe = (await import('stripe')).default
          const stripe = new Stripe(stripeKey)
          const baseUrl = process.env.APP_URL || 'http://localhost:3000'
          const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: lineItems.map((item: any) => ({
              price_data: {
                currency: (invoice.currency || 'usd').toLowerCase(),
                product_data: { name: item.name },
                unit_amount: Math.round(Number(item.price) * 100),
              },
              quantity: item.quantity || 1,
            })),
            mode: 'payment',
            success_url: `${baseUrl}/api/stripe/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${baseUrl}/backend/payments`,
            metadata: { orgId: auth.orgId, tenantId: auth.tenantId || '', invoiceId: invoice.id, type: 'invoice' },
            customer_email: email,
          }, { stripeAccount: stripeConn.stripe_account_id })
          if (session.url) {
            invoice.stripe_payment_link = session.url
            await knex('invoices').where('id', invoiceId).update({ stripe_payment_link: session.url, updated_at: new Date() })
          }
        }
      } catch (stripeErr) {
        console.warn('[invoice.send] Auto payment link generation failed:', stripeErr)
      }
    }

    const items = typeof invoice.line_items === 'string' ? JSON.parse(invoice.line_items) : invoice.line_items

    // Build default invoice email HTML (used if no custom body provided)
    const itemsHtml = items.map((item: any) =>
      `<tr><td style="padding:8px;border-bottom:1px solid #eee">${item.name}</td>
       <td style="padding:8px;border-bottom:1px solid #eee;text-align:center">${item.quantity || 1}</td>
       <td style="padding:8px;border-bottom:1px solid #eee;text-align:right">$${Number(item.price).toFixed(2)}</td></tr>`
    ).join('')

    const invoiceTableHtml = `<table style="width:100%;border-collapse:collapse;margin:16px 0 24px">
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
      </table>`

    const payButtonHtml = invoice.stripe_payment_link
      ? `<a href="${invoice.stripe_payment_link}" style="display:inline-block;padding:12px 24px;background:#3B82F6;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Pay Now</a>`
      : ''

    const defaultSubject = `Invoice ${invoice.invoice_number} - $${Number(invoice.total).toFixed(2)}`
    const defaultBody = `Please find your invoice details below.`

    // Use custom subject/body if provided, otherwise defaults
    const subject = body.subject || defaultSubject
    const userMessage = body.body || defaultBody

    const emailHtml = `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#1a1a1a">
      <h2 style="margin-bottom:4px">Invoice ${invoice.invoice_number}</h2>
      <p style="color:#666;margin-bottom:8px">Total: <strong>$${Number(invoice.total).toFixed(2)}</strong>${invoice.due_date ? ` | Due: ${new Date(invoice.due_date).toLocaleDateString()}` : ''}</p>
      <div style="margin-bottom:16px;white-space:pre-wrap">${userMessage}</div>
      ${invoiceTableHtml}
      ${payButtonHtml}
      ${invoice.notes ? `<p style="margin-top:24px;color:#888;font-size:14px">${invoice.notes}</p>` : ''}
    </body></html>`

    let sentVia = 'resend'
    let fromAddress = process.env.EMAIL_FROM || 'noreply@localhost'
    let externalMessageId: string | undefined

    const ccList = body.cc ? body.cc.split(',').map((s: string) => s.trim()).filter(Boolean) : []
    const bccList = body.bcc ? body.bcc.split(',').map((s: string) => s.trim()).filter(Boolean) : []

    const routerResult = await sendEmailByPurpose(knex, auth.orgId, auth.tenantId || '', 'invoices', {
      to: email,
      subject,
      htmlBody: emailHtml,
      contactId: invoice.contact_id || undefined,
    })

    if (routerResult.ok) {
      sentVia = routerResult.sentVia || 'connected'
      fromAddress = routerResult.fromAddress || fromAddress
      externalMessageId = routerResult.messageId
    } else {
      return NextResponse.json({
        ok: false,
        error: routerResult.error || 'Email send failed',
      }, { status: 422 })
    }

    // Store the email in email_messages with invoice metadata
    const trackingId = require('crypto').randomUUID()
    await knex('email_messages').insert({
      id: require('crypto').randomUUID(),
      tenant_id: auth.tenantId,
      organization_id: auth.orgId,
      direction: 'outbound',
      from_address: fromAddress,
      to_address: email,
      cc: ccList.length ? ccList.join(', ') : null,
      bcc: bccList.length ? bccList.join(', ') : null,
      subject,
      body_html: emailHtml,
      contact_id: invoice.contact_id || null,
      status: 'sent',
      tracking_id: trackingId,
      sent_at: new Date(),
      metadata: JSON.stringify({
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoice_number,
        sentVia,
        externalMessageId: externalMessageId || null,
      }),
      created_at: new Date(),
    })

    // Update invoice status to sent AFTER successful email
    await knex('invoices').where('id', invoiceId).update({
      status: 'sent',
      sent_at: new Date(),
      updated_at: new Date(),
    })

    // Log to contact timeline
    if (invoice.contact_id) {
      try {
        const { logTimelineEvent } = await import('@/lib/timeline')
        await logTimelineEvent(knex, {
          tenantId: auth.tenantId,
          organizationId: auth.orgId,
          contactId: invoice.contact_id,
          eventType: 'invoice_sent',
          title: `Invoice sent: ${invoice.invoice_number}`,
          description: `$${Number(invoice.total).toFixed(2)}`,
        })
      } catch {}
    }

    return NextResponse.json({
      ok: true,
      sentVia,
      fromAddress,
    })
  } catch (error) {
    console.error('[invoice.send]', error)
    const message = error instanceof Error ? error.message : 'Failed to send invoice email'
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
