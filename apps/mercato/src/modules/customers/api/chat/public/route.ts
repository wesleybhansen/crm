import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import crypto from 'crypto'
import type { Knex } from 'knex'

export const metadata = {
  GET: { requireAuth: false },
  POST: { requireAuth: false },
  OPTIONS: { requireAuth: false },
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

function corsJson(data: any, init?: ResponseInit) {
  const headers = { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  return new NextResponse(JSON.stringify(data), { ...init, headers: { ...init?.headers, ...headers } })
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}

export async function POST(req: Request) {
  try {
    await bootstrap()
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()

    if (body.conversationId && body.message) {
      const conversation = await knex('chat_conversations').where('id', body.conversationId).first()
      if (!conversation) return corsJson({ ok: false, error: 'Conversation not found' }, { status: 404 })

      const msgId = crypto.randomUUID()
      await knex('chat_messages').insert({
        id: msgId,
        conversation_id: body.conversationId,
        sender_type: 'visitor',
        message: body.message.trim(),
        created_at: new Date(),
      })
      await knex('chat_conversations')
        .where('id', body.conversationId)
        .update({ updated_at: new Date(), visitor_typing: false, visitor_typing_at: null })

      // Update unified inbox
      try {
        const { upsertInboxConversation } = await import('@/lib/inbox-conversation')
        upsertInboxConversation(knex, conversation.organization_id, conversation.tenant_id, {
          contactId: conversation.contact_id || null,
          chatConversationId: body.conversationId,
          channel: 'chat',
          preview: body.message.trim(),
          direction: 'inbound',
          displayName: conversation.visitor_name || conversation.visitor_email || 'Visitor',
          avatarEmail: conversation.visitor_email,
        }).catch(() => {})
      } catch { /* non-blocking */ }

      // Fire-and-forget bot response
      tryBotResponse(knex, body.conversationId, conversation.widget_id).catch(() => {})

      return corsJson({ ok: true, data: { id: msgId } }, { status: 201 })
    }

    const { widgetId, visitorName, visitorEmail, message } = body
    if (!widgetId || !message?.trim()) {
      return corsJson({ ok: false, error: 'widgetId and message are required' }, { status: 400 })
    }

    const widget = await knex('chat_widgets').where('id', widgetId).andWhere('is_active', true).first()
    if (!widget) return corsJson({ ok: false, error: 'Widget not found or inactive' }, { status: 404 })

    let contactId: string | null = null
    if (visitorEmail) {
      const existingContact = await knex('customer_entities')
        .where('organization_id', widget.organization_id)
        .andWhere('primary_email', visitorEmail.trim().toLowerCase())
        .whereNull('deleted_at')
        .first()

      if (existingContact) {
        contactId = existingContact.id
      } else {
        contactId = crypto.randomUUID()
        const chatDisplayName = visitorName?.trim() || visitorEmail.trim()
        await knex('customer_entities').insert({
          id: contactId,
          tenant_id: widget.tenant_id,
          organization_id: widget.organization_id,
          kind: 'person',
          display_name: chatDisplayName,
          primary_email: visitorEmail.trim().toLowerCase(),
          source: 'chat_widget',
          status: 'active',
          email_status: 'active',
          created_at: new Date(),
          updated_at: new Date(),
        })
        const chatNameParts = chatDisplayName.split(' ')
        await knex('customer_people').insert({
          id: crypto.randomUUID(), tenant_id: widget.tenant_id, organization_id: widget.organization_id,
          entity_id: contactId, first_name: chatNameParts[0] || '', last_name: chatNameParts.slice(1).join(' ') || '',
          created_at: new Date(), updated_at: new Date(),
        }).catch(() => {})
      }
    }

    // Log chat start to timeline
    if (contactId) {
      const { logTimelineEvent } = await import('@/lib/timeline')
      await logTimelineEvent(knex, {
        tenantId: widget.tenant_id, organizationId: widget.organization_id, contactId,
        eventType: 'chat', title: 'Chat conversation started',
        description: visitorName ? `Started by ${visitorName}` : undefined,
      })
    }

    const conversationId = crypto.randomUUID()
    await knex('chat_conversations').insert({
      id: conversationId,
      tenant_id: widget.tenant_id,
      organization_id: widget.organization_id,
      widget_id: widgetId,
      contact_id: contactId,
      visitor_name: visitorName?.trim() || null,
      visitor_email: visitorEmail?.trim()?.toLowerCase() || null,
      status: 'open',
      created_at: new Date(),
      updated_at: new Date(),
    })

    const msgId = crypto.randomUUID()
    await knex('chat_messages').insert({
      id: msgId,
      conversation_id: conversationId,
      sender_type: 'visitor',
      message: message.trim(),
      created_at: new Date(),
    })

    // Update unified inbox
    try {
      const { upsertInboxConversation } = await import('@/lib/inbox-conversation')
      upsertInboxConversation(knex, widget.organization_id, widget.tenant_id, {
        contactId: contactId || null,
        chatConversationId: conversationId,
        channel: 'chat',
        preview: message.trim(),
        direction: 'inbound',
        displayName: visitorName?.trim() || visitorEmail?.trim() || 'Visitor',
        avatarEmail: visitorEmail?.trim() || null,
      }).catch(() => {})
    } catch { /* non-blocking */ }

    // Fire-and-forget bot response for new conversations
    tryBotResponse(knex, conversationId, widgetId).catch(() => {})

    return corsJson({
      ok: true,
      data: {
        conversationId,
        greeting: widget.greeting_message || 'Hi there! How can we help you today?',
      },
    }, { status: 201 })
  } catch (error) {
    console.error('[chat.public.post]', error)
    return corsJson({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export async function GET(req: Request) {
  try {
    await bootstrap()
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const url = new URL(req.url)
    const conversationId = url.searchParams.get('conversationId')
    if (!conversationId) return corsJson({ ok: false, error: 'conversationId required' }, { status: 400 })

    const conversation = await knex('chat_conversations').where('id', conversationId).first()
    if (!conversation) return corsJson({ ok: false, error: 'Not found' }, { status: 404 })

    const messages = await knex('chat_messages')
      .where('conversation_id', conversationId)
      .orderBy('created_at', 'asc')
      .select('id', 'sender_type', 'message', 'created_at', 'is_bot')

    return corsJson({
      ok: true,
      data: {
        messages,
        agent_typing: conversation.agent_typing,
        agent_typing_at: conversation.agent_typing_at,
      },
    })
  } catch (error) {
    console.error('[chat.public.get]', error)
    return corsJson({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

async function tryBotResponse(knex: Knex, conversationId: string, widgetId: string) {
  try {
    const widget = await knex('chat_widgets').where('id', widgetId).first()
    if (!widget?.bot_enabled) return

    const allMessages = await knex('chat_messages')
      .where('conversation_id', conversationId)
      .orderBy('created_at', 'desc')
      .limit(50)

    // Check if a handoff already occurred
    const lastHandoffMessage = allMessages.find(
      (m: { sender_type: string; message: string }) => m.sender_type === 'business' && m.message.includes('[HANDOFF]'),
    )
    if (lastHandoffMessage) return

    // Count existing bot messages in this conversation
    const botMessageCount = allMessages.filter(
      (m: { sender_type: string; is_bot?: boolean }) => m.sender_type === 'business' && m.is_bot,
    ).length

    const maxResponses = widget.bot_max_responses ?? 25
    const handoffMessage = widget.bot_handoff_message || 'Let me connect you with a team member who can help with that!'

    // If bot has reached max responses, auto-handoff instead of generating a new response
    if (botMessageCount >= maxResponses) {
      const handoffMsgId = crypto.randomUUID()
      await knex('chat_messages').insert({
        id: handoffMsgId,
        conversation_id: conversationId,
        sender_type: 'business',
        message: handoffMessage,
        is_bot: true,
        created_at: new Date(),
      })
      await knex('chat_conversations')
        .where('id', conversationId)
        .update({ updated_at: new Date() })
      return
    }

    const recentMessages = allMessages.slice(0, 10)
    const messagesForContext = [...recentMessages].reverse()

    let guardrailsBlock = ''
    if (widget.bot_guardrails?.trim()) {
      guardrailsBlock = `\n\nOFF-LIMITS TOPICS — NEVER discuss these topics. If the visitor asks about any of them, politely decline and offer to connect them with a human agent:
${widget.bot_guardrails}`
    }

    const systemPrompt = `You are a helpful AI assistant for a business. You answer customer questions based on the knowledge base provided.

KNOWLEDGE BASE:
${widget.bot_knowledge_base || 'No specific knowledge base provided.'}

PERSONALITY: ${widget.bot_personality || 'friendly and helpful'}

ADDITIONAL INSTRUCTIONS: ${widget.bot_instructions || 'None'}${guardrailsBlock}

RULES:
- Have a natural, flowing conversation. Engage like a real person would.
- Give thorough, helpful responses. Use enough detail to fully answer the question.
- Use the knowledge base to provide accurate, specific information when relevant.
- If you don't have the exact answer, try to be helpful with what you know. Only say "I don't know" if you truly can't help.
- Never invent specific facts, prices, or details that aren't in the knowledge base.
- Match the personality described above in tone and style.
- Ask follow-up questions to better understand what the visitor needs.
- Format responses naturally. Short paragraphs are fine. Use bullet points only for actual lists.
- ONLY use [HANDOFF] in these specific situations:
  1. The visitor explicitly asks to speak to a human/agent/person
  2. The conversation has gone back and forth and you genuinely cannot help further
  3. The topic requires a human decision (e.g., custom pricing, contract negotiation)
- Do NOT hand off just because a question is slightly outside the knowledge base. Try to help first.
- When you do hand off, respond with [HANDOFF] followed by: "${handoffMessage}"
- If asked about an off-limits topic, politely redirect the conversation without handing off unless the visitor insists.`

    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY
    if (!apiKey) return

    // Show typing indicator while AI generates response
    await knex('chat_conversations').where('id', conversationId).update({
      agent_typing: true,
      agent_typing_at: new Date(),
    }).catch(() => {})

    const { createGoogleGenerativeAI } = await import('@ai-sdk/google')
    const { generateText } = await import('ai')

    const google = createGoogleGenerativeAI({ apiKey })
    const model = google('gemini-3.1-flash-lite-preview')

    const aiMessages = messagesForContext.map((m: { sender_type: string; message: string }) => ({
      role: m.sender_type === 'visitor' ? 'user' as const : 'assistant' as const,
      content: m.message,
    }))

    const result = await generateText({
      model,
      system: systemPrompt,
      messages: aiMessages,
    })

    const botReply = result.text?.trim()
    if (!botReply) return

    const isHandoff = botReply.includes('[HANDOFF]')
    const cleanedReply = isHandoff ? botReply.replace('[HANDOFF]', '').trim() || handoffMessage : botReply

    const botMsgId = crypto.randomUUID()
    await knex('chat_messages').insert({
      id: botMsgId,
      conversation_id: conversationId,
      sender_type: 'business',
      message: cleanedReply,
      is_bot: true,
      created_at: new Date(),
    })
    await knex('chat_conversations')
      .where('id', conversationId)
      .update({ updated_at: new Date(), agent_typing: false, agent_typing_at: null })
  } catch (err) {
    console.error('[chat.bot.response]', err)
    // Clear typing indicator on error
    await knex('chat_conversations').where('id', conversationId).update({
      agent_typing: false, agent_typing_at: null,
    }).catch(() => {})
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Chat',
  summary: 'Public chat API for website visitors',
  methods: {
    POST: { summary: 'Start a conversation or send a visitor message', tags: ['Chat'] },
    GET: { summary: 'Poll messages for a conversation', tags: ['Chat'] },
  },
}
