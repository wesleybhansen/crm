type BrandVoiceProfile = {
  style_summary?: string
  sample_phrases?: string[]
  formality_score?: number
  avg_sentence_length?: number
  uses_emoji?: boolean
  greeting_style?: string
  closing_style?: string
  vocabulary_notes?: string
}

type PersonaProfile = {
  ai_persona_name?: string | null
  ai_persona_style?: string | null
  ai_custom_instructions?: string | null
  business_name?: string | null
  business_type?: string | null
  business_description?: string | null
  brand_voice_profile?: BrandVoiceProfile | null
}

export function buildVoicePromptSection(voice: BrandVoiceProfile): string {
  const parts = [`WRITING VOICE (match this style closely):\n${voice.style_summary || ''}`]
  if (voice.greeting_style) parts.push(`Typical greetings: ${voice.greeting_style}`)
  if (voice.closing_style) parts.push(`Typical closings: ${voice.closing_style}`)
  if (voice.sample_phrases?.length) parts.push(`Sample phrases to use naturally: ${voice.sample_phrases.join(', ')}`)
  if (voice.formality_score) parts.push(`Formality level: ${voice.formality_score}/5`)
  parts.push(voice.uses_emoji ? 'Uses emoji occasionally' : 'Does not use emoji')
  if (voice.vocabulary_notes) parts.push(voice.vocabulary_notes)
  return parts.join('\n')
}

const stylePrompts: Record<string, (name: string) => string> = {
  professional: (name) =>
    `You are ${name}, a sharp and efficient business assistant. Be direct, data-driven, and proactive. Use professional language. Get to the point quickly.`,
  casual: (name) =>
    `You are ${name}, a friendly and encouraging business partner. Be warm, conversational, and supportive. Use casual language. Feel like a helpful friend.`,
  minimal: (name) =>
    `You are ${name}. Be extremely concise. Only speak when you have something valuable to say. No filler, no pleasantries, just substance.`,
}

export function buildPersonaPrompt(profile: PersonaProfile): string {
  const name = profile.ai_persona_name || 'Scout'
  const style = profile.ai_persona_style || 'professional'

  const parts: string[] = []

  const styleBuilder = stylePrompts[style] || stylePrompts.professional
  parts.push(styleBuilder(name))

  const businessContext: string[] = []
  if (profile.business_name) businessContext.push(`Business: ${profile.business_name}`)
  if (profile.business_type) businessContext.push(`Type: ${profile.business_type}`)
  if (profile.business_description) businessContext.push(`Description: ${profile.business_description}`)

  if (businessContext.length > 0) {
    parts.push(`\nBUSINESS CONTEXT:\n${businessContext.join('\n')}`)
  }

  if (profile.ai_custom_instructions) {
    parts.push(`\nCUSTOM INSTRUCTIONS:\n${profile.ai_custom_instructions}`)
  }

  return parts.join('\n')
}

export async function getPersonaForOrg(knex: any, orgId: string): Promise<PersonaProfile | null> {
  const profile = await knex('business_profiles')
    .where('organization_id', orgId)
    .select(
      'ai_persona_name',
      'ai_persona_style',
      'ai_custom_instructions',
      'business_name',
      'business_type',
      'business_description',
      'brand_voice_profile'
    )
    .first()

  return profile || null
}
