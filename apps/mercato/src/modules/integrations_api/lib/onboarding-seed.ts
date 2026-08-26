export type NoliOnboardingSeed = {
  businessName: string
  businessDescription: string
  idealClients: string
  goals: string
  voice: string
  websiteUrl: string
  contextVersion: number
}

export type CrmFirstValueDraft = {
  subject: string
  body: string
}

export const NOLI_FIRST_VALUE_TEMPLATE_MARKER = '<!-- noli:first-value:v2 -->'

const clean = (value: unknown, max: number): string =>
  (typeof value === 'string' ? value : '').replace(/—|–/g, ', ').trim().slice(0, max)

function conciseEmailPhrase(value: string, prefixes: RegExp[], max: number): string {
  let phrase = value.replace(/\s+/g, ' ').trim()
  for (const prefix of prefixes) phrase = phrase.replace(prefix, '').trim()
  if (!phrase) return ''

  const completeSentence = phrase.match(/^.*?[.!?](?=\s|$)/)?.[0]
  if (completeSentence && completeSentence.length <= max) phrase = completeSentence
  if (phrase.length > max) {
    const candidate = phrase.slice(0, max + 1)
    const boundary = Math.max(candidate.lastIndexOf(', '), candidate.lastIndexOf('; '), candidate.lastIndexOf(' '))
    phrase = candidate.slice(0, boundary > max / 2 ? boundary : max).trim()
  }
  return phrase.replace(/[\s,;:.!?]+$/g, '').trim()
}

export function buildCrmFirstValueDraft(seed: NoliOnboardingSeed): CrmFirstValueDraft {
  const business = seed.businessName.trim() || 'your business'
  const escapedBusiness = business.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const offer = conciseEmailPhrase(seed.businessDescription, [
    new RegExp(`^${escapedBusiness}\\s+(?:provides?|offers?|delivers?|creates?|helps?)\\s+`, 'i'),
    /^(?:you|we|our (?:business|company|team))\s+(?:provides?|offers?|delivers?|creates?|helps?)\s+/i,
    /^(?:what (?:you|we) (?:do|offer)(?: is)?|our offer is)\s*:?\s*/i,
  ], 220)
  const audience = conciseEmailPhrase(seed.idealClients, [
    /^(?:your|our|the)\s+(?:ideal|best-fit|target)\s+(?:customers?|clients?|audience)\s+(?:are|is|include)\s+/i,
    /^(?:you|we)\s+(?:serve|help|work with)\s+/i,
    /^(?:customers?|clients?|audience)\s*:?\s*/i,
  ], 220)
  const contextSentence = offer && audience
    ? `We help ${audience} with ${offer}.`
    : offer
      ? `We help customers with ${offer}.`
      : audience
        ? `We work with ${audience} to help them move forward.`
        : 'We would be glad to learn what you are working toward and see how we can help.'

  return {
    subject: business === 'your business' ? 'A quick follow-up' : `A quick follow-up from ${business}`.slice(0, 200),
    body: [
      'Hi {{first_name}},',
      '',
      `Thanks for your interest in ${business}. ${contextSentence}`,
      '',
      'Would a short conversation this week be useful? Reply with a time that works for you, and we will take it from there.',
      '',
      business === 'your business' ? 'Your team' : business,
    ].join('\n'),
  }
}

export function isLegacyNoliFirstValueTemplate(subject: string, bodyHtml: string): boolean {
  const plain = bodyHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').toLowerCase()
  return subject.toLowerCase().startsWith('following up with ')
    && plain.includes('thanks for your interest in ')
    && plain.includes('i would be glad to learn what you are working toward')
    && plain.includes('reply with a time that works')
}

export function buildNoliOnboardingSeed(body: Record<string, unknown>): NoliOnboardingSeed {
  const rawVersion = Number(body.contextVersion ?? 1)
  return {
    businessName: clean(body.businessName, 200),
    businessDescription: clean(body.businessDescription, 600),
    idealClients: clean(body.idealClients, 1200),
    goals: clean(body.goals, 1200),
    voice: clean(body.voice, 400),
    websiteUrl: clean(body.websiteUrl, 300),
    contextVersion: Number.isSafeInteger(rawVersion) ? Math.max(1, Math.min(1_000_000, rawVersion)) : 1,
  }
}

export function gtmBusinessContext(seed: NoliOnboardingSeed): Record<string, unknown> {
  return {
    source: 'noli_intel_hub',
    verification_status: 'owner_confirmed',
    context_version: seed.contextVersion,
    business_name: seed.businessName || null,
    business_description: seed.businessDescription || null,
    ideal_clients: seed.idealClients || null,
    immediate_goal: seed.goals || null,
    website: seed.websiteUrl || null,
  }
}

export function gtmIcpStarter(seed: NoliOnboardingSeed): Record<string, unknown> {
  return {
    status: 'needs_review',
    summary: seed.idealClients || 'Ideal customer has not been confirmed yet.',
    business_context: seed.businessDescription || null,
    immediate_goal: seed.goals || null,
    evidence: [{ source: 'noli_intel_hub', context_version: seed.contextVersion }],
    review_prompt: 'Edit this starter, then lock the version only after it accurately describes your best-fit customer.',
  }
}

export function gtmVoiceStarter(seed: NoliOnboardingSeed): Record<string, unknown> {
  return {
    status: 'needs_review',
    style_summary: seed.voice || 'Brand voice has not been confirmed yet.',
    business_name: seed.businessName || null,
    website: seed.websiteUrl || null,
    evidence: [{ source: 'noli_intel_hub', context_version: seed.contextVersion }],
    review_prompt: 'Edit this starter or derive a voice from approved sources, then lock it before outbound drafting uses it.',
  }
}
