import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

// POST: Generate an AI draft reply for a conversation
export async function POST(req: Request) {
  await bootstrap()
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const aiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY
  if (!aiKey) return NextResponse.json({ ok: false, error: 'AI not configured' }, { status: 400 })

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { conversationId, channel, recentMessages } = body

    if (!conversationId) return NextResponse.json({ ok: false, error: 'conversationId required' }, { status: 400 })

    // Load AI settings for this org
    const settings = await knex('inbox_ai_settings').where('organization_id', auth.orgId).first()

    // Load conversation context
    const conv = await knex('inbox_conversations').where('id', conversationId).where('organization_id', auth.orgId).first()
    if (!conv) return NextResponse.json({ ok: false, error: 'Conversation not found' }, { status: 404 })

    // Load contact info if available
    let contactInfo = ''
    if (conv.contact_id) {
      const contact = await knex('customer_entities').where('id', conv.contact_id).first()
      if (contact) {
        contactInfo = `Contact: ${contact.display_name || 'Unknown'}${contact.primary_email ? `, Email: ${contact.primary_email}` : ''}${contact.primary_phone ? `, Phone: ${contact.primary_phone}` : ''}${contact.lifecycle_stage ? `, Stage: ${contact.lifecycle_stage}` : ''}`
      }
    }

    // Build conversation transcript from recent messages
    const transcript = (recentMessages || [])
      .slice(-10) // last 10 messages for context
      .map((m: any) => `[${m.direction === 'inbound' ? 'Customer' : 'You'}] ${m.bodyText || m.body || ''}`.substring(0, 500))
      .join('\n')

    const businessName = settings?.business_name || ''
    const businessDesc = settings?.business_description || ''
    const knowledgeBase = settings?.knowledge_base || ''
    const tone = settings?.tone || 'professional'
    const customInstructions = settings?.instructions || ''

    // Load brand voice profile if available
    const bpRow = await knex('business_profiles').where('organization_id', auth.orgId).select('brand_voice_profile').first()
    const voiceProfile = bpRow?.brand_voice_profile

    let voiceSection = `Tone: ${tone}`
    if (voiceProfile?.style_summary) {
      const { buildVoicePromptSection } = await import('@/app/api/ai/persona')
      voiceSection = buildVoicePromptSection(voiceProfile)
    }

    const systemPrompt = `You are a helpful AI assistant drafting a reply for a ${channel || 'message'} conversation on behalf of ${businessName || 'a business'}.

${businessDesc ? `About the business: ${businessDesc}` : ''}
${knowledgeBase ? `Knowledge base:\n${knowledgeBase}` : ''}
${customInstructions ? `Special instructions: ${customInstructions}` : ''}
${contactInfo ? `\n${contactInfo}` : ''}

${voiceSection}

CRITICAL RULES:
- Write the COMPLETE reply from start to finish. Do NOT stop mid-sentence. Finish every thought.
- Do NOT include a subject line — the subject is already handled separately
- Do NOT start with "Subject:" or "Re:" — just write the message body
- Match the channel: ${channel === 'sms' ? 'keep it brief, under 300 chars' : channel === 'chat' ? 'conversational, 2-4 sentences' : 'professional email — max 6 paragraphs'}
- Use information from the knowledge base when relevant. If you don't have the answer, say you'll check and follow up
- ${channel === 'email' ? 'Start with a greeting (Hi/Hello [name]) and end with a sign-off and your name' : 'No greeting or sign-off needed'}
- Address every question the customer asked — don't skip any
- Sound natural and human, not robotic or generic
- Output ONLY the message body text — no labels, no "Subject:", no meta-commentary`

    const aiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${aiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${systemPrompt}\n\nConversation:\n${transcript}\n\nWrite the complete reply body (no subject line):` }] }],
          generationConfig: { maxOutputTokens: 10000, temperature: 0.7 },
        }),
      },
    )

    const aiData = await aiRes.json()
    let draft = aiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim()

    if (!draft) return NextResponse.json({ ok: false, error: 'AI could not generate a draft' }, { status: 500 })

    // Strip any subject line the AI may have included
    draft = draft.replace(/^Subject:\s*.+\n+/i, '').replace(/^Re:\s*.+\n+/i, '').trim()

    return NextResponse.json({ ok: true, data: { draft } })
  } catch (error) {
    console.error('[inbox.ai-draft]', error)
    return NextResponse.json({ ok: false, error: 'Failed to generate draft' }, { status: 500 })
  }
}
