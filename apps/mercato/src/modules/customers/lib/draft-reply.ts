import type { Knex } from 'knex'

/**
 * Shared reply-drafting logic for the inbox. Factored out of
 * customers/api/inbox/ai-draft/route.ts so the interactive "Draft reply" button
 * and the recurring Customer Service engine share ONE prompt and ONE provider
 * call. Do not duplicate the prompt anywhere else.
 *
 * The caller is responsible for the allowance gate (checkCustomersAiAllowance)
 * and for passing the resolved api key. This function meters nothing itself; it
 * returns the token usage so the caller can meter with the right feature label
 * and byoKey flag.
 */

export type DraftReplyMessage = {
  direction?: string | null
  bodyText?: string | null
  body?: string | null
}

export type DraftReplyInput = {
  orgId: string
  channel?: string | null
  // Recent messages, oldest-to-newest is fine; we slice the last 10.
  recentMessages: DraftReplyMessage[]
  // Optional pre-resolved contact context line; if omitted and contactId is
  // given, we look it up.
  contactId?: string | null
  // Appended verbatim to the body when present (Customer Service signature).
  signature?: string | null
}

export type DraftReplyResult = {
  ok: boolean
  draft?: string
  error?: string
  model: string
  tokensIn: number
  tokensOut: number
}

const DRAFT_MODEL = 'gemini-2.5-flash'

// Total budget for injected grounding-library content (model answers +
// documents). If the org has more than this, we include the most recently
// updated entries first and note that the rest were truncated.
const KNOWLEDGE_BUDGET_CHARS = 8000

/**
 * Load the org's active Customer Service grounding library (model answers +
 * reference documents) and render it into prompt sections. Newest entries are
 * preferred when over the budget. Returns '' when the org has no entries.
 */
async function buildKnowledgeSection(knex: Knex, orgId: string): Promise<string> {
  let rows: any[] = []
  try {
    rows = await knex('customer_service_knowledge')
      .where('organization_id', orgId)
      .where('is_active', true)
      .orderBy('updated_at', 'desc')
      .limit(200)
  } catch {
    // Table may not exist yet (pre-migration); grounding is optional.
    return ''
  }
  if (!rows.length) return ''

  const modelAnswers: string[] = []
  const documents: string[] = []
  let used = 0
  let truncated = false

  for (const row of rows) {
    const title = (row.title || '').toString().trim()
    const content = (row.content || '').toString().trim()
    if (!content) continue
    const block = title ? `- ${title}:\n${content}` : `- ${content}`
    if (used + block.length > KNOWLEDGE_BUDGET_CHARS) {
      truncated = true
      const remaining = KNOWLEDGE_BUDGET_CHARS - used
      if (remaining > 200) {
        const clipped = `${block.substring(0, remaining)}...`
        if (row.kind === 'model_answer') modelAnswers.push(clipped)
        else documents.push(clipped)
        used = KNOWLEDGE_BUDGET_CHARS
      }
      break
    }
    used += block.length
    if (row.kind === 'model_answer') modelAnswers.push(block)
    else documents.push(block)
  }

  const parts: string[] = []
  if (modelAnswers.length) {
    parts.push(`Approved example answers — reuse or adapt these when relevant:\n${modelAnswers.join('\n\n')}`)
  }
  if (documents.length) {
    parts.push(`Reference material:\n${documents.join('\n\n')}`)
  }
  if (!parts.length) return ''
  if (truncated) {
    parts.push('(Some grounding entries were omitted to stay within the prompt budget. The most recently updated entries are shown.)')
  }
  return parts.join('\n\n')
}

/**
 * Build the contact context line used in the prompt. Mirrors the original
 * inline logic from ai-draft/route.ts.
 */
async function buildContactInfo(knex: Knex, orgId: string, contactId?: string | null): Promise<string> {
  if (!contactId) return ''
  const contact = await knex('customer_entities')
    .where('id', contactId)
    .where('organization_id', orgId)
    .first()
  if (!contact) return ''
  return `Contact: ${contact.display_name || 'Unknown'}${contact.primary_email ? `, Email: ${contact.primary_email}` : ''}${contact.primary_phone ? `, Phone: ${contact.primary_phone}` : ''}${contact.lifecycle_stage ? `, Stage: ${contact.lifecycle_stage}` : ''}`
}

/**
 * Generate a reply draft grounded in the org's inbox AI settings + brand voice.
 * Returns the draft body (no subject line) plus token usage for metering.
 */
export async function generateReplyDraft(
  knex: Knex,
  apiKey: string,
  input: DraftReplyInput,
): Promise<DraftReplyResult> {
  const { orgId, channel, recentMessages, contactId, signature } = input

  // Load inbox AI settings for this org (knowledge base, tone, business info).
  const settings = await knex('inbox_ai_settings').where('organization_id', orgId).first()

  const contactInfo = await buildContactInfo(knex, orgId, contactId)

  const transcript = (recentMessages || [])
    .slice(-10)
    .map((m) => `[${m.direction === 'inbound' ? 'Customer' : 'You'}] ${(m.bodyText || m.body || '')}`.substring(0, 500))
    .join('\n')

  const businessName = settings?.business_name || ''
  const businessDesc = settings?.business_description || ''
  const knowledgeBase = settings?.knowledge_base || ''
  const tone = settings?.tone || 'professional'
  const customInstructions = settings?.instructions || ''

  // Load brand voice profile if available.
  const bpRow = await knex('business_profiles').where('organization_id', orgId).select('brand_voice_profile').first()
  const voiceProfile = bpRow?.brand_voice_profile

  let voiceSection = `Tone: ${tone}`
  if (voiceProfile?.style_summary) {
    const { buildVoicePromptSection } = await import('@/modules/customers/api/ai/persona')
    voiceSection = buildVoicePromptSection(voiceProfile)
  }

  // Load the org's Customer Service grounding library (model answers + docs).
  const knowledgeSection = await buildKnowledgeSection(knex, orgId)

  const systemPrompt = `You are a helpful AI assistant drafting a reply for a ${channel || 'message'} conversation on behalf of ${businessName || 'a business'}.

${businessDesc ? `About the business: ${businessDesc}` : ''}
${knowledgeBase ? `Knowledge base:
${knowledgeBase}` : ''}
${knowledgeSection ? `
${knowledgeSection}` : ''}
${customInstructions ? `Special instructions: ${customInstructions}` : ''}
${contactInfo ? `
${contactInfo}` : ''}

${voiceSection}

CRITICAL RULES:
- Write the COMPLETE reply from start to finish. Do NOT stop mid-sentence. Finish every thought.
- Do NOT include a subject line. The subject is already handled separately
- Do NOT start with "Subject:" or "Re:". Just write the message body
- Match the channel: ${channel === 'sms' ? 'keep it brief, under 300 chars' : channel === 'chat' ? 'conversational, 2-4 sentences' : 'professional email, max 6 paragraphs'}
- Use information from the knowledge base when relevant. If you do not have the answer, say you will check and follow up
- ${channel === 'email' ? 'Start with a greeting (Hi/Hello [name]) and end with a sign-off and your name' : 'No greeting or sign-off needed'}
- Address every question the customer asked. Do not skip any
- Sound natural and human, not robotic or generic
- Output ONLY the message body text. No labels, no "Subject:", no meta-commentary`

  const aiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${DRAFT_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${systemPrompt}

Conversation:
${transcript}

Write the complete reply body (no subject line):` }] }],
        generationConfig: { maxOutputTokens: 10000, temperature: 0.7 },
      }),
    },
  )

  const aiData = await aiRes.json()
  let draft: string | undefined = aiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim()

  const tokensIn = aiData?.usageMetadata?.promptTokenCount || 0
  const tokensOut = aiData?.usageMetadata?.candidatesTokenCount || 0

  if (!draft) {
    return { ok: false, error: 'AI could not generate a draft', model: DRAFT_MODEL, tokensIn, tokensOut }
  }

  // Strip any subject line the model may have included.
  draft = draft.replace(/^Subject:\s*.+\n+/i, '').replace(/^Re:\s*.+\n+/i, '').trim()

  if (signature && signature.trim()) {
    draft = `${draft}\n\n${signature.trim()}`
  }

  return { ok: true, draft, model: DRAFT_MODEL, tokensIn, tokensOut }
}
