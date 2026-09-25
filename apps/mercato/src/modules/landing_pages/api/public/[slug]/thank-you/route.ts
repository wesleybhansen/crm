// ORM-SKIP: landing_page_checkouts and business_profiles are raw-knex tables
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

/*
 * Where Stripe Checkout returns a buyer after paying on a landing page
 * (success_url set by payments/services/public-checkout.ts). Public, no scripts. The
 * order line is shown only for a session this page started; anything else
 * gets the plain thank-you. The payment itself is recorded by the Stripe
 * webhook, which may land a moment after the buyer does.
 */
export const metadata = {
  GET: { requireAuth: false },
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function money(amount: unknown, currency: unknown): string {
  const n = Number(amount)
  if (!Number.isFinite(n)) return ''
  const code = String(currency || 'usd').toUpperCase()
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(n)
  } catch {
    return `${n.toFixed(2)} ${code}`
  }
}

export function renderThankYouPage(input: {
  businessName: string | null
  headline: string
  message: string
  order: { name: string; amount: string; paid: boolean } | null
  backUrl: string
}): string {
  const status = input.order
    ? input.order.paid
      ? 'Payment received. A receipt is on its way to your inbox.'
      : 'Your payment is being confirmed. A receipt will arrive by email shortly.'
    : ''
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(input.headline)}</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;background:#f7f7f5;color:#1c1c1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
main{width:100%;max-width:480px;background:#fff;border:1px solid #e6e4df;border-radius:12px;padding:40px 32px;text-align:center}
.brand{font-size:14px;font-weight:600;letter-spacing:.02em;color:#55534e;margin:0 0 24px}
.mark{width:56px;height:56px;border-radius:50%;background:#e7f4ea;color:#1f7a3a;display:flex;align-items:center;justify-content:center;margin:0 auto 20px}
h1{font-size:24px;line-height:1.3;margin:0 0 12px}
p{font-size:16px;line-height:1.6;color:#4a4843;margin:0 0 16px}
.order{margin:24px 0 8px;padding:16px 0;border-top:1px solid #eeece8;border-bottom:1px solid #eeece8;display:flex;justify-content:space-between;gap:16px;font-size:15px;text-align:left}
.order strong{white-space:nowrap}
.status{font-size:14px;color:#6b6963}
a{color:#1c1c1a}
.back{display:inline-block;margin-top:16px;font-size:14px}
</style>
</head><body><main>
${input.businessName ? `<p class="brand">${esc(input.businessName)}</p>` : ''}
<div class="mark"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg></div>
<h1>${esc(input.headline)}</h1>
<p>${esc(input.message)}</p>
${input.order ? `<div class="order"><span>${esc(input.order.name)}</span><strong>${esc(input.order.amount)}</strong></div><p class="status">${esc(status)}</p>` : ''}
<a class="back" href="${esc(input.backUrl)}">Back to the page</a>
</main></body></html>`
}

export async function GET(req: Request, { params }: { params: { slug: string } | Promise<{ slug: string }> }) {
  try {
    const { slug } = await params
    const url = new URL(req.url)
    const sessionId = url.searchParams.get('session_id') || ''

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const page = await knex('landing_pages')
      .where('slug', slug)
      .where('status', 'published')
      .whereNull('deleted_at')
      .first()
    if (!page) {
      return new NextResponse('<html><body><h1>Page not found</h1></body></html>', { status: 404, headers: { 'Content-Type': 'text/html' } })
    }

    let config: any = page.config
    if (typeof config === 'string') {
      try { config = JSON.parse(config) } catch { config = {} }
    }
    config = config && typeof config === 'object' ? config : {}

    let order: { name: string; amount: string; paid: boolean } | null = null
    if (/^cs_(test|live)_[A-Za-z0-9]{1,200}$/.test(sessionId)) {
      const row = await knex('landing_page_checkouts')
        .where('stripe_checkout_session_id', sessionId)
        .where('landing_page_id', page.id)
        .where('organization_id', page.organization_id)
        .first()
      if (row) order = { name: String(row.item_name || 'Your order'), amount: money(row.amount, row.currency), paid: row.status === 'paid' }
    }

    const profile = await knex('business_profiles')
      .where('organization_id', page.organization_id)
      .first()
      .catch(() => null)

    const html = renderThankYouPage({
      businessName: profile?.business_name || null,
      headline: (typeof config.thankYouHeadline === 'string' && config.thankYouHeadline.trim()) || 'Thank you for your order!',
      message: (typeof config.thankYouMessage === 'string' && config.thankYouMessage.trim()) || "We've received your order and will be in touch soon.",
      order,
      backUrl: `/api/landing_pages/public/${encodeURIComponent(page.slug)}`,
    })
    return new NextResponse(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    console.error('[landing_pages.public.thank-you] failed', error)
    return new NextResponse('Server error', { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Landing Pages (Public)',
  summary: 'Checkout thank-you page',
  methods: { GET: { summary: 'Page shown after a landing page checkout', tags: ['Landing Pages (Public)'] } },
}
