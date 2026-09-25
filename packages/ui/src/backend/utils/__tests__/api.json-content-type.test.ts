/**
 * @jest-environment jsdom
 */
jest.mock('../../FlashMessages', () => ({ flash: jest.fn() }))

import { apiFetch, withJsonContentTypeDefault } from '../api'

describe('JSON Content-Type default for same-origin writes (CRM CSRF guard)', () => {
  it('declares a same-origin JSON string body as application/json', () => {
    const init = withJsonContentTypeDefault('/api/x', { method: 'PUT', body: JSON.stringify({ a: 1 }) })
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
    const absolute = withJsonContentTypeDefault(`${window.location.origin}/api/x`, { method: 'POST', body: '[1]' })
    expect(new Headers(absolute?.headers).get('content-type')).toBe('application/json')
  })

  it('leaves reads, explicit types, non-JSON bodies, FormData and other origins alone', () => {
    const cases: Array<[RequestInfo | URL, RequestInit]> = [
      ['/api/x', { method: 'GET' }],
      ['/api/x', { method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain' } }],
      ['/api/x', { method: 'POST', body: 'a=1' }],
      ['/api/x', { method: 'POST', body: new FormData() }],
      ['https://us.i.posthog.com/e', { method: 'POST', body: '{}' }],
    ]
    for (const [input, init] of cases) {
      expect(withJsonContentTypeDefault(input, init)).toBe(init)
    }
    expect(withJsonContentTypeDefault('/api/x', undefined)).toBeUndefined()
  })

  it('sends the header through apiFetch', async () => {
    const baseFetch = jest.fn(async () => new Response('{}', { status: 200 }))
    ;(window as unknown as Record<string, unknown>).__omOriginalFetch = baseFetch
    try {
      await apiFetch('/api/customers/pipeline-automation/rules', { method: 'PUT', body: JSON.stringify({ id: 'r' }) })
      const [, init] = baseFetch.mock.calls[0] as unknown as [string, RequestInit]
      expect(new Headers(init.headers).get('content-type')).toBe('application/json')
    } finally {
      ;(window as unknown as Record<string, unknown>).__omOriginalFetch = undefined
    }
  })
})
