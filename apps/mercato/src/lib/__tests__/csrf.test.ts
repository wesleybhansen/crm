import { allowedOrigins, evaluateCsrf, hasSessionCookie, isCsrfExemptPath } from '../csrf'

const PROD = { APP_URL: 'https://crm.noliai.com', NODE_ENV: 'production' }

function check(
  method: string,
  pathname: string,
  headers: Record<string, string>,
  env: Record<string, string> = PROD,
) {
  return evaluateCsrf({ method, pathname, headers: new Headers(headers) }, env)
}

const SESSION = { cookie: '__client_uat=1; __session=eyJhbGciOi.x.y' }

describe('CRM CSRF guard', () => {
  it('blocks the sweep repro: a same-site page posting text/plain with the session cookie', () => {
    const verdict = check('POST', '/api/calendar/booking-pages', {
      ...SESSION,
      origin: 'https://noliai.com',
      'sec-fetch-site': 'same-site',
      'content-type': 'text/plain;charset=UTF-8',
      'content-length': '40',
    })
    expect(verdict).toEqual({ ok: false, status: 403, reason: 'cross-origin' })
  })

  it('blocks a cross-origin write even when it claims JSON', () => {
    for (const origin of ['https://app.noliai.com', 'https://evil.example', 'null']) {
      expect(check('PUT', '/api/customers/people', { ...SESSION, origin, 'content-type': 'application/json' }).ok).toBe(false)
    }
  })

  it('blocks a cross-site write that sends only Sec-Fetch-Site', () => {
    expect(check('DELETE', '/api/customers/people', { ...SESSION, 'sec-fetch-site': 'cross-site' }).ok).toBe(false)
  })

  it('allows the CRM UI: same origin, JSON', () => {
    expect(check('POST', '/api/calendar/booking-pages', {
      ...SESSION,
      origin: 'https://crm.noliai.com',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      'content-length': '40',
    })).toEqual({ ok: true })
  })

  it('accepts Sec-Fetch-Site: same-origin when Origin is absent', () => {
    expect(check('PATCH', '/api/customers/people', { ...SESSION, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }).ok).toBe(true)
  })

  it('allows uploads (multipart) and empty-body deletes from the CRM', () => {
    const base = { ...SESSION, origin: 'https://crm.noliai.com' }
    expect(check('POST', '/api/attachments', { ...base, 'content-type': 'multipart/form-data; boundary=x', 'content-length': '900' }).ok).toBe(true)
    expect(check('DELETE', '/api/chat/widgets', { ...base, 'content-length': '0' }).ok).toBe(true)
    expect(check('DELETE', '/api/chat/widgets', base).ok).toBe(true)
  })

  it('rejects same-origin writes whose body is not JSON or multipart', () => {
    const base = { ...SESSION, origin: 'https://crm.noliai.com' }
    expect(check('POST', '/api/customers/people', { ...base, 'content-type': 'text/plain', 'content-length': '5' }))
      .toEqual({ ok: false, status: 415, reason: 'content-type' })
    expect(check('POST', '/api/customers/people', { ...base, 'content-type': 'application/x-www-form-urlencoded', 'content-length': '5' }).ok).toBe(false)
    expect(check('POST', '/api/customers/people', { ...base, 'content-length': '5' }).ok).toBe(false)
  })

  it('keeps the plain-HTML sign-out form working', () => {
    expect(check('POST', '/api/auth/logout', { ...SESSION, origin: 'https://crm.noliai.com', 'content-type': 'application/x-www-form-urlencoded', 'content-length': '0' }).ok).toBe(true)
  })

  it('does not apply to reads', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(check(method, '/api/customers/people', { ...SESSION, origin: 'https://evil.example' }).ok).toBe(true)
    }
  })

  it('exempts requests with no session cookie (API keys, bearer tokens, MCP, server calls)', () => {
    expect(check('POST', '/api/customers/people', { 'x-api-key': 'k', 'content-type': 'text/plain' }).ok).toBe(true)
    expect(check('POST', '/api/customers/people', { authorization: 'Bearer t', origin: 'https://evil.example' }).ok).toBe(true)
    expect(check('POST', '/api/customers/people', { cookie: 'om_selected_org=abc; lp_ab_x=control', origin: 'https://evil.example' }).ok).toBe(true)
  })

  it('treats a request with neither Origin nor Sec-Fetch-Site as non-browser', () => {
    expect(check('POST', '/api/customers/people', { ...SESSION, 'content-type': 'application/json' }).ok).toBe(true)
  })

  it('exempts internal, webhook, cron and SSO callback paths', () => {
    const cross = { ...SESSION, origin: 'https://evil.example', 'content-type': 'text/plain', 'content-length': '3' }
    for (const path of [
      '/api/integrations_api/internal/email-send',
      '/api/gtm/internal/plays',
      '/api/payments/stripe/webhook',
      '/api/payment_gateways/webhook/stripe',
      '/api/customers/sms/webhook',
      '/api/email/intelligence-cron',
      '/api/sso/callback/oidc',
      '/api/gtm/threads-callback',
    ]) {
      expect({ path, ok: check('POST', path, cross).ok }).toEqual({ path, ok: true })
    }
  })

  it('does not exempt the webhook-management routes (cookie-authenticated)', () => {
    for (const path of ['/api/customers/webhooks', '/api/webhooks/subscriptions', '/api/webhooks/subscriptions/abc/rotate-secret']) {
      expect(isCsrfExemptPath(path, 'POST')).toBe(false)
    }
  })

  it('exempts the public endpoints sandboxed pages call, but not the chat agent typing branch', () => {
    const cross = { ...SESSION, origin: 'null', 'content-type': 'application/json' }
    expect(check('POST', '/api/landing_pages/public/my-page/submit', cross).ok).toBe(true)
    expect(check('POST', '/api/forms/public/f1/submit', cross).ok).toBe(true)
    expect(check('POST', '/api/calendar/bookings', cross).ok).toBe(true)
    // Only POST on /calendar/bookings is public; the owner's PUT/DELETE are not.
    expect(check('PUT', '/api/calendar/bookings', cross).ok).toBe(false)
    expect(check('DELETE', '/api/calendar/bookings', cross).ok).toBe(false)
    // /chat/typing sets the agent flag for signed-in users, so it keeps the check.
    expect(check('POST', '/api/chat/typing', cross).ok).toBe(false)
  })

  it('allows the configured app origins and local dev outside production', () => {
    expect([...allowedOrigins({ APP_URL: 'https://qa1.crm.example/x', NEXT_PUBLIC_APP_URL: 'not a url' })])
      .toEqual(['https://crm.noliai.com', 'https://qa1.crm.example'])
    const json = { ...SESSION, 'content-type': 'application/json' }
    expect(check('POST', '/api/x/y', { ...json, origin: 'http://localhost:3000' }, { NODE_ENV: 'development' }).ok).toBe(true)
    expect(check('POST', '/api/x/y', { ...json, origin: 'http://localhost:3000' }, PROD).ok).toBe(false)
    expect(check('POST', '/api/x/y', { ...json, origin: 'https://qa1.crm.example' }, { APP_URL: 'https://qa1.crm.example', NODE_ENV: 'production' }).ok).toBe(true)
  })

  it('recognises every CRM session cookie, and only non-empty ones', () => {
    for (const name of ['__session', '__session_Abc123', 'auth_token', 'session_token', 'customer_auth_token', 'customer_session_token', 'course_session']) {
      expect(hasSessionCookie(`a=1; ${name}=v`)).toBe(true)
    }
    expect(hasSessionCookie('__session=')).toBe(false)
    expect(hasSessionCookie('__client_uat=0; funnel_vid=x; affiliate_ref=y')).toBe(false)
    expect(hasSessionCookie(null)).toBe(false)
  })
})
