/** @jest-environment node */

const mockCreateRequestContainer = jest.fn()

type TokenRow = {
  id: string
  organization_id: string
  email: string
  token: string
  expires_at: Date
  used_at: Date | null
}

let tokenRows: TokenRow[] = []
let enrollmentRow: { slug: string } | undefined
const sessionInserts: Array<Record<string, unknown>> = []
const tokenUpdates: Array<{ id: string; whereNull: string[]; patch: Record<string, unknown> }> = []

function createKnex() {
  const knex = (table: string) => {
    const filters: Array<[string, unknown]> = []
    const nulls: string[] = []
    const q: any = {
      where: jest.fn((field: string, value: unknown) => { filters.push([field, value]); return q }),
      whereNull: jest.fn((field: string) => { nulls.push(field); return q }),
      join: jest.fn(() => q),
      select: jest.fn(() => q),
      first: jest.fn(async () => {
        if (table === 'course_magic_tokens') {
          const tok = filters.find(([f]) => f === 'token')?.[1]
          return tokenRows.find((r) => r.token === tok)
        }
        if (table.startsWith('course_enrollments')) return enrollmentRow
        return undefined
      }),
      insert: jest.fn(async (row: Record<string, unknown>) => {
        if (table === 'course_student_sessions') sessionInserts.push(row)
      }),
      update: jest.fn(async (patch: Record<string, unknown>) => {
        if (table === 'course_magic_tokens') {
          const id = filters.find(([f]) => f === 'id')?.[1] as string
          tokenUpdates.push({ id, whereNull: [...nulls], patch })
          const row = tokenRows.find((r) => r.id === id)
          if (row && (!nulls.includes('used_at') || row.used_at === null)) Object.assign(row, patch)
          return 1
        }
        return 0
      }),
    }
    return q
  }
  return knex
}

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: (...args: unknown[]) => mockCreateRequestContainer(...args),
}))

import { GET } from '../route'

const BASE = 'https://crm.example.com'
const DAY = 24 * 60 * 60 * 1000
const originalEnv = process.env

beforeEach(() => {
  jest.clearAllMocks()
  process.env = { ...originalEnv, APP_URL: BASE }
  delete process.env.COURSE_MAGIC_LINK_TTL_DAYS
  tokenRows = []
  enrollmentRow = { slug: 'intro-course' }
  sessionInserts.length = 0
  tokenUpdates.length = 0
  mockCreateRequestContainer.mockResolvedValue({
    resolve: (name: string) => {
      if (name === 'em') return { getKnex: () => createKnex() }
      throw new Error(`unexpected resolve: ${name}`)
    },
  })
})

afterAll(() => {
  process.env = originalEnv
})

function seed(overrides: Partial<TokenRow> = {}): TokenRow {
  const row: TokenRow = {
    id: 'tok-1',
    organization_id: 'org-1',
    email: 'student@example.com',
    token: 'valid-token',
    expires_at: new Date(Date.now() + 3 * DAY),
    used_at: null,
    ...overrides,
  }
  tokenRows.push(row)
  return row
}

const request = (token: string) => new Request(`${BASE}/api/courses/student/verify?token=${token}`)

describe('GET /api/courses/student/verify', () => {
  it('redeems a fresh token: creates a session, stamps used_at, redirects to the course', async () => {
    const row = seed()
    const res = await GET(request('valid-token'))

    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe(`${BASE}/course/intro-course/learn`)
    expect(res.headers.get('set-cookie')).toContain('course_session=')
    expect(sessionInserts).toHaveLength(1)
    expect(sessionInserts[0]).toMatchObject({ organization_id: 'org-1', email: 'student@example.com' })
    expect(row.used_at).toBeInstanceOf(Date)
    expect(tokenUpdates[0].whereNull).toContain('used_at')
  })

  it('rejects an expired token with a clear message and the request-new-link form', async () => {
    seed({ token: 'old-token', expires_at: new Date(Date.now() - 1000) })
    const res = await GET(request('old-token'))

    expect(res.status).toBe(400)
    const html = await res.text()
    expect(html).toContain('<h1>Link expired</h1>')
    expect(html).toContain('Links are valid for 7 days')
    expect(html).toContain('/api/courses/student/magic-link')
    expect(html).toContain('value="student@example.com"')
    expect(sessionInserts).toHaveLength(0)
    expect(tokenUpdates).toHaveLength(0)
  })

  it('rejects a token used outside the grace window', async () => {
    seed({ token: 'spent-token', used_at: new Date(Date.now() - 60 * 60 * 1000) })
    const res = await GET(request('spent-token'))

    expect(res.status).toBe(400)
    const html = await res.text()
    expect(html).toContain('<h1>Link already used</h1>')
    expect(sessionInserts).toHaveLength(0)
  })

  it('allows a second click shortly after the first without moving the used_at stamp', async () => {
    const firstUse = new Date(Date.now() - 30 * 1000)
    const row = seed({ token: 'valid-token', used_at: firstUse })
    const res = await GET(request('valid-token'))

    expect(res.status).toBe(307)
    expect(sessionInserts).toHaveLength(1)
    expect(tokenUpdates).toHaveLength(0)
    expect(row.used_at).toBe(firstUse)
  })

  it('still reports unknown tokens as invalid', async () => {
    const res = await GET(request('nope'))
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('<h1>Invalid link</h1>')
  })

  it('escapes the email it echoes into the page', async () => {
    seed({ token: 'xss-token', email: '"><script>alert(1)</script>@x.com', expires_at: new Date(Date.now() - 1) })
    const html = await (await GET(request('xss-token'))).text()
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })
})
