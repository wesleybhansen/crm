import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { threadsAppConfig } from '../../lib/adapters/threads/connection'
import {
  parseThreadsSignedRequest,
  threadsDeletionConfirmationCode,
} from '../../lib/social/threads-callbacks'
import { disconnectThreadsUser, readSignedRequest } from '../threads-uninstall/route'
import { threadsCallbackUrl } from '../../lib/social/threads-oauth'

export const openApi: OpenApiRouteDoc = {
  tag: 'GTM Sources',
  summary: 'Meta Threads data deletion callback',
  methods: { POST: { summary: 'Threads data deletion request', tags: ['GTM Sources'] } },
}

/*
 * Meta's Data Deletion Request callback. Same trust model as the uninstall
 * callback. Noli stores no Threads user content: the only per-user data is
 * the connection row (id, username, sealed token), which is disconnected and
 * scrubbed here. The response shape is what Meta requires: a status URL the
 * user can open and a confirmation code shown to them.
 */
export const metadata = {
  path: '/gtm/threads/delete',
  POST: { requireAuth: false },
}

export async function POST(req: Request) {
  const app = threadsAppConfig()
  if (!app) return NextResponse.json({ ok: false, error: 'Not configured' }, { status: 503 })
  const parsed = parseThreadsSignedRequest(await readSignedRequest(req), app.appSecret)
  if (!parsed) return NextResponse.json({ ok: false, error: 'Invalid signed request' }, { status: 400 })
  const receivedAt = new Date()
  const confirmationCode = threadsDeletionConfirmationCode(parsed.userId, receivedAt)
  try {
    const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const { GtmSocialConnection } = await import('../../data/entities')
    const rows = await em.find(GtmSocialConnection, { provider: 'threads', providerUserId: parsed.userId })
    await disconnectThreadsUser(em, parsed.userId, `meta_data_deletion:${confirmationCode}`)
    // Scrub the profile fields too; the row survives only as a deletion stub.
    for (const row of rows) {
      row.username = null
      row.displayName = null
      em.persist(row)
    }
    if (rows.length > 0) await em.flush()
    const base = threadsCallbackUrl().replace(/\/api\/gtm\/threads\/callback$/, '')
    return NextResponse.json({
      url: `${base}/api/gtm/threads/deletion-status?code=${confirmationCode}`,
      confirmation_code: confirmationCode,
    })
  } catch (error) {
    console.error('[gtm.threads.delete] failed', error)
    return NextResponse.json({ ok: false, error: 'Internal error' }, { status: 500 })
  }
}
