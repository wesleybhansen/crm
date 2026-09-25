/**
 * /p/{slug} and /f/{slug} are the share links for landing pages and funnels.
 * Signed-out visitors must reach the public page: the short route redirects
 * to an API route that needs no auth. ('/p/(.*)' and '/f/(.*)' are listed in
 * isPublicPage in src/proxy.ts so the page proxy lets them through.)
 */
jest.mock('@/bootstrap', () => ({ bootstrap: jest.fn(), isBootstrapped: jest.fn(() => true) }))

import { GET as landingShortLink } from '@/app/p/[slug]/route'
import { GET as funnelShortLink } from '@/app/f/[slug]/route'
import { metadata as publicPageMeta } from '../api/public/[slug]/route'
import { metadata as publicSubmitMeta } from '../api/public/[slug]/submit/route'
import { metadata as funnelMeta } from '../api/funnels/public/[slug]/route'
import { metadata as funnelAdvanceMeta } from '../api/funnels/public/[slug]/advance/route'
import { metadata as funnelUpsellMeta } from '../api/funnels/public/[slug]/upsell/route'
import { metadata as funnelCheckoutMeta } from '../api/funnels/public/[slug]/checkout/route'
import * as fs from 'fs'
import * as path from 'path'

const originalAppUrl = process.env.APP_URL
beforeEach(() => { delete process.env.APP_URL })
afterAll(() => { if (originalAppUrl !== undefined) process.env.APP_URL = originalAppUrl })

describe('short links', () => {
  it('/p/{slug} redirects to the public landing page API, keeping the query', async () => {
    const res = await landingShortLink(new Request('https://crm.example.com/p/my-page?utm_source=x'), { params: Promise.resolve({ slug: 'my-page' }) })
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('https://crm.example.com/api/landing_pages/public/my-page?utm_source=x')
  })

  it('/f/{slug} redirects to the public funnel API under the module id', async () => {
    const res = await funnelShortLink(new Request('https://crm.example.com/f/my-funnel'), { params: Promise.resolve({ slug: 'my-funnel' }) })
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('https://crm.example.com/api/landing_pages/funnels/public/my-funnel')
  })
})

describe('the routes they land on need no sign-in', () => {
  it.each([
    ['landing page GET', publicPageMeta, 'GET'],
    ['landing page submit POST', publicSubmitMeta, 'POST'],
    ['funnel GET', funnelMeta, 'GET'],
    ['funnel advance POST', funnelAdvanceMeta, 'POST'],
    ['funnel upsell POST', funnelUpsellMeta, 'POST'],
    ['funnel checkout GET', funnelCheckoutMeta, 'GET'],
    ['funnel checkout POST', funnelCheckoutMeta, 'POST'],
  ])('%s', (_label, meta, method) => {
    expect((meta as Record<string, { requireAuth?: boolean }>)[method]?.requireAuth).toBe(false)
  })

  it('the page proxy lists /p and /f as public pages', () => {
    const proxySource = fs.readFileSync(path.join(__dirname, '../../../proxy.ts'), 'utf8')
    const matcherBlock = proxySource.slice(proxySource.indexOf('const isPublicPage'), proxySource.indexOf('])', proxySource.indexOf('const isPublicPage')))
    expect(matcherBlock).toContain("'/p/(.*)'")
    expect(matcherBlock).toContain("'/f/(.*)'")
  })
})
