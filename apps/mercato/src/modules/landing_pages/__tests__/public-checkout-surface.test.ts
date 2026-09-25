/** @jest-environment node */
/**
 * How a sandboxed landing page reaches the public checkout: the endpoint is
 * the one CORS-enabled path for buy buttons (credential-less), wizard pages
 * call it, pages published before it existed are pointed at it when served,
 * and a funnel's checkout success lands on its thank-you step.
 */
import { createFakeKnex } from './fake-knex'

let tables: Record<string, any[]> = {}
jest.mock('@/bootstrap', () => ({ bootstrap: async () => undefined }))
jest.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }))
jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: async () => ({ resolve: () => ({ getKnex: () => createFakeKnex(tables) }) }),
}))

import { applyPublicSurfaceHeaders, isPublicSandboxEndpoint, publicCorsHeaders } from '../../../lib/public-surface'
import { isCsrfExemptPath } from '../../../lib/csrf'
import { normalizeHtml } from '../services/public-serving'
import { renderWizardPageHtml, type WizardConfig } from '../services/wizard-publish'
import { GET as funnelGet } from '../api/funnels/public/[slug]/route'

const CHECKOUT_PATH = '/api/landing_pages/public/spring-sale/checkout'
const OFFER_PATH = '/api/payments/public/offers/aaaaaaaa-3333-4000-8000-000000000001/checkout'

describe('public checkout endpoint surface', () => {
  it('answers CORS for sandboxed pages (Origin: null) on POST, without credentials', () => {
    expect(isPublicSandboxEndpoint(CHECKOUT_PATH, 'POST')).toBe(true)
    const res = applyPublicSurfaceHeaders(
      new Response('{}', { headers: { 'content-type': 'application/json', 'Access-Control-Allow-Credentials': 'true' } }),
      CHECKOUT_PATH,
      'POST',
    )
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-credentials')).toBeNull()
    expect(publicCorsHeaders(['POST'])['Access-Control-Allow-Methods']).toBe('POST, OPTIONS')
  })

  it('opens exactly this path and method', () => {
    expect(isPublicSandboxEndpoint(CHECKOUT_PATH, 'GET')).toBe(false)
    expect(isPublicSandboxEndpoint(`${CHECKOUT_PATH}/extra`, 'POST')).toBe(false)
    expect(isPublicSandboxEndpoint('/api/landing_pages/public/a/b/checkout', 'POST')).toBe(false)
    expect(isPublicSandboxEndpoint('/api/payments/stripe/connect', 'POST')).toBe(false)
    expect(isPublicSandboxEndpoint('/api/landing_pages/public/spring-sale/thank-you', 'GET')).toBe(false)
  })

  it('needs no session, so the CSRF origin check does not apply to it', () => {
    expect(isCsrfExemptPath(CHECKOUT_PATH, 'POST')).toBe(true)
    expect(isCsrfExemptPath(OFFER_PATH, 'POST')).toBe(true)
  })

  it('the offer checkout is public the same way, and only its checkout path', () => {
    expect(isPublicSandboxEndpoint(OFFER_PATH, 'POST')).toBe(true)
    const res = applyPublicSurfaceHeaders(Response.json({ ok: true }), OFFER_PATH, 'POST')
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-credentials')).toBeNull()
    expect(isPublicSandboxEndpoint('/api/payments/offers', 'POST')).toBe(false)
    expect(isPublicSandboxEndpoint('/api/payments/offers', 'GET')).toBe(false)
    expect(isPublicSandboxEndpoint('/api/ext/offers', 'GET')).toBe(false)
    expect(isPublicSandboxEndpoint(`${OFFER_PATH}/x`, 'POST')).toBe(false)
  })
})

describe('pages call the public checkout', () => {
  const config: WizardConfig = {
    wizardVersion: 2,
    pageType: 'sell-digital',
    subType: 'ebook',
    styleId: 'minimal',
    productId: 'aaaaaaaa-1111-4000-8000-000000000001',
    formFields: [{ label: 'Email', type: 'email', required: true }],
    generatedSections: [{ type: 'hero', headline: 'The guide', subtitle: 'Now', ctaText: 'Buy now' } as any],
  }

  it('a wizard sell page posts to /api/landing_pages/public/{slug}/checkout with a per-attempt request id', () => {
    const prev = process.env.APP_URL
    process.env.APP_URL = 'https://crm.example.test'
    try {
      const html = renderWizardPageHtml(config, { title: 'Guide', slug: 'spring-sale' }, 'https://crm.example.test/api/landing_pages/public/spring-sale/submit')
      expect(html).toContain("https://crm.example.test/api/landing_pages/public/spring-sale/checkout")
      expect(html).not.toContain('/api/landing-page-checkout')
      expect(html).toContain('requestId: requestId')
      expect(html).not.toMatch(/unit_amount|price:/)
    } finally {
      process.env.APP_URL = prev
    }
  })

  it('serving points pages published with the old, never-existing URL at this page\'s checkout', () => {
    const legacy = `<script>fetch('https://crm.noliai.com/api/landing-page-checkout', {method:'POST'}); fetch('/api/landing-page-checkout')</script>`
    const out = normalizeHtml(legacy, { makeApiUrlsRelative: false, slug: 'spring-sale' })
    expect(out).not.toContain('landing-page-checkout')
    expect(out.match(/'\/api\/landing_pages\/public\/spring-sale\/checkout'/g)).toHaveLength(2)
    // Current pages on a custom domain keep a relative, same-host checkout URL.
    const current = `fetch('https://crm.noliai.com/api/landing_pages/public/spring-sale/checkout')`
    expect(normalizeHtml(current, { makeApiUrlsRelative: true, slug: 'spring-sale' })).toBe(`fetch('/api/landing_pages/public/spring-sale/checkout')`)
  })
})

describe('funnel checkout success page', () => {
  beforeEach(() => {
    tables = {
      funnels: [{ id: 'f1', slug: 'launch', is_published: true, organization_id: 'org-a', tenant_id: 't-a' }],
      funnel_steps: [
        { id: 's1', funnel_id: 'f1', step_type: 'page', step_order: 1, page_id: null, config: {} },
        { id: 's2', funnel_id: 'f1', step_type: 'checkout', step_order: 2, product_id: 'p1', config: {} },
        { id: 's3', funnel_id: 'f1', step_type: 'thank_you', step_order: 3, config: { message: 'You are in!' } },
      ],
      funnel_sessions: [
        { id: 'sid-1', funnel_id: 'f1', organization_id: 'org-a', visitor_id: 'v1', status: 'active' },
        { id: 'sid-other', funnel_id: 'f-other', organization_id: 'org-b', visitor_id: 'v9', status: 'active' },
      ],
      funnel_orders: [{ id: 'o1', session_id: 'sid-1', product_id: 'p1', amount: 49, status: 'succeeded', order_type: 'checkout', product_name: 'Launch kit', created_at: 1 }],
      funnel_visits: [],
    }
  })

  const get = async (qs: string) => {
    const res = await funnelGet(new Request(`https://crm.example.test/api/landing_pages/funnels/public/launch?${qs}`), { params: Promise.resolve({ slug: 'launch' }) })
    return { status: res.status, html: await res.text() }
  }

  it('step=thank_you renders the funnel\'s thank-you step for the paying session', async () => {
    const res = await get('step=thank_you&sid=sid-1')
    expect(res.status).toBe(200)
    expect(res.html).toContain('You are in!')
    expect(res.html).toContain('Launch kit')
    expect(tables.funnel_sessions.find((s) => s.id === 'sid-1')?.status).toBe('completed')
  })

  it('does not use a session of another funnel', async () => {
    const res = await get('step=thank_you&sid=sid-other')
    expect(res.html).toContain('You are in!')
    expect(tables.funnel_sessions.find((s) => s.id === 'sid-other')?.status).toBe('active')
  })

  it('renders a plain thank-you when the funnel has no thank-you step', async () => {
    tables.funnel_steps = tables.funnel_steps.filter((s) => s.step_type !== 'thank_you')
    const res = await get('step=thank_you&sid=sid-1')
    expect(res.status).toBe(200)
    expect(res.html).toContain('Thank you for your purchase!')
  })
})
