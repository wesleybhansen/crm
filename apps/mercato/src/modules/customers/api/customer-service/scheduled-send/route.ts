// ORM-SKIP: fires held (scheduled) customer-service auto-sends after their hold
// window, with the safety rails: kill switch, hourly rate cap, and a circuit
// breaker that auto-pauses an org that keeps cancelling its scheduled sends.
export const metadata = {
  path: '/customer-service/scheduled-send',
  POST: { requireAuth: false },
}

import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { requireProcessAuth } from '@/lib/cron-auth'
import { sendReply } from '@/modules/customers/lib/send-reply'

// If this many scheduled auto-sends are cancelled by the user within the window,
// the org's auto-sending trips the circuit breaker and pauses itself.
const BREAKER_CANCELS = 3
const BREAKER_WINDOW_HOURS = 6

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function safeParse(s: any): Record<string, any> {
  if (s && typeof s === 'object') return s
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}

export async function POST(req: Request) {
  const denied = requireProcessAuth(req, process.env.SEQUENCE_PROCESS_SECRET)
  if (denied) return denied

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const now = new Date()

    const settingsRows = await knex('customer_service_settings').where('enabled', true)
    const results: Array<{ orgId: string; sent: number; paused: boolean; tripped: boolean }> = []

    for (const settings of settingsRows) {
      const orgId = settings.organization_id
      const tenantId = settings.tenant_id
      let sent = 0
      let tripped = false

      try {
        // ── Stale-claim recovery ── a row stuck in 'sending' (a crash between
        // claim and finalize) is released back to pending so it isn't lost.
        await knex('inbox_proposal_actions')
          .where('organization_id', orgId)
          .where('status', 'sending')
          .where('updated_at', '<', new Date(now.getTime() - 10 * 60 * 1000))
          .update({ status: 'pending', updated_at: now })

        // ── Circuit breaker ── if too many scheduled sends were cancelled
        // (dismissed) recently, pause the org and skip. It stays paused until
        // the user turns automatic sending back on.
        if (settings.auto_send_paused !== true) {
          const since = new Date(now.getTime() - BREAKER_WINDOW_HOURS * 3600 * 1000)
          // Only count cancellations since the user last resumed, so hitting
          // "Resume sending" isn't instantly re-tripped by the same dismissals.
          const resumedAt = settings.auto_send_resumed_at ? new Date(settings.auto_send_resumed_at) : null
          const windowStart = resumedAt && resumedAt.getTime() > since.getTime() ? resumedAt : since
          const cancelled = await knex('inbox_proposal_actions')
            .where('organization_id', orgId)
            .where('status', 'dismissed')
            .whereRaw("metadata->>'auto_scheduled' = 'true'")
            .where('updated_at', '>=', windowStart)
            .count('* as c')
            .first()
          if (Number(cancelled?.c || 0) >= BREAKER_CANCELS) {
            await knex('customer_service_settings').where('id', settings.id).update({ auto_send_paused: true, updated_at: now })
            tripped = true
          }
        }

        // Kill switch (or just-tripped breaker): don't send.
        if (settings.auto_send_paused === true || tripped) {
          results.push({ orgId, sent: 0, paused: true, tripped })
          continue
        }

        // ── Rate cap ── how many auto-sends are still allowed this hour.
        const hourAgo = new Date(now.getTime() - 3600 * 1000)
        const sentLastHour = await knex('inbox_proposal_actions')
          .where('organization_id', orgId)
          .where('status', 'sent')
          .whereRaw("metadata->>'auto_sent' = 'true'")
          .where('executed_at', '>=', hourAgo)
          .count('* as c')
          .first()
        const cap = Number.isFinite(Number(settings.auto_send_hourly_cap)) ? Number(settings.auto_send_hourly_cap) : 20
        let remaining = Math.max(0, cap - Number(sentLastHour?.c || 0))
        if (remaining <= 0) {
          results.push({ orgId, sent: 0, paused: false, tripped })
          continue
        }

        // ── Due scheduled sends ── pending draft_reply actions whose hold
        // window has elapsed. Org+tenant scoped.
        const due = await knex('inbox_proposal_actions as a')
          .join('inbox_proposals as p', 'p.id', 'a.proposal_id')
          .where('a.organization_id', orgId)
          .where('a.tenant_id', tenantId)
          .where('a.status', 'pending')
          .where('p.status', 'pending')
          .whereRaw("a.metadata->>'auto_scheduled' = 'true'")
          .whereRaw("a.metadata->>'scheduled_send_at' <= ?", [now.toISOString()])
          .orderBy('a.created_at', 'asc')
          .limit(remaining)
          .select('a.id as action_id', 'a.proposal_id', 'a.payload', 'a.metadata')

        for (const row of due) {
          if (remaining <= 0) break
          const meta = safeParse(row.metadata)
          const payload = safeParse(row.payload)
          const to = payload.to as string | undefined
          const bodyText = (payload.body as string) || ''
          const subject = (payload.subject as string) || 'Re: your message'
          const contactId = (payload.contactId as string) || null

          // Malformed row: unschedule it so it can't starve the queue forever.
          if (!to || !bodyText) {
            await knex('inbox_proposal_actions')
              .where('id', row.action_id)
              .update({ updated_at: now, metadata: JSON.stringify({ ...meta, auto_scheduled: false }) })
            continue
          }

          // ── Atomic claim ── flip pending→sending in ONE guarded update. Only
          // the winner (rowcount 1) proceeds to send. This is the single point of
          // mutual exclusion against the Approve path, a Dismiss, and any
          // overlapping cron run — so a held reply can never be double-sent or
          // sent after the user cancelled it.
          const claimed = await knex('inbox_proposal_actions')
            .where('id', row.action_id)
            .where('status', 'pending')
            .whereRaw("metadata->>'auto_scheduled' = 'true'")
            .update({ status: 'sending', updated_at: now })
          if (!claimed) continue // someone else (approve/dismiss/other run) got it

          const sendResult = await sendReply(knex, orgId, tenantId, { to, subject, body: bodyText, contactId })
          if (sendResult.ok) {
            await knex('inbox_proposal_actions')
              .where('id', row.action_id)
              .update({
                status: 'sent',
                executed_at: now,
                updated_at: now,
                metadata: JSON.stringify({ ...meta, auto_sent: true, auto_scheduled: false }),
              })
            await knex('inbox_proposals').where('id', row.proposal_id).where('organization_id', orgId).update({ status: 'accepted', reviewed_at: now, updated_at: now })
            sent++
            remaining--
          } else {
            // Send failed (e.g. mailbox disconnected): release the claim back to a
            // plain pending draft for manual handling; clear the schedule so it
            // doesn't retry forever.
            await knex('inbox_proposal_actions')
              .where('id', row.action_id)
              .update({ status: 'pending', updated_at: now, metadata: JSON.stringify({ ...meta, auto_scheduled: false }) })
            console.error('[customer-service.scheduled-send] send failed, unscheduled', { orgId, actionId: row.action_id, err: sendResult.error })
          }
        }

        results.push({ orgId, sent, paused: false, tripped })
      } catch (orgErr) {
        console.error('[customer-service.scheduled-send] org error', { orgId, err: orgErr })
        results.push({ orgId, sent, paused: false, tripped })
      }
    }

    return NextResponse.json({ ok: true, orgs: results.length, results })
  } catch (error) {
    console.error('[customer-service.scheduled-send]', error)
    return NextResponse.json({ ok: false, error: 'Scheduled send failed' }, { status: 500 })
  }
}
