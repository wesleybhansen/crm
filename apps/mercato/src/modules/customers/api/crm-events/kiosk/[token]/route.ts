// ORM-SKIP: events/event_attendees are raw-knex tables (no mercato entity)
//
// Public event sign-in kiosk. The page is addressed by the event's random
// kiosk_token (minted by an authenticated admin), never by id or slug, so
// possession of the URL is the credential. Server-renders a touch-friendly
// sign-in page (same server-rendered-HTML style as /crm-events/public/[slug])
// and accepts sign-in submissions with an in-memory per-IP rate limit and a
// honeypot field (same anti-abuse pattern as the landing page submit route).
export const metadata = {
  path: '/crm-events/kiosk/[token]',
  GET: { requireAuth: false },
  POST: { requireAuth: false },
}

import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import crypto from 'crypto'
import { qrSvg } from '../qr'

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;')
}

// Per-IP+token rate limit for this public, unauthenticated endpoint.
// In-memory (per instance). Trims opportunistically so the map can't grow
// unbounded.
const signinHits = new Map<string, number[]>()
const WINDOW_MS = 60 * 60 * 1000
const MAX_PER_WINDOW = 60 // a kiosk device serves many people from one IP
function rateLimited(key: string): boolean {
  const now = Date.now()
  const hits = (signinHits.get(key) ?? []).filter((t) => now - t < WINDOW_MS)
  hits.push(now)
  signinHits.set(key, hits)
  if (signinHits.size > 5000) {
    for (const [k, v] of signinHits) {
      if (v.every((t) => now - t >= WINDOW_MS)) signinHits.delete(k)
    }
  }
  return hits.length > MAX_PER_WINDOW
}

async function findKioskEvent(knex: any, token: string) {
  if (!token || token.length < 16) return null
  const event = await knex('events')
    .where('kiosk_token', token)
    .whereNull('deleted_at')
    .first()
  if (!event) return null
  if (event.status === 'cancelled') return null
  return event
}

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const event = await findKioskEvent(knex, token)
    if (!event) {
      return new NextResponse('<html><body style="font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;color:#64748b"><h1>Sign-in link not found</h1></body></html>', { status: 404, headers: { 'Content-Type': 'text/html' } })
    }

    const profile = await knex('business_profiles').where('organization_id', event.organization_id).first().catch(() => null)
    const biz = profile?.business_name || ''

    const eventDate = new Date(event.start_time).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    const eventTime = new Date(event.start_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

    const [{ count: checkedInCount }] = await knex('event_attendees')
      .where('event_id', event.id)
      .whereNotNull('checked_in_at')
      .count()

    const origin = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || new URL(req.url).origin
    const kioskUrl = `${origin}/api/crm-events/kiosk/${token}`
    const qr = qrSvg(kioskUrl, { moduleSize: 4, margin: 3 })

    const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<title>Sign in: ${esc(event.title)}</title>
<style>
:root { --ink: #0f172a; --muted: #64748b; --line: #e2e8f0; --accent: #4f46e5; --bg: #f8fafc; }
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--ink); min-height: 100vh; display: flex; flex-direction: column; }
main { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 32px 20px; }
.card { width: 100%; max-width: 560px; background: #fff; border: 1px solid var(--line); border-radius: 24px; padding: 40px 36px; box-shadow: 0 10px 40px rgba(15,23,42,.06); }
.kicker { font-size: 13px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--accent); text-align: center; margin-bottom: 10px; }
h1 { font-size: clamp(26px, 5vw, 38px); line-height: 1.15; text-align: center; margin-bottom: 8px; }
.meta { text-align: center; color: var(--muted); font-size: 15px; margin-bottom: 28px; }
label { display: block; font-size: 14px; font-weight: 600; margin-bottom: 6px; }
input { width: 100%; font-size: 19px; padding: 16px 18px; border: 1.5px solid var(--line); border-radius: 14px; margin-bottom: 18px; background: #fff; color: var(--ink); }
input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(79,70,229,.12); }
button { width: 100%; font-size: 20px; font-weight: 700; padding: 18px; border: none; border-radius: 14px; background: var(--accent); color: #fff; cursor: pointer; }
button:disabled { opacity: .6; }
.hp-field { position: absolute; left: -9999px; top: -9999px; height: 0; overflow: hidden; }
.flash { display: none; text-align: center; padding: 40px 10px; }
.flash h2 { font-size: clamp(28px, 6vw, 44px); margin-bottom: 10px; color: var(--accent); }
.flash p { color: var(--muted); font-size: 17px; }
.err { display: none; background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; border-radius: 12px; padding: 12px 16px; font-size: 15px; margin-bottom: 16px; text-align: center; }
.counter { text-align: center; color: var(--muted); font-size: 13px; margin-top: 18px; }
footer { padding: 22px 20px 34px; display: flex; flex-direction: column; align-items: center; gap: 10px; }
.qr-wrap { background: #fff; border: 1px solid var(--line); border-radius: 16px; padding: 10px; }
.qr-wrap svg { display: block; width: 132px; height: 132px; }
.foot-note { color: var(--muted); font-size: 13px; text-align: center; max-width: 420px; }
.foot-url { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; color: var(--ink); word-break: break-all; text-align: center; }
</style></head><body>

<main>
  <div class="card">
    <p class="kicker">${esc(biz || 'Event sign-in')}</p>
    <h1>${esc(event.title)}</h1>
    <p class="meta">${esc(eventDate)} at ${esc(eventTime)}</p>
    <div class="err" id="err"></div>
    <form id="signinForm" autocomplete="off">
      <label for="f-name">Your name</label>
      <input id="f-name" name="name" type="text" required placeholder="Jane Smith" autocomplete="off">
      <label for="f-email">Email address</label>
      <input id="f-email" name="email" type="email" required placeholder="jane@example.com" autocomplete="off">
      <label for="f-phone">Phone (optional)</label>
      <input id="f-phone" name="phone" type="tel" placeholder="+1 (555) 000-0000" autocomplete="off">
      <div class="hp-field" aria-hidden="true"><label>Company website<input name="company_website" type="text" tabindex="-1"></label></div>
      <button type="submit" id="signinBtn">Sign in</button>
    </form>
    <div class="flash" id="flash">
      <h2 id="flashName">Welcome!</h2>
      <p>You are signed in. Enjoy the event.</p>
    </div>
    <p class="counter" id="counter">${Number(checkedInCount) || 0} signed in so far</p>
  </div>
</main>

<footer>
  ${qr ? `<div class="qr-wrap">${qr}</div><p class="foot-note">Scan with your phone to sign in from your own device.</p>` : ''}
  <p class="foot-url">${esc(kioskUrl)}</p>
</footer>

<script>
var signedIn = ${Number(checkedInCount) || 0};
document.getElementById('signinForm').addEventListener('submit', async function (ev) {
  ev.preventDefault();
  var btn = document.getElementById('signinBtn');
  var err = document.getElementById('err');
  err.style.display = 'none';
  btn.disabled = true; btn.textContent = 'Signing in...';
  var fd = new FormData(ev.target);
  try {
    var r = await fetch(window.location.pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: fd.get('name'),
        email: fd.get('email'),
        phone: fd.get('phone') || undefined,
        company_website: fd.get('company_website') || undefined
      })
    });
    var d = await r.json();
    if (d.ok) {
      var firstName = String(fd.get('name') || '').trim().split(/\\s+/)[0] || 'friend';
      document.getElementById('flashName').textContent = 'Welcome, ' + firstName + '!';
      document.getElementById('signinForm').style.display = 'none';
      document.getElementById('flash').style.display = 'block';
      if (!d.alreadyCheckedIn) { signedIn++; }
      document.getElementById('counter').textContent = signedIn + ' signed in so far';
      setTimeout(function () {
        ev.target.reset();
        document.getElementById('flash').style.display = 'none';
        document.getElementById('signinForm').style.display = 'block';
        document.getElementById('f-name').focus();
      }, 3000);
    } else {
      err.textContent = d.error || 'Sign-in failed. Please try again.';
      err.style.display = 'block';
    }
  } catch (e) {
    err.textContent = 'Something went wrong. Please try again.';
    err.style.display = 'block';
  }
  btn.disabled = false; btn.textContent = 'Sign in';
});
</script>
</body></html>`

    return new NextResponse(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[crm-events.kiosk.page]', error)
    return new NextResponse('Something went wrong', { status: 500 })
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const event = await findKioskEvent(knex, token)
    if (!event) return NextResponse.json({ ok: false, error: 'Sign-in link not found' }, { status: 404 })

    // Rate limit per IP + token (public, unauthenticated write surface).
    const ip = (req.headers.get('x-forwarded-for') ?? 'unknown').split(',')[0].trim()
    if (rateLimited(`${ip}:${token}`)) {
      return NextResponse.json({ ok: false, error: 'Too many sign-ins from this device. Please wait a moment.' }, { status: 429 })
    }

    const body = await req.json()

    // Honeypot: hidden field a human never fills. Return 200 so bots can't
    // distinguish rejection.
    if (body._hp || body.company_website || body.honeypot) {
      return NextResponse.json({ ok: true })
    }

    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    const phone = typeof body.phone === 'string' ? body.phone.trim() : ''
    if (!name || !email) return NextResponse.json({ ok: false, error: 'Name and email are required' }, { status: 400 })
    if (name.length > 200 || email.length > 320 || phone.length > 50) {
      return NextResponse.json({ ok: false, error: 'A field is too long' }, { status: 400 })
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ ok: false, error: 'Please enter a valid email address' }, { status: 400 })
    }

    const now = new Date()

    // Existing registration: mark checked in.
    const existing = await knex('event_attendees')
      .where('event_id', event.id)
      .where('attendee_email', email)
      .orderBy('registered_at', 'desc')
      .first()

    if (existing) {
      if (existing.checked_in_at) {
        return NextResponse.json({ ok: true, alreadyCheckedIn: true })
      }
      await knex('event_attendees').where('id', existing.id).update({
        checked_in_at: now,
        checkin_source: 'kiosk',
      })
      return NextResponse.json({ ok: true })
    }

    // Walk-in: create the attendee, checked in immediately.
    const attendeeId = crypto.randomUUID()
    await knex('event_attendees').insert({
      id: attendeeId,
      tenant_id: event.tenant_id,
      organization_id: event.organization_id,
      event_id: event.id,
      attendee_name: name,
      attendee_email: email,
      status: 'registered',
      ticket_quantity: 1,
      registration_data: JSON.stringify({ walk_in: true, ...(phone ? { phone } : {}) }),
      checked_in_at: now,
      checkin_source: 'kiosk',
      registered_at: now,
      created_at: now,
    })
    await knex('events').where('id', event.id).increment('attendee_count', 1).catch(() => {})

    // Create/link CRM contact + timeline event (mirrors the public register
    // route's behavior, minimally).
    try {
      const existingContact = await knex('customer_entities')
        .where('primary_email', email)
        .where('organization_id', event.organization_id)
        .whereNull('deleted_at')
        .first()

      let contactId = existingContact?.id
      if (!existingContact) {
        contactId = crypto.randomUUID()
        await knex('customer_entities').insert({
          id: contactId,
          tenant_id: event.tenant_id,
          organization_id: event.organization_id,
          kind: 'person',
          display_name: name,
          primary_email: email,
          primary_phone: phone || null,
          source: 'event',
          status: 'active',
          lifecycle_stage: 'prospect',
          is_active: true,
          created_at: now,
          updated_at: now,
        }).catch(() => { contactId = null })
        if (contactId) {
          const parts = name.split(/\s+/)
          await knex('customer_people').insert({
            id: crypto.randomUUID(),
            tenant_id: event.tenant_id,
            organization_id: event.organization_id,
            entity_id: contactId,
            first_name: parts[0] || '',
            last_name: parts.slice(1).join(' ') || '',
            created_at: now,
            updated_at: now,
          }).catch(() => {})
        }
      }
      if (contactId) {
        await knex('event_attendees').where('id', attendeeId).update({ contact_id: contactId }).catch(() => {})
        const { logTimelineEvent } = await import('@/lib/timeline')
        await logTimelineEvent(knex, {
          tenantId: event.tenant_id,
          organizationId: event.organization_id,
          contactId,
          eventType: 'event_checkin',
          title: `Signed in at ${event.title}`,
          description: `Walk-in via kiosk on ${now.toLocaleDateString()}`,
          metadata: { eventId: event.id, walkIn: true },
        })
      }
    } catch (contactErr) {
      console.error('[crm-events.kiosk.signin] contact creation failed (non-fatal):', contactErr)
    }

    return NextResponse.json({ ok: true, walkIn: true })
  } catch (error) {
    console.error('[crm-events.kiosk.signin]', error)
    return NextResponse.json({ ok: false, error: 'Sign-in failed' }, { status: 500 })
  }
}
