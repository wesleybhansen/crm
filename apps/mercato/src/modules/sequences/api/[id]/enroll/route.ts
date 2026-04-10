export const metadata = { POST: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

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
      .whereNull('deleted_at')
      .first()

    if (!sequence) return NextResponse.json({ ok: false, error: 'Sequence not found' }, { status: 404 })
    if (sequence.status !== 'active') {
      return NextResponse.json({ ok: false, error: 'Sequence must be active to enroll contacts' }, { status: 400 })
    }

    const contact = await knex('customer_entities')
      .where('id', contactId)
      .where('organization_id', auth.orgId)
      .first()

    if (!contact) return NextResponse.json({ ok: false, error: 'Contact not found' }, { status: 404 })

    const existingEnrollment = await knex('sequence_enrollments')
      .where('sequence_id', params.id)
      .where('contact_id', contactId)
      .whereIn('status', ['active'])
      .first()

    if (existingEnrollment) {
      return NextResponse.json({ ok: false, error: 'Contact is already enrolled in this sequence' }, { status: 409 })
    }

    const enrollmentId = require('crypto').randomUUID()
    const now = new Date()

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
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Sequences', summary: 'Enroll contact',
  methods: { POST: { summary: 'Enroll a contact in a sequence', tags: ['Sequences'] } },
}
