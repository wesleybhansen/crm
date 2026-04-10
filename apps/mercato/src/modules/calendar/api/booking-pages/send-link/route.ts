import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { sendEmailByPurpose } from '@/modules/email/lib/email-router'


export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['calendar.manage'] },
}

export async function POST(req: Request, ctx: any) {
  const auth = ctx?.auth || await getAuthFromCookies()
  if (!auth?.orgId || !auth?.tenantId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await req.json()
    const { bookingPageId, contactId, customMessage } = body

    if (!bookingPageId || !contactId) {
      return NextResponse.json({ ok: false, error: 'bookingPageId and contactId are required' }, { status: 400 })
    }

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // Look up the booking page
    const bookingPage = await knex('booking_pages')
      .where('id', bookingPageId)
      .where('organization_id', auth.orgId)
      .where('is_active', true)
      .first()

    if (!bookingPage) {
      return NextResponse.json({ ok: false, error: 'Booking page not found or inactive' }, { status: 404 })
    }

    // Look up the contact
    const contact = await knex('customer_entities')
      .where('id', contactId)
      .where('organization_id', auth.orgId)
      .first()

    if (!contact) {
      return NextResponse.json({ ok: false, error: 'Contact not found' }, { status: 404 })
    }

    if (!contact.primary_email) {
      return NextResponse.json({ ok: false, error: 'Contact does not have an email address' }, { status: 400 })
    }

    // Look up the sender (current user)
    const sender = await knex('users').where('id', auth.sub).select('name', 'email').first()
    const senderName = sender?.name || 'Your team'

    // Build the booking URL
    const baseUrl = process.env.APP_URL || 'http://localhost:3000'
    const bookingUrl = `${baseUrl}/api/calendar/book/${bookingPage.slug}?contact=${contactId}`

    // Build the email HTML
    const contactName = contact.display_name || contact.primary_email
    const durationLabel = `${bookingPage.duration_minutes || 30} minutes`

    const customMessageHtml = customMessage
      ? `<tr><td style="padding:0 32px 20px">
          <p style="margin:0;font-size:14px;color:#374151;line-height:1.6;font-style:italic;background:#f9fafb;border-radius:8px;padding:16px">${customMessage.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>
        </td></tr>`
      : ''

    const htmlBody = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.06)">
        <tr><td style="padding:32px 32px 0;text-align:center">
          <div style="width:48px;height:48px;background:#DBEAFE;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:22px;line-height:48px">&#128197;</div>
        </td></tr>
        <tr><td style="padding:16px 32px 4px;text-align:center">
          <h1 style="margin:0;font-size:22px;font-weight:700;color:#1a1a1a">You're Invited to Book a Meeting</h1>
        </td></tr>
        <tr><td style="padding:4px 32px 24px;text-align:center">
          <p style="margin:0;font-size:14px;color:#666">${senderName} would like to schedule a meeting with you.</p>
        </td></tr>
        ${customMessageHtml}
        <tr><td style="padding:0 32px 24px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:8px;padding:20px">
            <tr><td style="padding:8px 16px">
              <span style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#888;font-weight:600">Meeting</span><br>
              <span style="font-size:15px;color:#1a1a1a;font-weight:500">${bookingPage.title}</span>
            </td></tr>
            <tr><td style="padding:8px 16px">
              <span style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#888;font-weight:600">Duration</span><br>
              <span style="font-size:15px;color:#1a1a1a;font-weight:500">${durationLabel}</span>
            </td></tr>
            ${bookingPage.description ? `<tr><td style="padding:8px 16px">
              <span style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#888;font-weight:600">Details</span><br>
              <span style="font-size:14px;color:#374151">${bookingPage.description}</span>
            </td></tr>` : ''}
          </table>
        </td></tr>
        <tr><td style="padding:0 32px 24px;text-align:center">
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto">
            <tr><td style="background:#3B82F6;border-radius:8px">
              <a href="${bookingUrl}" style="display:inline-block;padding:14px 32px;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px">Choose a Time</a>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:0 32px 32px;text-align:center">
          <p style="margin:0;font-size:12px;color:#999">Or copy this link: <a href="${bookingUrl}" style="color:#3B82F6;text-decoration:none;word-break:break-all">${bookingUrl}</a></p>
        </td></tr>
      </table>
      <p style="margin-top:24px;font-size:12px;color:#999;text-align:center">This is an automated message. Please do not reply directly.</p>
    </td></tr>
  </table>
</body>
</html>`

    const subject = `${senderName} invited you to book a meeting: ${bookingPage.title}`

    // Send the email
    const result = await sendEmailByPurpose(knex, auth.orgId, auth.tenantId, 'transactional', {
      to: contact.primary_email,
      subject,
      htmlBody,
    })

    // Store in email_messages
    const crypto = require('crypto')
    try {
      await knex('email_messages').insert({
        id: crypto.randomUUID(),
        tenant_id: auth.tenantId,
        organization_id: auth.orgId,
        direction: 'outbound',
        from_address: result.fromAddress || process.env.EMAIL_FROM || 'noreply@localhost',
        to_address: contact.primary_email,
        subject,
        body_html: htmlBody,
        status: result.ok ? 'sent' : 'failed',
        tracking_id: crypto.randomUUID(),
        sent_at: result.ok ? new Date() : null,
        metadata: JSON.stringify({
          type: 'booking_link',
          bookingPageId: bookingPage.id,
          contactId,
          sentVia: result.sentVia || null,
          externalMessageId: result.messageId || null,
        }),
        created_at: new Date(),
      })
    } catch {
      // Non-critical -- email was sent even if tracking insert fails
    }

    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error || 'Failed to send email' }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      data: {
        sentTo: contact.primary_email,
        contactName,
        bookingPageTitle: bookingPage.title,
        bookingUrl,
      },
    })
  } catch (error) {
    console.error('[calendar.booking-pages.send-link]', error)
    return NextResponse.json({ ok: false, error: 'Failed to send booking link' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Calendar', summary: 'Send booking link to contact',
  methods: {
    POST: { summary: 'Send a booking page link to a contact via email', tags: ['Calendar'] },
  },
}
