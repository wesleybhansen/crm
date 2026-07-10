import type { Knex } from 'knex'

/**
 * Incrementally-maintained AI summaries for threads (inbox_conversations) and
 * deals (customer_deals). Requires the ai_summary/ai_summary_at columns from
 * scripts/sql/ai-summaries-deal-thread.sql.
 *
 * Thread summaries give the reply drafter memory beyond its last-10-messages
 * window: on long conversations we summarize the OLDER messages once, cache the
 * result on the conversation row, and refresh lazily only when new messages
 * have arrived since the summary was written. Short threads never generate a
 * summary — the recent-message window already carries everything.
 *
 * Callers meter the returned token counts themselves (same contract as
 * draft-reply.ts): this module never meters.
 */

const SUMMARY_MODEL = 'gemini-2.5-flash'

// Must match the drafter's transcript window in draft-reply.ts (slice(-10)).
const RECENT_WINDOW = 10
// Only bother summarizing when there is meaningfully more history than the
// window shows. Below this the summary would just restate the transcript.
const MIN_MESSAGES_FOR_SUMMARY = RECENT_WINDOW + 4
// How many older messages feed the summary, newest-first from the pre-window
// backlog. Caps the prompt on very long threads.
const MAX_OLDER_MESSAGES = 40
const PER_MESSAGE_CAP = 400

export type ThreadSummaryResult = {
  summary: string | null
  tokensIn: number
  tokensOut: number
  model: string
}

type RawMessage = { direction: string; body: string; createdAt: string }

async function loadConversationMessages(
  knex: Knex,
  orgId: string,
  conv: Record<string, unknown>,
): Promise<RawMessage[]> {
  const channel = String(conv.last_message_channel || 'email')
  if (channel === 'chat' && conv.chat_conversation_id) {
    const rows = await knex('chat_messages')
      .where('conversation_id', conv.chat_conversation_id as string)
      .orderBy('created_at', 'asc')
      .select('sender_type', 'message', 'created_at')
      .catch(() => [])
    return rows.map((m: any) => ({
      direction: m.sender_type === 'visitor' ? 'inbound' : 'outbound',
      body: m.message || '',
      createdAt: m.created_at,
    }))
  }
  if (channel === 'sms' && conv.contact_id) {
    const rows = await knex('sms_messages')
      .where('contact_id', conv.contact_id as string)
      .where('organization_id', orgId)
      .orderBy('created_at', 'asc')
      .select('direction', 'body', 'created_at')
      .catch(() => [])
    return rows.map((m: any) => ({ direction: m.direction, body: m.body || '', createdAt: m.created_at }))
  }
  if (conv.contact_id) {
    const rows = await knex('email_messages')
      .where('contact_id', conv.contact_id as string)
      .where('organization_id', orgId)
      .orderBy('created_at', 'asc')
      .select('direction', 'subject', 'body_text', 'created_at')
      .catch(() => [])
    return rows.map((m: any) => ({
      direction: m.direction,
      body: m.body_text || m.subject || '',
      createdAt: m.created_at,
    }))
  }
  return []
}

/**
 * Return the cached thread summary, refreshing it first when the conversation
 * has grown past the drafter's window AND new messages arrived since the last
 * summary. Returns { summary: null } for short threads, missing conversations,
 * or any error — the drafter simply proceeds without the section.
 */
export async function maybeRefreshThreadSummary(
  knex: Knex,
  apiKey: string,
  orgId: string,
  conversationId: string,
): Promise<ThreadSummaryResult> {
  const none: ThreadSummaryResult = { summary: null, tokensIn: 0, tokensOut: 0, model: SUMMARY_MODEL }
  try {
    const conv = await knex('inbox_conversations')
      .where('id', conversationId)
      .where('organization_id', orgId)
      .first()
    if (!conv) return none

    // Fresh cache: nothing new since the summary was written.
    if (
      conv.ai_summary &&
      conv.ai_summary_at &&
      conv.last_message_at &&
      new Date(conv.ai_summary_at) >= new Date(conv.last_message_at)
    ) {
      return { ...none, summary: conv.ai_summary }
    }

    const messages = await loadConversationMessages(knex, orgId, conv)
    if (messages.length < MIN_MESSAGES_FOR_SUMMARY) {
      // Short thread: serve a stale cache if one exists, else nothing.
      return { ...none, summary: conv.ai_summary || null }
    }

    // Summarize the backlog the drafter cannot see (everything except the
    // recent window), capped from the newest side.
    const older = messages.slice(0, -RECENT_WINDOW).slice(-MAX_OLDER_MESSAGES)
    if (older.length === 0) return { ...none, summary: conv.ai_summary || null }

    const transcript = older
      .map((m) => `[${m.direction === 'inbound' ? 'Customer' : 'Business'}] ${m.body.toString().slice(0, PER_MESSAGE_CAP)}`)
      .join('\n')

    const prompt = `Summarize this customer conversation history in 4-6 sentences for an assistant that will draft the next reply. Cover: what the customer originally wanted, key facts established, any commitments or promises the business made, unresolved questions, and the customer's overall tone. Plain text only, no headings or bullets.

${transcript}`

    const aiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${SUMMARY_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 400, temperature: 0.3 },
        }),
      },
    )
    const aiData = await aiRes.json()
    const tokensIn = aiData?.usageMetadata?.promptTokenCount || 0
    const tokensOut = aiData?.usageMetadata?.candidatesTokenCount || 0
    const text: string | undefined = aiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
    if (!text) return { ...none, summary: conv.ai_summary || null, tokensIn, tokensOut }

    await knex('inbox_conversations')
      .where('id', conversationId)
      .where('organization_id', orgId)
      .update({ ai_summary: text, ai_summary_at: new Date(), updated_at: new Date() })

    return { summary: text, tokensIn, tokensOut, model: SUMMARY_MODEL }
  } catch {
    return none
  }
}
