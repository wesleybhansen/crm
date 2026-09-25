import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { requireProcessAuth } from '../../../../../../lib/cron-auth'
import { drainOutboundEvents } from '../../../../lib/outbound-events'

/*
 * Box-cron endpoint (same SEQUENCE_PROCESS_SECRET as the other /root/crm-cron
 * jobs): delivers the cross-app event outbox, today closed deals to the
 * marketing app. The subscriber already tries each event once as it happens;
 * this pass is the retry path, so a slow or down AMS only delays delivery.
 * Suggested cadence: every 5 minutes.
 */
export const metadata = {
  path: '/internal/outbound-events/drain',
  POST: { requireAuth: false },
}

export async function POST(req: Request) {
  const denied = requireProcessAuth(req, process.env.SEQUENCE_PROCESS_SECRET)
  if (denied) return denied
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const result = await drainOutboundEvents(em.getKnex(), { limit: 50, em })
    return NextResponse.json({ ok: true, data: result })
  } catch (error) {
    console.error('[internal.outbound-events.drain]', error)
    return NextResponse.json({ ok: false, error: 'Failed to deliver outbound events' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Integrations',
  summary: 'Deliver the cross-app event outbox',
  methods: {
    POST: { summary: 'Cron: deliver due outbound events (closed deals to the marketing app) with retry and backoff', tags: ['Integrations'] },
  },
}
