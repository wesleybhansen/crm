/** @jest-environment node */

/*
 * 2026-09-25 review, M4: installing an email-sending template inserted an
 * ACTIVE rule with no sending check, so every trigger failed. Without a way to
 * send it is installed paused, with a notice; with one it goes in active.
 */
const mockCreateRequestContainer = jest.fn()
const mockGetAuth = jest.fn()
const mockHasSendingSetup = jest.fn()
const inserts: Array<Record<string, unknown>> = []

function createKnex() {
  return () => {
    const q: any = {
      where: jest.fn(() => q),
      first: jest.fn(async () => inserts[inserts.length - 1]),
      insert: jest.fn(async (payload: Record<string, unknown>) => { inserts.push(payload) }),
    }
    return q
  }
}

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: (...args: unknown[]) => mockCreateRequestContainer(...args),
}))
jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromCookies: (...args: unknown[]) => mockGetAuth(...args),
}))
jest.mock('../../../../email/lib/routing-service', () => ({
  ...jest.requireActual('../../../../email/lib/routing-service'),
  hasSendingSetup: (...args: unknown[]) => mockHasSendingSetup(...args),
}))

import { POST } from '../templates/route'

function install(templateId: string) {
  return POST(new Request('https://crm.example.test/api/sequences/automation-rules/templates', {
    method: 'POST',
    body: JSON.stringify({ templateId }),
  }))
}

beforeEach(() => {
  jest.clearAllMocks()
  inserts.length = 0
  mockGetAuth.mockResolvedValue({ orgId: 'org-1', tenantId: 'tenant-1', sub: 'user-1' })
  mockCreateRequestContainer.mockResolvedValue({
    resolve: (name: string) => {
      if (name === 'em') return { getKnex: () => createKnex() }
      throw new Error(`unexpected resolve: ${name}`)
    },
  })
})

describe('automation templates: email templates respect the sending gate', () => {
  it('installs an email template paused, with a notice, when nothing can send', async () => {
    mockHasSendingSetup.mockResolvedValue(false)
    const res = await install('sales-new-lead-welcome')
    expect(res.status).toBe(201)
    expect(inserts[0]).toMatchObject({ status: 'paused', is_active: false })
    const body = await res.json()
    expect(body.code).toBe('email_not_connected')
    expect(body.notice).toMatch(/Installed paused/)
  })

  it('installs it active once an email account is connected', async () => {
    mockHasSendingSetup.mockResolvedValue(true)
    const res = await install('sales-new-lead-welcome')
    expect(res.status).toBe(201)
    expect(inserts[0]).toMatchObject({ status: 'active', is_active: true })
    expect((await res.json()).notice).toBeUndefined()
  })
})
