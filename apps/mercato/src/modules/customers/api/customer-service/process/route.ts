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
import type { FlagScenarioInput } from '@/modules/customers/lib/draft-reply'
import { sendReply } from '@/modules/customers/lib/send-reply'
import { sendSmsReply } from '@/modules/customers/lib/send-sms-reply'
import { sendEmailByPurpose } from '@/modules/email/lib/email-router'
import { ingestImapConnection } from '@/modules/email/lib/inbox-ingest'
import { isAutomatedMail } from '@/lib/automated-mail'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

// Hard cap on conversations processed per org per run.
const BATCH_PER_ORG = 25
// Per-mailbox cap on inbound CS mail pulled per run.
const CS_FETCH_PER_MAILBOX = 50
// How far back to look on the first fetch (no prior watermark on the conn).
const CS_FETCH_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000

const VALID_MODES = new Set(['draft', 'auto', 'hybrid'])
const DEFAULT_HYBRID_THRESHOLD = 0.8

export const openApi: OpenApiRouteDoc = {
  tag: 'Customer Service',
  summary: 'Customer Service recurring processor',
  methods: {
    POST: { summary: 'Cron: draft/auto-send replies for new inbound inquiries (draft | auto | hybrid)', tags: ['Customer Service'] },
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

    const results: Array<{ orgId: string; mode: string; candidates: number; queued: number; autoSent: number; skipped: number; skippedAutomated: number }> = []

    for (const settings of settingsRows) {
      const orgId = settings.organization_id
      const tenantId = settings.tenant_id
      const mode = VALID_MODES.has(settings.reply_mode) ? settings.reply_mode : 'draft'
      const hybridThreshold = settings.hybrid_confidence_threshold != null
        ? Number(settings.hybrid_confidence_threshold)
        : DEFAULT_HYBRID_THRESHOLD
      // Per-source (per-mailbox) overrides, keyed by email_connection id. Falls
      // back to the global mode/threshold for sources without an entry.
      const sourceModes = parseSourceModes(settings.source_modes)
      // Flag scenarios for this org (full validated list) + the enabled subset
      // handed to the drafter. Empty = no flagging, existing behavior unchanged.
      const flagScenarios = parseFlagScenarios(settings.flag_scenarios)
      const drafterScenarios = toDrafterScenarios(flagScenarios)
      let queued = 0
      let autoSent = 0
      let skipped = 0
      let skippedAutomated = 0

      try {
        // ---- Dedicated support-mailbox fetch pass ----
        // Pull new inbound mail from this org's Customer Service mailboxes
        // (provider='smtp', purpose='customer_service') into inbox_conversations
        // BEFORE the draft loop, so the draft loop below can pick them up. This
        // runs independent of the AI allowance gate: even an over-allowance org
        // should still see support mail land in the queue for manual handling.
        // Each mailbox fetch is isolated so one bad credential can't break the run.
        try {
          const csConns = await knex('email_connections')
            .where('organization_id', orgId)
            .where('provider', 'smtp')
            .where('purpose', 'customer_service')
            .where('is_active', true)
            .whereNotNull('imap_host')
            .select('id', 'email_address', 'imap_host', 'imap_port', 'imap_secure', 'smtp_user', 'smtp_pass', 'cs_last_fetch_at', 'purpose')

          if (csConns.length > 0) {
            // Skip self-sent: don't ingest mail from our own connected mailboxes.
            const ownConns = await knex('email_connections')
              .where('organization_id', orgId)
              .where('is_active', true)
              .select('email_address')
            const ownEmails = new Set<string>(
              ownConns.map((c: any) => (c.email_address || '').toLowerCase()).filter(Boolean),
            )

            for (const conn of csConns) {
              try {
                const sinceDate = conn.cs_last_fetch_at
                  ? new Date(conn.cs_last_fetch_at)
                  : new Date(Date.now() - CS_FETCH_LOOKBACK_MS)
                const ingest = await ingestImapConnection(knex, orgId, tenantId, conn, {
                  sinceDate,
                  maxMessages: CS_FETCH_PER_MAILBOX,
                  autoCreateContacts: true,
                  source: 'customer_service',
                  ownEmails,
                })
                // Advance the per-mailbox watermark only when the fetch itself
                // succeeded (errors here are per-message, not connection-level).
                await knex('email_connections')
                  .where('id', conn.id)
                  .where('organization_id', orgId)
                  .update({ cs_last_fetch_at: new Date(), updated_at: new Date() })
                if (ingest.errors.length > 0) {
                  console.error('[customer-service.process] CS ingest partial errors', { orgId, connId: conn.id, errors: ingest.errors.slice(0, 5) })
                }
              } catch (connErr) {
                console.error('[customer-service.process] CS mailbox fetch failed', { orgId, connId: conn.id, err: connErr })
              }
            }
          }
        } catch (fetchErr) {
          console.error('[customer-service.process] CS fetch pass error', { orgId, err: fetchErr })
        }

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

        // Resolve watched connection email addresses (null/empty = all active).
        const watchedIds: string[] | null = Array.isArray(settings.watched_connection_ids)
          ? settings.watched_connection_ids
          : (settings.watched_connection_ids ? safeParse(settings.watched_connection_ids) : null)

        // {id, address} for each watched connection. Used both to filter
        // conversations (by inbound to_address) and to resolve the per-source
        // override for the matched connection. null = watching all mailboxes.
        let watched: Array<{ id: string; address: string }> | null = null
        let watchedAddresses: string[] | null = null
        if (watchedIds && watchedIds.length > 0) {
          const conns = await knex('email_connections')
            .where('organization_id', orgId)
            .whereIn('id', watchedIds)
            .select('id', 'email_address')
          watched = conns
            .map((c: any) => ({ id: c.id, address: (c.email_address || '').toLowerCase() }))
            .filter((c: any) => c.address)
          watchedAddresses = watched.map((c) => c.address)
          // Watching specific connections that no longer exist means nothing to do.
          if (watchedAddresses.length === 0) {
            results.push({ orgId, mode, candidates: 0, queued: 0, autoSent: 0, skipped: 0, skippedAutomated: 0 })
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

        // Dedicated customer-service SMS number for this org (E.164-normalized).
        // When set, inbound SMS conversations addressed to it are drafted too.
        const csSmsNumber = normalizeE164(settings.cs_sms_number)

        for (const conv of conversations) {
          try {
            // SMS conversations addressed to the dedicated CS number are handled
            // by a separate concise-reply path; everything else that is not email
            // is skipped (this engine only drafts email + dedicated-CS SMS).
            if (conv.last_message_channel === 'sms') {
              if (csSmsNumber) {
                const handled = await handleSmsConversation(knex, aiKey, {
                  conv, orgId, tenantId, mode, hybridThreshold, csSmsNumber,
                  signature: settings.signature || null,
                  byoKey: !!gate.byoApiKey,
                  flagScenarios,
                  drafterScenarios,
                })
                if (handled === 'queued') queued++
                else if (handled === 'sent') autoSent++
                else skipped++
              } else {
                // No CS SMS number configured: this SMS isn't ours to draft.
                await markDrafted(knex, conv.id, orgId)
                skipped++
              }
              continue
            }
            // Only email conversations can be drafted+sent by this engine.
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

            // Never draft a reply to no-reply / automated / bulk mail (noreply@,
            // mailer-daemon, newsletters, notifications, list/bulk blasts). Mark
            // drafted so it is not reprocessed every run, and do NOT create a
            // proposal. Conservative: a normal human reply is never skipped here.
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

            // Watched-connection filter: the inbound message must have been
            // addressed to one of the watched connection addresses. (Conversations
            // are not tied to a connection, so we match on the inbound to_address.)
            // Also capture WHICH watched connection it matched, so we can apply a
            // per-source override below.
            const toAddr = (inbound.to_address || '').toLowerCase()
            let matchedConnId: string | null = null
            if (watched) {
              const hit = watched.find((c) => toAddr.includes(c.address))
              if (!hit) { await markDrafted(knex, conv.id, orgId); skipped++; continue }
              matchedConnId = hit.id
            }

            // Resolve the effective mode + threshold for this conversation:
            // per-source override if the matched connection has one, else the
            // org-wide default. If we couldn't match a specific connection
            // (watching all, or no to_address match), use the global default.
            let effMode = mode
            let effThreshold = hybridThreshold
            if (matchedConnId && sourceModes[matchedConnId]) {
              const ov = sourceModes[matchedConnId]
              if (VALID_MODES.has(ov.mode)) {
                effMode = ov.mode
                effThreshold = Number.isFinite(ov.threshold) ? ov.threshold : hybridThreshold
              }
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
              flagScenarios: drafterScenarios,
              // The critic verdict only gates hybrid auto-send; auto mode sends
              // regardless and draft mode queues everything, so skip the extra call.
              criticGate: effMode === 'hybrid',
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

            // Flag scenarios override the normal reply mode. If the drafter
            // matched any enabled scenario, this message is FLAGGED: the user is
            // emailed an alert, and the action depends on the matched scenarios.
            //   any matched scenario action 'pause'  -> always QUEUE (even in
            //     auto/hybrid; flag-pause beats reply_mode).
            //   all matched scenarios 'auto_send'    -> send the draft.
            const matched = result.matchedScenarios || []
            const flagged = matched.length > 0
            const flagOutcome = flagged ? resolveFlagOutcome(matched, flagScenarios) : null

            // Decide whether to auto-send based on the org's reply mode.
            //   draft  -> never auto-send (always queue).
            //   auto   -> always auto-send.
            //   hybrid -> auto-send only when the drafter is confident AND
            //             flagged the reply auto-send-safe; otherwise queue.
            // Default to NOT sending whenever the signal is ambiguous.
            let shouldAutoSend = false
            if (effMode === 'auto') {
              shouldAutoSend = true
            } else if (effMode === 'hybrid') {
              shouldAutoSend = result.autoSendSafe === true && result.confidence >= effThreshold
            }

            // Flag override: pause wins over everything; all-auto_send forces send.
            if (flagOutcome) {
              shouldAutoSend = flagOutcome.shouldPause ? false : true
            }

            // Common flag metadata for the proposal/action rows.
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
                // Record an audit proposal already marked sent (same review-queue
                // mechanism approve uses), so auto-sent replies are visible.
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
                // Send failed (e.g. no connected mailbox): fall back to queuing
                // the draft for manual review rather than dropping it.
                console.error('[customer-service.process] auto-send failed, queuing instead', { orgId, convId: conv.id, err: sendResult.error })
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
                channel: 'email',
                reasons: flagOutcome.reasons,
                paused: flagOutcome.shouldPause,
                preview: lastInboundPreview,
              })
            }
          } catch (convErr) {
            console.error('[customer-service.process] conversation error', { orgId, convId: conv?.id, err: convErr })
            skipped++
          }
        }

        results.push({ orgId, mode, candidates: conversations.length, queued, autoSent, skipped, skippedAutomated })
        console.log('[customer-service.process] org done', { orgId, mode, candidates: conversations.length, queued, autoSent, skipped, skippedAutomated })
      } catch (orgErr) {
        console.error('[customer-service.process] org error', { orgId, err: orgErr })
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

// Normalize a phone number to E.164-ish form (+<digits>). Returns null for
// empty/invalid input. Used to match the dedicated CS number to inbound SMS.
function normalizeE164(v: unknown): string | null {
  if (typeof v !== 'string') return null
  let n = v.replace(/[\s\-\(\)\.]/g, '')
  if (!n) return null
  if (n.match(/^\d{10}$/)) n = `+1${n}`
  else if (n.match(/^1\d{10}$/)) n = `+${n}`
  else if (!n.startsWith('+')) n = `+${n}`
  return n
}

// Draft (and, per mode, send) a reply to a single inbound customer-service SMS
// conversation. Mirrors the email per-conversation handling but pulls the
// transcript from sms_messages, only proceeds when the latest inbound was sent
// to the org's dedicated CS number, and sends via the org's BYO Twilio. Returns
// 'queued' | 'sent' | 'skipped' so the caller can tally results. Always marks
// the conversation drafted so it is not reprocessed until a new inbound arrives.
async function handleSmsConversation(
  knex: any,
  aiKey: string,
  args: {
    conv: any
    orgId: string
    tenantId: string
    mode: string
    hybridThreshold: number
    csSmsNumber: string
    signature: string | null
    byoKey: boolean
    flagScenarios: FlagScenario[]
    drafterScenarios: FlagScenarioInput[]
  },
): Promise<'queued' | 'sent' | 'skipped'> {
  const { conv, orgId, tenantId, mode, hybridThreshold, csSmsNumber, signature, byoKey, flagScenarios, drafterScenarios } = args

  // Resolve the customer's phone number: prefer the conversation avatar_phone,
  // else the contact's primary_phone. We need it both to load the transcript and
  // as the reply recipient.
  let toPhone: string | null = normalizeE164(conv.avatar_phone)
  const contactId: string | null = conv.contact_id || null
  let contact: any = null
  if (contactId) {
    contact = await knex('customer_entities').where('id', contactId).where('organization_id', orgId).first()
    if (!toPhone) toPhone = normalizeE164(contact?.primary_phone)
  }
  if (!toPhone) { await markDrafted(knex, conv.id, orgId); return 'skipped' }

  // Load the recent SMS transcript for context. Match on contact_id when present,
  // otherwise on the customer phone (from_number for inbound, to_number for
  // outbound). All scoped to this org + the dedicated CS number so we never mix
  // in unrelated inbox SMS that used a different number.
  let txQuery = knex('sms_messages')
    .where('organization_id', orgId)
    .where(function (this: any) {
      this.where('from_number', toPhone).orWhere('to_number', toPhone)
    })
    .where(function (this: any) {
      // inbound to the CS number, or outbound from the CS number
      this.where('to_number', csSmsNumber).orWhere('from_number', csSmsNumber)
    })
    .orderBy('created_at', 'asc')
    .limit(50)
  if (contactId) {
    txQuery = knex('sms_messages')
      .where('organization_id', orgId)
      .where('contact_id', contactId)
      .where(function (this: any) {
        this.where('to_number', csSmsNumber).orWhere('from_number', csSmsNumber)
      })
      .orderBy('created_at', 'asc')
      .limit(50)
  }
  const smsMessages = await txQuery

  const inbound = [...smsMessages].reverse().find((m: any) => m.direction === 'inbound')
  if (!inbound) { await markDrafted(knex, conv.id, orgId); return 'skipped' }

  // Confirm the latest inbound really went to the dedicated CS number. The
  // conversation marker was set by the webhook, but re-check defensively.
  if (normalizeE164(inbound.to_number) !== csSmsNumber) {
    await markDrafted(knex, conv.id, orgId)
    return 'skipped'
  }

  const recentMessages = smsMessages.map((m: any) => ({
    direction: m.direction,
    bodyText: m.body,
    body: m.body,
  }))

  const result = await generateReplyDraft(knex, aiKey, {
    orgId,
    // 'sms' hint => the drafter keeps it brief and emits no greeting/sign-off
    // block. We pass NO signature so the SMS body stays short.
    channel: 'sms',
    recentMessages,
    contactId,
    signature: null,
    flagScenarios: drafterScenarios,
    criticGate: mode === 'hybrid',
  })

  void meterCustomersAi({ orgId }, {
    model: result.model,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    feature: 'customer-service-draft',
    byoKey,
  })

  if (!result.ok || !result.draft) { await markDrafted(knex, conv.id, orgId); return 'skipped' }

  const displayName = contact?.display_name || conv.display_name || toPhone
  const lastInboundPreview = (inbound.body || '').toString().substring(0, 200)

  // Flag scenarios override reply mode (same rule as email): pause beats
  // auto/hybrid, all-auto_send forces a send. Email the org user on any flag.
  const matched = result.matchedScenarios || []
  const flagged = matched.length > 0
  const flagOutcome = flagged ? resolveFlagOutcome(matched, flagScenarios) : null
  const flagMeta = flagged ? { flagged: true, flagReasons: flagOutcome?.reasons || [] } : undefined

  let shouldAutoSend = false
  if (mode === 'auto') shouldAutoSend = true
  else if (mode === 'hybrid') shouldAutoSend = result.autoSendSafe === true && result.confidence >= hybridThreshold
  if (flagOutcome) shouldAutoSend = flagOutcome.shouldPause ? false : true

  // Fire the flag alert once, regardless of which branch handles the draft.
  const fireAlert = async (paused: boolean) => {
    if (flagged && flagOutcome) {
      await sendFlagAlert(knex, orgId, tenantId, {
        contactName: displayName,
        contactHandle: toPhone,
        channel: 'sms',
        reasons: flagOutcome.reasons,
        paused,
        preview: lastInboundPreview,
      })
    }
  }

  if (shouldAutoSend) {
    const sendResult = await sendSmsReply(knex, orgId, tenantId, {
      to: toPhone,
      body: result.draft,
      contactId,
    })
    if (sendResult.ok) {
      await createSmsDraftProposal(knex, orgId, tenantId, {
        displayName, toPhone, contactId: contactId || '', conversationId: conv.id,
        body: result.draft, lastInboundPreview, confidence: result.confidence, status: 'sent', flag: flagMeta,
      })
      await markDrafted(knex, conv.id, orgId)
      await fireAlert(false)
      return 'sent'
    }
    // Send failed: fall back to queuing for manual review.
    console.error('[customer-service.process] SMS auto-send failed, queuing instead', { orgId, convId: conv.id, err: sendResult.error })
    await createSmsDraftProposal(knex, orgId, tenantId, {
      displayName, toPhone, contactId: contactId || '', conversationId: conv.id,
      body: result.draft, lastInboundPreview, confidence: result.confidence, status: 'pending', flag: flagMeta,
    })
    await markDrafted(knex, conv.id, orgId)
    await fireAlert(true)
    return 'queued'
  }

  await createSmsDraftProposal(knex, orgId, tenantId, {
    displayName, toPhone, contactId: contactId || '', conversationId: conv.id,
    body: result.draft, lastInboundPreview, confidence: result.confidence, status: 'pending', flag: flagMeta,
  })
  await markDrafted(knex, conv.id, orgId)
  await fireAlert(true)
  return 'queued'
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

// Per-source override map keyed by email_connection id. jsonb may arrive parsed
// or as a string depending on the driver path; coerce + validate either way.
function parseSourceModes(raw: any): Record<string, { mode: string; threshold: number }> {
  let obj: any = raw
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj) } catch { return {} }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {}
  const out: Record<string, { mode: string; threshold: number }> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (!v || typeof v !== 'object') continue
    const mode = (v as any).mode
    if (!VALID_MODES.has(mode)) continue
    const t = Number((v as any).threshold)
    out[k] = { mode, threshold: Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : DEFAULT_HYBRID_THRESHOLD }
  }
  return out
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
    const label = typeof item.label === 'string' ? item.label : ''
    if (!key) continue
    const action = VALID_FLAG_ACTIONS.has(item.action) ? item.action : 'pause'
    out.push({
      key,
      label,
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
// (same user-notification path the AI digest cron uses) and sends to the org's
// primary active email connection address (the org owner's mailbox). No new env
// var: APP_URL is already set for link building. Best-effort: never throws.
async function sendFlagAlert(
  knex: any,
  orgId: string,
  tenantId: string,
  d: {
    contactName: string
    contactHandle: string
    channel: 'email' | 'sms'
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
    const queueUrl = `${appUrl.replace(/\/$/, '')}/backend/customer-service`
    const labels = d.reasons.map((r) => r.label).filter(Boolean)
    const scenarioLine = labels.length ? labels.join(', ') : 'a flagged scenario'
    const channelLabel = d.channel === 'sms' ? 'text message' : 'email'
    const actionLine = d.paused
      ? 'The reply is waiting in your review queue. Nothing was sent automatically.'
      : 'A reply was drafted and sent automatically for this scenario.'

    const esc = (s: string) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const subject = 'A customer message was flagged'
    const htmlBody = `
      <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; font-size: 14px; color: #1f2937; line-height: 1.6;">
        <p>A customer ${channelLabel} from <strong>${esc(d.contactName)}</strong>${d.contactHandle ? ` (${esc(d.contactHandle)})` : ''} matched ${labels.length > 1 ? 'these flag scenarios' : 'a flag scenario'}: <strong>${esc(scenarioLine)}</strong>.</p>
        <p>${actionLine}</p>
        ${d.preview ? `<p style="color:#6b7280;"><em>They wrote:</em><br>${esc(d.preview)}</p>` : ''}
        <p><a href="${queueUrl}" style="color:#2563eb;">Open your Customer Service queue</a></p>
      </div>
    `.trim()

    await sendEmailByPurpose(knex, orgId, tenantId, 'transactional', {
      to: recipient.email_address,
      subject,
      htmlBody,
    })
  } catch (err) {
    console.error('[customer-service.process] flag alert email failed', { orgId, err })
  }
}

async function markDrafted(knex: any, conversationId: string, orgId: string) {
  await knex('inbox_conversations')
    .where('id', conversationId)
    .where('organization_id', orgId)
    .update({ cs_drafted_at: new Date() })
}

// Reuses the inbox-proposal review mechanism: a synthetic inbox_emails row, an
// inbox_proposals row (shown in the review queue), and a draft_reply
// inbox_proposal_actions row carrying the drafted body. Marked feature_source =
// customer_service in metadata so the queue/approve/dismiss endpoints can find
// it. status: 'pending' = queued for approval; status: 'sent' = an audit record
// for a reply already auto-sent (auto/hybrid modes), mirroring how approve marks
// rows (action -> 'sent', proposal -> 'accepted').
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
    // Set when the message matched a flag scenario; stored in action metadata so
    // the queue can render the flag badge + reasons.
    flag?: { flagged: boolean; flagReasons: Array<{ key: string; label: string }> }
  },
) {
  const now = new Date()
  const status = d.status || 'pending'
  const isSent = status === 'sent'
  // Confidence drives the queue display; clamp to a sane range and fall back to
  // the prior fixed 0.7 when the drafter gave no signal.
  const conf = typeof d.confidence === 'number' && Number.isFinite(d.confidence)
    ? Math.min(1, Math.max(0, d.confidence))
    : 0.7
  const emailId = crypto.randomUUID()
  await knex('inbox_emails').insert({
    id: emailId,
    tenant_id: tenantId,
    organization_id: orgId,
    forwarded_by_address: 'customer-service@noliai.com',
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
      ? `Auto-sent reply to ${d.displayName}. Noli sent a response to their latest message.`
      : `Draft reply for ${d.displayName}. Your team drafted a response to their latest message.`,
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
      feature_source: 'customer_service',
      auto_sent: isSent,
      channel: 'email',
      flagged: d.flag?.flagged === true,
      flagReasons: d.flag?.flagReasons || [],
    }),
    created_at: now,
    updated_at: now,
  })
}

// SMS variant of createDraftProposal. Same review-queue mechanism, but the
// payload carries channel='sms' + the phone number so the queue UI shows an SMS
// indicator and the approve endpoint sends via Twilio instead of email.
async function createSmsDraftProposal(
  knex: any,
  orgId: string,
  tenantId: string,
  d: {
    displayName: string
    toPhone: string
    contactId: string
    conversationId: string
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
  // Audit row reuses inbox_emails; to_address holds the phone for SMS.
  await knex('inbox_emails').insert({
    id: emailId,
    tenant_id: tenantId,
    organization_id: orgId,
    forwarded_by_address: 'customer-service@noliai.com',
    to_address: d.toPhone,
    subject: isSent ? `Auto-sent SMS to ${d.displayName}` : `Draft SMS reply for ${d.displayName}`,
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
      ? `Auto-sent SMS to ${d.displayName}. Noli texted a response to their latest message.`
      : `Draft SMS reply for ${d.displayName}. Your team drafted a text response to their latest message.`,
    participants: JSON.stringify([{ name: d.displayName, phone: d.toPhone }]),
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
      ? `Auto-sent the drafted SMS to ${d.displayName}`
      : `Send the drafted SMS to ${d.displayName}`,
    payload: JSON.stringify({
      channel: 'sms',
      to: d.toPhone,
      toName: d.displayName,
      contactId: d.contactId || null,
      conversationId: d.conversationId,
      body: d.body,
      lastInboundPreview: d.lastInboundPreview,
    }),
    status: isSent ? 'sent' : 'pending',
    executed_at: isSent ? now : null,
    confidence: conf,
    metadata: JSON.stringify({
      feature_source: 'customer_service',
      auto_sent: isSent,
      channel: 'sms',
      flagged: d.flag?.flagged === true,
      flagReasons: d.flag?.flagReasons || [],
    }),
    created_at: now,
    updated_at: now,
  })
}
