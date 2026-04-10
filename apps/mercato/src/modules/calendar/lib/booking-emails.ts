/**
 * Booking Email Service
 * Sends confirmation emails to guests and notification emails to booking page owners.
 */

import type { Knex } from 'knex'
import { sendEmailByPurpose } from '@/modules/email/lib/email-router'

interface BookingEmailParams {
  knex: Knex
  orgId: string
  tenantId: string
  ownerUserId?: string
  booking: Record<string, any>
  bookingPage: Record<string, any>
}

function formatDateTime(date: Date): string {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }) + ' at ' + date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

function getMeetingTypeIcon(meetingType: string): string {
  switch (meetingType) {
    case 'google_meet': return '&#128249;'
    case 'zoom': return '&#128247;'
    case 'phone': return '&#128222;'
    case 'in_person': return '&#128205;'
    default: return '&#128197;'
  }
}

function getMeetingTypeLabel(meetingType: string): string {
  switch (meetingType) {
    case 'google_meet': return 'Google Meet'
    case 'zoom': return 'Zoom'
    case 'phone': return 'Phone Call'
    case 'in_person': return 'In Person'
    default: return 'Meeting'
  }
}

function getMeetingDetailHtml(booking: Record<string, any>, bookingPage: Record<string, any>): string {
  const meetingType = bookingPage.meeting_type || 'google_meet'
  const meetLink = booking.meeting_link || bookingPage.meeting_link
  const location = bookingPage.meeting_location

  if (meetingType === 'google_meet' && meetLink) {
    return `<a href="${meetLink}" style="color:#1a73e8;text-decoration:none;font-weight:500">${meetLink}</a>`
  }
  if (meetingType === 'zoom' && meetLink) {
    return `<a href="${meetLink}" style="color:#2d8cff;text-decoration:none;font-weight:500">${meetLink}</a>`
  }
  if (meetingType === 'phone' && location) {
    return `<span style="font-weight:500">${location}</span>`
  }
  if (meetingType === 'in_person' && location) {
    return `<span style="font-weight:500">${location}</span>`
  }
  if (meetLink) {
    return `<a href="${meetLink}" style="color:#3B82F6;text-decoration:none;font-weight:500">${meetLink}</a>`
  }
  return '<span style="color:#888">Details will be shared before the meeting</span>'
}

function buildEmailWrapper(content: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.06)">
        ${content}
      </table>
      <p style="margin-top:24px;font-size:12px;color:#999;text-align:center">This is an automated message. Please do not reply directly.</p>
    </td></tr>
  </table>
</body>
</html>`
}

/**
 * Send a booking confirmation email to the guest.
 */
export async function sendBookingConfirmationToGuest(params: BookingEmailParams): Promise<void> {
  const { knex, orgId, tenantId, ownerUserId, booking, bookingPage } = params

  if (!booking.guest_email) return

  const startTime = new Date(booking.start_time)
  const endTime = new Date(booking.end_time)
  const durationMinutes = Math.round((endTime.getTime() - startTime.getTime()) / 60000)
  const meetingType = bookingPage.meeting_type || 'google_meet'
  const isAutoConfirm = bookingPage.auto_confirm !== false
  const isPending = !isAutoConfirm && booking.status === 'pending'

  // Look up the owner's name and email
  const owner = await knex('users')
    .where('id', ownerUserId)
    .select('name', 'email')
    .first()

  const subject = isAutoConfirm
    ? `Your appointment is confirmed: ${bookingPage.title}`
    : `Please confirm your appointment: ${bookingPage.title}`

  const baseUrl = process.env.APP_URL || 'http://localhost:3000'

  const confirmButtonHtml = isPending && booking.confirmation_token
    ? `<tr><td style="padding:0 32px 24px">
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto">
          <tr><td style="background:#16a34a;border-radius:8px">
            <a href="${baseUrl}/api/calendar/bookings/confirm?token=${booking.confirmation_token}" style="display:inline-block;padding:14px 32px;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px">Confirm Appointment</a>
          </td></tr>
        </table>
      </td></tr>`
    : ''

  const statusBadge = isPending
    ? '<span style="display:inline-block;padding:3px 10px;background:#FEF3C7;color:#92400E;border-radius:12px;font-size:12px;font-weight:600">Pending Confirmation</span>'
    : '<span style="display:inline-block;padding:3px 10px;background:#D1FAE5;color:#065F46;border-radius:12px;font-size:12px;font-weight:600">Confirmed</span>'

  const content = `
    <tr><td style="padding:32px 32px 0;text-align:center">
      <div style="width:48px;height:48px;background:${isPending ? '#FEF3C7' : '#D1FAE5'};border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:22px;line-height:48px">${isPending ? '&#9203;' : '&#10003;'}</div>
    </td></tr>
    <tr><td style="padding:16px 32px 4px;text-align:center">
      <h1 style="margin:0;font-size:22px;font-weight:700;color:#1a1a1a">${isAutoConfirm ? 'Appointment Confirmed' : 'Appointment Requested'}</h1>
    </td></tr>
    <tr><td style="padding:4px 32px 24px;text-align:center">
      <p style="margin:0;font-size:14px;color:#666">${bookingPage.title} ${statusBadge}</p>
    </td></tr>
    <tr><td style="padding:0 32px 24px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:8px;padding:20px">
        <tr><td style="padding:8px 16px">
          <span style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#888;font-weight:600">Date &amp; Time</span><br>
          <span style="font-size:15px;color:#1a1a1a;font-weight:500">${formatDateTime(startTime)}</span>
        </td></tr>
        <tr><td style="padding:8px 16px">
          <span style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#888;font-weight:600">Duration</span><br>
          <span style="font-size:15px;color:#1a1a1a;font-weight:500">${durationMinutes} minutes</span>
        </td></tr>
        <tr><td style="padding:8px 16px">
          <span style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#888;font-weight:600">${getMeetingTypeIcon(meetingType)} ${getMeetingTypeLabel(meetingType)}</span><br>
          ${getMeetingDetailHtml(booking, bookingPage)}
        </td></tr>
      </table>
    </td></tr>
    ${confirmButtonHtml}
    ${owner ? `<tr><td style="padding:0 32px 32px">
      <p style="margin:0;font-size:13px;color:#888">Your host: <strong>${owner.name || 'Team'}</strong>${owner.email ? ` (${owner.email})` : ''}</p>
    </td></tr>` : ''}`

  const htmlBody = buildEmailWrapper(content)

  // Send the email via personal connection (Gmail/Outlook) so it comes from the business owner
  const result = await sendEmailByPurpose(knex, orgId, tenantId, 'inbox', {
    to: booking.guest_email,
    subject,
    htmlBody,
  })

  // Store in email_messages
  const crypto = require('crypto')
  try {
    await knex('email_messages').insert({
      id: crypto.randomUUID(),
      tenant_id: tenantId,
      organization_id: orgId,
      direction: 'outbound',
      from_address: result.fromAddress || process.env.EMAIL_FROM || 'noreply@localhost',
      to_address: booking.guest_email,
      subject,
      body_html: htmlBody,
      status: result.ok ? 'sent' : 'failed',
      tracking_id: crypto.randomUUID(),
      sent_at: result.ok ? new Date() : null,
      metadata: JSON.stringify({
        type: 'booking_confirmation',
        bookingId: booking.id,
        bookingPageId: bookingPage.id,
        sentVia: result.sentVia || null,
        externalMessageId: result.messageId || null,
      }),
      created_at: new Date(),
    })
  } catch {
    // Non-critical — email was sent even if tracking insert fails
  }

  // Log to contact timeline
  if (result.ok && booking.contact_id) {
    try {
      const { logTimelineEvent } = await import('@/lib/timeline')
      await logTimelineEvent(knex, {
        tenantId,
        organizationId: orgId,
        contactId: booking.contact_id,
        eventType: 'booking_confirmation',
        title: `Booking confirmed`,
      })
    } catch {}
  }
}

/**
 * Send a booking notification email to the booking page owner.
 */
export async function sendBookingNotificationToOwner(params: BookingEmailParams): Promise<void> {
  const { knex, orgId, tenantId, ownerUserId, booking, bookingPage } = params

  // Find owner's email address
  let ownerEmail: string | undefined
  if (ownerUserId) {
    const owner = await knex('users')
      .where('id', ownerUserId)
      .select('name', 'email')
      .first()
    ownerEmail = owner?.email

    // Fall back to email_connections if users table doesn't have email
    if (!ownerEmail) {
      const emailConn = await knex('email_connections')
        .where('user_id', ownerUserId)
        .where('organization_id', orgId)
        .where('is_active', true)
        .orderBy('is_primary', 'desc')
        .select('email_address')
        .first()
      ownerEmail = emailConn?.email_address
    }
  }

  if (!ownerEmail) return

  const startTime = new Date(booking.start_time)
  const endTime = new Date(booking.end_time)
  const durationMinutes = Math.round((endTime.getTime() - startTime.getTime()) / 60000)
  const meetingType = bookingPage.meeting_type || 'google_meet'
  const isPending = bookingPage.auto_confirm === false && booking.status === 'pending'
  const baseUrl = process.env.APP_URL || 'http://localhost:3000'

  const subject = `New booking: ${booking.guest_name} - ${bookingPage.title}`

  const pendingNotice = isPending
    ? `<tr><td style="padding:0 32px 16px">
        <div style="background:#FEF3C7;border-radius:8px;padding:12px 16px;font-size:14px;color:#92400E">
          <strong>Action required:</strong> This booking requires your confirmation.
          <a href="${baseUrl}/backend/calendar" style="color:#92400E;font-weight:600;margin-left:4px">Review in Dashboard</a>
        </div>
      </td></tr>`
    : ''

  const content = `
    <tr><td style="padding:32px 32px 0;text-align:center">
      <div style="width:48px;height:48px;background:#DBEAFE;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:22px;line-height:48px">&#128197;</div>
    </td></tr>
    <tr><td style="padding:16px 32px 4px;text-align:center">
      <h1 style="margin:0;font-size:22px;font-weight:700;color:#1a1a1a">New Booking</h1>
    </td></tr>
    <tr><td style="padding:4px 32px 24px;text-align:center">
      <p style="margin:0;font-size:14px;color:#666">${bookingPage.title}</p>
    </td></tr>
    ${pendingNotice}
    <tr><td style="padding:0 32px 24px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:8px;padding:20px">
        <tr><td style="padding:8px 16px">
          <span style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#888;font-weight:600">Guest</span><br>
          <span style="font-size:15px;color:#1a1a1a;font-weight:500">${booking.guest_name}</span>
        </td></tr>
        <tr><td style="padding:8px 16px">
          <span style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#888;font-weight:600">Email</span><br>
          <a href="mailto:${booking.guest_email}" style="font-size:15px;color:#3B82F6;text-decoration:none">${booking.guest_email}</a>
        </td></tr>
        ${booking.guest_phone ? `<tr><td style="padding:8px 16px">
          <span style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#888;font-weight:600">Phone</span><br>
          <span style="font-size:15px;color:#1a1a1a;font-weight:500">${booking.guest_phone}</span>
        </td></tr>` : ''}
        <tr><td style="padding:8px 16px">
          <span style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#888;font-weight:600">Date &amp; Time</span><br>
          <span style="font-size:15px;color:#1a1a1a;font-weight:500">${formatDateTime(startTime)}</span>
        </td></tr>
        <tr><td style="padding:8px 16px">
          <span style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#888;font-weight:600">Duration</span><br>
          <span style="font-size:15px;color:#1a1a1a;font-weight:500">${durationMinutes} minutes</span>
        </td></tr>
        <tr><td style="padding:8px 16px">
          <span style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#888;font-weight:600">${getMeetingTypeIcon(meetingType)} ${getMeetingTypeLabel(meetingType)}</span><br>
          ${getMeetingDetailHtml(booking, bookingPage)}
        </td></tr>
        ${booking.notes ? `<tr><td style="padding:8px 16px">
          <span style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#888;font-weight:600">Notes</span><br>
          <span style="font-size:15px;color:#1a1a1a">${booking.notes}</span>
        </td></tr>` : ''}
      </table>
    </td></tr>
    <tr><td style="padding:0 32px 32px;text-align:center">
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto">
        <tr><td style="background:#3B82F6;border-radius:8px">
          <a href="${baseUrl}/backend/calendar" style="display:inline-block;padding:12px 28px;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px">View in Dashboard</a>
        </td></tr>
      </table>
    </td></tr>`

  const htmlBody = buildEmailWrapper(content)

  // Send the email via personal connection (Gmail/Outlook) — same as guest confirmation
  const result = await sendEmailByPurpose(knex, orgId, tenantId, 'inbox', {
    to: ownerEmail,
    subject,
    htmlBody,
  })

  // Store in email_messages
  const crypto = require('crypto')
  try {
    await knex('email_messages').insert({
      id: crypto.randomUUID(),
      tenant_id: tenantId,
      organization_id: orgId,
      direction: 'outbound',
      from_address: result.fromAddress || process.env.EMAIL_FROM || 'noreply@localhost',
      to_address: ownerEmail,
      subject,
      body_html: htmlBody,
      status: result.ok ? 'sent' : 'failed',
      tracking_id: crypto.randomUUID(),
      sent_at: result.ok ? new Date() : null,
      metadata: JSON.stringify({
        type: 'booking_owner_notification',
        bookingId: booking.id,
        bookingPageId: bookingPage.id,
        sentVia: result.sentVia || null,
        externalMessageId: result.messageId || null,
      }),
      created_at: new Date(),
    })
  } catch {
    // Non-critical — email was sent even if tracking insert fails
  }
}
