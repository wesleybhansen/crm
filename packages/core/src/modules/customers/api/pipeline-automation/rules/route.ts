/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { TRIGGERS_BY_KEY } from '../../../pipeline_automation/triggers'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['pipeline_automation.configure'] },
  POST: { requireAuth: true, requireFeatures: ['pipeline_automation.configure'] },
  PUT: { requireAuth: true, requireFeatures: ['pipeline_automation.configure'] },
  DELETE: { requireAuth: true, requireFeatures: ['pipeline_automation.configure'] },
}

const ruleBaseSchema = z.object({
  name: z.string().min(1).max(200),
  triggerKey: z.string().min(1),
  filters: z.record(z.string(), z.any()).default({}),
  targetEntity: z.enum(['deal', 'person']),
  targetPipelineId: z.string().uuid().nullish(),
  targetStageId: z.string().uuid().nullish(),
  targetLifecycleStage: z.string().nullish(),
  targetAction: z.enum(['set_stage', 'advance_one', 'set_lifecycle']),
  allowBackward: z.boolean().default(false),
  isActive: z.boolean().default(true),
})

const createSchema = ruleBaseSchema
const updateSchema = ruleBaseSchema.partial().extend({ id: z.string().uuid() })

async function validateRule(
  body: z.infer<typeof ruleBaseSchema>,
  knex: any,
  organizationId: string,
  tenantId: string,
): Promise<string | null> {
  const trigger = TRIGGERS_BY_KEY[body.triggerKey as keyof typeof TRIGGERS_BY_KEY]
  if (!trigger) return `Unknown trigger key: ${body.triggerKey}`
  if (!trigger.supportedEntities.includes(body.targetEntity)) {
    return `Trigger '${body.triggerKey}' does not support target entity '${body.targetEntity}'`
  }
  try {
    trigger.filtersSchema.parse(body.filters ?? {})
  } catch (err: any) {
    return `Filter validation failed: ${err?.message ?? String(err)}`
  }
  if (body.targetEntity === 'person' && body.targetAction !== 'set_lifecycle') {
    return `Person target requires action 'set_lifecycle'`
  }
  if (body.targetEntity === 'deal' && body.targetAction === 'set_lifecycle') {
    return `Deal target cannot use action 'set_lifecycle'`
  }
  if (body.targetEntity === 'person' && !body.targetLifecycleStage) {
    return `targetLifecycleStage is required when targetEntity = 'person'`
  }
  if (body.targetEntity === 'deal' && body.targetAction === 'set_stage' && !body.targetStageId) {
    return `targetStageId is required when targetAction = 'set_stage'`
  }
  if (body.targetPipelineId) {
    const pipeline = await knex('customer_pipelines')
      .where('id', body.targetPipelineId)
      .where('organization_id', organizationId)
      .where('tenant_id', tenantId)
      .first('id')
    if (!pipeline) return `targetPipelineId does not belong to your organization`
  }
  if (body.targetStageId) {
    const stage = await knex('customer_pipeline_stages')
      .where('id', body.targetStageId)
      .where('organization_id', organizationId)
      .where('tenant_id', tenantId)
      .first('id', 'pipeline_id')
    if (!stage) return `targetStageId does not belong to your organization`
    if (body.targetPipelineId && stage.pipeline_id !== body.targetPipelineId) {
      return `targetStageId does not belong to targetPipelineId`
    }
  }
  return null
}

function rowToDto(row: any) {
  return {
    id: row.id,
    name: row.name,
    triggerKey: row.trigger_key,
    filters: typeof row.filters === 'string' ? JSON.parse(row.filters || '{}') : (row.filters ?? {}),
    targetEntity: row.target_entity,
    targetPipelineId: row.target_pipeline_id,
    targetStageId: row.target_stage_id,
    targetLifecycleStage: row.target_lifecycle_stage,
    targetAction: row.target_action,
    allowBackward: row.allow_backward,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function GET(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth?.orgId || !auth?.tenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const url = new URL(req.url)
  const triggerKey = url.searchParams.get('trigger_key')
  const isActive = url.searchParams.get('is_active')
  const container = await createRequestContainer()
  const knex = (container.resolve('em') as EntityManager).getKnex()
  let q = knex('customer_pipeline_automation_rules')
    .where('organization_id', auth.orgId)
    .where('tenant_id', auth.tenantId)
    .whereNull('deleted_at')
    .orderBy('created_at', 'desc')
  if (triggerKey) q = q.where('trigger_key', triggerKey)
  if (isActive === 'true') q = q.where('is_active', true)
  if (isActive === 'false') q = q.where('is_active', false)
  const rows = await q
  return NextResponse.json({ items: rows.map(rowToDto) })
}

export async function POST(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth?.orgId || !auth?.tenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 422 })
  }
  const container = await createRequestContainer()
  const knex = (container.resolve('em') as EntityManager).getKnex()
  const validationError = await validateRule(parsed.data, knex, auth.orgId, auth.tenantId)
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 422 })
  }
  const [row] = await knex('customer_pipeline_automation_rules')
    .insert({
      organization_id: auth.orgId,
      tenant_id: auth.tenantId,
      name: parsed.data.name,
      trigger_key: parsed.data.triggerKey,
      filters: JSON.stringify(parsed.data.filters ?? {}),
      target_entity: parsed.data.targetEntity,
      target_pipeline_id: parsed.data.targetPipelineId ?? null,
      target_stage_id: parsed.data.targetStageId ?? null,
      target_lifecycle_stage: parsed.data.targetLifecycleStage ?? null,
      target_action: parsed.data.targetAction,
      allow_backward: parsed.data.allowBackward,
      is_active: parsed.data.isActive,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .returning('*')
  return NextResponse.json({ item: rowToDto(row) }, { status: 201 })
}

export async function PUT(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth?.orgId || !auth?.tenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 422 })
  }
  const container = await createRequestContainer()
  const knex = (container.resolve('em') as EntityManager).getKnex()
  const existing = await knex('customer_pipeline_automation_rules')
    .where('id', parsed.data.id)
    .where('organization_id', auth.orgId)
    .where('tenant_id', auth.tenantId)
    .whereNull('deleted_at')
    .first()
  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const merged = {
    name: parsed.data.name ?? existing.name,
    triggerKey: parsed.data.triggerKey ?? existing.trigger_key,
    filters: parsed.data.filters ?? (typeof existing.filters === 'string' ? JSON.parse(existing.filters || '{}') : existing.filters),
    targetEntity: parsed.data.targetEntity ?? existing.target_entity,
    targetPipelineId: parsed.data.targetPipelineId === undefined ? existing.target_pipeline_id : parsed.data.targetPipelineId,
    targetStageId: parsed.data.targetStageId === undefined ? existing.target_stage_id : parsed.data.targetStageId,
    targetLifecycleStage: parsed.data.targetLifecycleStage === undefined ? existing.target_lifecycle_stage : parsed.data.targetLifecycleStage,
    targetAction: parsed.data.targetAction ?? existing.target_action,
    allowBackward: parsed.data.allowBackward ?? existing.allow_backward,
    isActive: parsed.data.isActive ?? existing.is_active,
  }
  const validationError = await validateRule(merged as any, knex, auth.orgId, auth.tenantId)
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 422 })
  }
  await knex('customer_pipeline_automation_rules')
    .where('id', parsed.data.id)
    .where('organization_id', auth.orgId)
    .where('tenant_id', auth.tenantId)
    .update({
      name: merged.name,
      trigger_key: merged.triggerKey,
      filters: JSON.stringify(merged.filters ?? {}),
      target_entity: merged.targetEntity,
      target_pipeline_id: merged.targetPipelineId,
      target_stage_id: merged.targetStageId,
      target_lifecycle_stage: merged.targetLifecycleStage,
      target_action: merged.targetAction,
      allow_backward: merged.allowBackward,
      is_active: merged.isActive,
      updated_at: new Date(),
    })
  const updated = await knex('customer_pipeline_automation_rules').where('id', parsed.data.id).first()
  return NextResponse.json({ item: rowToDto(updated) })
}

export async function DELETE(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth?.orgId || !auth?.tenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const url = new URL(req.url)
  const id = url.searchParams.get('id')
  if (!id) {
    return NextResponse.json({ error: 'id query parameter required' }, { status: 400 })
  }
  const container = await createRequestContainer()
  const knex = (container.resolve('em') as EntityManager).getKnex()
  const result = await knex('customer_pipeline_automation_rules')
    .where('id', id)
    .where('organization_id', auth.orgId)
    .where('tenant_id', auth.tenantId)
    .whereNull('deleted_at')
    .update({ deleted_at: new Date(), is_active: false })
  if (result === 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  return NextResponse.json({ ok: true })
}

export const openApi = {
  tags: ['Customers'],
  paths: {
    list: { summary: 'List pipeline automation rules', description: 'Returns rules scoped to caller org.' },
    create: { summary: 'Create a rule' },
    update: { summary: 'Update a rule' },
    del: { summary: 'Soft-delete a rule' },
  },
}
