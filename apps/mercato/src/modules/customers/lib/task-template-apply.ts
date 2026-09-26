/**
 * Create a contact's tasks from a task template. Shared by the Apply button
 * (api/task-templates/apply) and the apply_task_template automation action.
 *
 * Plain module, no Next imports: automation actions run inside the queue
 * workers, whose bundle cannot load Next route modules.
 */
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
