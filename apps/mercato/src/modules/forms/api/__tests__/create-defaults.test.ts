/** @jest-environment node */

const mockCreateRequestContainer = jest.fn()
const inserts: Array<Record<string, any>> = []
const updates: Array<Record<string, any>> = []

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: (...args: unknown[]) => mockCreateRequestContainer(...args),
}))
jest.mock('@/lib/public-slug', () => ({
  uniquePublicSlug: async (_knex: unknown, _table: string, base: string) => base,
  isPublicSlugTaken: async () => false,
}))

import { POST, PUT } from '../route'

function createKnex() {
  return (table: string) => {
    const q: any = {
      where: () => q,
      first: async () => (table === 'forms' ? { id: 'form-1', slug: 'old', status: 'draft', name: 'Old', settings: {} } : undefined),
      insert: async (row: Record<string, any>) => { inserts.push(row) },
      update: async (row: Record<string, any>) => { updates.push(row); return 1 },
    }
    return q
  }
}

const ctx = { auth: { tenantId: 't-1', orgId: 'o-1', sub: 'u-1' } }
const post = (body: unknown) => POST(new Request('http://x/api/forms', { method: 'POST', body: JSON.stringify(body) }), ctx)
const emailField = { id: 'f1', type: 'email', label: 'Email', crm_mapping: 'contact.email' }

beforeEach(() => {
  inserts.length = 0
  updates.length = 0
  mockCreateRequestContainer.mockResolvedValue({ resolve: () => ({ getKnex: () => createKnex() }) })
})

describe('POST /api/forms new-form defaults', () => {
  it('creates a form that captures an email with contact creation ON (e.g. the AI assistant create_form)', async () => {
    const res = await post({ name: 'Sign up', fields: [emailField] })
    expect(res.status).toBe(201)
    expect(JSON.parse(inserts[0].settings)).toEqual({ createContact: true })
    expect(inserts[0].tenant_id).toBe('t-1')
    expect(inserts[0].organization_id).toBe('o-1')
  })

  it('keeps an explicit OFF', async () => {
    await post({ name: 'Sign up', fields: [emailField], settings: { createContact: false, submitLabel: 'Go' } })
    expect(JSON.parse(inserts[0].settings)).toEqual({ createContact: false, submitLabel: 'Go' })
  })

  it('leaves a form with no email field unchanged', async () => {
    await post({ name: 'Survey', fields: [{ id: 'r', type: 'rating', label: 'Stars' }] })
    expect(JSON.parse(inserts[0].settings)).toEqual({})
  })
})

describe('PUT /api/forms does not apply new-form defaults', () => {
  it('stores the settings exactly as sent, so existing forms keep their setting', async () => {
    const res = await PUT(new Request('http://x/api/forms', {
      method: 'PUT',
      body: JSON.stringify({ id: 'form-1', fields: [emailField], settings: { submitLabel: 'Go' } }),
    }), ctx)
    expect(res.status).toBe(200)
    expect(JSON.parse(updates[0].settings)).toEqual({ submitLabel: 'Go' })
  })
})
