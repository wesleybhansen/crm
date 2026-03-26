import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

/**
 * Execute automations for a deal stage change.
 * Called when a deal moves to a new stage.
 */
export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { dealId, newStage, contactId } = body

    if (!dealId || !newStage) {
      return NextResponse.json({ ok: false, error: 'dealId and newStage required' }, { status: 400 })
    }

    // Find matching automations
    const automations = await knex('stage_automations')
      .where('organization_id', auth.orgId)
      .where('trigger_stage', newStage)
      .where('is_active', true)

    const results: Array<{ automationId: string; action: string; success: boolean; error?: string }> = []

    for (const auto of automations) {
      const config = typeof auto.action_config === 'string' ? JSON.parse(auto.action_config) : auto.action_config

      try {
        switch (auto.action_type) {
          case 'send_email': {
            // Send an email to the deal's contact
            if (contactId) {
              const contact = await knex('customer_entities').where('id', contactId).first()
              if (contact?.primary_email) {
                await knex('email_messages').insert({
                  id: require('crypto').randomUUID(),
                  tenant_id: auth.tenantId,
                  organization_id: auth.orgId,
                  direction: 'outbound',
                  from_address: process.env.EMAIL_FROM || 'noreply@localhost',
                  to_address: contact.primary_email,
                  subject: config.subject || `Update on your ${newStage}`,
                  body_html: config.body || `<p>Hi ${(contact.display_name || '').split(' ')[0] || 'there'},</p><p>Just wanted to let you know your status has been updated.</p>`,
                  contact_id: contactId,
                  status: 'queued',
                  tracking_id: require('crypto').randomUUID(),
                  created_at: new Date(),
                })

                // TODO: Actually send via Resend when configured
                results.push({ automationId: auto.id, action: 'send_email', success: true })
              }
            }
            break
          }

          case 'create_task': {
            await knex('tasks').insert({
              id: require('crypto').randomUUID(),
              tenant_id: auth.tenantId,
              organization_id: auth.orgId,
              title: config.taskTitle || `Follow up — deal moved to ${newStage}`,
              description: config.taskDescription || null,
              deal_id: dealId,
              contact_id: contactId || null,
              due_date: config.dueDays ? new Date(Date.now() + config.dueDays * 24 * 60 * 60 * 1000) : null,
              is_done: false,
              created_at: new Date(),
              updated_at: new Date(),
            })
            results.push({ automationId: auto.id, action: 'create_task', success: true })
            break
          }

          case 'update_contact': {
            if (contactId && config.field && config.value) {
              const update: Record<string, any> = { updated_at: new Date() }
              if (config.field === 'lifecycle_stage') update.lifecycle_stage = config.value
              if (config.field === 'status') update.status = config.value
              await knex('customer_entities').where('id', contactId).update(update)
              results.push({ automationId: auto.id, action: 'update_contact', success: true })
            }
            break
          }

          case 'notify': {
            // Create a notification/activity log
            await knex('customer_activities').insert({
              id: require('crypto').randomUUID(),
              tenant_id: auth.tenantId,
              organization_id: auth.orgId,
              entity_id: contactId || dealId,
              activity_type: 'automation',
              subject: config.message || `Automation triggered: deal moved to ${newStage}`,
              occurred_at: new Date(),
              created_at: new Date(),
              updated_at: new Date(),
            }).catch(() => {})
            results.push({ automationId: auto.id, action: 'notify', success: true })
            break
          }

          default:
            results.push({ automationId: auto.id, action: auto.action_type, success: false, error: 'Unknown action type' })
        }
      } catch (err) {
        results.push({ automationId: auto.id, action: auto.action_type, success: false, error: err instanceof Error ? err.message : 'Unknown' })
      }
    }

    return NextResponse.json({ ok: true, data: { executed: results.length, results } })
  } catch (error) {
    console.error('[automations.execute]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
