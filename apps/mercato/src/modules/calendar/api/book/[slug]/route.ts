import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export const metadata = {
  GET: { requireAuth: false },
}

export async function GET(req: Request, ctx: any) {
  const slug = ctx?.params?.slug
  if (!slug) return new NextResponse('Not found', { status: 404 })

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const page = await knex('booking_pages').where('slug', slug).where('is_active', true).first()
    if (!page) return new NextResponse('Booking page not found', { status: 404, headers: { 'Content-Type': 'text/html' } })

    // Get existing bookings for next 14 days to show availability
    const now = new Date()
    const twoWeeksOut = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000)
    const existingBookings = await knex('bookings')
      .where('booking_page_id', page.id)
      .where('status', 'confirmed')
      .where('start_time', '>=', now)
      .where('start_time', '<=', twoWeeksOut)
      .select('start_time', 'end_time')

    let bookedSlots = existingBookings.map((b: any) => ({
      start: new Date(b.start_time).toISOString(),
      end: new Date(b.end_time).toISOString(),
    }))

    // Also get Google Calendar busy times if owner has connected
    if (page.owner_user_id) {
      try {
        const { getGoogleBusyTimes } = await import('../../../../app/api/google/calendar-service')
        const googleBusy = await getGoogleBusyTimes(page.owner_user_id, now, twoWeeksOut)
        bookedSlots = [...bookedSlots, ...googleBusy]
      } catch {}
    }

    const baseUrl = process.env.APP_URL || 'http://localhost:3000'
    const submitUrl = `${baseUrl}/api/calendar/bookings`

    const html = generateBookingPageHtml(page, bookedSlots, submitUrl)
    return new NextResponse(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  } catch (error) {
    console.error('[booking.page]', error)
    return new NextResponse('Server error', { status: 500 })
  }
}

function generateBookingPageHtml(page: any, bookedSlots: any[], submitUrl: string): string {
  const availability = typeof page.availability === 'string' ? JSON.parse(page.availability) : page.availability

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Book: ${page.title}</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Inter', system-ui, sans-serif; background: #FAFAFA; color: #1A1A1A; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card { background: #fff; border-radius: 16px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); max-width: 480px; width: 100%; padding: 40px; }
    h1 { font-size: 24px; font-weight: 700; margin-bottom: 4px; }
    .subtitle { color: #666; font-size: 14px; margin-bottom: 24px; }
    .meta { display: flex; gap: 16px; margin-bottom: 24px; font-size: 13px; color: #888; }
    .meta span { display: flex; align-items: center; gap: 4px; }
    label { display: block; font-size: 12px; font-weight: 600; color: #888; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; }
    input, select { width: 100%; padding: 10px 14px; border: 1px solid #E5E5E5; border-radius: 8px; font-size: 14px; font-family: inherit; outline: none; transition: border-color 0.15s; }
    input:focus, select:focus { border-color: #3B82F6; }
    .field { margin-bottom: 16px; }
    button[type="submit"] { width: 100%; padding: 12px; background: #3B82F6; color: #fff; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; margin-top: 8px; }
    button[type="submit"]:hover { background: #2563EB; }
    button[type="submit"]:disabled { opacity: 0.6; cursor: not-allowed; }
    .success { text-align: center; padding: 24px 0; }
    .success h2 { font-size: 20px; margin-bottom: 8px; }
    .success p { color: #666; font-size: 14px; }
    .check { width: 48px; height: 48px; background: #D1FAE5; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 16px; font-size: 24px; }
  </style>
</head>
<body>
  <div class="card" id="booking-form">
    <h1>${page.title}</h1>
    ${page.description ? `<p class="subtitle">${page.description}</p>` : ''}
    <div class="meta">
      <span>&#128337; ${page.duration_minutes} minutes</span>
    </div>
    <form onsubmit="submitBooking(event)">
      <div class="field">
        <label>Your Name</label>
        <input type="text" name="guestName" required placeholder="Jane Doe">
      </div>
      <div class="field">
        <label>Email</label>
        <input type="email" name="guestEmail" required placeholder="jane@example.com">
      </div>
      <div class="field">
        <label>Phone (optional)</label>
        <input type="tel" name="guestPhone" placeholder="+1 555-1234">
      </div>
      <div class="field">
        <label>Preferred Date</label>
        <input type="date" name="date" required min="${new Date().toISOString().split('T')[0]}">
      </div>
      <div class="field">
        <label>Preferred Time</label>
        <select name="time" required>
          <option value="">Select a time</option>
          <option value="09:00">9:00 AM</option>
          <option value="09:30">9:30 AM</option>
          <option value="10:00">10:00 AM</option>
          <option value="10:30">10:30 AM</option>
          <option value="11:00">11:00 AM</option>
          <option value="11:30">11:30 AM</option>
          <option value="12:00">12:00 PM</option>
          <option value="13:00">1:00 PM</option>
          <option value="13:30">1:30 PM</option>
          <option value="14:00">2:00 PM</option>
          <option value="14:30">2:30 PM</option>
          <option value="15:00">3:00 PM</option>
          <option value="15:30">3:30 PM</option>
          <option value="16:00">4:00 PM</option>
          <option value="16:30">4:30 PM</option>
        </select>
      </div>
      <div class="field">
        <label>Notes (optional)</label>
        <input type="text" name="notes" placeholder="Anything we should know?">
      </div>
      <button type="submit" id="submit-btn">Book Appointment</button>
    </form>
  </div>

  <div class="card success" id="success" style="display:none">
    <div class="check">&#10003;</div>
    <h2>Booked!</h2>
    <p>Your appointment has been confirmed. You'll receive a confirmation email shortly.</p>
  </div>

  <script>
    const bookedSlots = ${JSON.stringify(bookedSlots)};
    const bookingPageId = '${page.id}';
    const submitUrl = '${submitUrl}';

    async function submitBooking(e) {
      e.preventDefault();
      const btn = document.getElementById('submit-btn');
      btn.disabled = true;
      btn.textContent = 'Booking...';

      const form = new FormData(e.target);
      const date = form.get('date');
      const time = form.get('time');
      const startTime = date + 'T' + time + ':00';

      try {
        const res = await fetch(submitUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bookingPageId,
            guestName: form.get('guestName'),
            guestEmail: form.get('guestEmail'),
            guestPhone: form.get('guestPhone'),
            startTime,
            notes: form.get('notes'),
          }),
        });
        const data = await res.json();
        if (data.ok) {
          document.getElementById('booking-form').style.display = 'none';
          document.getElementById('success').style.display = 'block';
        } else {
          alert(data.error || 'Booking failed. Please try a different time.');
          btn.disabled = false;
          btn.textContent = 'Book Appointment';
        }
      } catch {
        alert('Connection error. Please try again.');
        btn.disabled = false;
        btn.textContent = 'Book Appointment';
      }
    }
  </script>
</body>
</html>`
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Calendar', summary: 'Public booking page',
  methods: { GET: { summary: 'Serve public booking page', tags: ['Calendar (Public)'] } },
}
