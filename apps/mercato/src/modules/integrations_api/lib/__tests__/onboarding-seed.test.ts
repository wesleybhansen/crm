import {
  buildCrmFirstValueDraft,
  buildNoliOnboardingSeed,
  gtmBusinessContext,
  gtmIcpStarter,
  gtmVoiceStarter,
  isLegacyNoliFirstValueTemplate,
} from '../onboarding-seed'
import { readFileSync } from 'node:fs'
import path from 'node:path'

describe('Noli onboarding seed contract', () => {
  const seed = buildNoliOnboardingSeed({
    businessName: 'Acme',
    businessDescription: 'Designs accessible websites',
    idealClients: 'Independent professional firms',
    goals: 'Win five retained clients',
    voice: 'Clear, warm, direct',
    websiteUrl: 'https://example.com',
    contextVersion: 3,
  })

  it('builds bounded owner-confirmed workspace context', () => {
    expect(gtmBusinessContext(seed)).toEqual(expect.objectContaining({
      source: 'noli_intel_hub',
      verification_status: 'owner_confirmed',
      context_version: 3,
      ideal_clients: 'Independent professional firms',
    }))
  })

  it('creates editable starters without presenting inference as confirmed', () => {
    const icp = gtmIcpStarter(seed)
    const voice = gtmVoiceStarter(seed)
    expect(icp.status).toBe('needs_review')
    expect(voice.status).toBe('needs_review')
    expect(JSON.stringify({ icp, voice })).not.toMatch(/status":"confirmed/)
    expect(JSON.stringify({ icp, voice })).toMatch(/noli_intel_hub/)
  })

  it('keeps missing context truthful', () => {
    const sparse = buildNoliOnboardingSeed({ businessName: 'Acme' })
    expect(gtmIcpStarter(sparse).summary).toMatch(/not been confirmed/i)
    expect(gtmVoiceStarter(sparse).style_summary).toMatch(/not been confirmed/i)
  })

  it('turns confirmed questionnaire answers into a complete customer-facing CRM draft', () => {
    const draft = buildCrmFirstValueDraft(buildNoliOnboardingSeed({
      businessName: 'Noli AI',
      businessDescription: 'You provide a pre-assembled AI team orchestrated by a Chief of Staff to handle marketing, business development, and project management for solopreneurs and small teams.',
      idealClients: 'Your ideal customers are solopreneurs, freelancers, and small teams who want to automate operations without hiring employees.',
    }))

    expect(draft.subject).toBe('A quick follow-up from Noli AI')
    expect(draft.body).toMatch(/We help solopreneurs, freelancers, and small teams/)
    expect(draft.body).toMatch(/pre-assembled AI team orchestrated by a Chief of Staff/)
    expect(draft.body).not.toMatch(/interest in You provide|helps Your ideal customers|\bsmal\b|[—–]/)
  })

  it('recognizes only the previous deterministic Noli draft for a safe in-place refresh', () => {
    expect(isLegacyNoliFirstValueTemplate(
      'Following up with Noli AI',
      '<p>Hi {{first_name}},</p><p>Thanks for your interest in You provide services. Noli AI helps Your ideal customers, and I would be glad to learn what you are working toward.</p><p>Would a short conversation this week be useful? Reply with a time that works.</p>',
    )).toBe(true)
    expect(isLegacyNoliFirstValueTemplate('My edited subject', '<p>My customer-approved copy.</p>')).toBe(false)
  })

  it('wires shared context to the CRM completion gate and reviewable GTM seed', () => {
    const source = readFileSync(path.resolve(process.cwd(), 'src/modules/integrations_api/api/internal/seed-profile/route.ts'), 'utf8')
    expect(source).toMatch(/input\.onboardingComplete = true/)
    expect(source).toMatch(/ensureGtmStarter/)
    expect(source).toMatch(/gtm\.workspace\.onboarding_seeded/)
    expect(source).toMatch(/status: templateReady \? 'ready' : 'context_seeded'/)
    expect(source).toMatch(/followUpDraftReady: templateReady/)
    expect(source).not.toMatch(/sendEmailByPurpose|provider.*execute|GtmEnrollment/)
  })
})
