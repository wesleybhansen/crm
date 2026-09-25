import { AuthUnavailableError } from '../errors'

const clerkAuth = jest.fn()
jest.mock('@clerk/nextjs/server', () => ({ auth: () => clerkAuth() }), { virtual: true })

const resolveClerkUser = jest.fn()
jest.mock('../clerk', () => ({
  resolveClerkUserToAuthContext: (...args: unknown[]) => resolveClerkUser(...args),
}))

jest.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
}))

import { getAuthFromRequest, resolveAuthFromCookies, resolveAuthFromRequest } from '../server'

describe('auth resolution tells a sign-out apart from a temporary failure', () => {
  const originalKey = process.env.CLERK_SECRET_KEY
  beforeEach(() => {
    process.env.CLERK_SECRET_KEY = 'sk_test_x'
    clerkAuth.mockReset()
    resolveClerkUser.mockReset()
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    process.env.CLERK_SECRET_KEY = originalKey
    jest.restoreAllMocks()
  })

  const req = () => new Request('https://crm.example.test/api/x')

  it('is authenticated when the Clerk user resolves', async () => {
    clerkAuth.mockResolvedValue({ userId: 'user_1' })
    resolveClerkUser.mockResolvedValue({ sub: 'u1', tenantId: 't1', orgId: 'o1', roles: ['admin'] })
    const result = await resolveAuthFromRequest(req())
    expect(result.status).toBe('authenticated')
    expect(resolveClerkUser).toHaveBeenCalledWith('user_1', { throwOnUnavailable: true })
  })

  it('is unavailable (not signed out) when the lookup fails', async () => {
    clerkAuth.mockResolvedValue({ userId: 'user_1' })
    resolveClerkUser.mockRejectedValue(new AuthUnavailableError('db down'))
    expect((await resolveAuthFromRequest(req())).status).toBe('unavailable')
    expect((await resolveAuthFromCookies()).status).toBe('unavailable')
    // The legacy helper keeps its contract: null.
    expect(await getAuthFromRequest(req())).toBeNull()
  })

  it('is no-access when signed in to Noli without CRM access', async () => {
    clerkAuth.mockResolvedValue({ userId: 'user_1' })
    resolveClerkUser.mockResolvedValue(null)
    expect((await resolveAuthFromRequest(req())).status).toBe('no-access')
  })

  it('is unauthenticated with no Clerk session', async () => {
    clerkAuth.mockResolvedValue({ userId: null })
    expect((await resolveAuthFromRequest(req())).status).toBe('unauthenticated')
    expect(resolveClerkUser).not.toHaveBeenCalled()
  })
})
