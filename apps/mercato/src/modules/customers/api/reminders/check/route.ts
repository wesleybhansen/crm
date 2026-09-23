// ORM-SKIP: uses raw pg query() — conversion requires SQL rewrite
export const metadata = { path: '/reminders/check', POST: { requireAuth: true } }
/**
 * Standalone reminder processor — called from the dashboard on page load.
 * Processes due reminders and sends notifications via connected email or ESP.
 */
import { sendPlatformNotification } from '@/modules/email/lib/platform-sender'
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { query, queryOne } from '@/lib/db'

export async function POST() {
  const auth = await getAuthFromCookies()
  const userId = auth?.sub
  if (!auth?.tenantId || !auth?.orgId || !userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    // Atomically claim and mark reminders in one query to prevent duplicates
    const dueReminders = await query(
      `UPDATE reminders SET sent = true, sent_at = now()
       WHERE id IN (
         SELECT id FROM reminders
         WHERE user_id = $1 AND sent = false AND remind_at <= now()
         ORDER BY remind_at ASC LIMIT 20
       )
       RETURNING *`,
      [userId]
    )

    if (dueReminders.length === 0) {
      return NextResponse.json({ ok: true, processed: 0 })
    }

    let processed = 0

    for (const reminder of dueReminders) {
      try {
        // Build context
        let entityLabel = reminder.entity_type
        if (reminder.entity_type === 'contact') {
          const contact = await queryOne('SELECT display_name FROM customer_entities WHERE id = $1', [reminder.entity_id])
          entityLabel = contact?.display_name || 'Contact'
        } else if (reminder.entity_type === 'deal') {
          const deal = await queryOne('SELECT title FROM customer_deals WHERE id = $1', [reminder.entity_id])
          entityLabel = deal?.title || 'Deal'
        } else if (reminder.entity_type === 'task') {
          const task = await queryOne('SELECT title FROM tasks WHERE id = $1', [reminder.entity_id])
          entityLabel = task?.title || 'Task'
        }

        const appUrl = process.env.APP_URL || 'http://localhost:3000'
        const subject = `Reminder: ${reminder.message}`
        const bodyHtml = `
          <div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px">
            <h2 style="font-size:18px;margin:0 0 12px">Reminder</h2>
            <p style="color:#555;font-size:15px;line-height:1.6;margin:0 0 16px">${reminder.message}</p>
            <p style="color:#888;font-size:13px">Related to: <strong>${entityLabel}</strong></p>
            <a href="${appUrl}/backend" style="display:inline-block;background:#0000CC;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;margin-top:16px">Open Noli CRM</a>
          </div>`

        // Send reminder notification to user
        let sent = false

        // Get user email
        const userRow = await queryOne('SELECT email FROM users WHERE id = $1', [userId])
        const gmailConn = await queryOne(
          `SELECT email_address FROM email_connections WHERE organization_id = $1 AND user_id = $2 AND provider = 'gmail' AND is_active = true LIMIT 1`,
          [auth.orgId, userId]
        )
        const userEmail = userRow?.email || gmailConn?.email_address

        if (!userEmail) {
          console.log(`[reminders.check] No email for user ${userId}. Reminder: ${reminder.message}`)
        } else {
          // From Noli to its user: the platform sender, never the user's own mailbox (a self-sent Gmail
          // reminder used to arrive "from" the user's personal address).
          const res = await sendPlatformNotification({ to: userEmail, subject, htmlBody: bodyHtml })
          if (res.ok) sent = true
          else console.error('[reminders.check] reminder not sent:', res.error)
        }

        // Already marked as sent atomically. Don't revert on failure — prevents infinite retry loops.
        if (sent) processed++
      } catch (err) {
        console.error(`[reminders.check] Error processing reminder ${reminder.id}:`, err)
      }
    }

    return NextResponse.json({ ok: true, processed })
  } catch (error) {
    console.error('[reminders.check]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
