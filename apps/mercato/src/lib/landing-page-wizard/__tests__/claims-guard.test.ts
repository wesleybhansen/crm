import {
  collectSourceNumbers,
  describeRemovedClaims,
  findUnsourcedClaims,
  guardGeneratedSections,
  hasSocialProofInput,
  NO_INVENTED_CLAIMS_RULE,
} from '../claims-guard'
import type { GeneratedSection } from '../types'

describe('findUnsourcedClaims', () => {
  const none = new Set<string>()

  it.each([
    ['Join 500+ testers who get early access', '500+ testers'],
    ['Cut 15 hours of busywork every week', 'Cut 15 hours'],
    ['98% of our clients renew', '98%'],
    ['Book 3x more listings', '3x'],
    ['Trusted by 1,200 agents', 'Trusted by 1,200'],
    ['Rated 4.9 stars by homeowners', '4.9 stars'],
    ['The #1 rated planner', '#1'],
    ['Add $50k in revenue this year', '$50k in revenue'],
  ])('flags an invented figure: %s', (text, expected) => {
    expect(findUnsourcedClaims(text, none)).toContain(expected)
  })

  it('allows a figure the user supplied, in any formatting', () => {
    const sources = collectSourceNumbers({ socialProof: 'Helped 1200 agents; 500 testers so far' })
    expect(findUnsourcedClaims('Trusted by 1,200 agents', sources)).toEqual([])
    expect(findUnsourcedClaims('Join 500+ testers', sources)).toEqual([])
  })

  it('ignores plain wording and non-claim numbers', () => {
    expect(findUnsourcedClaims('100% free, no card needed', none)).toEqual([])
    expect(findUnsourcedClaims('Three simple steps to get started', none)).toEqual([])
    expect(findUnsourcedClaims('Answer 5 questions and get your plan', none)).toEqual([])
  })
})

describe('guardGeneratedSections', () => {
  const waitlistSections: GeneratedSection[] = [
    {
      type: 'hero',
      headline: 'Join 500+ testers fixing their launch before it ships',
      headlineVariants: [
        'Join 500+ testers fixing their launch before it ships',
        'Get early access and fix your launch before it ships',
        'Cut 15 hours of QA from every sprint',
      ],
      selectedHeadline: 0,
      subtitle: 'Early members get founder pricing. Cut 15 hours of manual testing every week.',
      ctaText: 'Join the waitlist',
    },
    {
      type: 'features-benefits',
      headline: 'What you get',
      items: [
        { title: 'Founder pricing', description: 'Lock in the launch price for life.' },
        { title: '3x faster releases', description: 'Ship without the fear.' },
        { title: 'Direct onboarding', description: 'A setup call with the team. 92% finish in a day.' },
      ],
    },
    {
      type: 'testimonials',
      headline: 'What testers say',
      items: [{ title: 'Dana, CTO', description: 'It saved us 20 hours a week.' }],
    },
    {
      type: 'value-stack',
      headline: 'Your investment',
      valueItems: [{ name: 'Founder seat', description: 'Lifetime price lock', value: '$497 value' }],
      totalValue: '$1,491',
      price: '$49',
    },
  ]

  const inputs = {
    sources: { businessName: 'QA Co', offerAnswers: { offerName: 'QA waitlist', earlyAccess: 'Founder pricing' } },
    hasSocialProof: false,
  }

  it('removes invented claims and reports each one', () => {
    const { sections, flags } = guardGeneratedSections(waitlistSections, inputs)
    const [hero, features, testimonials, valueStack] = sections

    expect(hero.headline).toBe('Get early access and fix your launch before it ships')
    expect(hero.headlineVariants).toEqual(['Get early access and fix your launch before it ships'])
    expect(hero.selectedHeadline).toBe(0)
    expect(hero.subtitle).toBe('Early members get founder pricing.')

    expect(features.items?.map((i) => i.title)).toEqual(['Founder pricing', 'Direct onboarding'])
    expect(features.items?.[1].description).toBe('A setup call with the team.')

    // No social proof supplied: testimonials are dropped, not invented.
    expect(testimonials.items).toEqual([])

    // Prices the value stack is asked to compute are left alone.
    expect(valueStack.totalValue).toBe('$1,491')
    expect(valueStack.valueItems?.[0].value).toBe('$497 value')

    expect(flags.length).toBeGreaterThanOrEqual(5)
    expect(flags.some((f) => f.action === 'cleared-testimonials')).toBe(true)
    expect(describeRemovedClaims(flags)).toMatch(/^We removed \d+ claims/)
  })

  it('keeps claims the user backed up', () => {
    const { sections, flags } = guardGeneratedSections(waitlistSections, {
      sources: { offerAnswers: { socialProof: '500 testers so far; teams cut 15 hours; 3x faster; 92% finish setup; saved 20 hours' } },
      hasSocialProof: true,
    })
    expect(flags).toEqual([])
    expect(sections[0].headline).toBe(waitlistSections[0].headline)
    expect(sections[2].items).toHaveLength(1)
  })

  it('cuts the phrase when a one-sentence field has no clean alternative', () => {
    const { sections } = guardGeneratedSections([{ type: 'cta-block', headline: 'Ready to join 2,000 happy customers?' }], {
      sources: {},
      hasSocialProof: false,
    })
    expect(sections[0].headline).not.toMatch(/2,000/)
  })
})

describe('helpers', () => {
  it('detects supplied social proof', () => {
    expect(hasSocialProofInput({ socialProof: 'Helped 40 families' })).toBe(true)
    expect(hasSocialProofInput({ socialProof: '   ' })).toBe(false)
    expect(hasSocialProofInput(undefined)).toBe(false)
  })

  it('has a prompt rule that forbids invented figures', () => {
    expect(NO_INVENTED_CLAIMS_RULE).toMatch(/NEVER invent numbers/)
    expect(NO_INVENTED_CLAIMS_RULE).not.toMatch(/—/)
  })

  it('says nothing when nothing was removed', () => {
    expect(describeRemovedClaims([])).toBeNull()
  })
})
