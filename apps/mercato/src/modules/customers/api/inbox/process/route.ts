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
import { loadAudiences, resolveSenderAudiences, scenarioAudienceMatches } from '@/modules/customers/lib/audiences'
import type { Audience } from '@/modules/customers/lib/audiences'
import { sendReply } from '@/modules/customers/lib/send-reply'
import { sendSmsReply } from '@/modules/customers/lib/send-sms-reply'
import { sendEmailByPurpose } from '@/modules/email/lib/email-router'
import { isAutomatedMail } from '@/lib/automated-mail'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

// Recurring personal-Inbox drafting engine. Mirrors the Customer Service
// processor (customer-service/process) but is scoped to inbound EMAIL + SMS in
// the PERSONAL inbox (source_mailbox_purpose IS NULL). It reads the org's
// inbox_ai_settings (reply_mode / hybrid threshold / flag scenarios / tone /
// signature) + the inbox_knowledge grounding library, drafts a reply through the
// SHARED generateReplyDraft helper, then drafts / auto-sends / holds per the
// org's reply mode and any matched flag scenario. Email replies send via the
// shared sendReply path; SMS replies (channel 'sms') send via sendSmsReply.

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
      // Email content scenarios are re-filtered per-conversation by audience below;
      // the SMS path (senders are phone numbers) keeps the full org set.
      const drafterScenarios = toDrafterScenarios(flagScenarios)
      // Audiences (My team / Customers / …) — identity-based handling for this org.
      const audiences = await loadAudiences(knex, orgId)
      // Map each connected personal mailbox address -> its owning user, so a draft
      // can be stamped with the user whose inbox it belongs to. This scopes the
      // dashboard queue per-user in team orgs (a solo org has one mailbox -> one user).
      const personalConns = await knex('email_connections')
        .where('organization_id', orgId)
        .where('is_active', true)
        .whereNull('purpose')
        .select('email_address', 'user_id')
      const mailboxOwners = new Map<string, string>(
        (personalConns as Array<{ email_address?: string; user_id?: string }>)
          .filter((c) => c.email_address && c.user_id)
          .map((c) => [String(c.email_address).toLowerCase(), String(c.user_id)]),
      )
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
            // Atomic claim: flip inbox_drafted_at now, guarded on it still being
            // NULL, so an overlapping run (cron overlap, or cron + a manual trigger)
            // can't select and draft the same conversation twice → double-send. Only
            // the winner (rowcount 1) proceeds; a new inbound later resets the flag.
            const claimed = await knex('inbox_conversations')
              .where('id', conv.id)
              .where('organization_id', orgId)
              .whereNull('inbox_drafted_at')
              .update({ inbox_drafted_at: new Date() })
            if (!claimed) { skipped++; continue }

            // SMS personal-inbox conversations are drafted by a separate
            // concise-reply path (mirrors the Customer Service SMS handling):
            // pull the transcript from sms_messages, draft with channel 'sms',
            // then hold / auto-send / hold-on-flag per the same reply-mode rules.
            if (conv.last_message_channel === 'sms') {
              const handled = await handleSmsConversation(knex, aiKey, {
                conv, orgId, tenantId, mode, hybridThreshold,
                signature: settings.signature || null,
                byoKey: !!gate.byoApiKey,
                flagScenarios,
                drafterScenarios,
                audiences,
              })
              if (handled === 'queued') queued++
              else if (handled === 'sent') autoSent++
              else skipped++
              continue
            }
            // Anything else that is not email (e.g. chat) is marked drafted so it
            // is not reprocessed every run.
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
              await markDrafted(knex, conv.id, orgId, 'automated')
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

            // Audience (identity) handling: 'no_draft' (e.g. your own team) -> don't
            // draft at all, before spending AI. 'pause' -> always hold for review.
            const senderMatch = await resolveSenderAudiences(knex, orgId, audiences, inbound.from_address || toEmail, contact)
            if (senderMatch.action === 'no_draft') {
              await markDrafted(knex, conv.id, orgId)
              skipped++
              continue
            }

            // The user whose personal mailbox received this message — stamped on the
            // draft so only they see/approve it in the dashboard queue.
            const ownerUserId = mailboxOwners.get(String(inbound.to_address || '').toLowerCase()) || null

            // Audience-scoped guardrails: a content rule targeting a named audience
            // ('aud:*') applies only when the sender is in it; 'new'/'existing' gate on
            // prior correspondence; 'anyone' (or none) always applies.
            const contactIsNew = emailMessages.length <= 1
            const applicableScenarios = flagScenarios.filter((s) => {
              if (s.audience && s.audience.startsWith('aud:')) return scenarioAudienceMatches(s.audience, senderMatch)
              return (
                !s.audience ||
                s.audience === 'anyone' ||
                (s.audience === 'new' && contactIsNew) ||
                (s.audience === 'existing' && !contactIsNew)
              )
            })
            const convDrafterScenarios = toDrafterScenarios(applicableScenarios)

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
              flagScenarios: convDrafterScenarios,
              knowledgeTable: 'inbox_knowledge',
              // Critic only gates hybrid auto-send; skip the extra call otherwise.
              criticGate: mode === 'hybrid',
              conversationId: conv.id,
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
            const flagOutcome = flagged ? resolveFlagOutcome(matched, applicableScenarios) : null

            // A "don't draft" rule matched (e.g. automated / no-reply mail) — discard
            // the draft, mark handled so it isn't re-processed, and move on.
            if (flagOutcome?.noDraft) {
              await markDrafted(knex, conv.id, orgId)
              skipped++
              continue
            }

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

            // Audience 'pause' (e.g. VIP contacts): always hold for review.
            const audiencePause = senderMatch.action === 'pause'
            if (audiencePause) shouldAutoSend = false
            // Audience 'auto_send': in hybrid mode, treat as auto-send-safe (skip the
            // confidence gate). Never overrides a content pause; draft mode still holds.
            if (senderMatch.action === 'auto_send' && mode === 'hybrid' && !flagOutcome?.shouldPause) {
              shouldAutoSend = true
            }

            const audienceReasons = audiencePause
              ? [{ key: 'audience_pause', label: 'Held for review: message from a review-first audience' }]
              : []
            const flagMeta = flagged || audiencePause
              ? { flagged: true, flagReasons: [...(flagOutcome?.reasons || []), ...audienceReasons] }
              : undefined

            if (shouldAutoSend) {
              const sendResult = await sendReply(knex, orgId, tenantId, {
                to: toEmail,
                toName: displayName,
                subject,
                body: result.draft,
                contactId,
                // Personal inbox = 1:1 mail; no tracking/unsubscribe injection.
                skipTracking: true,
              })

              if (sendResult.ok) {
                await createDraftProposal(knex, orgId, tenantId, {
                  displayName,
                  toEmail,
                  contactId,
                  ownerUserId,
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
                  ownerUserId,
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
                ownerUserId,
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

// Normalize a phone number to E.164-ish form (+<digits>). Returns null for
// empty/invalid input. Used for the SMS reply recipient + transcript matching.
function normalizeE164(v: unknown): string | null {
  if (typeof v !== 'string') return null
  let n = v.replace(/[\s\-\(\)\.]/g, '')
  if (!n) return null
  if (n.match(/^\d{10}$/)) n = `+1${n}`
  else if (n.match(/^1\d{10}$/)) n = `+${n}`
  else if (!n.startsWith('+')) n = `+${n}`
  return n
}

// Draft (and, per mode, send) a reply to a single inbound personal-inbox SMS
// conversation. Mirrors the Customer Service SMS handler: it pulls the transcript
// from sms_messages, drafts with channel 'sms' (concise, no signature) through
// the SHARED generateReplyDraft helper, meters the call, then holds / auto-sends
// / holds-on-flag per the org's reply mode + matched flag scenarios. Auto-send
// goes through sendSmsReply (the org's connected Twilio); a missing SMS sender
// makes sendSmsReply return ok:false, and we fall back to HOLD rather than crash.
// Returns 'queued' | 'sent' | 'skipped' so the caller can tally. Always marks the
// conversation drafted so it is not reprocessed until a new inbound arrives.
async function handleSmsConversation(
  knex: any,
  aiKey: string,
  args: {
    conv: any
    orgId: string
    tenantId: string
    mode: string
    hybridThreshold: number
    signature: string | null
    byoKey: boolean
    flagScenarios: FlagScenario[]
    drafterScenarios: FlagScenarioInput[]
    audiences: Audience[]
  },
): Promise<'queued' | 'sent' | 'skipped'> {
  // drafterScenarios is re-derived per-conversation below (audience-gated), so the
  // pre-built set from the caller is intentionally not destructured here.
  const { conv, orgId, tenantId, mode, hybridThreshold, byoKey, flagScenarios, audiences } = args

  // Resolve the customer's phone number: prefer the conversation avatar_phone,
  // else the contact's primary_phone. Needed both to load the transcript and as
  // the reply recipient.
  let toPhone: string | null = normalizeE164(conv.avatar_phone)
  const contactId: string | null = conv.contact_id || null
  let contact: any = null
  if (contactId) {
    contact = await knex('customer_entities').where('id', contactId).where('organization_id', orgId).first()
    if (!toPhone) toPhone = normalizeE164(contact?.primary_phone)
  }
  if (!toPhone) { await markDrafted(knex, conv.id, orgId); return 'skipped' }

  // Audience (identity) handling for SMS — match by the contact's email/stage/CRM
  // list (there is no inbound email address on a text). no_draft -> skip before AI.
  const senderMatch = await resolveSenderAudiences(knex, orgId, audiences, contact?.primary_email || null, contact)
  if (senderMatch.action === 'no_draft') { await markDrafted(knex, conv.id, orgId); return 'skipped' }

  // Load the recent SMS transcript for context, org-scoped. Match on contact_id
  // when present, otherwise on the customer phone (from_number for inbound,
  // to_number for outbound).
  let txQuery = knex('sms_messages')
    .where('organization_id', orgId)
    .where(function (this: any) {
      this.where('from_number', toPhone).orWhere('to_number', toPhone)
    })
    .orderBy('created_at', 'asc')
    .limit(50)
  if (contactId) {
    txQuery = knex('sms_messages')
      .where('organization_id', orgId)
      .where('contact_id', contactId)
      .orderBy('created_at', 'asc')
      .limit(50)
  }
  const smsMessages = await txQuery

  const inbound = [...smsMessages].reverse().find((m: any) => m.direction === 'inbound')
  if (!inbound) { await markDrafted(knex, conv.id, orgId); return 'skipped' }

  // Audience-gate the content scenarios for this sender (parity with email): a rule
  // targeting a named audience only applies when the sender is in it.
  const contactIsNew = smsMessages.length <= 1
  const applicableScenarios = flagScenarios.filter((s) => {
    if (s.audience && s.audience.startsWith('aud:')) return scenarioAudienceMatches(s.audience, senderMatch)
    return !s.audience || s.audience === 'anyone' || (s.audience === 'new' && contactIsNew) || (s.audience === 'existing' && !contactIsNew)
  })
  const smsDrafterScenarios = toDrafterScenarios(applicableScenarios)

  const recentMessages = smsMessages.map((m: any) => ({
    direction: m.direction,
    bodyText: m.body,
    body: m.body,
  }))

  // Shared drafting helper. channel 'sms' keeps it brief and emits no
  // greeting/sign-off block; we pass NO signature so the body stays short.
  // knowledgeTable: 'inbox_knowledge' grounds on the personal Inbox library.
  const result = await generateReplyDraft(knex, aiKey, {
    orgId,
    channel: 'sms',
    recentMessages,
    contactId,
    signature: null,
    flagScenarios: smsDrafterScenarios,
    knowledgeTable: 'inbox_knowledge',
    criticGate: mode === 'hybrid',
    conversationId: conv.id,
  })

  void meterCustomersAi({ orgId }, {
    model: result.model,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    feature: 'inbox-draft',
    byoKey,
  })

  if (!result.ok || !result.draft) { await markDrafted(knex, conv.id, orgId); return 'skipped' }

  const displayName = contact?.display_name || conv.display_name || toPhone
  const lastInboundPreview = (inbound.body || '').toString().substring(0, 200)

  // Flag scenarios override reply mode (same rule as email): pause beats
  // auto/hybrid, all-auto_send forces a send. Email the org user on any flag.
  const matched = result.matchedScenarios || []
  const flagged = matched.length > 0
  const flagOutcome = flagged ? resolveFlagOutcome(matched, applicableScenarios) : null
  // A "don't draft" content rule matched — discard the draft and move on.
  if (flagOutcome?.noDraft) { await markDrafted(knex, conv.id, orgId); return 'skipped' }
  const flagMeta = flagged ? { flagged: true, flagReasons: flagOutcome?.reasons || [] } : undefined

  let shouldAutoSend = false
  if (mode === 'auto') shouldAutoSend = true
  else if (mode === 'hybrid') shouldAutoSend = result.autoSendSafe === true && result.confidence >= hybridThreshold
  if (flagOutcome) shouldAutoSend = flagOutcome.shouldPause ? false : true
  // Audience identity actions: 'pause' always holds; 'auto_send' relaxes the hybrid
  // gate (never over a content pause; draft mode still holds).
  if (senderMatch.action === 'pause') shouldAutoSend = false
  if (senderMatch.action === 'auto_send' && mode === 'hybrid' && !flagOutcome?.shouldPause) shouldAutoSend = true

  // Fire the flag alert once, regardless of which branch handles the draft.
  const fireAlert = async (paused: boolean) => {
    if (flagged && flagOutcome) {
      await sendFlagAlert(knex, orgId, tenantId, {
        contactName: displayName,
        contactHandle: toPhone || '',
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
    // Send failed (e.g. no connected Twilio / no SMS number configured): fall
    // back to holding the draft for manual review rather than dropping it.
    console.error('[inbox.process] SMS auto-send failed, holding instead', { orgId, convId: conv.id, err: sendResult.error })
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

// audience: 'anyone' | 'new' | 'existing' | 'aud:team' | 'aud:<audienceId>'
type FlagAction = 'pause' | 'auto_send' | 'no_draft'
type FlagScenario = { key: string; label: string; enabled: boolean; action: FlagAction; instructions: string; audience?: string }

const VALID_FLAG_ACTIONS = new Set(['pause', 'auto_send', 'no_draft'])

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
      action: action as FlagAction,
      instructions: typeof item.instructions === 'string' ? item.instructions : '',
      audience:
        item.audience === 'new' || item.audience === 'existing' || (typeof item.audience === 'string' && /^aud:[\w-]+$/.test(item.audience))
          ? item.audience
          : 'anyone',
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
function resolveFlagOutcome(matchedKeys: string[], scenarios: FlagScenario[]): { reasons: Array<{ key: string; label: string }>; shouldPause: boolean; noDraft: boolean } {
  const byKey = new Map(scenarios.map((s) => [s.key, s]))
  const reasons: Array<{ key: string; label: string }> = []
  let anyPause = false
  let anyNoDraft = false
  for (const k of matchedKeys) {
    const s = byKey.get(k)
    if (!s || !s.enabled) continue
    reasons.push({ key: s.key, label: s.label })
    if (s.action === 'pause') anyPause = true
    if (s.action === 'no_draft') anyNoDraft = true
  }
  return { reasons, shouldPause: anyPause, noDraft: anyNoDraft }
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
    channel?: 'email' | 'sms'
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
    const channelLabel = d.channel === 'sms' ? 'text message' : 'email'
    const actionLine = d.paused
      ? 'The reply is waiting in your inbox for review. Nothing was sent automatically.'
      : 'A reply was drafted and sent automatically for this scenario.'

    const esc = (s: string) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const subject = 'An inbox message was flagged'
    const htmlBody = `
      <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; font-size: 14px; color: #1f2937; line-height: 1.6;">
        <p>An ${channelLabel} from <strong>${esc(d.contactName)}</strong>${d.contactHandle ? ` (${esc(d.contactHandle)})` : ''} matched ${labels.length > 1 ? 'these flag scenarios' : 'a flag scenario'}: <strong>${esc(scenarioLine)}</strong>.</p>
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

async function markDrafted(knex: any, conversationId: string, orgId: string, skipReason?: string) {
  const update: Record<string, unknown> = { inbox_drafted_at: new Date() }
  if (skipReason) update.inbox_draft_skip_reason = skipReason
  await knex('inbox_conversations')
    .where('id', conversationId)
    .where('organization_id', orgId)
    .update(update)
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
    ownerUserId?: string | null
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
      owner_user_id: d.ownerUserId || null,
      auto_sent: isSent,
      channel: 'email',
      flagged: d.flag?.flagged === true,
      flagReasons: d.flag?.flagReasons || [],
    }),
    created_at: now,
    updated_at: now,
  })
}

// SMS variant of createDraftProposal. Same inbox review-queue mechanism, but the
// payload carries channel='sms' + the phone number so the queue UI shows an SMS
// indicator and the inbox approve endpoint sends via Twilio (sendSmsReply)
// instead of email. Marked feature_source='inbox' so the inbox read/approve/
// dismiss endpoints find it.
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
    forwarded_by_address: 'inbox@noliai.com',
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
      ? `Auto-sent SMS to ${d.displayName}. A text response was sent to their latest message.`
      : `Draft SMS reply for ${d.displayName}. A text response was drafted for their latest message.`,
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
      feature_source: 'inbox',
      auto_sent: isSent,
      channel: 'sms',
      flagged: d.flag?.flagged === true,
      flagReasons: d.flag?.flagReasons || [],
    }),
    created_at: now,
    updated_at: now,
  })
}
