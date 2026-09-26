export const metadata = { POST: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { processScheduledSteps } from '@/modules/sequences/lib/automation-execute'

export async function POST() {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // A signed-in user runs their own organization's due steps only; the box
    // cron runs everyone's through run-scheduled with the service token.
    const result = await processScheduledSteps(knex, { organizationId: auth.orgId })

    return NextResponse.json({ ok: true, data: result })
  } catch (error) {
    console.error('[automation-rules] process-scheduled error', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Automation Rules',
  summary: 'Process due scheduled automation steps',
  methods: {
    POST: { summary: 'Execute any pending scheduled automation steps that are past their execute_at time', tags: ['Automation Rules'] },
  },
}
