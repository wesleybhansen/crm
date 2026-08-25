/** @jest-environment node */

const mockGetAuthFromCookies = jest.fn()
const mockCreateRequestContainer = jest.fn()
const mockFindOne = jest.fn()

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromCookies: (...args: unknown[]) => mockGetAuthFromCookies(...args),
}))

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: (...args: unknown[]) => mockCreateRequestContainer(...args),
}))

import { GET } from '../route'

const orgId = '11111111-1111-4111-8111-111111111111'
const tenantId = '22222222-2222-4222-8222-222222222222'

describe('CRM onboarding first-value route', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthFromCookies.mockResolvedValue({ orgId, tenantId })
    mockCreateRequestContainer.mockResolvedValue({
      resolve: () => ({ fork: () => ({ findOne: mockFindOne }) }),
    })
  })

  it('requires both organization and tenant identity before reading', async () => {
    mockGetAuthFromCookies.mockResolvedValue({ orgId })
    const response = await GET()
    expect(response.status).toBe(401)
    expect(mockCreateRequestContainer).not.toHaveBeenCalled()
  })

  it('queries the seeded draft with exact tenant isolation and returns safe plain text', async () => {
    mockFindOne.mockResolvedValue({
      id: '33333333-3333-4333-8333-333333333333',
      subject: 'A useful follow-up',
      bodyHtml: '<p>Hello &amp; welcome.</p><p>How can we help?<br>Reply here.</p>',
    })

    const response = await GET()
    expect(response.status).toBe(200)
    expect(mockFindOne).toHaveBeenCalledWith(expect.any(Function), {
      organizationId: orgId,
      tenantId,
      name: 'Follow-up: new inquiry (drafted by your Noli team)',
      deletedAt: null,
    })
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: {
        kind: 'follow_up_draft',
        ready: true,
        id: '33333333-3333-4333-8333-333333333333',
        subject: 'A useful follow-up',
        body: 'Hello & welcome.\n\nHow can we help?\nReply here.',
      },
    })
  })

  it('returns a truthful empty result when onboarding did not create a draft', async () => {
    mockFindOne.mockResolvedValue(null)
    const response = await GET()
    await expect(response.json()).resolves.toEqual({ ok: true, data: null })
  })
})
