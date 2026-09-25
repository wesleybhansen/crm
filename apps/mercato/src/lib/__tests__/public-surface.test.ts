import fs from 'node:fs'
import path from 'node:path'
import {
  PUBLIC_SANDBOX_CSP,
  PUBLIC_SANDBOX_ENDPOINTS,
  applyPublicSurfaceHeaders,
  isActiveDocumentContentType,
  isPublicSandboxEndpoint,
  publicCorsHeaders,
} from '../public-surface'

const MODULES = path.resolve(__dirname, '../../modules')

// Every PUBLIC_SANDBOX_ENDPOINTS entry: an example path and the route file.
const ENDPOINT_ROUTES: Array<{ example: string; file: string }> = [
  { example: '/api/landing_pages/public/my-page/submit', file: 'landing_pages/api/public/[slug]/submit/route.ts' },
  { example: '/api/landing_pages/funnels/public/f/advance', file: 'landing_pages/api/funnels/public/[slug]/advance/route.ts' },
  { example: '/api/landing_pages/funnels/public/f/upsell', file: 'landing_pages/api/funnels/public/[slug]/upsell/route.ts' },
  { example: '/api/landing_pages/funnels/public/f/checkout', file: 'landing_pages/api/funnels/public/[slug]/checkout/route.ts' },
  { example: '/api/forms/public/contact/submit', file: 'forms/api/public/[slug]/submit/route.ts' },
  { example: '/api/surveys/public/nps/submit', file: 'customers/api/surveys/public/[slug]/submit/route.ts' },
  { example: '/api/calendar/bookings', file: 'calendar/api/bookings/route.ts' },
  { example: '/api/crm-events/public/launch/register', file: 'customers/api/crm-events/public/[slug]/register/route.ts' },
  { example: '/api/crm-events/public/launch/checkout', file: 'customers/api/crm-events/public/[slug]/checkout/route.ts' },
  { example: '/api/crm-events/kiosk/tok', file: 'customers/api/crm-events/kiosk/[token]/route.ts' },
  { example: '/api/chat/public', file: 'customers/api/chat/public/route.ts' },
  { example: '/api/chat/typing', file: 'customers/api/chat/typing/route.ts' },
  { example: '/api/affiliates/signup', file: 'customers/api/affiliates/signup/route.ts' },
  { example: '/api/courses/enrollments', file: 'courses/api/enrollments/route.ts' },
  { example: '/api/courses/student/magic-link', file: 'courses/api/student/magic-link/route.ts' },
  { example: '/api/email/preferences/update', file: 'email/api/preferences/update/route.ts' },
]

describe('public surface: sandbox for customer-authored documents', () => {
  it('sandboxes scripts into an opaque origin (never allow-same-origin)', () => {
    const flags = PUBLIC_SANDBOX_CSP.split(/\s+/)
    expect(flags[0]).toBe('sandbox')
    expect(flags).toEqual(expect.arrayContaining(['allow-scripts', 'allow-forms', 'allow-popups', 'allow-popups-to-escape-sandbox']))
    expect(flags).not.toContain('allow-same-origin')
    expect(flags).not.toContain('allow-top-navigation')
  })

  it('treats HTML, XHTML, SVG and XML as active documents', () => {
    for (const type of ['text/html', 'text/html; charset=utf-8', 'TEXT/HTML', 'application/xhtml+xml', 'image/svg+xml', 'text/xml', 'application/xml']) {
      expect(isActiveDocumentContentType(type)).toBe(true)
    }
    for (const type of ['application/json', 'text/plain', 'text/calendar', 'image/png', 'application/javascript', null, undefined, '']) {
      expect(isActiveDocumentContentType(type)).toBe(false)
    }
  })

  it('adds the sandbox to HTML responses, including immutable redirects-turned-pages', () => {
    const html = applyPublicSurfaceHeaders(new Response('<p>x</p>', { headers: { 'content-type': 'text/html' } }), '/api/x', 'GET')
    expect(html.headers.get('content-security-policy')).toBe(PUBLIC_SANDBOX_CSP)
    const json = applyPublicSurfaceHeaders(Response.json({ ok: true }), '/api/x', 'GET')
    expect(json.headers.get('content-security-policy')).toBeNull()
    // Response.redirect() has immutable headers: the helper copies it instead of throwing.
    const redirect = Response.redirect('https://crm.noliai.com/x', 302)
    expect(() => applyPublicSurfaceHeaders(redirect, '/api/landing_pages/public/x/submit', 'POST')).not.toThrow()
  })

  it('answers CORS for the listed public endpoints only, never with credentials', () => {
    const listed = applyPublicSurfaceHeaders(
      new Response('{}', { headers: { 'content-type': 'application/json', 'Access-Control-Allow-Credentials': 'true' } }),
      '/api/landing_pages/public/my-page/submit',
      'POST',
    )
    expect(listed.headers.get('access-control-allow-origin')).toBe('*')
    expect(listed.headers.get('access-control-allow-credentials')).toBeNull()
    const owner = applyPublicSurfaceHeaders(Response.json({}), '/api/calendar/bookings', 'PUT')
    expect(owner.headers.get('access-control-allow-origin')).toBeNull()
    const other = applyPublicSurfaceHeaders(Response.json({}), '/api/customers/people', 'POST')
    expect(other.headers.get('access-control-allow-origin')).toBeNull()
    expect(publicCorsHeaders(['POST'])).toEqual({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
    })
  })

  it('covers every listed endpoint with an example, and each is public in its route metadata', () => {
    for (const endpoint of PUBLIC_SANDBOX_ENDPOINTS) {
      const examples = ENDPOINT_ROUTES.filter((r) => endpoint.pattern.test(r.example))
      expect({ endpoint: String(endpoint.pattern), examples: examples.length > 0 }).toEqual({ endpoint: String(endpoint.pattern), examples: true })
      for (const { file } of examples) {
        const source = fs.readFileSync(path.join(MODULES, file), 'utf8')
        const metadataBlock = source.slice(source.indexOf('export const metadata'))
        for (const method of endpoint.methods) {
          const isPublic = new RegExp(`\\b${method}:\\s*\\{\\s*requireAuth:\\s*false`).test(metadataBlock)
          expect({ file, method, isPublic }).toEqual({ file, method, isPublic: true })
        }
      }
    }
  })

  it('does not match lookalike or deeper paths', () => {
    expect(isPublicSandboxEndpoint('/api/landing_pages/public/x/submit/extra', 'POST')).toBe(false)
    expect(isPublicSandboxEndpoint('/api/landing_pages/pages/x', 'PUT')).toBe(false)
    expect(isPublicSandboxEndpoint('/api/calendar/bookings/confirm', 'POST')).toBe(false)
    expect(isPublicSandboxEndpoint('/api/chat/public', 'GET')).toBe(true)
  })
})
