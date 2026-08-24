import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { requireProcessAuth } from '@/lib/cron-auth'

export const metadata = {
  path: '/internal/gtm/retention',
  POST: { requireAuth: false },
}

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/** Service-only global retention sweep. Unlike represented-user GTM routes,
 * this is a scheduled compliance operation with no customer actor. It uses
 * the same fail-closed shared secret as the box's other process routes and
 * never accepts an organization or retention cutoff from the caller. */
export async function POST(req: Request) {
  const denied = requireProcessAuth(req, process.env.NOLI_INTERNAL_SERVICE_SECRET)
  if (denied) return denied

  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const { sweepExpiredCandidates } = await import('../../../lib/retention/sweep')
    const sweep = await sweepExpiredCandidates(
      em as unknown as import('../../../lib/retention/sweep').RetentionEm,
    )
    return NextResponse.json({ ok: true, sweep })
  } catch (error) {
    console.error('[internal.gtm.retention]', error instanceof Error ? error.message : 'failed')
    return NextResponse.json({ ok: false, error: 'Retention sweep failed' }, { status: 500 })
  }
}
