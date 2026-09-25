/** @jest-environment node */

const mockGetAuthFromCookies = jest.fn()
const mockCreateRequestContainer = jest.fn()
const mockFindOne = jest.fn()
const mockReadLaunchpadBriefing = jest.fn()

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromCookies: (...args: unknown[]) => mockGetAuthFromCookies(...args),
}))
jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: (...args: unknown[]) => mockCreateRequestContainer(...args),
}))
jest.mock('@open-mercato/core/modules/customers/data/entities', () => ({ CustomerBusinessProfile: class {} }))
jest.mock('@open-mercato/shared/lib/noli/core-client', () => ({ getNoliCoreClient: () => ({}) }))
jest.mock('../../../../lib/intake-gate', () => {
  const actual = jest.requireActual('../../../../lib/intake-gate')
  return { ...actual, readLaunchpadBriefing: (...args: unknown[]) => mockReadLaunchpadBriefing(...args) }
})

import { GET } from '../route'

const orgId = '11111111-1111-4111-8111-111111111111'
const tenantId = '22222222-2222-4222-8222-222222222222'

describe('CRM onboarding intake-gate route', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthFromCookies.mockResolvedValue({ orgId, tenantId, noliUserId: 'noli-1' })
    mockCreateRequestContainer.mockResolvedValue({ resolve: () => ({ fork: () => ({ findOne: mockFindOne }) }) })
  })

  it('requires organization and tenant identity', async () => {
    mockGetAuthFromCookies.mockResolvedValue({ orgId })
    const res = await GET()
    expect(res.status).toBe(401)
    expect(mockCreateRequestContainer).not.toHaveBeenCalled()
  })

  it('reads the profile for the caller organization only, and skips noli-core when onboarded', async () => {
    mockFindOne.mockResolvedValue({ onboardingComplete: true })
    const res = await GET()
    expect(mockFindOne).toHaveBeenCalledWith(expect.any(Function), { organizationId: orgId, tenantId })
    expect(mockReadLaunchpadBriefing).not.toHaveBeenCalled()
    await expect(res.json()).resolves.toEqual({ ok: true, data: { gate: 'dashboard' } })
  })

  it('answers awaiting_lab for a Launch Pad member before the Lab', async () => {
    mockFindOne.mockResolvedValue(null)
    mockReadLaunchpadBriefing.mockResolvedValue({ member: true, briefed: false })
    const res = await GET()
    expect(mockReadLaunchpadBriefing).toHaveBeenCalledWith(expect.anything(), 'noli-1')
    await expect(res.json()).resolves.toEqual({ ok: true, data: { gate: 'awaiting_lab' } })
  })

  it('falls back to the intake when the Launch Pad state cannot be read', async () => {
    mockFindOne.mockResolvedValue(null)
    mockReadLaunchpadBriefing.mockResolvedValue(null)
    const res = await GET()
    await expect(res.json()).resolves.toEqual({ ok: true, data: { gate: 'intake' } })
  })
})
