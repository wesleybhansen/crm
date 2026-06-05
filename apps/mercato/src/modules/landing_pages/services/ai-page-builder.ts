import type { TemplateSchema, TemplateSection } from './template-parser'

export interface ConversationMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface PageContent {
  brandName: string
  sections: Record<string, SectionContent>
  cssOverrides?: Record<string, string>
}

export interface SectionContent {
  enabled: boolean
  fields: Record<string, any>
}

const SYSTEM_PROMPT = `You are an expert landing page copywriter and conversion optimizer. You help entrepreneurs create high-converting landing pages by asking the right questions about their business and then generating compelling copy.

Your job is to have a brief, focused conversation (3-5 messages) to gather the information you need, then generate all the copy for their landing page.

CONVERSATION RULES:
- Be friendly but efficient. Don't waste their time.
- Ask one focused question at a time, sometimes two if they're related.
- After you have enough context (usually 3-4 exchanges), tell them you're ready to generate their page.
- If they give you a lot of info upfront, don't ask unnecessary follow-up questions.

INFORMATION YOU NEED:
1. What their business is and what they do
2. What this specific page is for (lead magnet, booking, webinar, product, service)
3. Who their target audience is
4. What makes them different / their key benefit
5. Any social proof (testimonials, stats, results)

You do NOT need all of these — use judgment. A simple lead magnet page needs less context than a services page.

When you're ready to generate, respond with EXACTLY this format:
---READY---
I have everything I need. Generating your page now...

Do NOT generate the actual content in the chat. Just signal that you're ready.`

const GENERATION_PROMPT = `You are an expert landing page copywriter. Given a template structure and business context from a conversation, generate ALL the content for a landing page.

RULES:
- Write compelling, conversion-focused copy
- Match the tone to the business (professional for B2B, energetic for fitness, warm for coaching, etc.)
- Keep headlines short and punchy (under 10 words)
- Subtitles should expand on the headline with a clear benefit
- Feature descriptions should be 1-2 sentences max
- Testimonials should feel real and specific, not generic
- Stats should be believable (don't claim "1 million users" for a small business)
- CTA buttons should be action-oriented ("Get Your Free Guide" not "Submit")
- If the business hasn't provided testimonials, create realistic placeholder ones they can edit
- If no stats are provided, create believable ones or skip the stats section

OUTPUT FORMAT:
Return a JSON object with this exact structure:
{
  "brandName": "Business Name",
  "sections": {
    "section-0": {
      "enabled": true,
      "fields": {
        "fieldKey": "value",
        "items": [{"title": "...", "description": "..."}]
      }
    }
  }
}

Match the field keys EXACTLY to the template schema provided. Every section in the schema should have a corresponding entry in your output.`

export class AIPageBuilder {
  private provider: string
  private apiKey: string
  private model: string

  constructor() {
    this.provider = process.env.AI_PROVIDER || 'google'
    this.apiKey = this.resolveApiKey()
    this.model = this.resolveModel()
  }

  private resolveApiKey(): string {
    const provider = process.env.AI_PROVIDER || 'google'
    switch (provider) {
      case 'google': return process.env.GOOGLE_GENERATIVE_AI_API_KEY || ''
      case 'anthropic': return process.env.ANTHROPIC_API_KEY || ''
      case 'openai': return process.env.OPENAI_API_KEY || ''
      default: return ''
    }
  }

  private resolveModel(): string {
    const provider = process.env.AI_PROVIDER || 'google'
    switch (provider) {
      case 'google': return process.env.AI_MODEL || 'gemini-3.5-flash'
      case 'anthropic': return process.env.AI_MODEL || 'claude-haiku-4-5-20251001'
      case 'openai': return process.env.AI_MODEL || 'gpt-4o-mini'
      default: return 'gemini-3.5-flash'
    }
  }

  /**
   * Continue the conversation — AI asks questions or signals ready.
   */
  async chat(messages: ConversationMessage[]): Promise<string> {
    const fullMessages = [
      { role: 'system' as const, content: SYSTEM_PROMPT },
      ...messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    ]

    return this.callAI(fullMessages)
  }

  /**
   * Generate all page content from conversation context + template schema.
   */
  async generatePageContent(
    conversation: ConversationMessage[],
    schema: TemplateSchema,
  ): Promise<PageContent> {
    // Build a simplified schema description for the AI
    const schemaDescription = schema.sections.map(s => ({
      id: s.id,
      name: s.name,
      type: s.type,
      fields: s.fields.map(f => ({
        key: f.key,
        type: f.type,
        label: f.label,
        current: f.type === 'repeater' ? `[${f.items?.length || 0} items] ${JSON.stringify(f.items?.slice(0, 2))}` : f.current,
      })),
    }))

    const conversationSummary = conversation
      .map(m => `${m.role === 'user' ? 'User' : 'AI'}: ${m.content}`)
      .join('\n')

    const prompt = `${GENERATION_PROMPT}

TEMPLATE: ${schema.templateName} (${schema.category})

TEMPLATE SECTIONS AND FIELDS:
${JSON.stringify(schemaDescription, null, 2)}

CONVERSATION WITH USER:
${conversationSummary}

Generate the JSON content now. Return ONLY valid JSON, no markdown code fences.`

    const response = await this.callAI([
      { role: 'system', content: 'You are a JSON generator. Return only valid JSON.' },
      { role: 'user', content: prompt },
    ])

    // Parse JSON from response (handle potential markdown fences)
    let json = response.trim()
    if (json.startsWith('```')) {
      json = json.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    }

    try {
      return JSON.parse(json) as PageContent
    } catch (e) {
      console.error('[ai-page-builder] Failed to parse AI response:', json.substring(0, 500))
      throw new Error('AI generated invalid content. Please try again.')
    }
  }

  /**
   * Revise specific content based on user feedback.
   */
  async reviseContent(
    currentContent: PageContent,
    schema: TemplateSchema,
    userFeedback: string,
  ): Promise<PageContent> {
    const prompt = `The user wants to revise their landing page. Here's the current content and their feedback.

CURRENT CONTENT:
${JSON.stringify(currentContent, null, 2)}

TEMPLATE SECTIONS:
${JSON.stringify(schema.sections.map(s => ({ id: s.id, name: s.name, type: s.type })), null, 2)}

USER FEEDBACK: "${userFeedback}"

Apply the user's feedback and return the COMPLETE updated JSON content (same structure as current). Return ONLY valid JSON.`

    const response = await this.callAI([
      { role: 'system', content: 'You are a JSON generator. Return only valid JSON.' },
      { role: 'user', content: prompt },
    ])

    let json = response.trim()
    if (json.startsWith('```')) {
      json = json.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    }

    try {
      return JSON.parse(json) as PageContent
    } catch {
      throw new Error('AI generated invalid content during revision. Please try again.')
    }
  }

  private async callAI(messages: Array<{ role: string; content: string }>): Promise<string> {
    if (!this.apiKey) {
      // Dev fallback — return mock response
      console.log('[ai-page-builder] No API key configured, using mock response')
      return this.mockResponse(messages)
    }

    switch (this.provider) {
      case 'google':
        return this.callGemini(messages)
      case 'anthropic':
        return this.callClaude(messages)
      case 'openai':
        return this.callOpenAI(messages)
      default:
        return this.callGemini(messages)
    }
  }

  private async callGemini(messages: Array<{ role: string; content: string }>): Promise<string> {
    // Extract system message
    const systemMsg = messages.find(m => m.role === 'system')?.content || ''
    const chatMessages = messages.filter(m => m.role !== 'system')

    const contents = chatMessages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }))

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemMsg }] },
          contents,
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 4096,
          },
        }),
      }
    )

    const data = await response.json()
    if (data.error) {
      console.error('[ai-page-builder] Gemini error:', JSON.stringify(data.error))
      throw new Error(`Gemini API error: ${data.error.message || JSON.stringify(data.error)}`)
    }
    if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
      console.error('[ai-page-builder] Gemini empty response:', JSON.stringify(data).substring(0, 500))
      throw new Error('Gemini returned empty response')
    }

    return data.candidates[0].content.parts[0].text
  }

  private async callClaude(messages: Array<{ role: string; content: string }>): Promise<string> {
    const systemMsg = messages.find(m => m.role === 'system')?.content || ''
    const chatMessages = messages.filter(m => m.role !== 'system').map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }))

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4096,
        system: systemMsg,
        messages: chatMessages,
      }),
    })

    const data = await response.json()
    return data.content?.[0]?.text || ''
  }

  private async callOpenAI(messages: Array<{ role: string; content: string }>): Promise<string> {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0.7,
        max_tokens: 4096,
      }),
    })

    const data = await response.json()
    return data.choices?.[0]?.message?.content || ''
  }

  private mockResponse(messages: Array<{ role: string; content: string }>): string {
    // Simple mock for development without API key
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || ''
    const msgCount = messages.filter(m => m.role === 'user').length

    if (lastUserMsg.includes('TEMPLATE') && lastUserMsg.includes('CONVERSATION')) {
      // This is a generation request — return mock content
      return JSON.stringify({
        brandName: 'Your Business',
        sections: {},
      })
    }

    if (msgCount <= 1) {
      return "Great! I'd love to help you create a landing page. Tell me about your business — what do you do, and what's this page for?"
    }
    if (msgCount === 2) {
      return "Nice! Who's your ideal customer for this? And what's the main benefit or transformation you offer them?"
    }
    if (msgCount === 3) {
      return "Perfect. Do you have any testimonials, stats, or results you'd like to highlight? (It's okay if not — I can create placeholders you can edit later.)"
    }
    return '---READY---\nI have everything I need. Generating your page now...'
  }
}
