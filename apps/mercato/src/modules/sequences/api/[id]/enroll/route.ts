export const metadata = { POST: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { enrollmentBlockedReason } from '../../../lib/enrollment'
import { unsubscribedEnrollmentRefusal } from '../../../lib/enrollment-gate'

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { contactId } = body

    if (!contactId) {
      return NextResponse.json({ ok: false, error: 'contactId is required' }, { status: 400 })
    }

    const sequence = await knex('sequences')
      .where('id', params.id)
      .where('organization_id', auth.orgId)
      .where('tenant_id', auth.tenantId)
      .whereNull('deleted_at')
      .first()

    if (!sequence) return NextResponse.json({ ok: false, error: 'Sequence not found' }, { status: 404 })
    const notActive = enrollmentBlockedReason(sequence.status)
    if (notActive) {
      return NextResponse.json({ ok: false, code: 'sequence_not_active', error: notActive }, { status: 400 })
    }

    const contact = await knex('customer_entities')
      .where('id', contactId)
      .where('organization_id', auth.orgId)
      .where('tenant_id', auth.tenantId)
      .first('id')

    if (!contact) return NextResponse.json({ ok: false, error: 'Contact not found' }, { status: 404 })

    // Unsubscribed from this business's email: never enrolled (the page counts
    // these as "skipped because they unsubscribed").
    const refusal = await unsubscribedEnrollmentRefusal(knex, { organizationId: auth.orgId, tenantId: auth.tenantId }, contactId)
    if (refusal) {
      return NextResponse.json({ ok: false, code: refusal.code, error: refusal.reason }, { status: 409 })
    }

    const existingEnrollment = await knex('sequence_enrollments')
      .where('sequence_id', params.id)
      .where('contact_id', contactId)
      .where('organization_id', auth.orgId)
      .whereIn('status', ['active'])
      .first()

    if (existingEnrollment) {
      return NextResponse.json({ ok: false, error: 'Contact is already enrolled in this sequence' }, { status: 409 })
    }

    const enrollmentId = require('crypto').randomUUID()
    const now = new Date()

    try {
      await knex('sequence_enrollments').insert({
        id: enrollmentId,
        sequence_id: params.id,
        contact_id: contactId,
        organization_id: auth.orgId,
        tenant_id: auth.tenantId,
        status: 'active',
        current_step_order: 1,
        enrolled_at: now,
      })
    } catch (err) {
      // enrollments_seq_contact_idx: a concurrent request enrolled first.
      if ((err as { code?: string })?.code === '23505') {
        return NextResponse.json({ ok: false, error: 'Contact is already enrolled in this sequence' }, { status: 409 })
      }
      throw err
    }

    const firstStep = await knex('sequence_steps')
      .where('sequence_id', params.id)
      .where('step_order', 1)
      .first()

    if (firstStep) {
      let scheduledFor = now
      if (firstStep.step_type === 'wait') {
        const config = typeof firstStep.config === 'string' ? JSON.parse(firstStep.config) : firstStep.config
        if (config?.delay) {
          scheduledFor = new Date(now.getTime())
          if (config.unit === 'days') {
            scheduledFor.setTime(scheduledFor.getTime() + config.delay * 24 * 60 * 60 * 1000)
          } else {
            scheduledFor.setTime(scheduledFor.getTime() + config.delay * 60 * 60 * 1000)
          }
        }
      }

      await knex('sequence_step_executions').insert({
        id: require('crypto').randomUUID(),
        enrollment_id: enrollmentId,
        step_id: firstStep.id,
        status: 'scheduled',
        scheduled_for: scheduledFor,
        created_at: now,
      })
    }

    const enrollment = await knex('sequence_enrollments').where('id', enrollmentId).first()
    return NextResponse.json({ ok: true, data: enrollment }, { status: 201 })
  } catch (error) {
    console.error('[sequences.enroll] POST error', error)
    return NextResponse.json({ ok: false, error: 'Could not enroll this contact. Please try again.' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Sequences', summary: 'Enroll contact',
  methods: { POST: { summary: 'Enroll a contact in a sequence', tags: ['Sequences'] } },
}
