import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { internalServiceBearerAuthorized } from '../../../../lib/authorize'
import { gtmEnabled } from '../../../../lib/flags'
import { gtmPlayNameBackfillBodySchema } from '../../../../data/validators'
import { gtmInternalOpenApi } from '../../../openapi'

export const openApi = gtmInternalOpenApi('Backfill short names onto GTM plays')

/*
 * Service-only play name backfill. Unlike the represented-user GTM routes
 * this carries no noliUserId: it is an operator process, proven by the
 * shared NOLI_INTERNAL_SERVICE_SECRET (same helper as /internal/gtm/plays),
 * that walks live plays with a null name across organizations and assigns
 * one to each.
 *
 * Body: { dryRun?: boolean (default false), limit?: number (1..500, default
 * 50) }. Response: { ok, dry_run, considered, named, failed, sample } where
 * sample holds at most 10 { id, name } pairs and no audience text.
 *
 * dryRun computes the deterministic fallback names only: no model call, no
 * metering, no write. A live run meters each model call against the play's
 * own organization under feature 'gtm-play-name' through the same canonical
 * usage path the strategist uses, with the deterministic fallback when the
 * org has no AI allowance or the call fails.
 *
 * Public at the dispatcher level (requireAuth: false) - authenticated by the
 * shared secret, mirroring internal/gtm/retention.
 */
export const metadata = {
  path: '/internal/gtm/plays/name-backfill',
  POST: { requireAuth: false },
}

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(req: Request) {
  if (!gtmEnabled()) {
    return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
  }
  if (!internalServiceBearerAuthorized(req)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const raw = await req.json().catch(() => ({}))
  const parsed = gtmPlayNameBackfillBodySchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const where = first?.path?.length ? `${first.path.join('.')}: ` : ''
    return NextResponse.json({ ok: false, error: `${where}${first?.message ?? 'Invalid body'}` }, { status: 400 })
  }
  const { dryRun, limit } = parsed.data

  try {
    const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const { backfillPlayNames } = await import('../../../../lib/play-name-backfill')
    const { createPlayNamer } = await import('../../../../lib/play-name-runtime')
    const requestId = req.headers.get('x-request-id')

    const result = await backfillPlayNames(
      em,
      { dryRun, limit },
      dryRun
        ? async () => null
        : async (play) => createPlayNamer(
            em,
            { organizationId: play.organizationId, tenantId: play.tenantId, requestId: requestId || null },
            null,
          ),
    )
    return NextResponse.json({ ok: true, dry_run: dryRun, ...result })
  } catch (err) {
    console.error('[internal.gtm.plays.name-backfill]', err instanceof Error ? err.message : err)
    return NextResponse.json({ ok: false, error: 'Play name backfill failed' }, { status: 500 })
  }
}
