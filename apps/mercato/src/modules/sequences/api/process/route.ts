
import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { sendEmailByPurpose } from '@/modules/email/lib/email-router'

export const metadata = {
  POST: { requireAuth: false },
}

async function emitSequenceCompleted(
  container: Awaited<ReturnType<typeof createRequestContainer>>,
  execution: {
    enrollment_id: string
    sequence_id: string
    contact_id: string | null
    organization_id: string
    tenant_id: string
  },
): Promise<void> {
  try {
    const bus = container.resolve('eventBus') as any
    if (bus?.emitEvent) {
      await bus.emitEvent('sequences.sequence.completed', {
        sequenceId: execution.sequence_id,
        sequenceRunId: execution.enrollment_id,
        contactId: execution.contact_id,
        organizationId: execution.organization_id,
        tenantId: execution.tenant_id,
      }, { persistent: true })
    }
  } catch {}
}

export async function POST(req: Request) {
  const secret = process.env.SEQUENCE_PROCESS_SECRET
  if (secret) {
    const authHeader = req.headers.get('authorization')
    if (authHeader !== `Bearer ${secret}`) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    }
  } else if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ ok: false, error: 'SEQUENCE_PROCESS_SECRET not configured' }, { status: 500 })
  }

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const dueExecutions = await knex('sequence_step_executions as sse')
      .join('sequence_enrollments as se', 'se.id', 'sse.enrollment_id')
      .join('sequences as s', 's.id', 'se.sequence_id')
      .where('sse.status', 'scheduled')
      .where('sse.scheduled_for', '<=', knex.fn.now())
      .where('se.status', 'active')
      .where('s.status', 'active')
      .whereNull('s.deleted_at')
      .select(
        'sse.id as execution_id',
        'sse.step_id',
        'sse.enrollment_id',
        'se.sequence_id',
        'se.contact_id',
        'se.current_step_order',
        's.organization_id',
        's.tenant_id',
      )
      .limit(50)

    let processed = 0

    for (const execution of dueExecutions) {
      try {
        const step = await knex('sequence_steps').where('id', execution.step_id).first()
        if (!step) {
          await knex('sequence_step_executions').where('id', execution.execution_id).update({
            status: 'failed',
            result: JSON.stringify({ error: 'Step not found' }),
            executed_at: new Date(),
          })
          continue
        }

        const config = step.config ? (typeof step.config === 'string' ? JSON.parse(step.config) : step.config) : {}

        const contact = await knex('customer_entities')
          .where('id', execution.contact_id)
          .first()

        if (!contact) {
          await knex('sequence_step_executions').where('id', execution.execution_id).update({
            status: 'failed',
            result: JSON.stringify({ error: 'Contact not found' }),
            executed_at: new Date(),
          })
          continue
        }

        const now = new Date()

        // ── Goal checking: before processing any step, check if a goal is met ──
        const goalSteps = await knex('sequence_steps')
          .where('sequence_id', execution.sequence_id)
          .where('is_goal', true)

        let goalAchieved = false
        let goalDescription = ''

        for (const goalStep of goalSteps) {
          const gc = goalStep.goal_config
            ? (typeof goalStep.goal_config === 'string' ? JSON.parse(goalStep.goal_config) : goalStep.goal_config)
            : {}

          if (gc.type === 'tag_added' && gc.value) {
            const tagMatch = await knex('customer_tag_assignments as cta')
              .join('customer_tags as ct', 'ct.id', 'cta.tag_id')
              .where('cta.entity_id', execution.contact_id)
              .where(function () {
                this.where('ct.slug', gc.value).orWhere('ct.name', gc.value)
              })
              .first()
            if (tagMatch) {
              goalAchieved = true
              goalDescription = `Goal met: tag "${gc.value}" added`
            }
          } else if (gc.type === 'deal_won') {
            const wonDeal = await knex('deals')
              .where('contact_id', execution.contact_id)
              .where('organization_id', execution.organization_id)
              .where('stage', 'won')
              .first()
            if (wonDeal) {
              goalAchieved = true
              goalDescription = 'Goal met: deal won'
            }
          } else if (gc.type === 'invoice_paid') {
            const paidInvoice = await knex('invoices')
              .where('contact_id', execution.contact_id)
              .where('organization_id', execution.organization_id)
              .where('status', 'paid')
              .first()
            if (paidInvoice) {
              goalAchieved = true
              goalDescription = 'Goal met: invoice paid'
            }
          }

          if (goalAchieved) break
        }

        if (goalAchieved) {
          await knex('sequence_step_executions').where('id', execution.execution_id).update({
            status: 'skipped',
            result: JSON.stringify({ goal_achieved: true, note: goalDescription }),
            executed_at: now,
          })
          await knex('sequence_enrollments').where('id', execution.enrollment_id).update({
            status: 'completed',
            completed_at: now,
          })
          await emitSequenceCompleted(container, execution)
          processed++
          continue
        }

        if (step.step_type === 'email') {
          const email = contact.primary_email
          if (!email) {
            await knex('sequence_step_executions').where('id', execution.execution_id).update({
              status: 'failed',
              result: JSON.stringify({ error: 'Contact has no email address' }),
              executed_at: now,
            })
            continue
          }

          const firstName = (contact.display_name || '').split(' ')[0] || 'there'
          const subject = (config.subject || '')
            .replace(/\{\{firstName\}\}/g, firstName)
            .replace(/\{\{name\}\}/g, contact.display_name || '')
            .replace(/\{\{email\}\}/g, email)

          const bodyHtml = (config.bodyHtml || config.body || '')
            .replace(/\{\{firstName\}\}/g, firstName)
            .replace(/\{\{name\}\}/g, contact.display_name || '')
            .replace(/\{\{email\}\}/g, email)

          const trackingId = require('crypto').randomUUID()

          await knex('email_messages').insert({
            id: require('crypto').randomUUID(),
            tenant_id: execution.tenant_id,
            organization_id: execution.organization_id,
            direction: 'outbound',
            from_address: 'pending@router',
            to_address: email,
            subject,
            body_html: bodyHtml,
            contact_id: execution.contact_id,
            status: 'queued',
            tracking_id: trackingId,
            created_at: now,
          })

          try {
            const result = await sendEmailByPurpose(knex, execution.organization_id, execution.tenant_id, 'marketing', {
              to: email,
              subject,
              htmlBody: bodyHtml,
              contactId: execution.contact_id,
            })
            if (!result.ok) {
              console.error(`[sequences.process] Failed to send email to ${email}:`, result.error)
            }
          } catch (sendErr) {
            console.error(`[sequences.process] Failed to send email to ${email}:`, sendErr)
          }

          await knex('sequence_step_executions').where('id', execution.execution_id).update({
            status: 'executed',
            result: JSON.stringify({ sent_to: email, subject, tracking_id: trackingId }),
            executed_at: now,
          })
        } else if (step.step_type === 'sms') {
          console.log(`[sequences.process] SMS step logged for contact ${execution.contact_id}: ${JSON.stringify(config)}`)
          await knex('sequence_step_executions').where('id', execution.execution_id).update({
            status: 'executed',
            result: JSON.stringify({ logged: true, note: 'SMS step logged, integration not wired' }),
            executed_at: now,
          })
        } else if (step.step_type === 'wait') {
          await knex('sequence_step_executions').where('id', execution.execution_id).update({
            status: 'executed',
            result: JSON.stringify({ note: 'Wait step completed' }),
            executed_at: now,
          })
        } else if (step.step_type === 'condition') {
          let conditionMet = false

          if (config.value) {
            const tagAssignment = await knex('customer_tag_assignments as cta')
              .join('customer_tags as ct', 'ct.id', 'cta.tag_id')
              .where('cta.entity_id', execution.contact_id)
              .where(function() {
                this.where('ct.slug', config.value).orWhere('ct.name', config.value)
              })
              .first()
            const hasTag = !!tagAssignment
            conditionMet = config.operator === 'not_has' ? !hasTag : hasTag
          }

          if (conditionMet) {
            await knex('sequence_step_executions').where('id', execution.execution_id).update({
              status: 'executed',
              result: JSON.stringify({ condition_met: true }),
              executed_at: now,
            })
          } else if (config.skipToStep) {
            await knex('sequence_enrollments').where('id', execution.enrollment_id).update({
              current_step_order: config.skipToStep,
            })

            const skipStep = await knex('sequence_steps')
              .where('sequence_id', execution.sequence_id)
              .where('step_order', config.skipToStep)
              .first()

            if (skipStep) {
              let scheduledFor = now
              if (skipStep.step_type === 'wait') {
                const skipConfig = skipStep.config ? (typeof skipStep.config === 'string' ? JSON.parse(skipStep.config) : skipStep.config) : {}
                if (skipConfig.delay) {
                  scheduledFor = new Date(now.getTime())
                  if (skipConfig.unit === 'days') {
                    scheduledFor.setTime(scheduledFor.getTime() + skipConfig.delay * 24 * 60 * 60 * 1000)
                  } else {
                    scheduledFor.setTime(scheduledFor.getTime() + skipConfig.delay * 60 * 60 * 1000)
                  }
                }
              }

              await knex('sequence_step_executions').insert({
                id: require('crypto').randomUUID(),
                enrollment_id: execution.enrollment_id,
                step_id: skipStep.id,
                status: 'scheduled',
                scheduled_for: scheduledFor,
                created_at: now,
              })
            }

            await knex('sequence_step_executions').where('id', execution.execution_id).update({
              status: 'executed',
              result: JSON.stringify({ condition_met: false, skipped_to_step: config.skipToStep }),
              executed_at: now,
            })
            processed++
            continue
          } else {
            await knex('sequence_step_executions').where('id', execution.execution_id).update({
              status: 'skipped',
              result: JSON.stringify({ condition_met: false, no_skip_target: true }),
              executed_at: now,
            })
            // Still advance to next step below
          }
        } else if (step.step_type === 'branch') {
          const bc = step.branch_config
            ? (typeof step.branch_config === 'string' ? JSON.parse(step.branch_config) : step.branch_config)
            : {}
          const condition = bc.condition || {}
          let conditionResult = false

          if (condition.field === 'tag' && condition.value) {
            const tagMatch = await knex('customer_tag_assignments as cta')
              .join('customer_tags as ct', 'ct.id', 'cta.tag_id')
              .where('cta.entity_id', execution.contact_id)
              .where(function () {
                this.where('ct.slug', condition.value).orWhere('ct.name', condition.value)
              })
              .first()
            const hasTag = !!tagMatch
            conditionResult = condition.operator === 'not_has' ? !hasTag : hasTag
          } else if (condition.field === 'opened_previous') {
            const prevEmailExec = await knex('sequence_step_executions as sse')
              .join('sequence_steps as ss', 'ss.id', 'sse.step_id')
              .where('sse.enrollment_id', execution.enrollment_id)
              .where('ss.step_type', 'email')
              .where('ss.step_order', '<', step.step_order)
              .where('sse.status', 'executed')
              .orderBy('ss.step_order', 'desc')
              .first()
            if (prevEmailExec) {
              const execResult = prevEmailExec.result
                ? (typeof prevEmailExec.result === 'string' ? JSON.parse(prevEmailExec.result) : prevEmailExec.result)
                : {}
              if (execResult.tracking_id) {
                const emailMsg = await knex('email_messages')
                  .where('tracking_id', execResult.tracking_id)
                  .whereNotNull('opened_at')
                  .first()
                conditionResult = !!emailMsg
              }
            }
          } else if (condition.field === 'clicked_previous') {
            const prevEmailExec = await knex('sequence_step_executions as sse')
              .join('sequence_steps as ss', 'ss.id', 'sse.step_id')
              .where('sse.enrollment_id', execution.enrollment_id)
              .where('ss.step_type', 'email')
              .where('ss.step_order', '<', step.step_order)
              .where('sse.status', 'executed')
              .orderBy('ss.step_order', 'desc')
              .first()
            if (prevEmailExec) {
              const execResult = prevEmailExec.result
                ? (typeof prevEmailExec.result === 'string' ? JSON.parse(prevEmailExec.result) : prevEmailExec.result)
                : {}
              if (execResult.tracking_id) {
                const emailMsg = await knex('email_messages')
                  .where('tracking_id', execResult.tracking_id)
                  .whereNotNull('clicked_at')
                  .first()
                conditionResult = !!emailMsg
              }
            }
          }

          const targetStepOrder = conditionResult ? bc.trueStepOrder : bc.falseStepOrder

          await knex('sequence_step_executions').where('id', execution.execution_id).update({
            status: 'executed',
            result: JSON.stringify({
              branch: true,
              condition: condition.field,
              result: conditionResult,
              target_step_order: targetStepOrder,
            }),
            executed_at: now,
          })

          if (targetStepOrder) {
            const targetStep = await knex('sequence_steps')
              .where('sequence_id', execution.sequence_id)
              .where('step_order', targetStepOrder)
              .first()

            if (targetStep) {
              await knex('sequence_enrollments').where('id', execution.enrollment_id).update({
                current_step_order: targetStepOrder,
              })

              let scheduledFor = now
              if (targetStep.step_type === 'wait') {
                const targetConfig = targetStep.config
                  ? (typeof targetStep.config === 'string' ? JSON.parse(targetStep.config) : targetStep.config)
                  : {}
                if (targetConfig.delay) {
                  scheduledFor = new Date(now.getTime())
                  if (targetConfig.unit === 'days') {
                    scheduledFor.setTime(scheduledFor.getTime() + targetConfig.delay * 24 * 60 * 60 * 1000)
                  } else {
                    scheduledFor.setTime(scheduledFor.getTime() + targetConfig.delay * 60 * 60 * 1000)
                  }
                }
              }

              await knex('sequence_step_executions').insert({
                id: require('crypto').randomUUID(),
                enrollment_id: execution.enrollment_id,
                step_id: targetStep.id,
                status: 'scheduled',
                scheduled_for: scheduledFor,
                created_at: now,
              })
            } else {
              await knex('sequence_enrollments').where('id', execution.enrollment_id).update({
                status: 'completed',
                completed_at: now,
              })
              await emitSequenceCompleted(container, execution)
            }
          } else {
            await knex('sequence_enrollments').where('id', execution.enrollment_id).update({
              status: 'completed',
              completed_at: now,
            })
            await emitSequenceCompleted(container, execution)
          }

          processed++
          continue
        } else if (step.step_type === 'goal') {
          // Goal steps are passive markers; just pass through
          await knex('sequence_step_executions').where('id', execution.execution_id).update({
            status: 'executed',
            result: JSON.stringify({ note: 'Goal step passed (goal not yet met)' }),
            executed_at: now,
          })
        }

        // Advance to next step
        const nextStep = await knex('sequence_steps')
          .where('sequence_id', execution.sequence_id)
          .where('step_order', '>', step.step_order)
          .orderBy('step_order', 'asc')
          .first()

        if (nextStep) {
          await knex('sequence_enrollments').where('id', execution.enrollment_id).update({
            current_step_order: nextStep.step_order,
          })

          let scheduledFor = new Date()
          if (nextStep.step_type === 'wait') {
            const nextConfig = nextStep.config ? (typeof nextStep.config === 'string' ? JSON.parse(nextStep.config) : nextStep.config) : {}
            if (nextConfig.delay) {
              if (nextConfig.unit === 'days') {
                scheduledFor.setTime(scheduledFor.getTime() + nextConfig.delay * 24 * 60 * 60 * 1000)
              } else {
                scheduledFor.setTime(scheduledFor.getTime() + nextConfig.delay * 60 * 60 * 1000)
              }
            }
          }

          await knex('sequence_step_executions').insert({
            id: require('crypto').randomUUID(),
            enrollment_id: execution.enrollment_id,
            step_id: nextStep.id,
            status: 'scheduled',
            scheduled_for: scheduledFor,
            created_at: new Date(),
          })
        } else {
          await knex('sequence_enrollments').where('id', execution.enrollment_id).update({
            status: 'completed',
            completed_at: new Date(),
          })
          await emitSequenceCompleted(container, execution)
        }

        processed++
      } catch (stepErr) {
        console.error(`[sequences.process] Error processing execution ${execution.execution_id}:`, stepErr)
        await knex('sequence_step_executions').where('id', execution.execution_id).update({
          status: 'failed',
          result: JSON.stringify({ error: String(stepErr) }),
          executed_at: new Date(),
        }).catch(() => {})
      }
    }

    return NextResponse.json({ ok: true, processed })
  } catch (error) {
    console.error('[sequences.process]', error)
    return NextResponse.json({ ok: false, error: 'Failed to process sequences' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Sequences', summary: 'Process sequences',
  methods: { POST: { summary: 'Process due sequence steps (cron)', tags: ['Sequences'] } },
}
