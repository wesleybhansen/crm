import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export const metadata = {
  POST: { requireAuth: false },
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

    const dueReminders = await knex('reminders')
      .where('sent', false)
      .where('remind_at', '<=', knex.fn.now())
      .limit(50)

    let processed = 0

    for (const reminder of dueReminders) {
      try {
        const user = await knex('users')
          .where('id', reminder.user_id)
          .select('email', 'display_name')
          .first()

        if (!user?.email) {
          console.warn(`[reminders.process] No email for user ${reminder.user_id}, skipping reminder ${reminder.id}`)
          await knex('reminders').where('id', reminder.id).update({
            sent: true,
            sent_at: new Date(),
          })
          processed++
          continue
        }

        let entityLabel = reminder.entity_type
        let entityUrl = ''

        if (reminder.entity_type === 'contact') {
          const contact = await knex('customer_entities').where('id', reminder.entity_id).select('display_name').first()
          entityLabel = contact?.display_name || 'Contact'
          entityUrl = `/backend/customers/people/${reminder.entity_id}`
        } else if (reminder.entity_type === 'deal') {
          const deal = await knex('customer_deals').where('id', reminder.entity_id).select('title').first()
          entityLabel = deal?.title || 'Deal'
          entityUrl = `/backend/customers/deals/${reminder.entity_id}`
        } else if (reminder.entity_type === 'task') {
          const task = await knex('tasks').where('id', reminder.entity_id).select('title').first()
          entityLabel = task?.title || 'Task'
          entityUrl = `/backend/customers/people`
        }

        const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
        const fullUrl = entityUrl ? `${appUrl}${entityUrl}` : appUrl

        const subject = `Reminder: ${reminder.message}`
        const bodyHtml = `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #1a1a1a; font-size: 18px;">Reminder</h2>
            <p style="color: #333; font-size: 14px; line-height: 1.6;">${reminder.message}</p>
            <p style="color: #666; font-size: 13px;">
              Related to: <strong>${entityLabel}</strong>
            </p>
            <p style="margin-top: 20px;">
              <a href="${fullUrl}" style="display: inline-block; background: #2563eb; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-size: 14px;">
                View ${reminder.entity_type}
              </a>
            </p>
          </div>
        `

        // Try ESP from DB first, then RESEND_API_KEY env fallback
        const espConn = await knex('esp_connections')
          .where('organization_id', reminder.organization_id).where('is_active', true).first()
        const apiKey = espConn?.api_key || process.env.RESEND_API_KEY
        const fromAddress = espConn?.default_sender_email || process.env.EMAIL_FROM || 'noreply@localhost'

        if (apiKey) {
          try {
            const espRes = await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ from: fromAddress, to: [user.email], subject, html: bodyHtml }),
            })
            if (!espRes.ok) console.error(`[reminders.process] ESP error:`, await espRes.text().catch(() => ''))
          } catch (sendErr) {
            console.error(`[reminders.process] Failed to send to ${user.email}:`, sendErr)
          }
        } else {
          console.log(`[reminders.process] No ESP configured. Reminder for ${user.email}: ${subject}`)
        }

        await knex('reminders').where('id', reminder.id).update({
          sent: true,
          sent_at: new Date(),
        })

        processed++
      } catch (reminderErr) {
        console.error(`[reminders.process] Error processing reminder ${reminder.id}:`, reminderErr)
      }
    }

    return NextResponse.json({ ok: true, processed })
  } catch (error) {
    console.error('[reminders.process]', error)
    return NextResponse.json({ ok: false, error: 'Failed to process reminders' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Reminders',
  summary: 'Process due reminders',
  methods: {
    POST: { summary: 'Process due reminders and send notification emails (cron)', tags: ['Reminders'] },
  },
}
