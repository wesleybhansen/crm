import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  applyBrowserSecurityHeaders,
  CRM_CSP_DIRECTIVES,
  crmContentSecurityPolicy,
  browserSecurityHeaderRules,
  COMPANY_LEGAL_REDIRECTS,
  DEFAULT_BROWSER_HEADER_SOURCE,
  FRAMEABLE_PUBLIC_HEADER_SOURCE,
  isIntentionallyFrameablePublicPath,
  trailingSlashRedirectPath,
  trustedRequestHost,
} from '../security-headers'

function headersFor(source: string): Map<string, string> {
  const rule = browserSecurityHeaderRules().find((candidate) => candidate.source === source)
  if (!rule) throw new Error(`missing browser security rule for ${source}`)
  return new Map(rule.headers.map((header) => [header.key, header.value]))
}

describe('CRM browser security headers', () => {
  test('applies the host-independent baseline to ordinary, API, and deeper routes', () => {
    const headers = headersFor(DEFAULT_BROWSER_HEADER_SOURCE)

    expect(Object.fromEntries(headers)).toEqual({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
      'X-Frame-Options': 'DENY',
    })
  })

  test('omits only frame blocking on the two intentionally embeddable HTML routes', () => {
    const headers = headersFor(FRAMEABLE_PUBLIC_HEADER_SOURCE)

    expect(Object.fromEntries(headers)).toEqual({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
    })
    expect(headers.has('X-Frame-Options')).toBe(false)
  })

  test.each([
    '/api/forms/public/contact-us',
    '/api/forms/public/contact-us/',
    '/api/surveys/public/customer-nps',
    '/api/surveys/public/customer-nps/',
  ])('classifies %s as intentionally frameable', (pathname) => {
    expect(isIntentionallyFrameablePublicPath(pathname)).toBe(true)
  })

  test.each([
    '/',
    '/backend',
    '/api/auth/me',
    '/api/forms/public/contact-us/submit',
    '/api/surveys/public/customer-nps/submit',
    '/api/forms/public/contact-us/extra',
    '/api/forms/public/contact%2Fsubmit',
    '/api/forms/public/Contact-Us',
    '/api/landing_pages/public/contact-us',
    '/api/courses/public/getting-started',
    '/api/crm-events/public/summer-event',
  ])('keeps %s frame-protected', (pathname) => {
    expect(isIntentionallyFrameablePublicPath(pathname)).toBe(false)
  })

  test('keeps the Next route sources aligned with the exact public-path policy', () => {
    expect(DEFAULT_BROWSER_HEADER_SOURCE).toBe(
      '/:path((?!api/(?:forms|surveys)/public/[a-z0-9-]+/?$).*)',
    )
    expect(FRAMEABLE_PUBLIC_HEADER_SOURCE).toBe(
      '/api/:surface(forms|surveys)/public/:slug([a-z0-9-]+)',
    )
  })

  test('keeps legal and trailing-slash redirects available to the header-aware proxy', () => {
    expect(COMPANY_LEGAL_REDIRECTS).toEqual({
      '/privacy': 'https://noliai.com/privacy',
      '/terms': 'https://noliai.com/terms',
    })
    expect(trailingSlashRedirectPath('/backend/')).toBe('/backend')
    expect(trailingSlashRedirectPath('/api/forms/public/contact-us/')).toBe(
      '/api/forms/public/contact-us',
    )
    expect(trailingSlashRedirectPath('/')).toBeNull()
    expect(trailingSlashRedirectPath('/backend')).toBeNull()
  })

  test('never lets a client forwarding hint override the request Host authority', () => {
    expect(trustedRequestHost(new Headers({
      Host: 'crm.noliai.com',
      'X-Forwarded-Host': 'attacker.invalid',
    }), 'fallback.invalid')).toBe('crm.noliai.com')
    expect(trustedRequestHost(
      new Headers({ 'X-Forwarded-Host': 'trusted-proxy.example' }),
      'fallback.invalid',
    )).toBe('fallback.invalid')
    expect(trustedRequestHost(new Headers(), 'fallback.invalid')).toBe('fallback.invalid')
  })

  test('applies the same policy to proxy-generated redirects and rewrites', () => {
    const ordinary = new Headers({ 'X-Frame-Options': 'SAMEORIGIN' })
    applyBrowserSecurityHeaders(ordinary, '/backend', { includeHsts: true })
    expect(Object.fromEntries(ordinary)).toMatchObject({
      'permissions-policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'strict-transport-security': 'max-age=31536000',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    })

    const embed = new Headers({ 'X-Frame-Options': 'DENY' })
    applyBrowserSecurityHeaders(embed, '/api/forms/public/contact-us', { includeHsts: true })
    expect(embed.has('X-Frame-Options')).toBe(false)
    expect(embed.get('X-Content-Type-Options')).toBe('nosniff')

    const customerDomain = new Headers({ 'Strict-Transport-Security': 'max-age=31536000' })
    applyBrowserSecurityHeaders(customerDomain, '/', { includeHsts: false })
    expect(customerDomain.has('Strict-Transport-Security')).toBe(false)
    expect(customerDomain.get('X-Frame-Options')).toBe('DENY')
  })

  describe('Content-Security-Policy', () => {
    const directive = (name: string): readonly string[] => {
      const entry = CRM_CSP_DIRECTIVES.find(([key]) => key === name)
      if (!entry) throw new Error(`missing CSP directive ${name}`)
      return entry[1]
    }

    test('nginx sends exactly the policy defined in code', () => {
      const nginx = readFileSync(path.resolve(__dirname, '../../../../../nginx.conf'), 'utf8')
      const match = nginx.match(/add_header Content-Security-Policy(?:-Report-Only)? "([^"]*)" always;/)
      expect(match?.[1]).toBe(crmContentSecurityPolicy())
    })

    test('allows Clerk sign-in on the custom Frontend API domain', () => {
      expect(directive('script-src')).toEqual(expect.arrayContaining([
        'https://clerk.noliai.com',
        'https://challenges.cloudflare.com',
      ]))
      expect(directive('connect-src')).toContain('https://*.noliai.com')
      expect(directive('frame-src')).toContain('https://challenges.cloudflare.com')
      expect(directive('img-src')).toContain('https:')
      expect(directive('worker-src')).toContain('blob:')
    })

    test('allows the Fontshare and Google font stylesheets and files', () => {
      expect(directive('style-src')).toEqual(expect.arrayContaining([
        'https://api.fontshare.com',
        'https://fonts.googleapis.com',
      ]))
      expect(directive('font-src')).toEqual(expect.arrayContaining([
        'https://cdn.fontshare.com',
        'https://fonts.gstatic.com',
      ]))
    })

    test('allows Stripe.js, PostHog and course video embeds', () => {
      expect(directive('script-src')).toEqual(expect.arrayContaining(['https://js.stripe.com', 'https://*.posthog.com']))
      expect(directive('connect-src')).toEqual(expect.arrayContaining(['https://api.stripe.com', 'https://*.posthog.com']))
      expect(directive('frame-src')).toEqual(expect.arrayContaining([
        'https://js.stripe.com',
        'https://hooks.stripe.com',
        'https://www.youtube.com',
        'https://player.vimeo.com',
        'https://www.loom.com',
      ]))
    })

    test('keeps plugins and base-tag hijacks blocked and each directive listed once', () => {
      expect(directive('object-src')).toEqual(["'none'"])
      expect(directive('base-uri')).toEqual(["'self'"])
      const names = CRM_CSP_DIRECTIVES.map(([name]) => name)
      expect(new Set(names).size).toBe(names.length)
      expect(crmContentSecurityPolicy()).not.toMatch(/"/)
    })
  })
})
