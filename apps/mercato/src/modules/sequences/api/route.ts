export const metadata = { GET: { requireAuth: true }, POST: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

const VALID_TRIGGER_TYPES = ['form_submit', 'tag_added', 'deal_stage_changed', 'manual', 'booking_created', 'invoice_paid', 'event_registered', 'course_enrolled', 'contact_created', 'deal_won', 'product_purchased'] as const
const VALID_STEP_TYPES = ['email', 'sms', 'wait', 'condition', 'branch', 'goal'] as const

export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const sequences = await knex('sequences')
      .select(
        'sequences.*',
        knex.raw('(SELECT COUNT(*) FROM sequence_steps WHERE sequence_steps.sequence_id = sequences.id) as step_count'),
        knex.raw("(SELECT COUNT(*) FROM sequence_enrollments WHERE sequence_enrollments.sequence_id = sequences.id AND sequence_enrollments.status = 'active') as enrollment_count"),
      )
      .where('sequences.organization_id', auth.orgId)
      .whereNull('sequences.deleted_at')
      .orderBy('sequences.created_at', 'desc')

    return NextResponse.json({ ok: true, data: sequences })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { name, description, triggerType, triggerConfig, steps } = body

    if (!name || !triggerType) {
      return NextResponse.json({ ok: false, error: 'name and triggerType are required' }, { status: 400 })
    }

    if (!VALID_TRIGGER_TYPES.includes(triggerType)) {
      return NextResponse.json({ ok: false, error: `triggerType must be one of: ${VALID_TRIGGER_TYPES.join(', ')}` }, { status: 400 })
    }

    if (!Array.isArray(steps) || steps.length === 0) {
      return NextResponse.json({ ok: false, error: 'At least one step is required' }, { status: 400 })
    }

    for (const step of steps) {
      if (!VALID_STEP_TYPES.includes(step.stepType)) {
        return NextResponse.json({ ok: false, error: `stepType must be one of: ${VALID_STEP_TYPES.join(', ')}` }, { status: 400 })
      }
      if (step.stepOrder == null) {
        return NextResponse.json({ ok: false, error: 'Each step must have a stepOrder' }, { status: 400 })
      }
    }

    const sequenceId = require('crypto').randomUUID()
    const now = new Date()

    await knex('sequences').insert({
      id: sequenceId,
      tenant_id: auth.tenantId,
      organization_id: auth.orgId,
      name,
      description: description || null,
      trigger_type: triggerType,
      trigger_config: triggerConfig ? JSON.stringify(triggerConfig) : null,
      status: 'draft',
      created_at: now,
      updated_at: now,
    })

    const insertedSteps = []
    for (const step of steps) {
      const stepId = require('crypto').randomUUID()
      const stepRow: Record<string, unknown> = {
        id: stepId,
        sequence_id: sequenceId,
        step_order: step.stepOrder,
        step_type: step.stepType,
        config: step.config ? JSON.stringify(step.config) : null,
        created_at: now,
      }
      if (step.branchConfig) stepRow.branch_config = JSON.stringify(step.branchConfig)
      if (step.isGoal) stepRow.is_goal = true
      if (step.goalConfig) stepRow.goal_config = JSON.stringify(step.goalConfig)
      await knex('sequence_steps').insert(stepRow)
      insertedSteps.push({ ...stepRow, config: step.config || null, branch_config: step.branchConfig || null, is_goal: step.isGoal || false, goal_config: step.goalConfig || null })
    }

    return NextResponse.json({
      ok: true,
      data: {
        id: sequenceId,
        name,
        description: description || null,
        trigger_type: triggerType,
        trigger_config: triggerConfig || null,
        status: 'draft',
        steps: insertedSteps,
        created_at: now,
      },
    }, { status: 201 })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Sequences', summary: 'Sequences CRUD',
  methods: {
    GET: { summary: 'List all sequences', tags: ['Sequences'] },
    POST: { summary: 'Create a sequence', tags: ['Sequences'] },
  },
}
