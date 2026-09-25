/** @jest-environment node */

const mockCreateRequestContainer = jest.fn()

let lessonCount = 0
let courseUpdates: Array<Record<string, unknown>> = []

function createKnex() {
  const knex = (table: string) => {
    const q: any = {
      where: jest.fn(() => q),
      whereNull: jest.fn(() => q),
      join: jest.fn(() => q),
      first: jest.fn(async () => (table === 'courses' ? { id: 'course-1', organization_id: 'org-1', is_published: false } : undefined)),
      count: jest.fn(async () => [{ count: String(lessonCount) }]),
      update: jest.fn(async (patch: Record<string, unknown>) => {
        if (table === 'courses') courseUpdates.push(patch)
        return 1
      }),
      insert: jest.fn(async () => undefined),
    }
    return q
  }
  return knex
}

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: (...args: unknown[]) => mockCreateRequestContainer(...args),
}))
jest.mock('@/lib/public-slug', () => ({ isPublicSlugTaken: jest.fn(async () => false) }))

import { PUT } from '../route'

const ctx = { auth: { orgId: 'org-1' }, params: { id: 'course-1' } }

function put(body: Record<string, unknown>) {
  return PUT(new Request('https://crm.example.com/api/courses/courses/course-1', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), ctx)
}

beforeEach(() => {
  jest.clearAllMocks()
  lessonCount = 0
  courseUpdates = []
  mockCreateRequestContainer.mockResolvedValue({
    resolve: (name: string) => {
      if (name === 'em') return { getKnex: () => createKnex() }
      throw new Error(`unexpected resolve: ${name}`)
    },
  })
})

describe('PUT /api/courses/courses/:id publish validation', () => {
  it('refuses to publish a course with no lessons but keeps the other edits', async () => {
    const res = await put({ title: 'New title', isPublished: true })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.code).toBe('course_has_no_lessons')
    expect(body.error).toMatch(/at least one lesson/i)
    expect(courseUpdates).toHaveLength(1)
    expect(courseUpdates[0].title).toBe('New title')
    expect(courseUpdates[0]).not.toHaveProperty('is_published')
  })

  it('publishes a course that has lessons', async () => {
    lessonCount = 2
    const res = await put({ isPublished: true })
    expect(res.status).toBe(200)
    expect(courseUpdates[0].is_published).toBe(true)
  })

  it('always allows unpublishing', async () => {
    const res = await put({ isPublished: false })
    expect(res.status).toBe(200)
    expect(courseUpdates[0].is_published).toBe(false)
  })

  it('does not count lessons for a plain save', async () => {
    const res = await put({ title: 'Just a rename' })
    expect(res.status).toBe(200)
    expect(courseUpdates[0]).not.toHaveProperty('is_published')
  })
})
