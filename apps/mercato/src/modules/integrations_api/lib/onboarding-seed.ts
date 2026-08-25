export type NoliOnboardingSeed = {
  businessName: string
  businessDescription: string
  idealClients: string
  goals: string
  voice: string
  websiteUrl: string
  contextVersion: number
}

const clean = (value: unknown, max: number): string =>
  (typeof value === 'string' ? value : '').replace(/—|–/g, ', ').trim().slice(0, max)

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
