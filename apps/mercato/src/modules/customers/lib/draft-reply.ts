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

// A single enabled flag scenario the drafter should watch for. Only enabled
// scenarios are passed in. `key` is matched back by the caller; `label` +
// `instructions` steer the model.
export type FlagScenarioInput = {
  key: string
  label: string
  instructions?: string | null
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
  // Enabled flag scenarios for the org. When the inbound message matches one,
  // the drafter returns its key(s) in matchedScenarios and drafts the reply
  // following that scenario's instructions (first match wins on conflicts).
  flagScenarios?: FlagScenarioInput[] | null
}

export type DraftReplyResult = {
  ok: boolean
  draft?: string
  error?: string
  model: string
  tokensIn: number
  tokensOut: number
  // Confidence (0..1) that the reply fully and correctly answers the inquiry
  // from available information. Used by the Customer Service hybrid auto-send
  // gate. Defaults to 0 when the model does not return a usable signal.
  confidence: number
  // True only when the reply is safe to send WITHOUT human review. The model is
  // instructed to return false for anything sensitive (refunds, cancellations,
  // complaints, legal, billing disputes, angry tone) or when it is guessing.
  // Defaults to false (conservative) when the signal is missing.
  autoSendSafe: boolean
  // Keys of the enabled flag scenarios the inbound message matched (empty when
  // none matched or no scenarios were provided). The caller uses this to flag
  // the proposal + apply the scenario's pause/auto_send action.
  matchedScenarios: string[]
}

const DRAFT_MODEL = 'gemini-2.5-flash'

/**
 * Build the default sign-off used when an org has not set its own Customer
 * Service signature. With a business name we produce "Regards,\nThe <Name> team";
 * without one we fall back to a bare "Regards," rather than emitting a literal
 * placeholder. Returns '' only if asked to skip (no graceful sign-off possible).
 */
export function buildDefaultSignature(businessName?: string | null): string {
  const name = (businessName || '').trim()
  if (name) return `Regards,\nThe ${name} team`
  return 'Regards,'
}

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
  const { orgId, channel, recentMessages, contactId, signature, flagScenarios } = input

  // Build the flag-scenario instruction block from the enabled scenarios. Keep
  // the ordering the caller gave so "first match wins" stays deterministic.
  const enabledScenarios = (flagScenarios || []).filter((s) => s && typeof s.key === 'string' && s.key)
  let flagSection = ''
  if (enabledScenarios.length > 0) {
    const lines = enabledScenarios.map((s) => {
      const instr = (s.instructions || '').toString().trim()
      return `- key "${s.key}": ${s.label}${instr ? `. When this matches, follow these instructions for the reply: ${instr}` : ''}`
    })
    flagSection = `FLAG SCENARIOS:
The business has defined situations to watch for. Decide which (if any) of these the CUSTOMER'S latest message matches. Be conservative: only include a scenario when the message clearly fits it.
${lines.join('\n')}

Return the matching scenario keys in "matched_scenarios" (an array of the key strings above, empty [] when none match). If a matched scenario has reply instructions, DRAFT the reply following those instructions. If multiple match, follow the instructions of the FIRST one listed above that has instructions.`
  }

  // Load inbox AI settings for this org (knowledge base, tone, business info).
  const settings = await knex('inbox_ai_settings').where('organization_id', orgId).first()

  const contactInfo = await buildContactInfo(knex, orgId, contactId)

  // Generous per-message safety cap so the model sees the FULL inbound body, not
  // a tiny preview. The old 500-char cap silently truncated real inquiries and
  // the AI drafted against a cut-off message. 12k chars per message is plenty for
  // a support email while still bounding the prompt.
  const PER_MESSAGE_BODY_CAP = 12000
  const transcript = (recentMessages || [])
    .slice(-10)
    .map((m) => {
      const body = (m.bodyText || m.body || '').toString().slice(0, PER_MESSAGE_BODY_CAP)
      return `[${m.direction === 'inbound' ? 'Customer' : 'You'}] ${body}`
    })
    .join('\n')

  const businessName = settings?.business_name || ''
  const businessDesc = settings?.business_description || ''
  const knowledgeBase = settings?.knowledge_base || ''
  const tone = settings?.tone || 'professional'
  const customInstructions = settings?.instructions || ''

  // Load brand voice profile if available. Also pull the canonical business name
  // from business_profiles so we can build a sensible default sign-off when the
  // org has not set a Customer Service signature.
  const bpRow = await knex('business_profiles').where('organization_id', orgId).select('brand_voice_profile', 'business_name').first()
  const voiceProfile = bpRow?.brand_voice_profile
  // Prefer the business_profiles name (same source brand voice uses); fall back
  // to the inbox AI settings name if the profile has none.
  const resolvedBusinessName = ((bpRow?.business_name || businessName || '') as string).trim()

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
${flagSection ? `
${flagSection}
` : ''}
CRITICAL RULES:
- Write the COMPLETE reply from start to finish. Do NOT stop mid-sentence. Finish every thought.
- Do NOT include a subject line. The subject is already handled separately
- Do NOT start with "Subject:" or "Re:". Just write the message body
- Match the channel: ${channel === 'sms' ? 'keep it brief, under 300 chars' : channel === 'chat' ? 'conversational, 2-4 sentences' : 'professional email, max 6 paragraphs'}
- Use information from the knowledge base when relevant. If you do not have the answer, say you will check and follow up
- ${channel === 'email' ? 'Start with a greeting (Hi/Hello [name]) and end with a sign-off and your name' : 'No greeting or sign-off needed'}
- Address every question the customer asked. Do not skip any
- Sound natural and human, not robotic or generic
- The "body" field must contain ONLY the message body text. No labels, no "Subject:", no meta-commentary

You also assess whether this reply could be sent to the customer WITHOUT a human reviewing it first. Return two extra signals:
- "confidence": a number from 0 to 1 for how fully and correctly the reply answers the customer's inquiry using the information actually available to you. Use a low value when you are guessing, the knowledge base lacks the answer, or you are promising to follow up rather than answering.
- "auto_send_safe": a boolean. Return false (NOT safe to auto-send) for ANYTHING sensitive: refunds, cancellations, returns, complaints, legal matters, billing or payment disputes, an angry or upset customer, anything that commits money or promises, or anywhere you are guessing or unsure. Only return true when the reply is a clear, correct, low-risk answer you would be comfortable sending unreviewed.

Respond with ONLY a single JSON object, no markdown fences, no commentary, in exactly this shape:
{"body": "the full reply body text", "confidence": 0.0, "auto_send_safe": false, "matched_scenarios": []}`

  const aiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${DRAFT_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${systemPrompt}

Conversation:
${transcript}

Return the JSON object now:` }] }],
        generationConfig: { maxOutputTokens: 10000, temperature: 0.7, responseMimeType: 'application/json' },
      }),
    },
  )

  const aiData = await aiRes.json()
  const raw: string | undefined = aiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim()

  const tokensIn = aiData?.usageMetadata?.promptTokenCount || 0
  const tokensOut = aiData?.usageMetadata?.candidatesTokenCount || 0

  if (!raw) {
    return { ok: false, error: 'AI could not generate a draft', model: DRAFT_MODEL, tokensIn, tokensOut, confidence: 0, autoSendSafe: false, matchedScenarios: [] }
  }

  // Parse the JSON envelope. The model is asked for strict JSON (responseMimeType
  // = application/json), but be defensive: tolerate stray fences and fall back to
  // treating the whole output as the body (with conservative signals) if parsing
  // fails, so the draft is never lost.
  let draft: string | undefined
  let confidence = 0
  let autoSendSafe = false
  // Only keys we actually offered are valid; ignore anything the model invents.
  const matchedScenarios: string[] = []
  const parsed = tryParseEnvelope(raw)
  if (parsed && typeof parsed.body === 'string' && parsed.body.trim()) {
    draft = parsed.body.trim()
    const c = Number(parsed.confidence)
    confidence = Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0
    autoSendSafe = parsed.auto_send_safe === true
    if (Array.isArray(parsed.matched_scenarios)) {
      const seen = new Set<string>()
      // Preserve the order the scenarios were given (first-match-wins downstream).
      for (const s of enabledScenarios) {
        if ((parsed.matched_scenarios as unknown[]).some((k) => k === s.key) && !seen.has(s.key)) {
          seen.add(s.key)
          matchedScenarios.push(s.key)
        }
      }
    }
  } else {
    // Could not parse structured output: keep the text as the body but force the
    // conservative path (no auto-send) since we have no trustworthy signal.
    draft = raw
    confidence = 0
    autoSendSafe = false
  }

  if (!draft) {
    return { ok: false, error: 'AI could not generate a draft', model: DRAFT_MODEL, tokensIn, tokensOut, confidence: 0, autoSendSafe: false, matchedScenarios: [] }
  }

  // Strip any subject line the model may have included.
  draft = draft.replace(/^Subject:\s*.+\n+/i, '').replace(/^Re:\s*.+\n+/i, '').trim()

  // Append a sign-off for email. SMS replies stay concise with no signature
  // block (the channel prompt already tells the model to skip greetings and
  // sign-offs), so we only append when an explicit signature was passed.
  if (channel === 'sms') {
    if (signature && signature.trim()) {
      draft = `${draft}\n\n${signature.trim()}`
    }
  } else {
    // Append the org's signature when set; otherwise fall back to a sensible
    // default sign-off built from the business name so every draft ends properly.
    const signoff = (signature && signature.trim())
      ? signature.trim()
      : buildDefaultSignature(resolvedBusinessName)
    if (signoff) {
      draft = `${draft}\n\n${signoff}`
    }
  }

  return { ok: true, draft, model: DRAFT_MODEL, tokensIn, tokensOut, confidence, autoSendSafe, matchedScenarios }
}

// Best-effort parse of the model's JSON envelope. Strips a ```json fence if the
// model added one, and extracts the first {...} block as a last resort.
function tryParseEnvelope(raw: string): { body?: unknown; confidence?: unknown; auto_send_safe?: unknown; matched_scenarios?: unknown } | null {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch {}
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(cleaned.substring(start, end + 1))
    } catch {}
  }
  return null
}
