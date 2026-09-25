/**
 * Route-level fixes from the 2026-09-25 security sweep (CRM medium and low
 * findings): chat typing ownership, the event calendar file, the API docs,
 * the course magic-link limits, the landing page's sandbox hand-off, and the
 * course lesson renderer.
 */

type Row = Record<string, unknown>
const mockDb: { tables: Record<string, Row[]>; updates: Array<{ table: string; where: Row; values: Row }> } = {
  tables: {},
  updates: [],
}

// Minimal knex stand-in that honours equality where() filters.
function mockQuery(table: string) {
  const filters: Row = {}
  let whereNullCols: string[] = []
  const matches = (row: Row) =>
    Object.entries(filters).every(([k, v]) => row[k] === v) && whereNullCols.every((c) => row[c] == null)
  const q: Record<string, unknown> = {
    where(col: string | Row, val?: unknown) {
      if (typeof col === 'object') Object.assign(filters, col)
      else filters[col] = val
      return q
    },
    andWhere(col: string, val: unknown) {
      filters[col] = val
      return q
    },
    whereNull(col: string) {
      whereNullCols = [...whereNullCols, col]
      return q
    },
    async first() {
      return (mockDb.tables[table] ?? []).find(matches)
    },
    async update(values: Row) {
      mockDb.updates.push({ table, where: { ...filters }, values })
      return 1
    },
    async insert() {
      return [1]
    },
  }
  return q
}
const mockKnex = Object.assign((table: string) => mockQuery(table), { raw: async () => ({ rows: [] }) })

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: async () => ({
    resolve: (key: string) => (key === 'em' ? { getKnex: () => mockKnex } : null),
  }),
}))

const mockAuth: { value: Record<string, unknown> | null } = { value: null }
jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: async () => mockAuth.value,
  getAuthFromCookies: async () => mockAuth.value,
}))

jest.mock('@/.mercato/generated/modules.generated', () => ({ modules: [] }))

const mockConsume = jest.fn()
jest.mock('@open-mercato/core/bootstrap', () => ({
  getCachedRateLimiterService: () => ({ consume: mockConsume }),
}))

import { POST as typingPost } from '@/modules/customers/api/chat/typing/route'
import { GET as calendarGet } from '@/modules/customers/api/crm-events/[id]/calendar/route'
import { metadata as openapiMeta } from '@/modules/customers/api/docs/openapi/route'
import { metadata as markdownMeta } from '@/modules/customers/api/docs/markdown/route'
import { POST as magicLinkPost, metadata as magicLinkMeta } from '@/modules/courses/api/student/magic-link/route'
import { signEventCalendarToken } from '@/modules/customers/lib/event-calendar-token'
import { readAffiliateRefFromRequest, visitorContextScript } from '@/modules/landing_pages/services/public-serving'
import { renderMarkdown } from '@/app/course/[slug]/learn/render-markdown'

const ORG = 'org-a'
const CONV = '33333333-3333-4333-8333-333333333333'
const EVENT = '44444444-4444-4444-8444-444444444444'

function json(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://crm.noliai.com/api/chat/typing', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  mockDb.tables = {}
  mockDb.updates = []
  mockAuth.value = null
  mockConsume.mockReset()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret'
})

describe('chat typing: only the visitor or the org may change a conversation', () => {
  beforeEach(() => {
    mockDb.tables.chat_conversations = [
      { id: CONV, organization_id: ORG, tenant_id: 't', widget_id: 'w1', visitor_token: 'visitor-secret' },
    ]
  })

  it('lets the visitor holding the token set the visitor flag', async () => {
    const res = await typingPost(json({ conversationId: CONV, visitorToken: 'visitor-secret', widgetId: 'w1', sender: 'visitor', isTyping: true }))
    expect(res.status).toBe(200)
    expect(mockDb.updates).toHaveLength(1)
    expect(mockDb.updates[0].values).toMatchObject({ visitor_typing: true })
  })

  it('refuses a visitor without the token, or with another widget id', async () => {
    for (const body of [
      { conversationId: CONV, sender: 'visitor', isTyping: true },
      { conversationId: CONV, visitorToken: 'wrong', sender: 'visitor', isTyping: true },
      { conversationId: CONV, visitorToken: 'visitor-secret', widgetId: 'other', sender: 'visitor', isTyping: true },
    ]) {
      const res = await typingPost(json(body))
      expect(res.status).toBe(404)
    }
    expect(mockDb.updates).toHaveLength(0)
  })

  it('refuses the agent flag to anonymous callers and to other orgs', async () => {
    expect((await typingPost(json({ conversationId: CONV, sender: 'agent', isTyping: true }))).status).toBe(404)
    mockAuth.value = { sub: 'u', orgId: 'org-b', tenantId: 't' }
    expect((await typingPost(json({ conversationId: CONV, sender: 'agent', isTyping: true }))).status).toBe(404)
    expect(mockDb.updates).toHaveLength(0)
  })

  it("lets the conversation's own org set the agent flag", async () => {
    mockAuth.value = { sub: 'u', orgId: ORG, tenantId: 't' }
    const res = await typingPost(json({ conversationId: CONV, sender: 'agent', isTyping: true }))
    expect(res.status).toBe(200)
    expect(mockDb.updates[0].values).toMatchObject({ agent_typing: true })
  })

  it('answers 404 for an unknown conversation', async () => {
    expect((await typingPost(json({ conversationId: 'nope', sender: 'visitor', isTyping: true }))).status).toBe(404)
  })
})

describe('event calendar file', () => {
  const published = {
    id: EVENT, status: 'published', deleted_at: null, title: 'Launch', event_type: 'virtual',
    virtual_link: 'https://meet.example/secret-room', start_time: '2026-10-01T10:00:00Z', end_time: null,
  }
  const call = (id: string, query = '') =>
    calendarGet(new Request(`https://crm.noliai.com/api/crm-events/${id}/calendar${query}`), { params: Promise.resolve({ id }) })

  it('serves nothing for a draft event', async () => {
    mockDb.tables.events = [{ ...published, status: 'draft' }]
    expect((await call(EVENT)).status).toBe(404)
  })

  it('serves a published event without its private join link by id alone', async () => {
    mockDb.tables.events = [published]
    const res = await call(EVENT)
    expect(res.status).toBe(200)
    const ics = await res.text()
    expect(ics).toContain('SUMMARY:Launch')
    expect(ics).not.toContain('secret-room')
  })

  it('includes the join link for the signed link in the registration email', async () => {
    mockDb.tables.events = [published]
    const token = signEventCalendarToken(EVENT)
    expect(token).toBeTruthy()
    const ics = await (await call(EVENT, `?t=${encodeURIComponent(token!)}`)).text()
    expect(ics).toContain('https://meet.example/secret-room')
    const forged = await (await call(EVENT, '?t=forged')).text()
    expect(forged).not.toContain('secret-room')
  })

  it('rejects ids that are not UUIDs', async () => {
    expect((await call('1 or 1=1')).status).toBe(404)
  })
})

describe('API docs need sign-in', () => {
  it('marks the OpenAPI and markdown route lists as requireAuth', () => {
    expect(openapiMeta.GET.requireAuth).toBe(true)
    expect(markdownMeta.GET.requireAuth).toBe(true)
  })
})

describe('course magic link limits', () => {
  it('has a per-IP limit in its route metadata', () => {
    expect(magicLinkMeta.POST.rateLimit).toMatchObject({ points: 5, keyPrefix: 'courses-magic-link-ip' })
  })

  it('stops sending once one address hits its limit, with the same answer', async () => {
    mockConsume.mockResolvedValue({ allowed: false, remainingPoints: 0, msBeforeNext: 1000, consumedPoints: 4 })
    const res = await magicLinkPost(new Request('https://crm.noliai.com/api/courses/student/magic-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'Student@Example.com', courseSlug: 'c' }),
    }))
    expect(await res.json()).toEqual({ ok: true })
    expect(mockConsume).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{64}$/), expect.objectContaining({ keyPrefix: 'courses-magic-link-email' }))
  })
})

describe('landing page hand-off to the sandboxed page', () => {
  it('reads only a well-formed affiliate code from the cookie', () => {
    const req = (cookie: string) => new Request('https://crm.noliai.com/p/x', { headers: { cookie } })
    expect(readAffiliateRefFromRequest(req('a=1; affiliate_ref=partner_7'))).toBe('partner_7')
    expect(readAffiliateRefFromRequest(req('affiliate_ref=%3Cscript%3E'))).toBeNull()
    expect(readAffiliateRefFromRequest(req('other=1'))).toBeNull()
  })

  it('passes the A/B arm and referral code to the forms as hidden fields, safely encoded', () => {
    const script = visitorContextScript({ _ab_arm: 'control', _aff_ref: 'partner_7', empty: null })
    expect(script).toContain('"_ab_arm":"control"')
    expect(script).toContain('"_aff_ref":"partner_7"')
    expect(script).not.toContain('empty')
    const hostile = visitorContextScript({ _ab_arm: '</script><script>alert(1)</script>' })
    expect(hostile).not.toContain('</script><script>')
    expect(visitorContextScript({})).toBe('')
  })
})

describe('course lesson renderer', () => {
  it('escapes HTML the old blocklist let through, and still renders markdown', () => {
    const html = renderMarkdown('# Title\n<img src=x onerror=alert(1)>\n**bold** <svg/onload=alert(1)>')
    expect(html).not.toMatch(/<img|<svg/)
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('<h1>Title</h1>')
    expect(html).toContain('<strong>bold</strong>')
  })
})
