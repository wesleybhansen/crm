// ORM-SKIP: needs entity definition — Phase 2 conversion
export const metadata = { path: '/task-templates/apply', POST: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export const openApi: OpenApiRouteDoc = {
  POST: { summary: 'Apply a task template to a contact', tags: ['Task Templates'] },
}

interface TemplateTask {
  title: string
  description?: string | null
  dueDaysFromTrigger: number
  order: number
}

export async function applyTaskTemplate(
  knex: any,
  orgId: string,
  tenantId: string,
  templateId: string,
  contactId: string
): Promise<{ success: boolean; tasksCreated: number; detail?: string }> {
  const template = await knex('task_templates')
    .where('id', templateId)
    .where('organization_id', orgId)
    .first()

  if (!template) return { success: false, tasksCreated: 0, detail: 'Template not found' }

  const tasks: TemplateTask[] = typeof template.tasks === 'string'
    ? JSON.parse(template.tasks)
    : (template.tasks || [])

  if (tasks.length === 0) return { success: false, tasksCreated: 0, detail: 'Template has no tasks' }

  const now = new Date()
  const crypto = require('crypto')

  for (const task of tasks) {
    const dueDate = new Date(now.getTime() + (task.dueDaysFromTrigger || 1) * 24 * 60 * 60 * 1000)
    await knex('tasks').insert({
      id: crypto.randomUUID(),
      tenant_id: tenantId,
      organization_id: orgId,
      title: task.title,
      description: task.description || null,
      contact_id: contactId,
      deal_id: null,
      due_date: dueDate,
      is_done: false,
      created_at: now,
      updated_at: now,
    })
  }

  return { success: true, tasksCreated: tasks.length, detail: `Created ${tasks.length} tasks from template "${template.name}"` }
}

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const body = await req.json()

    const { templateId, contactId } = body
    if (!templateId) return NextResponse.json({ ok: false, error: 'templateId required' }, { status: 400 })
    if (!contactId) return NextResponse.json({ ok: false, error: 'contactId required' }, { status: 400 })

    // Verify the contact exists
    const contact = await knex('customer_entities')
      .where('id', contactId)
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .first()
    if (!contact) return NextResponse.json({ ok: false, error: 'Contact not found' }, { status: 404 })

    const result = await applyTaskTemplate(knex, auth.orgId, auth.tenantId, templateId, contactId)

    if (!result.success) {
      return NextResponse.json({ ok: false, error: result.detail }, { status: 400 })
    }

    return NextResponse.json({ ok: true, data: result }, { status: 201 })
  } catch (error) {
    console.error('[task-templates.apply] POST error:', error)
    return NextResponse.json({ ok: false, error: 'Failed to apply template' }, { status: 500 })
  }
}
