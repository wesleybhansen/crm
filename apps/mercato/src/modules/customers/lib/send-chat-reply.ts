import type { Knex } from 'knex'
import crypto from 'crypto'

/**
 * Shared outbound-chat insert. Posts a business-side message into a chat
 * conversation (visible to the website visitor on their next poll) and keeps the
 * unified inbox current. Mirrors the logic in
 * customers/api/chat/messages/route.ts so the public CS chat flow and the
 * authenticated agent-reply path use ONE insert path.
 *
 * `isBot` marks AI-generated replies (the visitor widget renders them the same,
 * but is_bot lets the widget-bot guard count its own responses). The
 * authenticated agent path passes isBot=false; the CS auto-answer path passes
 * isBot=true. Returns the inserted message id.
 *
 * The conversation must already be loaded + org-scoped by the caller. This helper
 * does not re-check org ownership; callers (the public route resolves the
 * conversation by id, the agent route scopes by auth.orgId) own that check.
 */
export async function sendChatReply(
  knex: Knex,
  conversation: {
    id: string
    organization_id: string
    tenant_id: string
    contact_id?: string | null
    visitor_name?: string | null
    visitor_email?: string | null
  },
  args: { body: string; isBot?: boolean; direction?: 'outbound' },
): Promise<string> {
  const msgId = crypto.randomUUID()
  const now = new Date()
  await knex('chat_messages').insert({
    id: msgId,
    conversation_id: conversation.id,
    sender_type: 'business',
    message: args.body,
    is_bot: args.isBot === true,
    created_at: now,
  })
  await knex('chat_conversations')
    .where('id', conversation.id)
    .update({ updated_at: now, agent_typing: false, agent_typing_at: null })
    .catch(() => {})

  // Keep the unified inbox list current (best-effort).
  try {
    const { upsertInboxConversation } = await import('@/lib/inbox-conversation')
    await upsertInboxConversation(knex, conversation.organization_id, conversation.tenant_id, {
      contactId: conversation.contact_id || null,
      chatConversationId: conversation.id,
      channel: 'chat',
      preview: args.body,
      direction: args.direction || 'outbound',
      displayName: conversation.visitor_name || conversation.visitor_email || 'Visitor',
      avatarEmail: conversation.visitor_email || null,
    }).catch(() => {})
  } catch { /* non-blocking */ }

  return msgId
}
