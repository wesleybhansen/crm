import type { Knex } from 'knex'
import crypto from 'crypto'
import { generateReplyDraft } from '@/modules/customers/lib/draft-reply'
import type { FlagScenarioInput } from '@/modules/customers/lib/draft-reply'
import { sendChatReply } from '@/modules/customers/lib/send-chat-reply'
import { meterCustomersAi } from '@/lib/usage/meter'
import { sendEmailByPurpose } from '@/modules/email/lib/email-router'

// Brief acknowledgement posted to the live visitor when a flag scenario pauses
// the reply for human review. No em dash; ends with a period.
const HOLDING_MESSAGE = 'Thanks for reaching out. A team member will follow up with you shortly.'

type FlagScenario = { key: string; label: string; enabled: boolean; action: 'pause' | 'auto_send'; instructions: string }
const VALID_FLAG_ACTIONS = new Set(['pause', 'auto_send'])

// Parse the org's stored flag_scenarios jsonb (parsed object or string) into a
// clean, validated array. Mirrors the customer-service processor's parser so the
// chat path applies the SAME flag rules as email/SMS. Returns [] when nothing
// usable is present (no flagging => every chat message auto-answers).
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
    const label = typeof item.label === 'string' ? item.label : ''
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

function toDrafterScenarios(scenarios: FlagScenario[]): FlagScenarioInput[] {
  return scenarios.filter((s) => s.enabled).map((s) => ({ key: s.key, label: s.label, instructions: s.instructions }))
}

// Given matched keys + the org's scenarios, decide the outcome. Pause wins: if
// ANY matched scenario is 'pause', the reply is held for review. Only when ALL
// matched scenarios are 'auto_send' does the scenario-instructed reply go out.
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

// Email the org user a flag alert for a paused chat message. Reuses the SAME
// transactional path the customer-service processor uses; best-effort.
async function sendChatFlagAlert(
  knex: Knex,
  orgId: string,
  tenantId: string,
  d: { contactName: string; reasons: Array<{ key: string; label: string }>; preview: string },
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
    const esc = (s: string) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const subject = 'A website chat message was flagged'
    const htmlBody = `
      <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; font-size: 14px; color: #1f2937; line-height: 1.6;">
        <p>A website chat message from <strong>${esc(d.contactName)}</strong> matched ${labels.length > 1 ? 'these flag scenarios' : 'a flag scenario'}: <strong>${esc(scenarioLine)}</strong>.</p>
        <p>The reply is waiting in your review queue. The visitor was told a team member will follow up.</p>
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
    console.error('[cs-chat] flag alert email failed', { orgId, err })
  }
}

// Create a FLAGGED, pending customer-service proposal for a chat reply held for
// review. Reuses the same inbox-proposal review mechanism as the email/SMS CS
// drafts (synthetic inbox_emails row + inbox_proposals + a draft_reply
// inbox_proposal_actions carrying the body). channel='chat' so the queue renders
// a chat indicator and the approve route delivers it into the chat conversation.
async function createChatDraftProposal(
  knex: Knex,
  orgId: string,
  tenantId: string,
  d: {
    displayName: string
    contactHandle: string | null
    contactId: string | null
    conversationId: string
    body: string
    lastInboundPreview: string
    confidence?: number
    flagReasons: Array<{ key: string; label: string }>
  },
) {
  const now = new Date()
  const conf = typeof d.confidence === 'number' && Number.isFinite(d.confidence)
    ? Math.min(1, Math.max(0, d.confidence))
    : 0.7
  const emailId = crypto.randomUUID()
  await knex('inbox_emails').insert({
    id: emailId,
    tenant_id: tenantId,
    organization_id: orgId,
    forwarded_by_address: 'customer-service@noliai.com',
    to_address: d.contactHandle || d.displayName,
    subject: `Draft chat reply for ${d.displayName}`,
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
    summary: `Draft chat reply for ${d.displayName}. A website chat message was flagged for your review.`,
    participants: JSON.stringify([{ name: d.displayName, email: d.contactHandle }]),
    confidence: conf,
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
    description: `Send the drafted chat reply to ${d.displayName}`,
    payload: JSON.stringify({
      channel: 'chat',
      to: d.contactHandle,
      toName: d.displayName,
      contactId: d.contactId,
      conversationId: d.conversationId,
      body: d.body,
      lastInboundPreview: d.lastInboundPreview,
    }),
    status: 'pending',
    executed_at: null,
    confidence: conf,
    metadata: JSON.stringify({
      feature_source: 'customer_service',
      auto_sent: false,
      channel: 'chat',
      flagged: true,
      flagReasons: d.flagReasons,
    }),
    created_at: now,
    updated_at: now,
  })
}

/**
 * Customer-Service handling of a single inbound website-chat message. Called from
 * the public chat route's bot path ONLY when the org has cs_chat_enabled. The
 * caller has already run the allowance gate, max-bot-responses guard, and handoff
 * guard, and passes the resolved transcript + ai key.
 *
 * Behavior (the chosen "auto-answer + flag-escalate"):
 *   - No scenario matched     -> auto-answer: post the drafter's body to the
 *                                visitor instantly (as a bot message).
 *   - Flagged, all auto_send  -> post the scenario-instructed body to the visitor.
 *   - Flagged, any pause      -> do NOT post the draft. Store a flagged CS
 *                                proposal (with the drafted body), email the org
 *                                an alert, and post a brief holding message.
 *
 * Returns true when it handled the message (the caller should then stop). Returns
 * false on a drafting failure so the caller can fall back to its existing widget
 * bot, preserving the old behavior on errors.
 */
export async function handleCsChatMessage(
  knex: Knex,
  args: {
    aiKey: string
    byoKey: boolean
    orgId: string
    tenantId: string
    conversation: {
      id: string
      organization_id: string
      tenant_id: string
      contact_id?: string | null
      visitor_name?: string | null
      visitor_email?: string | null
    }
    settings: { flag_scenarios?: any; signature?: string | null }
    // Recent transcript oldest-to-newest; the drafter slices the last 10.
    recentMessages: Array<{ direction: string; bodyText: string; body: string }>
    lastInboundText: string
  },
): Promise<boolean> {
  const { aiKey, byoKey, orgId, tenantId, conversation, settings, recentMessages, lastInboundText } = args

  const flagScenarios = parseFlagScenarios(settings.flag_scenarios)
  const drafterScenarios = toDrafterScenarios(flagScenarios)

  const result = await generateReplyDraft(knex, aiKey, {
    orgId,
    channel: 'chat',
    recentMessages,
    contactId: conversation.contact_id || null,
    // Chat replies stay conversational; the drafter's chat hint emits no
    // greeting/sign-off block, so pass NO signature.
    signature: null,
    flagScenarios: drafterScenarios,
    criticGate: true,
  })

  void meterCustomersAi({ orgId }, {
    model: result.model,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    feature: 'customer-service-draft',
    byoKey,
  })

  if (!result.ok || !result.draft) return false

  const displayName = conversation.visitor_name || conversation.visitor_email || 'Visitor'
  const lastInboundPreview = (lastInboundText || '').toString().substring(0, 200)

  const matched = result.matchedScenarios || []
  const flagged = matched.length > 0
  const flagOutcome = flagged ? resolveFlagOutcome(matched, flagScenarios) : null

  // Pause wins: any matched 'pause' scenario escalates instead of replying.
  if (flagOutcome && flagOutcome.shouldPause) {
    await createChatDraftProposal(knex, orgId, tenantId, {
      displayName,
      contactHandle: conversation.visitor_email || null,
      contactId: conversation.contact_id || null,
      conversationId: conversation.id,
      body: result.draft,
      lastInboundPreview,
      confidence: result.confidence,
      flagReasons: flagOutcome.reasons,
    })
    await sendChatFlagAlert(knex, orgId, tenantId, {
      contactName: displayName,
      reasons: flagOutcome.reasons,
      preview: lastInboundPreview,
    })
    // Acknowledge the live visitor without posting the held draft.
    await sendChatReply(knex, conversation, { body: HOLDING_MESSAGE, isBot: true })
    return true
  }

  // Not flagged, or flagged with all matched scenarios action='auto_send':
  // post the drafted body to the visitor instantly.
  await sendChatReply(knex, conversation, { body: result.draft, isBot: true })
  return true
}
