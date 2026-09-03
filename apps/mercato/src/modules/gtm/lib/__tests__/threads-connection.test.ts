import { generateDek } from '@open-mercato/shared/lib/encryption/aes'
import {
  THREADS_QUERY_BUDGET_PER_WINDOW,
  THREADS_REFRESH_TOKEN_URL,
  createThreadsConnectionAccess,
  exchangeThreadsCode,
  exchangeThreadsLongLivedToken,
  openThreadsToken,
  queryWindowState,
  refreshThreadsToken,
  sealThreadsToken,
  shouldRefreshThreadsToken,
  threadsAppConfig,
  threadsAuthorizeUrl,
  type ThreadsConnectionEm,
} from '../adapters/threads/connection'
import {
  THREADS_OAUTH_STATE_KIND,
  isThreadsOAuthState,
  returnWithOutcome,
  threadsCallbackUrl,
  validatedReturnTo,
} from '../social/threads-oauth'
import type { GtmSocialConnection } from '../../data/entities'

const NOW = new Date('2026-09-02T18:00:00.000Z')

function row(overrides: Partial<GtmSocialConnection> = {}): GtmSocialConnection {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    organizationId: 'org',
    tenantId: 'tenant',
    userId: 'user',
    provider: 'threads',
    providerUserId: '99001',
    username: 'noli_customer',
    displayName: 'Noli Customer',
    accessTokenSealed: '',
    tokenIssuedAt: new Date('2026-08-01T00:00:00.000Z'),
    tokenExpiresAt: new Date('2026-09-30T00:00:00.000Z'),
    lastRefreshedAt: null,
    scopes: ['threads_basic', 'threads_keyword_search'],
    status: 'active',
    statusReason: null,
    queryWindowStartedAt: null,
    queriesInWindow: 0,
    lastUsedAt: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  } as GtmSocialConnection
}

function fakeEm(): ThreadsConnectionEm & { flushes: number } {
  return {
    flushes: 0,
    async findOne() { return null },
    async find() { return [] },
    persist() { return undefined },
    async flush() { this.flushes += 1 },
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('Threads OAuth connection helpers', () => {
  it('builds the Meta authorization URL with both required scopes', () => {
    expect(threadsAppConfig({ GTM_THREADS_APP_ID: '1234567890', GTM_THREADS_APP_SECRET: 's' })).toEqual({ appId: '1234567890', appSecret: 's' })
    expect(threadsAppConfig({ GTM_THREADS_APP_ID: 'not-numeric', GTM_THREADS_APP_SECRET: 's' })).toBeNull()
    const url = new URL(threadsAuthorizeUrl({ appId: '1234567890', redirectUri: 'https://crm.noliai.com/api/gtm/threads/callback', state: 'abc.def' }))
    expect(url.origin + url.pathname).toBe('https://threads.net/oauth/authorize')
    expect(url.searchParams.get('scope')).toBe('threads_basic,threads_keyword_search')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('state')).toBe('abc.def')
    expect(threadsCallbackUrl({ GTM_PUBLIC_BASE_URL: 'https://crm.noliai.com/' })).toBe('https://crm.noliai.com/api/gtm/threads/callback')
  })

  it('only returns the browser to an owned Noli https destination', () => {
    expect(validatedReturnTo('https://app.noliai.com/dashboard/gtm#setup', { NODE_ENV: 'production' })).toBe('https://app.noliai.com/dashboard/gtm#setup')
    expect(validatedReturnTo('https://evil.example.com/dashboard', { NODE_ENV: 'production' })).toBeNull()
    expect(validatedReturnTo('http://app.noliai.com/dashboard', { NODE_ENV: 'production' })).toBeNull()
    expect(validatedReturnTo('https://noliai.com.evil.com/', { NODE_ENV: 'production' })).toBeNull()
    expect(validatedReturnTo('http://localhost:3100/dashboard/gtm', { NODE_ENV: 'production' })).toBeNull()
    expect(validatedReturnTo('http://localhost:3100/dashboard/gtm', { NODE_ENV: 'development' })).toBe('http://localhost:3100/dashboard/gtm')
    expect(returnWithOutcome('https://app.noliai.com/dashboard/gtm#setup', 'error', 'declined')).toBe('https://app.noliai.com/dashboard/gtm?threads=error&threads_detail=declined#setup')
    expect(isThreadsOAuthState({ kind: THREADS_OAUTH_STATE_KIND, organizationId: 'o', tenantId: 't', userId: 'u', returnTo: 'https://x', nonce: 'n' })).toBe(true)
    expect(isThreadsOAuthState({ kind: 'other', organizationId: 'o', tenantId: 't', userId: 'u', returnTo: 'https://x', nonce: 'n' })).toBe(false)
    expect(isThreadsOAuthState({ kind: THREADS_OAUTH_STATE_KIND, organizationId: 'o' })).toBe(false)
  })

  it('exchanges codes and long-lived tokens through the documented endpoints', async () => {
    const calls: string[] = []
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input)
      calls.push(url)
      if (url === 'https://graph.threads.net/oauth/access_token') {
        const body = init.body as URLSearchParams
        expect(body.get('grant_type')).toBe('authorization_code')
        expect(body.get('code')).toBe('code-1')
        return jsonResponse({ access_token: 'short', user_id: 99001 })
      }
      if (url.startsWith('https://graph.threads.net/access_token?')) {
        expect(url).toContain('grant_type=th_exchange_token')
        return jsonResponse({ access_token: 'long', token_type: 'bearer', expires_in: 5_183_944 })
      }
      if (url.startsWith(THREADS_REFRESH_TOKEN_URL)) {
        expect(url).toContain('grant_type=th_refresh_token')
        return jsonResponse({ access_token: 'refreshed', token_type: 'bearer', expires_in: 5_183_944 })
      }
      throw new Error(`unexpected ${url}`)
    }) as typeof fetch
    const config = { appId: '1234567890', appSecret: 'secret' }
    await expect(exchangeThreadsCode(config, { code: 'code-1', redirectUri: 'https://crm/cb' }, fetchImpl)).resolves.toEqual({ accessToken: 'short', userId: '99001' })
    await expect(exchangeThreadsLongLivedToken(config, 'short', fetchImpl)).resolves.toEqual({ accessToken: 'long', expiresInSeconds: 5_183_944 })
    await expect(refreshThreadsToken('long', fetchImpl)).resolves.toEqual({ accessToken: 'refreshed', expiresInSeconds: 5_183_944 })
    expect(calls).toHaveLength(3)
    const rejecting = (async () => jsonResponse({ error: { code: 190, message: 'expired' } }, 400)) as typeof fetch
    await expect(refreshThreadsToken('dead', rejecting)).rejects.toMatchObject({ code: 'token_invalid' })
  })

  it('seals tokens under the tenant DEK and never stores them in the clear', () => {
    const dek = generateDek()
    const sealed = sealThreadsToken('THAA-long-lived-token', dek)
    expect(sealed).not.toContain('long-lived')
    expect(openThreadsToken(sealed, dek)).toBe('THAA-long-lived-token')
    expect(() => openThreadsToken(sealed, generateDek())).toThrow()
  })

  it('tracks a rolling 24-hour query window below the provider allowance', async () => {
    const fresh = queryWindowState(row(), NOW)
    expect(fresh).toMatchObject({ used: 0, remaining: THREADS_QUERY_BUDGET_PER_WINDOW })
    const inWindow = queryWindowState(row({ queryWindowStartedAt: new Date(NOW.getTime() - 3_600_000), queriesInWindow: 1_999 }), NOW)
    expect(inWindow.remaining).toBe(1)
    const rolled = queryWindowState(row({ queryWindowStartedAt: new Date(NOW.getTime() - 25 * 3_600_000), queriesInWindow: 2_000 }), NOW)
    expect(rolled).toMatchObject({ used: 0, remaining: THREADS_QUERY_BUDGET_PER_WINDOW, windowStartedAt: NOW })

    const em = fakeEm()
    const connection = row({ queryWindowStartedAt: new Date(NOW.getTime() - 3_600_000), queriesInWindow: 1_999, accessTokenSealed: sealThreadsToken('tok', generateDek()) })
    const access = createThreadsConnectionAccess(em, connection, { dekKey: generateDek(), now: () => NOW })
    expect(access.remainingQueries()).toBe(1)
    expect(await access.reserveQuery()).toBe(true)
    expect(await access.reserveQuery()).toBe(false)
    expect(connection.queriesInWindow).toBe(2_000)
    expect(em.flushes).toBe(1)
  })

  it('refreshes only tokens that are older than a day and nearing expiry, and parks rejected ones', async () => {
    expect(shouldRefreshThreadsToken(row(), NOW)).toBe(false) // 28 days left
    expect(shouldRefreshThreadsToken(row({ tokenExpiresAt: new Date(NOW.getTime() + 5 * 86_400_000) }), NOW)).toBe(true)
    expect(shouldRefreshThreadsToken(row({ tokenIssuedAt: new Date(NOW.getTime() - 3_600_000), tokenExpiresAt: new Date(NOW.getTime() + 5 * 86_400_000) }), NOW)).toBe(false)
    expect(shouldRefreshThreadsToken(row({ tokenExpiresAt: new Date(NOW.getTime() - 1) }), NOW)).toBe(false)

    const dek = generateDek()
    const em = fakeEm()
    const expiring = row({ accessTokenSealed: sealThreadsToken('old-token', dek), tokenExpiresAt: new Date(NOW.getTime() + 5 * 86_400_000) })
    const refreshing = createThreadsConnectionAccess(em, expiring, {
      dekKey: dek,
      now: () => NOW,
      fetchImpl: (async () => jsonResponse({ access_token: 'new-token', expires_in: 5_183_944 })) as typeof fetch,
    })
    expect(await refreshing.getAccessToken()).toBe('new-token')
    expect(openThreadsToken(expiring.accessTokenSealed, dek)).toBe('new-token')
    expect(expiring.lastRefreshedAt).toEqual(NOW)

    const rejected = row({ accessTokenSealed: sealThreadsToken('dead-token', dek), tokenExpiresAt: new Date(NOW.getTime() + 5 * 86_400_000) })
    const parking = createThreadsConnectionAccess(fakeEm(), rejected, {
      dekKey: dek,
      now: () => NOW,
      fetchImpl: (async () => jsonResponse({ error: { code: 190 } }, 400)) as typeof fetch,
    })
    await expect(parking.getAccessToken()).rejects.toMatchObject({ code: 'token_invalid' })
    expect(rejected.status).toBe('reauth_required')

    const transient = row({ accessTokenSealed: sealThreadsToken('still-valid', dek), tokenExpiresAt: new Date(NOW.getTime() + 5 * 86_400_000) })
    const tolerant = createThreadsConnectionAccess(fakeEm(), transient, {
      dekKey: dek,
      now: () => NOW,
      fetchImpl: (async () => new Response('', { status: 503 })) as typeof fetch,
    })
    expect(await tolerant.getAccessToken()).toBe('still-valid')
    expect(transient.status).toBe('active')

    const expired = row({ accessTokenSealed: sealThreadsToken('expired', dek), tokenExpiresAt: new Date(NOW.getTime() - 1) })
    const dead = createThreadsConnectionAccess(fakeEm(), expired, { dekKey: dek, now: () => NOW })
    await expect(dead.getAccessToken()).rejects.toMatchObject({ code: 'token_invalid' })
    expect(expired.status).toBe('reauth_required')
  })
})
