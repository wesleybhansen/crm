// ORM-SKIP: recurring multi-org engine that drafts replies to new inquiries
export const metadata = {
  path: '/customer-service/process',
  POST: { requireAuth: false },
}

import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { requireProcessAuth } from '@/lib/cron-auth'
import { checkCustomersAiAllowance } from '@/lib/usage/allowance'
import { meterCustomersAi } from '@/lib/usage/meter'
import { generateReplyDraft } from '@/modules/customers/lib/draft-reply'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

// Hard cap on conversations processed per org per run.
const BATCH_PER_ORG = 25

export const openApi: OpenApiRouteDoc = {
  tag: 'Customer Service',
  summary: 'Customer Service recurring processor',
  methods: {
    POST: { summary: 'Cron: draft replies for new inbound inquiries (draft mode only)', tags: ['Customer Service'] },
  },
}

export async function POST(req: Request) {
  // Cron auth (fail-closed, constant-time). NOT requireAuth. Uses
  // SEQUENCE_PROCESS_SECRET to match the other customers-module AI crons
  // (relationship-decay/digest/reminders/sequences) and the /root/crm-cron scripts.
  const denied = requireProcessAuth(req, process.env.SEQUENCE_PROCESS_SECRET)
  if (denied) return denied

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // Only orgs that have explicitly enabled the feature.
    const settingsRows = await knex('customer_service_settings').where('enabled', true)

    const results: Array<{ orgId: string; candidates: number; drafted: number; skipped: number }> = []

    for (const settings of settingsRows) {
      const orgId = settings.organization_id
      const tenantId = settings.tenant_id
      let drafted = 0
      let skipped = 0

      try {
        // Skip orgs over their AI allowance (don't bill the platform for cron AI).
        // Over-allowance orgs with a BYO key run on that key.
        const gate = await checkCustomersAiAllowance({ orgId })
        if (!gate.allowed) {
          results.push({ orgId, candidates: 0, drafted: 0, skipped: 0 })
          continue
        }
        const aiKey = gate.byoApiKey || process.env.GOOGLE_GENERATIVE_AI_API_KEY
        if (!aiKey) {
          results.push({ orgId, candidates: 0, drafted: 0, skipped: 0 })
          continue
        }

        // Resolve watched connection email addresses (null/empty = all active).
        const watchedIds: string[] | null = Array.isArray(settings.watched_connection_ids)
          ? settings.watched_connection_ids
          : (settings.watched_connection_ids ? safeParse(settings.watched_connection_ids) : null)

        let watchedAddresses: string[] | null = null
        if (watchedIds && watchedIds.length > 0) {
          const conns = await knex('email_connections')
            .where('organization_id', orgId)
            .whereIn('id', watchedIds)
            .select('email_address')
          watchedAddresses = conns.map((c: any) => (c.email_address || '').toLowerCase()).filter(Boolean)
          // Watching specific connections that no longer exist means nothing to do.
          if (watchedAddresses.length === 0) {
            results.push({ orgId, candidates: 0, drafted: 0, skipped: 0 })
            continue
          }
        }

        // New inbound inquiries: open conversations, last message inbound, not yet drafted.
        const conversations = await knex('inbox_conversations')
          .where('organization_id', orgId)
          .where('tenant_id', tenantId)
          .where('status', 'open')
          .where('last_message_direction', 'inbound')
          .whereNull('cs_drafted_at')
          .orderBy('last_message_at', 'desc')
          .limit(BATCH_PER_ORG)

        for (const conv of conversations) {
          try {
            // Only email conversations can be drafted+sent by this engine in Phase 1.
            if (conv.last_message_channel && conv.last_message_channel !== 'email') {
              await markDrafted(knex, conv.id, orgId)
              skipped++
              continue
            }

            const contactId: string | null = conv.contact_id || null
            if (!contactId) { await markDrafted(knex, conv.id, orgId); skipped++; continue }

            // Load the recent email transcript for context + the latest inbound message.
            const emailMessages = await knex('email_messages')
              .where('contact_id', contactId)
              .where('organization_id', orgId)
              .orderBy('created_at', 'asc')
              .limit(50)

            const inbound = [...emailMessages].reverse().find((m: any) => m.direction === 'inbound')
            if (!inbound) { await markDrafted(knex, conv.id, orgId); skipped++; continue }

            // Watched-connection filter: the inbound message must have been
            // addressed to one of the watched connection addresses. (Conversations
            // are not tied to a connection, so we match on the inbound to_address.)
            if (watchedAddresses) {
              const toAddr = (inbound.to_address || '').toLowerCase()
              const matched = watchedAddresses.some((a) => toAddr.includes(a))
              if (!matched) { await markDrafted(knex, conv.id, orgId); skipped++; continue }
            }

            // Resolve recipient + contact.
            const contact = await knex('customer_entities')
              .where('id', contactId)
              .where('organization_id', orgId)
              .first()
            const toEmail: string | null = contact?.primary_email || conv.avatar_email || inbound.from_address || null
            if (!toEmail) { await markDrafted(knex, conv.id, orgId); skipped++; continue }

            const recentMessages = emailMessages.map((m: any) => ({
              direction: m.direction,
              bodyText: m.body_text,
              body: m.body_html,
            }))

            const result = await generateReplyDraft(knex, aiKey, {
              orgId,
              channel: 'email',
              recentMessages,
              contactId,
              signature: settings.signature || null,
            })

            void meterCustomersAi({ orgId }, {
              model: result.model,
              tokensIn: result.tokensIn,
              tokensOut: result.tokensOut,
              feature: 'customer-service-draft',
              byoKey: !!gate.byoApiKey,
            })

            if (!result.ok || !result.draft) {
              // Mark drafted so we don't retry a failing conversation every run.
              await markDrafted(knex, conv.id, orgId)
              skipped++
              continue
            }

            const displayName = contact?.display_name || conv.display_name || toEmail
            const inboundSubject = inbound.subject || ''
            const subject = inboundSubject
              ? (/^re:/i.test(inboundSubject) ? inboundSubject : `Re: ${inboundSubject}`)
              : 'Re: your message'
            const lastInboundPreview = (inbound.body_text || inbound.body_html || '').toString().substring(0, 200)

            await createDraftProposal(knex, orgId, tenantId, {
              displayName,
              toEmail,
              contactId,
              conversationId: conv.id,
              subject,
              body: result.draft,
              lastInboundPreview,
            })

            await markDrafted(knex, conv.id, orgId)
            drafted++
          } catch (convErr) {
            console.error('[customer-service.process] conversation error', { orgId, convId: conv?.id, err: convErr })
            skipped++
          }
        }

        results.push({ orgId, candidates: conversations.length, drafted, skipped })
        console.log('[customer-service.process] org done', { orgId, candidates: conversations.length, drafted, skipped })
      } catch (orgErr) {
        console.error('[customer-service.process] org error', { orgId, err: orgErr })
        results.push({ orgId, candidates: 0, drafted, skipped })
      }
    }

    const totals = results.reduce(
      (acc, r) => ({ candidates: acc.candidates + r.candidates, drafted: acc.drafted + r.drafted, skipped: acc.skipped + r.skipped }),
      { candidates: 0, drafted: 0, skipped: 0 },
    )
    console.log('[customer-service.process] run complete', { orgs: results.length, ...totals })

    return NextResponse.json({ ok: true, data: { orgs: results.length, ...totals, perOrg: results } })
  } catch (error) {
    console.error('[customer-service.process]', error)
    return NextResponse.json({ ok: false, error: 'Failed to process customer service queue' }, { status: 500 })
  }
}

function safeParse(s: any) {
  try { return JSON.parse(s) } catch { return null }
}

async function markDrafted(knex: any, conversationId: string, orgId: string) {
  await knex('inbox_conversations')
    .where('id', conversationId)
    .where('organization_id', orgId)
    .update({ cs_drafted_at: new Date() })
}

// Reuses the inbox-proposal review mechanism: a synthetic inbox_emails row, a
// pending inbox_proposals row (shown in the review queue), and a draft_reply
// inbox_proposal_actions row carrying the drafted body. Marked feature_source =
// customer_service in metadata so the queue/approve/dismiss endpoints can find
// it. Phase 1 NEVER auto-sends.
async function createDraftProposal(
  knex: any,
  orgId: string,
  tenantId: string,
  d: {
    displayName: string
    toEmail: string
    contactId: string
    conversationId: string
    subject: string
    body: string
    lastInboundPreview: string
  },
) {
  const now = new Date()
  const emailId = crypto.randomUUID()
  await knex('inbox_emails').insert({
    id: emailId,
    tenant_id: tenantId,
    organization_id: orgId,
    forwarded_by_address: 'customer-service@noliai.com',
    to_address: d.toEmail,
    subject: `Draft reply for ${d.displayName}`,
    status: 'processed',
    received_at: now,
    is_active: true,
    created_at: now,
    updated_at: now,
  })

  const proposalId = crypto.randomUUID()
  await knex('inbox_proposals').insert({
    id: proposalId,
    inbox_email_id: emailId,
    tenant_id: tenantId,
    organization_id: orgId,
    summary: `Draft reply for ${d.displayName}. Your team drafted a response to their latest message.`,
    participants: JSON.stringify([{ name: d.displayName, email: d.toEmail }]),
    confidence: 0.7,
    category: 'inquiry',
    status: 'pending',
    is_active: true,
    created_at: now,
    updated_at: now,
  })

  await knex('inbox_proposal_actions').insert({
    id: crypto.randomUUID(),
    proposal_id: proposalId,
    tenant_id: tenantId,
    organization_id: orgId,
    action_type: 'draft_reply',
    sort_order: 0,
    description: `Send the drafted reply to ${d.displayName}`,
    payload: JSON.stringify({
      to: d.toEmail,
      toName: d.displayName,
      contactId: d.contactId,
      conversationId: d.conversationId,
      subject: d.subject,
      body: d.body,
      lastInboundPreview: d.lastInboundPreview,
    }),
    status: 'pending',
    confidence: 0.7,
    metadata: JSON.stringify({ feature_source: 'customer_service' }),
    created_at: now,
    updated_at: now,
  })
}
