export const metadata = { GET: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const sequence = await knex('sequences')
      .where('id', params.id)
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .first()

    if (!sequence) return NextResponse.json({ ok: false, error: 'Sequence not found' }, { status: 404 })

    const enrollments = await knex('sequence_enrollments as se')
      .leftJoin('customer_entities as ce', 'ce.id', 'se.contact_id')
      .where('se.sequence_id', params.id)
      .select(
        'se.id',
        'se.contact_id',
        'se.status',
        'se.current_step_order',
        'se.enrolled_at',
        'se.completed_at',
        'ce.display_name as contact_name',
        'ce.primary_email as contact_email',
        // Why an active enrollment is not moving: set by the sequence processor
        // when a due email step found no sending setup (lib/email-step.ts).
        knex.raw(
          "(SELECT sse.result->>'reason' FROM sequence_step_executions sse"
          + " WHERE sse.enrollment_id = se.id AND sse.status = 'scheduled'"
          + " AND sse.result->>'waiting' IS NOT NULL"
          + ' ORDER BY sse.created_at DESC LIMIT 1) as waiting_reason',
        ),
      )
      .orderBy('se.enrolled_at', 'desc')

    return NextResponse.json({ ok: true, data: enrollments })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Sequences', summary: 'Sequence enrollments',
  methods: { GET: { summary: 'List enrollments for a sequence', tags: ['Sequences'] } },
}
