export const metadata = { GET: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { decryptRowFields, CONTACT_ENTITY_KEY } from '@open-mercato/shared/lib/encryption/decryptRows'

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()

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
        // Named as the sequences page reads them (it showed "Unknown" when these
        // came back as contact_name/contact_email).
        'ce.display_name as display_name',
        'ce.primary_email as primary_email',
        // Why an active enrollment is not moving: set by the sequence processor
        // when a due email step found no sending setup (lib/email-step.ts).
        knex.raw(
          "(SELECT sse.result->>'reason' FROM sequence_step_executions sse"
          + " WHERE sse.enrollment_id = se.id AND sse.status = 'scheduled'"
          + " AND sse.result->>'waiting' IS NOT NULL"
          + ' ORDER BY sse.created_at DESC LIMIT 1) as waiting_reason',
        ),
        // The latest step that was skipped with a reason (a Send SMS step with
        // no Twilio connected, or no mobile number): the enrollment moved on,
        // and this says what did not go out.
        knex.raw(
          "(SELECT sse.result->>'reason' FROM sequence_step_executions sse"
          + " WHERE sse.enrollment_id = se.id AND sse.status = 'skipped'"
          + " AND sse.result->>'skipped' = 'true'"
          + ' ORDER BY sse.executed_at DESC NULLS LAST LIMIT 1) as skipped_reason',
        ),
      )
      .orderBy('se.enrolled_at', 'desc')

    // Raw knex skips the decrypting subscriber: without this the list shows
    // ciphertext for encrypted contacts.
    await decryptRowFields(em, CONTACT_ENTITY_KEY, enrollments, ['display_name', 'primary_email'], auth.tenantId ?? null, auth.orgId)

    return NextResponse.json({ ok: true, data: enrollments })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Sequences', summary: 'Sequence enrollments',
  methods: { GET: { summary: 'List enrollments for a sequence', tags: ['Sequences'] } },
}
