import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

export const metadata = { GET: { requireAuth: false } }

function decodeToken(token: string): { contactId: string; orgId: string } | null {
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf-8')
    const [contactId, orgId] = decoded.split(':')
    if (!contactId || !orgId) return null
    return { contactId, orgId }
  } catch {
    return null
  }
}

export async function GET(req: Request, { params }: { params: { token: string } }) {
  const parsed = decodeToken(params.token)
  if (!parsed) return new NextResponse('Invalid link', { status: 400 })

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const contact = await knex('customer_entities').where('id', parsed.contactId).first()
    if (!contact || contact.organization_id !== parsed.orgId) {
      return new NextResponse('Not found', { status: 404 })
    }

    const profile = await knex('business_profiles').where('organization_id', parsed.orgId).first()
    const orgName = profile?.business_name || 'Our Company'

    // Ensure default categories exist
    let categories = await knex('email_preference_categories')
      .where('organization_id', parsed.orgId)
      .orderBy('created_at', 'asc')

    if (categories.length === 0) {
      const crypto = require('crypto')
      const now = new Date()
      const defaults = [
        { name: 'Product Updates', slug: 'product-updates', description: 'New features and product announcements' },
        { name: 'Newsletter', slug: 'newsletter', description: 'Regular newsletter and company news' },
        { name: 'Promotions', slug: 'promotions', description: 'Special offers, discounts, and deals' },
        { name: 'Event Invitations', slug: 'event-invitations', description: 'Webinars, meetups, and event invitations' },
        { name: 'Tips & Education', slug: 'tips-education', description: 'How-to guides, tips, and educational content' },
      ]
      const rows = defaults.map((cat) => ({
        id: crypto.randomUUID(),
        tenant_id: contact.tenant_id,
        organization_id: parsed.orgId,
        name: cat.name,
        slug: cat.slug,
        description: cat.description,
        is_default: true,
        created_at: now,
      }))
      await knex('email_preference_categories').insert(rows)
      categories = rows
    }

    // Get current preferences
    const preferences = await knex('email_preferences')
      .where('contact_id', parsed.contactId)
      .where('organization_id', parsed.orgId)

    const prefMap = new Map(preferences.map((p: any) => [p.category_slug, p.opted_in]))

    // Check if globally unsubscribed
    const globalUnsub = await knex('email_unsubscribes')
      .where('contact_id', parsed.contactId)
      .where('organization_id', parsed.orgId)
      .first()

    const baseUrl = process.env.APP_URL || 'http://localhost:3000'
    const token = params.token

    const categoryRows = categories.map((cat: any) => {
      const optedIn = globalUnsub ? false : (prefMap.has(cat.slug) ? prefMap.get(cat.slug) : true)
      return `
        <div class="pref-row" id="row-${cat.slug}">
          <div class="pref-info">
            <div class="pref-name">${escapeHtml(cat.name)}</div>
            ${cat.description ? `<div class="pref-desc">${escapeHtml(cat.description)}</div>` : ''}
          </div>
          <label class="toggle">
            <input type="checkbox" ${optedIn ? 'checked' : ''}
              onchange="updatePref('${cat.slug}', this.checked)" />
            <span class="slider"></span>
          </label>
        </div>`
    }).join('')

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Email Preferences - ${escapeHtml(orgName)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #1a1a1a; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .container { background: #fff; border-radius: 16px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); max-width: 520px; width: 100%; padding: 40px; }
  .header { text-align: center; margin-bottom: 32px; }
  .header h1 { font-size: 22px; font-weight: 600; margin-bottom: 8px; }
  .header p { color: #666; font-size: 14px; line-height: 1.5; }
  .email-badge { display: inline-block; background: #f0f0f0; padding: 4px 12px; border-radius: 20px; font-size: 13px; color: #444; margin-top: 8px; }
  .pref-row { display: flex; align-items: center; justify-content: space-between; padding: 16px 0; border-bottom: 1px solid #f0f0f0; }
  .pref-row:last-child { border-bottom: none; }
  .pref-info { flex: 1; margin-right: 16px; }
  .pref-name { font-size: 15px; font-weight: 500; }
  .pref-desc { font-size: 13px; color: #888; margin-top: 2px; }
  .toggle { position: relative; display: inline-block; width: 44px; height: 24px; flex-shrink: 0; }
  .toggle input { opacity: 0; width: 0; height: 0; }
  .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background: #ddd; border-radius: 24px; transition: 0.2s; }
  .slider:before { position: absolute; content: ''; height: 18px; width: 18px; left: 3px; bottom: 3px; background: #fff; border-radius: 50%; transition: 0.2s; }
  .toggle input:checked + .slider { background: #2563eb; }
  .toggle input:checked + .slider:before { transform: translateX(20px); }
  .divider { height: 1px; background: #e5e5e5; margin: 24px 0; }
  .unsub-section { text-align: center; padding-top: 8px; }
  .unsub-btn { background: none; border: 1px solid #e5e5e5; color: #666; padding: 10px 24px; border-radius: 8px; cursor: pointer; font-size: 14px; transition: 0.2s; }
  .unsub-btn:hover { border-color: #ef4444; color: #ef4444; }
  .toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: #1a1a1a; color: #fff; padding: 10px 20px; border-radius: 8px; font-size: 14px; opacity: 0; transition: opacity 0.3s; pointer-events: none; z-index: 100; }
  .toast.show { opacity: 1; }
  ${globalUnsub ? `.resubscribe-notice { background: #fef3c7; border: 1px solid #f59e0b; border-radius: 8px; padding: 12px 16px; margin-bottom: 24px; font-size: 13px; color: #92400e; text-align: center; }
  .resub-btn { background: #2563eb; color: #fff; border: none; padding: 6px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; margin-top: 8px; }
  .resub-btn:hover { background: #1d4ed8; }` : ''}
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>${escapeHtml(orgName)}</h1>
    <p>Manage your email preferences</p>
    <div class="email-badge">${escapeHtml(contact.primary_email)}</div>
  </div>
  ${globalUnsub ? `<div class="resubscribe-notice">You are currently unsubscribed from all emails.<br><button class="resub-btn" onclick="resubscribe()">Re-subscribe</button></div>` : ''}
  <div id="categories">
    ${categoryRows}
  </div>
  <div class="divider"></div>
  <div class="unsub-section">
    <button class="unsub-btn" onclick="unsubAll()">Unsubscribe from all emails</button>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
  function showToast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(function() { t.classList.remove('show'); }, 2000);
  }

  function updatePref(slug, optedIn) {
    fetch('${baseUrl}/api/email/preferences/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: '${token}', categorySlug: slug, optedIn: optedIn })
    }).then(function(r) { return r.json(); }).then(function(d) {
      if (d.ok) showToast(optedIn ? 'Subscribed' : 'Unsubscribed');
      else showToast('Error updating preference');
    }).catch(function() { showToast('Error updating preference'); });
  }

  function unsubAll() {
    if (!confirm('Are you sure you want to unsubscribe from all emails?')) return;
    fetch('${baseUrl}/api/email/preferences/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: '${token}', unsubscribeAll: true })
    }).then(function(r) { return r.json(); }).then(function(d) {
      if (d.ok) {
        document.querySelectorAll('.toggle input').forEach(function(cb) { cb.checked = false; });
        showToast('Unsubscribed from all emails');
      } else showToast('Error');
    }).catch(function() { showToast('Error'); });
  }

  function resubscribe() {
    fetch('${baseUrl}/api/email/preferences/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: '${token}', resubscribe: true })
    }).then(function(r) { return r.json(); }).then(function(d) {
      if (d.ok) {
        document.querySelectorAll('.toggle input').forEach(function(cb) { cb.checked = true; });
        var notice = document.querySelector('.resubscribe-notice');
        if (notice) notice.style.display = 'none';
        showToast('Re-subscribed to all emails');
      } else showToast('Error');
    }).catch(function() { showToast('Error'); });
  }
</script>
</body>
</html>`

    return new NextResponse(html, { status: 200, headers: { 'Content-Type': 'text/html' } })
  } catch (error) {
    console.error('[email.preferences.page]', error)
    return new NextResponse('Something went wrong', { status: 500 })
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
