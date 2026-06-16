// ORM-SKIP: recurring multi-org engine that drafts replies to new personal-inbox mail
export const metadata = {
  path: '/inbox/process',
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
import type { FlagScenarioInput } from '@/modules/customers/lib/draft-reply'
import { sendReply } from '@/modules/customers/lib/send-reply'
import { sendEmailByPurpose } from '@/modules/email/lib/email-router'
import { isAutomatedMail } from '@/lib/automated-mail'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

// Recurring personal-Inbox drafting engine. Mirrors the Customer Service
// processor (customer-service/process) but is scoped to inbound EMAIL in the
// PERSONAL inbox (source_mailbox_purpose IS NULL). It reads the org's
// inbox_ai_settings (reply_mode / hybrid threshold / flag scenarios / tone /
// signature) + the inbox_knowledge grounding library, drafts a reply through the
// SHARED generateReplyDraft helper, then drafts / auto-sends / holds per the
// org's reply mode and any matched flag scenario. SMS is a later follow-on.

// Hard cap on conversations processed per org per run.
const BATCH_PER_ORG = 25

const VALID_MODES = new Set(['draft', 'auto', 'hybrid'])
const DEFAULT_HYBRID_THRESHOLD = 0.85

export const openApi: OpenApiRouteDoc = {
  tag: 'Inbox',
  summary: 'Personal Inbox recurring processor',
  methods: {
    POST: { summary: 'Cron: draft/auto-send replies for new inbound personal-inbox email (draft | auto | hybrid)', tags: ['Inbox'] },
  },
}

export async function POST(req: Request) {
  // Cron auth (fail-closed, constant-time). NOT requireAuth. Uses the SAME
  // SEQUENCE_PROCESS_SECRET as the other customers-module AI crons (including
  // the Customer Service processor) so it shares the box wrapper-script pattern.
  const denied = requireProcessAuth(req, process.env.SEQUENCE_PROCESS_SECRET)
  if (denied) return denied

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // Only orgs that have explicitly enabled the Inbox AI desk.
    const settingsRows = await knex('inbox_ai_settings').where('enabled', true)

    const results: Array<{ orgId: string; mode: string; candidates: number; queued: number; autoSent: number; skipped: number; skippedAutomated: number }> = []

    for (const settings of settingsRows) {
      const orgId = settings.organization_id
      const tenantId = settings.tenant_id
      const mode = VALID_MODES.has(settings.reply_mode) ? settings.reply_mode : 'draft'
      const hybridThreshold = settings.hybrid_confidence_threshold != null
        ? Number(settings.hybrid_confidence_threshold)
        : DEFAULT_HYBRID_THRESHOLD
      // Flag scenarios for this org (full validated list) + the enabled subset
      // handed to the drafter. Empty = no flagging.
      const flagScenarios = parseFlagScenarios(settings.flag_scenarios)
      const drafterScenarios = toDrafterScenarios(flagScenarios)
      let queued = 0
      let autoSent = 0
      let skipped = 0
      let skippedAutomated = 0

      try {
        // Skip orgs over their AI allowance (don't bill the platform for cron AI).
        // Over-allowance orgs with a BYO key run on that key.
        const gate = await checkCustomersAiAllowance({ orgId })
        if (!gate.allowed) {
          results.push({ orgId, mode, candidates: 0, queued: 0, autoSent: 0, skipped: 0, skippedAutomated: 0 })
          continue
        }
        const aiKey = gate.byoApiKey || process.env.GOOGLE_GENERATIVE_AI_API_KEY
        if (!aiKey) {
          results.push({ orgId, mode, candidates: 0, queued: 0, autoSent: 0, skipped: 0, skippedAutomated: 0 })
          continue
        }

        // New inbound personal-inbox inquiries: open conversations, last message
        // inbound, NOT a support-mailbox row (source_mailbox_purpose IS NULL =
        // personal inbox), and not yet drafted by this engine.
        const conversations = await knex('inbox_conversations')
          .where('organization_id', orgId)
          .where('tenant_id', tenantId)
          .where('status', 'open')
          .where('last_message_direction', 'inbound')
          .whereNull('source_mailbox_purpose')
          .whereNull('inbox_drafted_at')
          .orderBy('last_message_at', 'desc')
          .limit(BATCH_PER_ORG)

        for (const conv of conversations) {
          try {
            // Personal inbox engine drafts EMAIL only. Anything else (sms/chat)
            // is marked drafted so it is not reprocessed every run.
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

            // Never draft a reply to no-reply / automated / bulk mail. Mark
            // drafted so it is not reprocessed, and create no draft.
            const inboundMeta = parseMetadata(inbound.metadata)
            if (isAutomatedMail({
              fromAddress: inbound.from_address,
              subject: inbound.subject,
              headers: inboundMeta?.headers,
            })) {
              await markDrafted(knex, conv.id, orgId)
              skippedAutomated++
              continue
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

            // Shared drafting helper. knowledgeTable: 'inbox_knowledge' grounds on
            // the personal Inbox library (model answers + documents + web pages)
            // rather than the Customer Service one. Tone / instructions / signature
            // are read inside the helper from inbox_ai_settings.
            const result = await generateReplyDraft(knex, aiKey, {
              orgId,
              channel: 'email',
              recentMessages,
              contactId,
              signature: settings.signature || null,
              flagScenarios: drafterScenarios,
              knowledgeTable: 'inbox_knowledge',
            })

            void meterCustomersAi({ orgId }, {
              model: result.model,
              tokensIn: result.tokensIn,
              tokensOut: result.tokensOut,
              feature: 'inbox-draft',
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

            // Flag scenarios override the normal reply mode (same rule as CS):
            //   any matched scenario action 'pause'  -> always HOLD (even in
            //     auto/hybrid; flag-pause beats reply_mode), and email an alert.
            //   all matched scenarios 'auto_send'    -> send the draft.
            const matched = result.matchedScenarios || []
            const flagged = matched.length > 0
            const flagOutcome = flagged ? resolveFlagOutcome(matched, flagScenarios) : null

            // Decide whether to auto-send based on the org's reply mode.
            //   draft  -> never auto-send (always hold).
            //   auto   -> always auto-send.
            //   hybrid -> auto-send only when the drafter is confident AND
            //             flagged the reply auto-send-safe; otherwise hold.
            let shouldAutoSend = false
            if (mode === 'auto') {
              shouldAutoSend = true
            } else if (mode === 'hybrid') {
              shouldAutoSend = result.autoSendSafe === true && result.confidence >= hybridThreshold
            }

            // Flag override: pause wins over everything; all-auto_send forces send.
            if (flagOutcome) {
              shouldAutoSend = flagOutcome.shouldPause ? false : true
            }

            const flagMeta = flagged
              ? { flagged: true, flagReasons: flagOutcome?.reasons || [] }
              : undefined

            if (shouldAutoSend) {
              const sendResult = await sendReply(knex, orgId, tenantId, {
                to: toEmail,
                toName: displayName,
                subject,
                body: result.draft,
                contactId,
              })

              if (sendResult.ok) {
                await createDraftProposal(knex, orgId, tenantId, {
                  displayName,
                  toEmail,
                  contactId,
                  conversationId: conv.id,
                  subject,
                  body: result.draft,
                  lastInboundPreview,
                  confidence: result.confidence,
                  status: 'sent',
                  flag: flagMeta,
                })
                await markDrafted(knex, conv.id, orgId)
                autoSent++
              } else {
                // Send failed (e.g. no connected mailbox): fall back to holding
                // the draft for manual review rather than dropping it.
                console.error('[inbox.process] auto-send failed, holding instead', { orgId, convId: conv.id, err: sendResult.error })
                await createDraftProposal(knex, orgId, tenantId, {
                  displayName,
                  toEmail,
                  contactId,
                  conversationId: conv.id,
                  subject,
                  body: result.draft,
                  lastInboundPreview,
                  confidence: result.confidence,
                  status: 'pending',
                  flag: flagMeta,
                })
                await markDrafted(knex, conv.id, orgId)
                queued++
              }
            } else {
              await createDraftProposal(knex, orgId, tenantId, {
                displayName,
                toEmail,
                contactId,
                conversationId: conv.id,
                subject,
                body: result.draft,
                lastInboundPreview,
                confidence: result.confidence,
                status: 'pending',
                flag: flagMeta,
              })
              await markDrafted(knex, conv.id, orgId)
              queued++
            }

            // Flag alert: when this message was flagged, email the org user. Done
            // after the proposal is recorded so the queue link resolves to it.
            if (flagged && flagOutcome) {
              await sendFlagAlert(knex, orgId, tenantId, {
                contactName: displayName,
                contactHandle: toEmail,
                reasons: flagOutcome.reasons,
                paused: flagOutcome.shouldPause,
                preview: lastInboundPreview,
              })
            }
          } catch (convErr) {
            console.error('[inbox.process] conversation error', { orgId, convId: conv?.id, err: convErr })
            skipped++
          }
        }

        results.push({ orgId, mode, candidates: conversations.length, queued, autoSent, skipped, skippedAutomated })
        console.log('[inbox.process] org done', { orgId, mode, candidates: conversations.length, queued, autoSent, skipped, skippedAutomated })
      } catch (orgErr) {
        console.error('[inbox.process] org error', { orgId, err: orgErr })
        results.push({ orgId, mode, candidates: 0, queued, autoSent, skipped, skippedAutomated })
      }
    }

    const totals = results.reduce(
      (acc, r) => ({
        candidates: acc.candidates + r.candidates,
        queued: acc.queued + r.queued,
        autoSent: acc.autoSent + r.autoSent,
        skipped: acc.skipped + r.skipped,
        skippedAutomated: acc.skippedAutomated + r.skippedAutomated,
      }),
      { candidates: 0, queued: 0, autoSent: 0, skipped: 0, skippedAutomated: 0 },
    )
    console.log('[inbox.process] run complete', { orgs: results.length, ...totals })

    return NextResponse.json({ ok: true, data: { orgs: results.length, ...totals, perOrg: results } })
  } catch (error) {
    console.error('[inbox.process]', error)
    return NextResponse.json({ ok: false, error: 'Failed to process inbox queue' }, { status: 500 })
  }
}

// email_messages.metadata is jsonb; the driver may hand it back parsed or as a
// string. Coerce to an object (with optional headers map) either way.
function parseMetadata(raw: any): { headers?: Record<string, string> } | null {
  let obj: any = raw
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj) } catch { return null }
  }
  if (!obj || typeof obj !== 'object') return null
  return obj
}

type FlagScenario = { key: string; label: string; enabled: boolean; action: 'pause' | 'auto_send'; instructions: string }

const VALID_FLAG_ACTIONS = new Set(['pause', 'auto_send'])

// Parse the org's stored flag_scenarios jsonb (parsed object or string) into a
// clean, validated array. Returns [] when nothing usable is present.
function parseFlagScenarios(raw: any): FlagScenario[] {
  let arr: any = raw
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr) } catch { return [] }
  }
  if (!Array.isArray(arr)) return []
  const out: FlagScenario[] = []
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue
    const key = typeof item.key === 'string' ? item.key : ''
    if (!key) continue
    const action = VALID_FLAG_ACTIONS.has(item.action) ? item.action : 'pause'
    out.push({
      key,
      label: typeof item.label === 'string' ? item.label : '',
      enabled: item.enabled === true,
      action: action as 'pause' | 'auto_send',
      instructions: typeof item.instructions === 'string' ? item.instructions : '',
    })
  }
  return out
}

// Map enabled scenarios to the shape the drafter consumes (key/label/instructions).
function toDrafterScenarios(scenarios: FlagScenario[]): FlagScenarioInput[] {
  return scenarios.filter((s) => s.enabled).map((s) => ({ key: s.key, label: s.label, instructions: s.instructions }))
}

// Given the matched keys and the org's scenarios, decide the flag outcome:
//  - reasons: the matched {key,label} for metadata + the alert email
//  - shouldPause: true if ANY matched scenario is 'pause' (pause overrides
//    auto_send AND the org's reply_mode). false only when ALL matched are
//    'auto_send'.
function resolveFlagOutcome(matchedKeys: string[], scenarios: FlagScenario[]): { reasons: Array<{ key: string; label: string }>; shouldPause: boolean } {
  const byKey = new Map(scenarios.map((s) => [s.key, s]))
  const reasons: Array<{ key: string; label: string }> = []
  let anyPause = false
  for (const k of matchedKeys) {
    const s = byKey.get(k)
    if (!s || !s.enabled) continue
    reasons.push({ key: s.key, label: s.label })
    if (s.action === 'pause') anyPause = true
  }
  return { reasons, shouldPause: anyPause }
}

// Email the org user a flag alert. Reuses sendEmailByPurpose('transactional')
// (same user-notification path the CS engine + AI digest cron use) and sends to
// the org's primary active email connection address. Best-effort: never throws.
async function sendFlagAlert(
  knex: any,
  orgId: string,
  tenantId: string,
  d: {
    contactName: string
    contactHandle: string
    reasons: Array<{ key: string; label: string }>
    paused: boolean
    preview: string
  },
) {
  try {
    const recipient = await knex('email_connections')
      .where('organization_id', orgId)
      .where('is_active', true)
      .orderBy('is_primary', 'desc')
      .first()
    if (!recipient?.email_address) return

    const appUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
    const queueUrl = `${appUrl.replace(/\/$/, '')}/backend/inbox`
    const labels = d.reasons.map((r) => r.label).filter(Boolean)
    const scenarioLine = labels.length ? labels.join(', ') : 'a flagged scenario'
    const actionLine = d.paused
      ? 'The reply is waiting in your inbox for review. Nothing was sent automatically.'
      : 'A reply was drafted and sent automatically for this scenario.'

    const esc = (s: string) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const subject = 'An inbox message was flagged'
    const htmlBody = `
      <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; font-size: 14px; color: #1f2937; line-height: 1.6;">
        <p>An email from <strong>${esc(d.contactName)}</strong>${d.contactHandle ? ` (${esc(d.contactHandle)})` : ''} matched ${labels.length > 1 ? 'these flag scenarios' : 'a flag scenario'}: <strong>${esc(scenarioLine)}</strong>.</p>
        <p>${actionLine}</p>
        ${d.preview ? `<p style="color:#6b7280;"><em>They wrote:</em><br>${esc(d.preview)}</p>` : ''}
        <p><a href="${queueUrl}" style="color:#2563eb;">Open your inbox</a></p>
      </div>
    `.trim()

    await sendEmailByPurpose(knex, orgId, tenantId, 'transactional', {
      to: recipient.email_address,
      subject,
      htmlBody,
    })
  } catch (err) {
    console.error('[inbox.process] flag alert email failed', { orgId, err })
  }
}

async function markDrafted(knex: any, conversationId: string, orgId: string) {
  await knex('inbox_conversations')
    .where('id', conversationId)
    .where('organization_id', orgId)
    .update({ inbox_drafted_at: new Date() })
}

// Reuses the inbox-proposal review mechanism (same as the Customer Service
// engine): a synthetic inbox_emails row, an inbox_proposals row, and a
// draft_reply inbox_proposal_actions row carrying the drafted body. Marked
// feature_source = 'inbox' in metadata so the inbox draft read/approve/dismiss
// endpoints can find it (distinct from the CS queue's 'customer_service' rows).
// status 'pending' = held for approval; status 'sent' = an audit record for an
// already auto-sent reply (auto/hybrid modes).
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
    confidence?: number
    status?: 'pending' | 'sent'
    flag?: { flagged: boolean; flagReasons: Array<{ key: string; label: string }> }
  },
) {
  const now = new Date()
  const status = d.status || 'pending'
  const isSent = status === 'sent'
  const conf = typeof d.confidence === 'number' && Number.isFinite(d.confidence)
    ? Math.min(1, Math.max(0, d.confidence))
    : 0.7
  const emailId = crypto.randomUUID()
  await knex('inbox_emails').insert({
    id: emailId,
    tenant_id: tenantId,
    organization_id: orgId,
    forwarded_by_address: 'inbox@noliai.com',
    to_address: d.toEmail,
    subject: isSent ? `Auto-sent reply to ${d.displayName}` : `Draft reply for ${d.displayName}`,
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
    summary: isSent
      ? `Auto-sent reply to ${d.displayName}. A response was sent to their latest message.`
      : `Draft reply for ${d.displayName}. A response was drafted for their latest message.`,
    participants: JSON.stringify([{ name: d.displayName, email: d.toEmail }]),
    confidence: conf,
    category: 'inquiry',
    status: isSent ? 'accepted' : 'pending',
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
    description: isSent
      ? `Auto-sent the drafted reply to ${d.displayName}`
      : `Send the drafted reply to ${d.displayName}`,
    payload: JSON.stringify({
      to: d.toEmail,
      toName: d.displayName,
      contactId: d.contactId,
      conversationId: d.conversationId,
      subject: d.subject,
      body: d.body,
      lastInboundPreview: d.lastInboundPreview,
    }),
    status: isSent ? 'sent' : 'pending',
    executed_at: isSent ? now : null,
    confidence: conf,
    metadata: JSON.stringify({
      feature_source: 'inbox',
      auto_sent: isSent,
      channel: 'email',
      flagged: d.flag?.flagged === true,
      flagReasons: d.flag?.flagReasons || [],
    }),
    created_at: now,
    updated_at: now,
  })
}
