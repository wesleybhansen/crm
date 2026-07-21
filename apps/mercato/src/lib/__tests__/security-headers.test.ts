import {
  applyBrowserSecurityHeaders,
  browserSecurityHeaderRules,
  DEFAULT_BROWSER_HEADER_SOURCE,
  FRAMEABLE_PUBLIC_HEADER_SOURCE,
  isIntentionallyFrameablePublicPath,
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
})
