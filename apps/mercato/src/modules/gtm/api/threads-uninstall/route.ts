import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { THREADS_PROVIDER, threadsAppConfig } from '../../lib/adapters/threads/connection'
import { parseThreadsSignedRequest } from '../../lib/social/threads-callbacks'

export const openApi: OpenApiRouteDoc = {
  tag: 'GTM Sources',
  summary: 'Meta Threads app uninstall callback',
  methods: { POST: { summary: 'Threads uninstall callback', tags: ['GTM Sources'] } },
}

/*
 * Meta calls this when a user removes the Noli app from their Threads
 * account. The only trusted input is the HMAC-signed request under the app
 * secret; on a valid signature every connection for that Threads user id is
 * disconnected and its sealed token is dropped. Always answers 200 on a
 * verified request (Meta retries otherwise) and 400 on anything unverified.
 */
export const metadata = {
  path: '/gtm/threads/uninstall',
  POST: { requireAuth: false },
}

export async function readSignedRequest(req: Request): Promise<unknown> {
  const contentType = req.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    const body = await req.json().catch(() => null) as { signed_request?: unknown } | null
    return body?.signed_request
  }
  const form = await req.formData().catch(() => null)
  return form?.get('signed_request') ?? null
}

export async function disconnectThreadsUser(
  em: EntityManager,
  providerUserId: string,
  reason: string,
): Promise<number> {
  const { GtmSocialConnection } = await import('../../data/entities')
  const rows = await em.find(GtmSocialConnection, { provider: THREADS_PROVIDER, providerUserId })
  const now = new Date()
  for (const row of rows) {
    row.status = 'disconnected'
    row.statusReason = reason
    row.accessTokenSealed = ''
    row.deletedAt = row.deletedAt ?? now
    em.persist(row)
  }
  if (rows.length > 0) await em.flush()
  return rows.length
}

export async function POST(req: Request) {
  const app = threadsAppConfig()
  if (!app) return NextResponse.json({ ok: false, error: 'Not configured' }, { status: 503 })
  const parsed = parseThreadsSignedRequest(await readSignedRequest(req), app.appSecret)
  if (!parsed) return NextResponse.json({ ok: false, error: 'Invalid signed request' }, { status: 400 })
  try {
    const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const disconnected = await disconnectThreadsUser(em, parsed.userId, 'meta_uninstall_callback')
    return NextResponse.json({ ok: true, disconnected })
  } catch (error) {
    console.error('[gtm.threads.uninstall] failed', error)
    return NextResponse.json({ ok: false, error: 'Internal error' }, { status: 500 })
  }
}
