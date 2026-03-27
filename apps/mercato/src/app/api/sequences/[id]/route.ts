import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

const VALID_TRIGGER_TYPES = ['form_submit', 'tag_added', 'deal_stage_changed', 'manual', 'booking_created', 'invoice_paid'] as const
const VALID_STEP_TYPES = ['email', 'sms', 'wait', 'condition'] as const

const VALID_STATUS_TRANSITIONS: Record<string, string[]> = {
  draft: ['active'],
  active: ['paused', 'archived'],
  paused: ['active', 'draft', 'archived'],
}

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

    const steps = await knex('sequence_steps')
      .where('sequence_id', params.id)
      .orderBy('step_order', 'asc')

    const [enrollmentStats] = await knex('sequence_enrollments')
      .where('sequence_id', params.id)
      .select(
        knex.raw('COUNT(*) as total'),
        knex.raw("COUNT(*) FILTER (WHERE status = 'active') as active"),
        knex.raw("COUNT(*) FILTER (WHERE status = 'completed') as completed"),
      )

    sequence.steps = steps
    sequence.enrollment_stats = {
      total: Number(enrollmentStats.total),
      active: Number(enrollmentStats.active),
      completed: Number(enrollmentStats.completed),
    }

    return NextResponse.json({ ok: true, data: sequence })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export async function PUT(req: Request, { params }: { params: { id: string } }) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { name, description, triggerType, triggerConfig, status, steps } = body

    const sequence = await knex('sequences')
      .where('id', params.id)
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .first()

    if (!sequence) return NextResponse.json({ ok: false, error: 'Sequence not found' }, { status: 404 })

    const isStatusOnlyUpdate = status && !name && !description && triggerType === undefined && triggerConfig === undefined && !steps

    if (!isStatusOnlyUpdate && sequence.status !== 'draft' && sequence.status !== 'paused') {
      return NextResponse.json({ ok: false, error: 'Can only edit sequences in draft or paused status' }, { status: 400 })
    }

    if (status && status !== sequence.status) {
      const allowed = VALID_STATUS_TRANSITIONS[sequence.status] || []
      if (status === 'archived') {
        // any status can go to archived
      } else if (!allowed.includes(status)) {
        return NextResponse.json({ ok: false, error: `Cannot transition from ${sequence.status} to ${status}` }, { status: 400 })
      }
    }

    if (triggerType && !VALID_TRIGGER_TYPES.includes(triggerType)) {
      return NextResponse.json({ ok: false, error: `triggerType must be one of: ${VALID_TRIGGER_TYPES.join(', ')}` }, { status: 400 })
    }

    const updates: Record<string, unknown> = { updated_at: new Date() }
    if (name !== undefined) updates.name = name
    if (description !== undefined) updates.description = description
    if (triggerType !== undefined) updates.trigger_type = triggerType
    if (triggerConfig !== undefined) updates.trigger_config = triggerConfig ? JSON.stringify(triggerConfig) : null
    if (status !== undefined) updates.status = status

    await knex('sequences').where('id', params.id).update(updates)

    if (Array.isArray(steps)) {
      for (const step of steps) {
        if (!VALID_STEP_TYPES.includes(step.stepType)) {
          return NextResponse.json({ ok: false, error: `stepType must be one of: ${VALID_STEP_TYPES.join(', ')}` }, { status: 400 })
        }
      }

      await knex('sequence_steps').where('sequence_id', params.id).del()

      const now = new Date()
      for (const step of steps) {
        await knex('sequence_steps').insert({
          id: require('crypto').randomUUID(),
          sequence_id: params.id,
          step_order: step.stepOrder,
          step_type: step.stepType,
          config: step.config ? JSON.stringify(step.config) : null,
          created_at: now,
        })
      }
    }

    const updated = await knex('sequences').where('id', params.id).first()
    const updatedSteps = await knex('sequence_steps').where('sequence_id', params.id).orderBy('step_order', 'asc')
    updated.steps = updatedSteps

    return NextResponse.json({ ok: true, data: updated })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
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

    await knex('sequences').where('id', params.id).update({ deleted_at: new Date(), updated_at: new Date() })

    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Sequences', summary: 'Sequence detail',
  methods: {
    GET: { summary: 'Get a sequence with steps and enrollment stats', tags: ['Sequences'] },
    PUT: { summary: 'Update a sequence', tags: ['Sequences'] },
    DELETE: { summary: 'Delete a sequence (soft)', tags: ['Sequences'] },
  },
}
