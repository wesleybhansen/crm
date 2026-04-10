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
        const { getGoogleBusyTimes } = await import('@/modules/calendar/lib/google-calendar-service')
        const googleBusy = await getGoogleBusyTimes(page.owner_user_id, now, twoWeeksOut)
        bookedSlots = [...bookedSlots, ...googleBusy]
      } catch {}
    }

    // Look up host info from users table
    let hostName = ''
    let hostEmail = ''
    if (page.owner_user_id) {
      try {
        const ownerUser = await knex('users').where('id', page.owner_user_id).first()
        if (ownerUser) {
          hostName = ownerUser.display_name || ownerUser.name || ownerUser.first_name || ''
          if (!hostName && ownerUser.first_name) {
            hostName = [ownerUser.first_name, ownerUser.last_name].filter(Boolean).join(' ')
          }
          hostEmail = ownerUser.email || ''
        }
      } catch {}
    }

    // Look up contact info for pre-fill
    const url = new URL(req.url)
    const contactId = url.searchParams.get('contact')
    let prefillContact: { name?: string; email?: string; phone?: string } | null = null
    if (contactId) {
      try {
        const contact = await knex('customer_entities').where('id', contactId).first()
        if (contact) {
          prefillContact = {
            name: contact.display_name || '',
            email: contact.primary_email || '',
            phone: contact.primary_phone || '',
          }
        }
      } catch {}
    }

    const baseUrl = process.env.APP_URL || 'http://localhost:3000'
    const submitUrl = `${baseUrl}/api/calendar/bookings`

    const html = generateBookingPageHtml(page, bookedSlots, submitUrl, hostName, hostEmail, prefillContact)
    return new NextResponse(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  } catch (error) {
    console.error('[booking.page]', error)
    return new NextResponse('Server error', { status: 500 })
  }
}

function getMeetingTypeDisplay(meetingType: string, meetingLocation?: string): { icon: string; label: string; detail?: string } {
  switch (meetingType) {
    case 'google_meet': return { icon: '&#127909;', label: 'Google Meet' }
    case 'zoom': return { icon: '&#128187;', label: 'Zoom' }
    case 'phone': return { icon: '&#128222;', label: 'Phone Call' }
    case 'in_person': return { icon: '&#128205;', label: 'In-Person', detail: meetingLocation || undefined }
    default: return { icon: '&#128197;', label: 'Meeting' }
  }
}

function generateBookingPageHtml(
  page: any,
  bookedSlots: any[],
  submitUrl: string,
  hostName: string,
  hostEmail: string,
  prefillContact: { name?: string; email?: string; phone?: string } | null,
): string {
  const availability = typeof page.availability === 'string' ? JSON.parse(page.availability) : page.availability
  const meetingType = page.meeting_type || 'in_person'
  const meetingDisplay = getMeetingTypeDisplay(meetingType, page.meeting_location)
  const autoConfirm = page.auto_confirm !== false
  const durationMinutes = page.duration_minutes || 30

  // Build day availability JSON for client-side date filtering
  const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
  const dayAvailability: Record<number, { start: string; end: string }> = {}
  if (availability) {
    for (const [day, range] of Object.entries(availability)) {
      const dayIndex = dayNames.indexOf(day.toLowerCase())
      if (dayIndex >= 0 && (range as any)?.start && (range as any)?.end) {
        dayAvailability[dayIndex] = range as { start: string; end: string }
      }
    }
  }

  // Host initials for avatar
  const hostInitials = hostName
    ? hostName.split(' ').map((w: string) => w[0]).join('').toUpperCase().slice(0, 2)
    : '?'

  const escapeHtml = (str: string) => str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Book: ${escapeHtml(page.title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: linear-gradient(135deg, #f5f7fa 0%, #e8ecf1 50%, #f0f2f5 100%);
      color: #1a1a2e;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    .booking-container {
      background: #ffffff;
      border-radius: 20px;
      box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05), 0 10px 40px -5px rgba(0,0,0,0.08);
      max-width: 960px;
      width: 100%;
      display: grid;
      grid-template-columns: 2fr 3fr;
      overflow: hidden;
      min-height: 560px;
    }

    /* ─── Left Panel ─── */
    .info-panel {
      background: linear-gradient(160deg, #f8fafc 0%, #f1f5f9 100%);
      padding: 40px 32px;
      border-right: 1px solid #e2e8f0;
      display: flex;
      flex-direction: column;
    }

    .host-section {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 28px;
    }

    .host-avatar {
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: #3B82F6;
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 15px;
      font-weight: 600;
      letter-spacing: 0.5px;
      flex-shrink: 0;
    }

    .host-name {
      font-size: 14px;
      font-weight: 600;
      color: #334155;
    }

    .host-label {
      font-size: 12px;
      color: #94a3b8;
      margin-top: 1px;
    }

    .meeting-title {
      font-size: 26px;
      font-weight: 700;
      color: #0f172a;
      line-height: 1.25;
      margin-bottom: 20px;
      letter-spacing: -0.02em;
    }

    .meeting-meta {
      display: flex;
      flex-direction: column;
      gap: 14px;
      margin-bottom: 24px;
    }

    .meta-item {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 14px;
      color: #475569;
    }

    .meta-icon {
      width: 36px;
      height: 36px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      flex-shrink: 0;
    }

    .meta-icon.duration {
      background: #eff6ff;
      color: #3b82f6;
    }

    .meta-icon.type {
      background: #f0fdf4;
      color: #22c55e;
    }

    .meta-label {
      font-weight: 500;
    }

    .meta-sublabel {
      font-size: 12px;
      color: #94a3b8;
      margin-top: 1px;
    }

    .meeting-description {
      font-size: 13px;
      line-height: 1.7;
      color: #64748b;
      margin-top: auto;
      padding-top: 20px;
      border-top: 1px solid #e2e8f0;
    }

    /* ─── Right Panel ─── */
    .booking-panel {
      padding: 36px 32px;
      display: flex;
      flex-direction: column;
      position: relative;
      overflow: hidden;
    }

    .step-header {
      font-size: 13px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #94a3b8;
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .step-indicator {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: #3B82F6;
      color: #fff;
      font-size: 11px;
      font-weight: 700;
    }

    .step-back {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: none;
      border: none;
      color: #64748b;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      padding: 4px 0;
      margin-bottom: 12px;
      font-family: inherit;
      transition: color 0.15s;
    }

    .step-back:hover { color: #3B82F6; }

    .step-back svg {
      width: 16px;
      height: 16px;
    }

    /* ─── Step containers ─── */
    .step {
      display: none;
      animation: stepIn 0.3s ease;
    }

    .step.active {
      display: block;
    }

    @keyframes stepIn {
      from { opacity: 0; transform: translateY(12px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* ─── Calendar ─── */
    .calendar-nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }

    .calendar-month {
      font-size: 16px;
      font-weight: 600;
      color: #0f172a;
    }

    .calendar-nav-btn {
      width: 34px;
      height: 34px;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      background: #fff;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s;
      color: #475569;
    }

    .calendar-nav-btn:hover {
      background: #f8fafc;
      border-color: #cbd5e1;
    }

    .calendar-nav-btn:disabled {
      opacity: 0.3;
      cursor: not-allowed;
    }

    .calendar-nav-btn svg {
      width: 16px;
      height: 16px;
    }

    .calendar-grid {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      gap: 2px;
    }

    .calendar-dow {
      text-align: center;
      font-size: 11px;
      font-weight: 600;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 8px 0;
    }

    .calendar-day {
      aspect-ratio: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      font-weight: 500;
      border-radius: 10px;
      cursor: pointer;
      transition: all 0.15s;
      color: #334155;
      position: relative;
      border: none;
      background: none;
      font-family: inherit;
    }

    .calendar-day:hover:not(.disabled):not(.empty) {
      background: #eff6ff;
      color: #3B82F6;
    }

    .calendar-day.today::after {
      content: '';
      position: absolute;
      bottom: 4px;
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: #3B82F6;
    }

    .calendar-day.selected {
      background: #3B82F6;
      color: #fff;
    }

    .calendar-day.selected::after {
      background: #fff;
    }

    .calendar-day.disabled {
      color: #cbd5e1;
      cursor: not-allowed;
    }

    .calendar-day.empty {
      cursor: default;
    }

    .no-availability-hint {
      margin-top: 12px;
      text-align: center;
      font-size: 13px;
      color: #94a3b8;
    }

    /* ─── Time Slots ─── */
    .selected-date-label {
      font-size: 15px;
      font-weight: 600;
      color: #0f172a;
      margin-bottom: 16px;
    }

    .time-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
      max-height: 360px;
      overflow-y: auto;
      padding-right: 4px;
    }

    .time-grid::-webkit-scrollbar { width: 4px; }
    .time-grid::-webkit-scrollbar-track { background: transparent; }
    .time-grid::-webkit-scrollbar-thumb { background: #e2e8f0; border-radius: 4px; }

    .time-slot {
      padding: 12px 8px;
      border: 1.5px solid #e2e8f0;
      border-radius: 10px;
      background: #fff;
      font-size: 14px;
      font-weight: 500;
      color: #334155;
      cursor: pointer;
      transition: all 0.15s;
      text-align: center;
      font-family: inherit;
    }

    .time-slot:hover {
      border-color: #3B82F6;
      background: #eff6ff;
      color: #3B82F6;
    }

    .time-slot.selected {
      background: #3B82F6;
      border-color: #3B82F6;
      color: #fff;
    }

    .no-slots-message {
      text-align: center;
      color: #94a3b8;
      font-size: 14px;
      padding: 32px 0;
    }

    /* ─── Form ─── */
    .form-grid {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .form-field label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      color: #334155;
      margin-bottom: 6px;
    }

    .form-field label .optional {
      font-weight: 400;
      color: #94a3b8;
      font-size: 12px;
    }

    .form-field input,
    .form-field textarea {
      width: 100%;
      padding: 11px 14px;
      border: 1.5px solid #e2e8f0;
      border-radius: 10px;
      font-size: 14px;
      font-family: inherit;
      color: #0f172a;
      background: #fff;
      outline: none;
      transition: all 0.2s;
    }

    .form-field input:focus,
    .form-field textarea:focus {
      border-color: #3B82F6;
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
    }

    .form-field input::placeholder,
    .form-field textarea::placeholder {
      color: #94a3b8;
    }

    .form-field textarea {
      min-height: 80px;
      resize: vertical;
    }

    .booking-summary {
      background: #f8fafc;
      border-radius: 10px;
      padding: 14px 16px;
      font-size: 13px;
      color: #475569;
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 4px;
    }

    .booking-summary-icon {
      font-size: 18px;
    }

    .booking-summary strong {
      color: #0f172a;
    }

    .submit-btn {
      width: 100%;
      padding: 14px 24px;
      background: #3B82F6;
      color: #fff;
      border: none;
      border-radius: 12px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      font-family: inherit;
      margin-top: 4px;
    }

    .submit-btn:hover {
      background: #2563eb;
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3);
    }

    .submit-btn:active {
      transform: translateY(0);
    }

    .submit-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
      box-shadow: none;
    }

    /* ─── Success State ─── */
    .success-container {
      display: none;
      max-width: 960px;
      width: 100%;
    }

    .success-card {
      background: #fff;
      border-radius: 20px;
      box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05), 0 10px 40px -5px rgba(0,0,0,0.08);
      padding: 60px 40px;
      text-align: center;
    }

    .success-check {
      width: 72px;
      height: 72px;
      border-radius: 50%;
      background: linear-gradient(135deg, #d1fae5, #a7f3d0);
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 24px;
      animation: successPop 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    }

    .success-check svg {
      width: 32px;
      height: 32px;
      color: #059669;
    }

    @keyframes successPop {
      0% { transform: scale(0); opacity: 0; }
      60% { transform: scale(1.1); }
      100% { transform: scale(1); opacity: 1; }
    }

    .success-title {
      font-size: 24px;
      font-weight: 700;
      color: #0f172a;
      margin-bottom: 8px;
    }

    .success-message {
      font-size: 15px;
      color: #64748b;
      margin-bottom: 32px;
      line-height: 1.5;
    }

    .success-details {
      background: #f8fafc;
      border-radius: 12px;
      padding: 20px 24px;
      display: inline-flex;
      flex-direction: column;
      gap: 12px;
      text-align: left;
      max-width: 360px;
      width: 100%;
    }

    .success-detail-row {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 14px;
      color: #475569;
    }

    .success-detail-row span:first-child {
      font-size: 16px;
      width: 24px;
      text-align: center;
      flex-shrink: 0;
    }

    /* ─── Error toast ─── */
    .toast {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%) translateY(80px);
      background: #1e293b;
      color: #fff;
      padding: 14px 24px;
      border-radius: 12px;
      font-size: 14px;
      font-weight: 500;
      z-index: 1000;
      transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
      box-shadow: 0 10px 25px rgba(0,0,0,0.15);
      max-width: 400px;
      text-align: center;
    }

    .toast.visible {
      transform: translateX(-50%) translateY(0);
    }

    /* ─── Responsive ─── */
    @media (max-width: 768px) {
      body { padding: 0; align-items: flex-start; }

      .booking-container {
        grid-template-columns: 1fr;
        border-radius: 0;
        min-height: 100vh;
        box-shadow: none;
      }

      .info-panel {
        border-right: none;
        border-bottom: 1px solid #e2e8f0;
        padding: 28px 24px;
      }

      .meeting-title { font-size: 22px; }

      .meeting-description {
        margin-top: 16px;
        padding-top: 16px;
      }

      .booking-panel {
        padding: 28px 24px;
      }

      .time-grid {
        grid-template-columns: repeat(2, 1fr);
      }

      .success-card {
        border-radius: 0;
        padding: 48px 24px;
        min-height: 100vh;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
      }

      .success-container {
        max-width: 100%;
      }
    }

    @media (max-width: 480px) {
      .calendar-day {
        font-size: 13px;
      }

      .time-grid {
        grid-template-columns: repeat(2, 1fr);
      }
    }

    @media (min-width: 769px) and (max-width: 1024px) {
      .booking-container {
        max-width: 840px;
      }

      .time-grid {
        grid-template-columns: repeat(3, 1fr);
      }
    }
  </style>
</head>
<body>
  <div class="booking-container" id="booking-container">
    <!-- Left: Meeting Info -->
    <div class="info-panel">
      ${hostName ? `
      <div class="host-section">
        <div class="host-avatar">${hostInitials}</div>
        <div>
          <div class="host-name">${escapeHtml(hostName)}</div>
          <div class="host-label">Host</div>
        </div>
      </div>` : ''}

      <div class="meeting-title">${escapeHtml(page.title)}</div>

      <div class="meeting-meta">
        <div class="meta-item">
          <div class="meta-icon duration">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          </div>
          <div>
            <div class="meta-label">${durationMinutes} minutes</div>
          </div>
        </div>
        <div class="meta-item">
          <div class="meta-icon type">
            <span>${meetingDisplay.icon}</span>
          </div>
          <div>
            <div class="meta-label">${meetingDisplay.label}</div>
            ${meetingDisplay.detail ? `<div class="meta-sublabel">${escapeHtml(meetingDisplay.detail)}</div>` : ''}
          </div>
        </div>
      </div>

      ${page.description ? `<div class="meeting-description">${escapeHtml(page.description)}</div>` : ''}
    </div>

    <!-- Right: Booking Flow -->
    <div class="booking-panel">

      <!-- Step 1: Select Date -->
      <div class="step active" id="step-date">
        <div class="step-header">
          <span class="step-indicator">1</span> Select a Date
        </div>
        <div class="calendar-nav">
          <button class="calendar-nav-btn" id="prev-month" onclick="changeMonth(-1)">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <span class="calendar-month" id="calendar-month-label"></span>
          <button class="calendar-nav-btn" id="next-month" onclick="changeMonth(1)">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        </div>
        <div class="calendar-grid" id="calendar-grid">
          <div class="calendar-dow">Sun</div>
          <div class="calendar-dow">Mon</div>
          <div class="calendar-dow">Tue</div>
          <div class="calendar-dow">Wed</div>
          <div class="calendar-dow">Thu</div>
          <div class="calendar-dow">Fri</div>
          <div class="calendar-dow">Sat</div>
        </div>
        <div class="no-availability-hint" id="no-availability-hint" style="display:none">No available days this month</div>
      </div>

      <!-- Step 2: Select Time -->
      <div class="step" id="step-time">
        <button class="step-back" onclick="goToStep('date')">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          Back
        </button>
        <div class="step-header">
          <span class="step-indicator">2</span> Select a Time
        </div>
        <div class="selected-date-label" id="selected-date-label"></div>
        <div class="time-grid" id="time-grid"></div>
        <div class="no-slots-message" id="no-slots-message" style="display:none">No available times on this date</div>
      </div>

      <!-- Step 3: Your Details -->
      <div class="step" id="step-form">
        <button class="step-back" onclick="goToStep('time')">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          Back
        </button>
        <div class="step-header">
          <span class="step-indicator">3</span> Your Details
        </div>
        <div class="booking-summary" id="booking-summary">
          <span class="booking-summary-icon">&#128197;</span>
          <span id="booking-summary-text"></span>
        </div>
        <form id="booking-form" class="form-grid" onsubmit="submitBooking(event)">
          <div class="form-field">
            <label for="guestName">Name</label>
            <input type="text" id="guestName" name="guestName" required placeholder="Your full name" autocomplete="name">
          </div>
          <div class="form-field">
            <label for="guestEmail">Email</label>
            <input type="email" id="guestEmail" name="guestEmail" required placeholder="you@example.com" autocomplete="email">
          </div>
          <div class="form-field">
            <label for="guestPhone">Phone <span class="optional">(optional)</span></label>
            <input type="tel" id="guestPhone" name="guestPhone" placeholder="+1 (555) 123-4567" autocomplete="tel">
          </div>
          <div class="form-field">
            <label for="notes">Notes <span class="optional">(optional)</span></label>
            <textarea id="notes" name="notes" placeholder="Anything the host should know?"></textarea>
          </div>
          <button type="submit" class="submit-btn" id="submit-btn">Book Meeting</button>
        </form>
      </div>
    </div>
  </div>

  <!-- Success -->
  <div class="success-container" id="success-container">
    <div class="success-card">
      <div class="success-check">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      </div>
      <h1 class="success-title" id="success-title"></h1>
      <p class="success-message" id="success-message"></p>
      <div class="success-details" id="success-details"></div>
    </div>
  </div>

  <!-- Toast -->
  <div class="toast" id="toast"></div>

  <script>
    // ─── Injected Data ───
    var bookedSlots = ${JSON.stringify(bookedSlots)};
    var bookingPageId = '${page.id}';
    var submitUrl = '${submitUrl}';
    var dayAvailability = ${JSON.stringify(dayAvailability)};
    var durationMinutes = ${durationMinutes};
    var autoConfirm = ${autoConfirm ? 'true' : 'false'};
    var meetingTypeLabel = '${meetingDisplay.label}';
    var meetingTypeIcon = '${meetingDisplay.icon}';
    var prefillContact = ${prefillContact ? JSON.stringify(prefillContact) : 'null'};

    // ─── State ───
    var currentMonth = new Date().getMonth();
    var currentYear = new Date().getFullYear();
    var selectedDate = null;
    var selectedTime = null;
    var todayStr = new Date().toISOString().split('T')[0];

    // ─── Init ───
    document.addEventListener('DOMContentLoaded', function() {
      renderCalendar();
      if (prefillContact) {
        if (prefillContact.name) document.getElementById('guestName').value = prefillContact.name;
        if (prefillContact.email) document.getElementById('guestEmail').value = prefillContact.email;
        if (prefillContact.phone) document.getElementById('guestPhone').value = prefillContact.phone;
      }
    });

    // ─── Navigation ───
    function goToStep(step) {
      document.querySelectorAll('.step').forEach(function(el) { el.classList.remove('active'); });
      document.getElementById('step-' + step).classList.add('active');
      if (step === 'date') { selectedTime = null; }
    }

    // ─── Calendar Rendering ───
    function renderCalendar() {
      var grid = document.getElementById('calendar-grid');
      // Remove old day buttons but keep DOW headers
      var existingDays = grid.querySelectorAll('.calendar-day');
      existingDays.forEach(function(el) { el.remove(); });

      var monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      document.getElementById('calendar-month-label').textContent = monthNames[currentMonth] + ' ' + currentYear;

      // Disable prev if current month is this month
      var now = new Date();
      document.getElementById('prev-month').disabled = (currentYear === now.getFullYear() && currentMonth === now.getMonth());

      var firstDay = new Date(currentYear, currentMonth, 1).getDay();
      var daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
      var hasAvailableDays = false;

      // Empty cells for offset
      for (var e = 0; e < firstDay; e++) {
        var empty = document.createElement('div');
        empty.className = 'calendar-day empty';
        grid.appendChild(empty);
      }

      for (var d = 1; d <= daysInMonth; d++) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'calendar-day';
        btn.textContent = d;

        var dateObj = new Date(currentYear, currentMonth, d);
        var dateStr = formatDateStr(currentYear, currentMonth, d);
        var dayOfWeek = dateObj.getDay();
        var isPast = dateStr < todayStr;
        var hasAvailability = dayAvailability[dayOfWeek] !== undefined;

        // If no availability config at all, assume weekdays available
        if (Object.keys(dayAvailability).length === 0) {
          hasAvailability = dayOfWeek >= 1 && dayOfWeek <= 5;
        }

        if (isPast || !hasAvailability) {
          btn.className += ' disabled';
        } else {
          hasAvailableDays = true;
          btn.setAttribute('data-date', dateStr);
          btn.onclick = (function(ds) {
            return function() { selectDate(ds); };
          })(dateStr);
        }

        // Today indicator
        if (dateStr === todayStr) {
          btn.className += ' today';
        }

        // Selected indicator
        if (selectedDate && dateStr === selectedDate) {
          btn.className += ' selected';
        }

        grid.appendChild(btn);
      }

      document.getElementById('no-availability-hint').style.display = hasAvailableDays ? 'none' : 'block';
    }

    function formatDateStr(y, m, d) {
      return y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    }

    function changeMonth(delta) {
      currentMonth += delta;
      if (currentMonth > 11) { currentMonth = 0; currentYear++; }
      if (currentMonth < 0) { currentMonth = 11; currentYear--; }
      renderCalendar();
    }

    // ─── Date Selection ───
    function selectDate(dateStr) {
      selectedDate = dateStr;
      selectedTime = null;
      renderCalendar();
      renderTimeSlots();
      goToStep('time');
    }

    // ─── Time Slot Rendering ───
    function renderTimeSlots() {
      if (!selectedDate) return;

      var dateObj = new Date(selectedDate + 'T00:00:00');
      var dayOfWeek = dateObj.getDay();
      var dayRange = dayAvailability[dayOfWeek];

      // Format display date
      var dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      var monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      var displayDate = dayNames[dateObj.getDay()] + ', ' + monthNames[dateObj.getMonth()] + ' ' + dateObj.getDate();
      document.getElementById('selected-date-label').textContent = displayDate;

      var grid = document.getElementById('time-grid');
      grid.innerHTML = '';

      // Determine time range
      var startTime = '09:00';
      var endTime = '17:00';
      if (dayRange && dayRange.start && dayRange.end) {
        startTime = dayRange.start;
        endTime = dayRange.end;
      }

      var slots = generateSlots(startTime, endTime, durationMinutes);

      // Filter out booked/busy slots
      var availableSlots = slots.filter(function(slot) {
        var slotStart = new Date(selectedDate + 'T' + slot + ':00');
        var slotEnd = new Date(slotStart.getTime() + durationMinutes * 60000);

        // Filter past times for today
        if (selectedDate === todayStr && slotStart <= new Date()) return false;

        return !bookedSlots.some(function(bs) {
          var bsStart = new Date(bs.start);
          var bsEnd = new Date(bs.end);
          return slotStart < bsEnd && slotEnd > bsStart;
        });
      });

      if (availableSlots.length === 0) {
        document.getElementById('no-slots-message').style.display = 'block';
        grid.style.display = 'none';
        return;
      }

      document.getElementById('no-slots-message').style.display = 'none';
      grid.style.display = 'grid';

      availableSlots.forEach(function(slot) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'time-slot';
        btn.textContent = formatTimeDisplay(slot);
        btn.onclick = function() { selectTime(slot, btn); };
        grid.appendChild(btn);
      });
    }

    function generateSlots(start, end, duration) {
      var result = [];
      var parts = start.split(':').map(Number);
      var startMin = parts[0] * 60 + parts[1];
      parts = end.split(':').map(Number);
      var endMin = parts[0] * 60 + parts[1];

      for (var t = startMin; t + duration <= endMin; t += duration) {
        var h = Math.floor(t / 60);
        var m = t % 60;
        result.push(String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0'));
      }
      return result;
    }

    function formatTimeDisplay(time) {
      var parts = time.split(':').map(Number);
      var h = parts[0];
      var m = parts[1];
      var ampm = h >= 12 ? 'PM' : 'AM';
      var displayHour = h === 0 ? 12 : h > 12 ? h - 12 : h;
      return displayHour + ':' + String(m).padStart(2, '0') + ' ' + ampm;
    }

    // ─── Time Selection ───
    function selectTime(time, btnEl) {
      selectedTime = time;
      document.querySelectorAll('.time-slot').forEach(function(el) { el.classList.remove('selected'); });
      btnEl.classList.add('selected');

      // Update summary
      var dateObj = new Date(selectedDate + 'T00:00:00');
      var dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      var monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      var summaryText = dayNames[dateObj.getDay()] + ', ' + monthNames[dateObj.getMonth()] + ' ' + dateObj.getDate() + ' at ' + formatTimeDisplay(time) + ' (' + durationMinutes + ' min)';
      document.getElementById('booking-summary-text').innerHTML = '<strong>' + summaryText + '</strong>';

      setTimeout(function() { goToStep('form'); }, 200);
    }

    // ─── Form Submission ───
    async function submitBooking(e) {
      e.preventDefault();
      var btn = document.getElementById('submit-btn');
      btn.disabled = true;
      btn.textContent = 'Booking...';

      var startTime = selectedDate + 'T' + selectedTime + ':00';

      try {
        var res = await fetch(submitUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bookingPageId: bookingPageId,
            guestName: document.getElementById('guestName').value,
            guestEmail: document.getElementById('guestEmail').value,
            guestPhone: document.getElementById('guestPhone').value || null,
            startTime: startTime,
            notes: document.getElementById('notes').value || null,
          }),
        });
        var data = await res.json();
        if (data.ok) {
          showSuccess(data);
        } else {
          showToast(data.error || 'This slot is no longer available. Please pick another time.');
          btn.disabled = false;
          btn.textContent = 'Book Meeting';
        }
      } catch (err) {
        showToast('Connection error. Please try again.');
        btn.disabled = false;
        btn.textContent = 'Book Meeting';
      }
    }

    // ─── Success ───
    function showSuccess(data) {
      document.getElementById('booking-container').style.display = 'none';
      var sc = document.getElementById('success-container');
      sc.style.display = 'block';

      document.getElementById('success-title').textContent = autoConfirm ? "You're booked!" : 'Request Submitted!';
      document.getElementById('success-message').textContent = autoConfirm
        ? 'A confirmation email has been sent to your inbox.'
        : 'Check your email to confirm your appointment.';

      var dateObj = new Date(selectedDate + 'T00:00:00');
      var dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      var monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      var dateDisplay = dayNames[dateObj.getDay()] + ', ' + monthNames[dateObj.getMonth()] + ' ' + dateObj.getDate() + ', ' + dateObj.getFullYear();

      var details = document.getElementById('success-details');
      var rows = [
        { icon: '&#128197;', text: dateDisplay },
        { icon: '&#128336;', text: formatTimeDisplay(selectedTime) + ' (' + durationMinutes + ' min)' },
        { icon: meetingTypeIcon, text: meetingTypeLabel },
      ];

      if (data.data && data.data.meetLink) {
        rows.push({ icon: '&#128279;', text: '<a href="' + data.data.meetLink + '" style="color:#3B82F6;text-decoration:none" target="_blank">Join meeting link</a>' });
      }

      details.innerHTML = rows.map(function(r) {
        return '<div class="success-detail-row"><span>' + r.icon + '</span><span>' + r.text + '</span></div>';
      }).join('');
    }

    // ─── Toast ───
    function showToast(message) {
      var toast = document.getElementById('toast');
      toast.textContent = message;
      toast.classList.add('visible');
      setTimeout(function() { toast.classList.remove('visible'); }, 4000);
    }
  </script>
</body>
</html>`
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Calendar', summary: 'Public booking page',
  methods: { GET: { summary: 'Serve public booking page', tags: ['Calendar (Public)'] } },
}
