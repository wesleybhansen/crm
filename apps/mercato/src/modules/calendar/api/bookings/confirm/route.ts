import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export const metadata = {
  GET: { requireAuth: false },
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const token = url.searchParams.get('token')

    if (!token) {
      return new NextResponse(renderErrorHtml('Missing confirmation token.'), {
        status: 400,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    }

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const booking = await knex('bookings')
      .where('confirmation_token', token)
      .where('confirmation_token_expires_at', '>', new Date())
      .where('status', 'pending')
      .first()

    if (!booking) {
      return new NextResponse(renderErrorHtml('This confirmation link has expired or is invalid.'), {
        status: 404,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    }

    await knex('bookings').where('id', booking.id).update({
      status: 'confirmed',
      confirmed_at: new Date(),
      confirmation_token: null,
      confirmation_token_expires_at: null,
    })

    const page = await knex('booking_pages').where('id', booking.booking_page_id).first()

    const startDate = new Date(booking.start_time)
    const endDate = new Date(booking.end_time)
    const dateStr = startDate.toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    })
    const timeStr = startDate.toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true,
    })
    const endTimeStr = endDate.toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true,
    })

    const meetingType = booking.meeting_type || page?.meeting_type || 'in_person'
    const meetingLink = booking.meeting_link || null
    const meetingLocation = booking.meeting_location || page?.meeting_location || null

    const html = renderConfirmationHtml({
      title: page?.title || 'Appointment',
      guestName: booking.guest_name,
      dateStr,
      timeStr,
      endTimeStr,
      durationMinutes: page?.duration_minutes || 30,
      meetingType,
      meetingLink,
      meetingLocation,
    })

    return new NextResponse(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  } catch (error) {
    console.error('[booking.confirm]', error)
    return new NextResponse(renderErrorHtml('An unexpected error occurred. Please try again later.'), {
      status: 500,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  }
}

/** Everything interpolated into these pages is guest- or owner-supplied. */
function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Only http(s) links may become an href (no javascript: or data: URLs). */
function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

function renderErrorHtml(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Booking Confirmation</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Inter', system-ui, sans-serif; background: #FAFAFA; color: #1A1A1A; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card { background: #fff; border-radius: 16px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); max-width: 480px; width: 100%; padding: 40px; text-align: center; }
    .icon { width: 56px; height: 56px; background: #FEE2E2; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; font-size: 28px; }
    h1 { font-size: 22px; font-weight: 700; margin-bottom: 12px; color: #DC2626; }
    p { color: #666; font-size: 15px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">&#10007;</div>
    <h1>Unable to Confirm</h1>
    <p>${escapeHtml(message)}</p>
  </div>
</body>
</html>`
}

function renderConfirmationHtml(details: {
  title: string
  guestName: string
  dateStr: string
  timeStr: string
  endTimeStr: string
  durationMinutes: number
  meetingType: string
  meetingLink: string | null
  meetingLocation: string | null
}): string {
  const meetingTypeLabels: Record<string, string> = {
    google_meet: 'Google Meet',
    zoom: 'Zoom',
    phone: 'Phone Call',
    in_person: 'In Person',
  }

  const meetingLabel = escapeHtml(meetingTypeLabels[details.meetingType] || details.meetingType)
  const meetingHref = safeHttpUrl(details.meetingLink)

  let meetingDetails = ''
  if (meetingHref) {
    meetingDetails = `
      <div class="detail">
        <span class="detail-label">Meeting Link</span>
        <a href="${escapeHtml(meetingHref)}" target="_blank" rel="noopener noreferrer" class="meeting-link">${meetingLabel} &rarr;</a>
      </div>`
  } else if (details.meetingLocation) {
    meetingDetails = `
      <div class="detail">
        <span class="detail-label">${details.meetingType === 'phone' ? 'Phone' : 'Location'}</span>
        <span class="detail-value">${escapeHtml(details.meetingLocation)}</span>
      </div>`
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Appointment Confirmed</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Inter', system-ui, sans-serif; background: #FAFAFA; color: #1A1A1A; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card { background: #fff; border-radius: 16px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); max-width: 480px; width: 100%; padding: 40px; }
    .header { text-align: center; margin-bottom: 28px; }
    .icon { width: 56px; height: 56px; background: #D1FAE5; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 16px; font-size: 28px; color: #059669; }
    h1 { font-size: 22px; font-weight: 700; margin-bottom: 4px; }
    .subtitle { color: #666; font-size: 14px; }
    .details { background: #F9FAFB; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
    .detail { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid #E5E7EB; }
    .detail:last-child { border-bottom: none; }
    .detail-label { font-size: 13px; font-weight: 600; color: #888; text-transform: uppercase; letter-spacing: 0.03em; }
    .detail-value { font-size: 14px; font-weight: 500; color: #1A1A1A; text-align: right; }
    .meeting-link { font-size: 14px; font-weight: 600; color: #3B82F6; text-decoration: none; }
    .meeting-link:hover { text-decoration: underline; }
    .footer { text-align: center; color: #999; font-size: 13px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="icon">&#10003;</div>
      <h1>Your Appointment is Confirmed!</h1>
      <p class="subtitle">${escapeHtml(details.title)}</p>
    </div>
    <div class="details">
      <div class="detail">
        <span class="detail-label">Date</span>
        <span class="detail-value">${escapeHtml(details.dateStr)}</span>
      </div>
      <div class="detail">
        <span class="detail-label">Time</span>
        <span class="detail-value">${escapeHtml(details.timeStr)} - ${escapeHtml(details.endTimeStr)}</span>
      </div>
      <div class="detail">
        <span class="detail-label">Duration</span>
        <span class="detail-value">${escapeHtml(details.durationMinutes)} minutes</span>
      </div>
      <div class="detail">
        <span class="detail-label">Meeting Type</span>
        <span class="detail-value">${meetingLabel}</span>
      </div>${meetingDetails}
    </div>
    <p class="footer">
      Hi ${escapeHtml(details.guestName)}, your booking has been confirmed.<br>
      You can close this page now.
    </p>
  </div>
</body>
</html>`
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Calendar', summary: 'Confirm booking via token',
  methods: {
    GET: { summary: 'Confirm a pending booking (public, returns HTML)', tags: ['Calendar (Public)'] },
  },
}
