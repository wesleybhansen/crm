import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { verifyOAuthState } from '@/lib/oauth-state'
import { gtmEnabled } from '../../lib/flags'
import {
  THREADS_PROVIDER,
  ThreadsOAuthError,
  exchangeThreadsCode,
  exchangeThreadsLongLivedToken,
  fetchThreadsProfile,
  sealThreadsToken,
  threadsAppConfig,
} from '../../lib/adapters/threads/connection'
import { threadsConnectionEnabled } from '../../lib/adapters/threads/keyword-search-opportunity-source'
import {
  isThreadsOAuthState,
  returnWithOutcome,
  threadsCallbackUrl,
  validatedReturnTo,
} from '../../lib/social/threads-oauth'

export const openApi: OpenApiRouteDoc = {
  tag: 'GTM Sources',
  summary: 'Complete a customer Threads OAuth grant for GTM keyword search',
  methods: { GET: { summary: 'Threads OAuth callback', tags: ['GTM Sources'] } },
}

/*
 * Public Meta redirect target. Nothing here is trusted except the HMAC-signed
 * `state` minted by internal/gtm/social-connections (15-minute TTL): the
 * org/tenant/user that own the resulting connection come from that state,
 * never from the query string. The authorization code is exchanged, upgraded
 * to a 60-day token, sealed with the tenant DEK, and stored. The browser is
 * then sent back to the validated Noli return URL with an outcome flag only.
 */
export const metadata = {
  path: '/gtm/threads/callback',
  GET: { requireAuth: false },
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const stateRaw = url.searchParams.get('state')
  const parsedState = verifyOAuthState<Record<string, unknown>>(stateRaw)
  if (!parsedState || !isThreadsOAuthState(parsedState)) {
    return NextResponse.json({ ok: false, error: 'Invalid or expired connection state' }, { status: 400 })
  }
  const returnTo = validatedReturnTo(parsedState.returnTo)
  if (!returnTo) {
    return NextResponse.json({ ok: false, error: 'Invalid return destination' }, { status: 400 })
  }
  const back = (outcome: 'connected' | 'error', detail?: string) =>
    NextResponse.redirect(returnWithOutcome(returnTo, outcome, detail))

  if (!gtmEnabled() || !threadsConnectionEnabled()) return back('error', 'threads_disabled')
  const app = threadsAppConfig()
  if (!app) return back('error', 'not_configured')

  const providerError = url.searchParams.get('error')
  const code = url.searchParams.get('code')
  if (providerError || !code) {
    return back('error', providerError === 'access_denied' ? 'declined' : 'no_code')
  }

  try {
    const shortLived = await exchangeThreadsCode(app, { code, redirectUri: threadsCallbackUrl() })
    const longLived = await exchangeThreadsLongLivedToken(app, shortLived.accessToken)
    const profile = await fetchThreadsProfile(longLived.accessToken)
    if (profile.id !== shortLived.userId) return back('error', 'identity_mismatch')

    const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
    const container = await createRequestContainer()
    const encryption = container.resolve('tenantEncryptionService') as {
      isEnabled(): boolean
      getDek(tenantId: string): Promise<{ key: string } | null>
    } | null
    if (!encryption?.isEnabled()) return back('error', 'encryption_unavailable')
    const dek = await encryption.getDek(parsedState.tenantId)
    if (!dek?.key) return back('error', 'encryption_unavailable')

    const em = container.resolve('em') as EntityManager
    const { GtmSocialConnection } = await import('../../data/entities')
    const now = new Date()
    const sealed = sealThreadsToken(longLived.accessToken, dek.key)
    const expiresAt = new Date(now.getTime() + longLived.expiresInSeconds * 1_000)
    // The granted scope set is not echoed by Meta on the token response. It is
    // recorded as requested; a later 403/10 from keyword search marks the row.
    const scopes = ['threads_basic', 'threads_keyword_search']

    const existing = await em.findOne(GtmSocialConnection, {
      organizationId: parsedState.organizationId,
      tenantId: parsedState.tenantId,
      provider: THREADS_PROVIDER,
      providerUserId: profile.id,
    })
    if (existing) {
      existing.userId = parsedState.userId
      existing.username = profile.username
      existing.displayName = profile.name
      existing.accessTokenSealed = sealed
      existing.tokenIssuedAt = now
      existing.tokenExpiresAt = expiresAt
      existing.lastRefreshedAt = null
      existing.scopes = scopes
      existing.status = 'active'
      existing.statusReason = null
      existing.deletedAt = null
      await em.persistAndFlush(existing)
    } else {
      const row = em.create(GtmSocialConnection, {
        organizationId: parsedState.organizationId,
        tenantId: parsedState.tenantId,
        userId: parsedState.userId,
        provider: THREADS_PROVIDER,
        providerUserId: profile.id,
        username: profile.username,
        displayName: profile.name,
        accessTokenSealed: sealed,
        tokenIssuedAt: now,
        tokenExpiresAt: expiresAt,
        scopes,
        status: 'active',
        queriesInWindow: 0,
      })
      await em.persistAndFlush(row)
    }
    return back('connected')
  } catch (error) {
    const code = error instanceof ThreadsOAuthError ? error.code : 'unexpected'
    console.error('[gtm.threads.callback] connection failed', code)
    return back('error', code)
  }
}
