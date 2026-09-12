/** @jest-environment node */

const mockCreateRequestContainer = jest.fn()
const mockSetupInitialTenant = jest.fn()
const mockFindUserByEmail = jest.fn()
const mockGetUserRoles = jest.fn()
const mockUpdateLastLoginAt = jest.fn()
const mockEmFindOne = jest.fn()
const mockPersistAndFlush = jest.fn()

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: (...args: unknown[]) => mockCreateRequestContainer(...args),
}))
jest.mock('@open-mercato/core/modules/auth/lib/setup-app', () => ({
  setupInitialTenant: (...args: unknown[]) => mockSetupInitialTenant(...args),
}))
jest.mock('@open-mercato/core/modules/auth/services/authService', () => ({ AuthService: class {} }))
jest.mock('@open-mercato/core/modules/auth/data/entities', () => ({ User: class User {} }))
jest.mock('@open-mercato/shared/lib/modules/registry', () => ({ getModules: () => [] }))
jest.mock('@open-mercato/shared/lib/auth/jwt', () => ({ signJwt: () => 'signed-jwt' }))

import { NextRequest } from 'next/server'
import { GET } from '../route'

const CLIENT_ID = 'test-client-id'
const BASE = 'https://crm.example.com'
const originalEnv = process.env
const originalFetch = global.fetch

function b64url(obj: unknown) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url')
}

function idTokenFor(email: string, sub = 'google-sub-1') {
  const header = b64url({ alg: 'RS256', typ: 'JWT' })
  const payload = b64url({
    sub,
    email,
    email_verified: true,
    name: 'New Person',
    aud: CLIENT_ID,
    iss: 'https://accounts.google.com',
  })
  return `${header}.${payload}.sig`
}

function makeRequest() {
  const req = new NextRequest(`${BASE}/api/auth/google/callback?code=abc&state=st4te`, {
    headers: { cookie: 'google_auth_state=st4te; google_auth_verifier=v3rifier' },
  })
  return req
}

beforeEach(() => {
  jest.clearAllMocks()
  process.env = {
    ...originalEnv,
    GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
    APP_URL: BASE,
  }
  delete process.env.SIGNUP_INVITED_EMAILS
  mockCreateRequestContainer.mockResolvedValue({
    resolve: (name: string) => {
      if (name === 'em') return { findOne: mockEmFindOne, persistAndFlush: mockPersistAndFlush }
      if (name === 'authService') {
        return {
          findUserByEmail: mockFindUserByEmail,
          getUserRoles: mockGetUserRoles,
          updateLastLoginAt: mockUpdateLastLoginAt,
        }
      }
      throw new Error(`unexpected resolve: ${name}`)
    },
  })
  mockGetUserRoles.mockResolvedValue(['admin'])
  mockUpdateLastLoginAt.mockResolvedValue(undefined)
  mockPersistAndFlush.mockResolvedValue(undefined)
})

afterAll(() => {
  process.env = originalEnv
  global.fetch = originalFetch
})

function stubGoogleTokenExchange(email: string) {
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({ id_token: idTokenFor(email) }),
    text: async () => '',
  })) as unknown as typeof fetch
}

describe('GET /api/auth/google/callback invite gate', () => {
  it('rejects a brand-new Google identity with no invitation using the email sign-up message', async () => {
    stubGoogleTokenExchange('stranger@example.com')
    mockEmFindOne.mockResolvedValue(null)
    mockFindUserByEmail.mockResolvedValue(null)

    const res = await GET(makeRequest())

    expect(res.status).toBe(307)
    const location = new URL(res.headers.get('location') || '')
    expect(location.pathname).toBe('/login')
    expect(location.searchParams.get('error')).toBe('Signups are currently invite-only. Contact us for access.')
    expect(mockSetupInitialTenant).not.toHaveBeenCalled()
    expect(res.cookies.get('auth_token')).toBeUndefined()
  })

  it('creates the workspace for a new Google identity that holds an invitation', async () => {
    process.env.SIGNUP_INVITED_EMAILS = 'invited@example.com'
    stubGoogleTokenExchange('Invited@Example.com')
    mockEmFindOne.mockResolvedValue(null)
    mockFindUserByEmail.mockResolvedValue(null)
    const createdUser = { id: 'u1', tenantId: 't1', organizationId: 'o1', googleSub: null as string | null }
    mockSetupInitialTenant.mockResolvedValue({
      tenantId: 't1',
      organizationId: 'o1',
      users: [{ user: createdUser, roles: ['admin'] }],
    })

    const res = await GET(makeRequest())

    expect(mockSetupInitialTenant).toHaveBeenCalledTimes(1)
    expect(mockSetupInitialTenant.mock.calls[0][1].primaryUser.email).toBe('invited@example.com')
    expect(createdUser.googleSub).toBe('google-sub-1')
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe(`${BASE}/backend/welcome`)
    expect(res.cookies.get('auth_token')?.value).toBe('signed-jwt')
  })

  it('signs an existing user in unchanged, even without an invitation', async () => {
    stubGoogleTokenExchange('existing@example.com')
    const existing = { id: 'u2', tenantId: 't1', organizationId: 'o1', isConfirmed: true, googleSub: null as string | null }
    mockEmFindOne.mockResolvedValue(null) // no googleSub match yet
    mockFindUserByEmail.mockResolvedValue(existing) // but the email exists

    const res = await GET(makeRequest())

    expect(mockSetupInitialTenant).not.toHaveBeenCalled()
    expect(existing.googleSub).toBe('google-sub-1')
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe(`${BASE}/backend`)
    expect(res.cookies.get('auth_token')?.value).toBe('signed-jwt')
  })
})
