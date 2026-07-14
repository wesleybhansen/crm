import type { PageType, SubType, Framework, SectionType } from './types'
import { FRAMEWORK_SECTIONS } from './constants'

interface ResolvedFramework {
  framework: Framework
  sections: SectionType[]
}

export function resolveFramework(
  pageType: PageType,
  subType: SubType,
  price?: string,
): ResolvedFramework {
  // Funnel page types have custom section lists
  if (pageType === 'upsell' || pageType === 'downsell') {
    return {
      framework: 'PAS',
      sections: ['hero', 'features-benefits', 'testimonials', 'faq', 'cta-block'],
    }
  }
  if (pageType === 'funnel-checkout') {
    return {
      framework: 'PAS',
      sections: ['hero', 'testimonials', 'faq'],
    }
  }

  const framework = selectFramework(pageType, subType, price)
  return {
    framework,
    sections: FRAMEWORK_SECTIONS[framework],
  }
}

function selectFramework(
  pageType: PageType,
  subType: SubType,
  price?: string,
): Framework {
  const numericPrice = parsePrice(price)

  // Free offers and lead capture → PAS (short, punchy)
  if (pageType === 'capture-leads') return 'PAS'

  // Booking pages → PAS (concise, action-oriented)
  if (pageType === 'book-a-call') {
    if (subType === 'paid-consultation' || subType === 'strategy-session') {
      return numericPrice !== null && numericPrice >= 500 ? 'PASTOR' : 'PAS'
    }
    return 'PAS'
  }

  // Events → BAB (aspirational transformation)
  if (pageType === 'promote-event') return 'BAB'

  // Case studies → BAB (before → after is the case-study arc)
  if (pageType === 'case-study') return 'BAB'

  // Comparison pages → AIDA (attention, then a decision-oriented feature showcase)
  if (pageType === 'comparison') return 'AIDA'

  // High-ticket services → PASTOR (story + transformation + detailed offer)
  if (pageType === 'sell-service') {
    if (subType === 'coaching' || subType === 'consulting') return 'PASTOR'
    return numericPrice !== null && numericPrice >= 500 ? 'PASTOR' : 'AIDA'
  }

  // Digital products
  if (pageType === 'sell-digital') {
    if (subType === 'course' || subType === 'membership') return 'PASTOR'
    if (subType === 'software-saas') return 'AIDA'
    // Low-ticket digital → AIDA
    if (numericPrice !== null && numericPrice >= 500) return 'PASTOR'
    return 'AIDA'
  }

  // Physical products → AIDA (feature showcase)
  if (pageType === 'sell-physical') return 'AIDA'

  // General → AIDA (safest default)
  return 'AIDA'
}

function parsePrice(price?: string): number | null {
  if (!price) return null
  const cleaned = price.replace(/[^0-9.]/g, '')
  const num = parseFloat(cleaned)
  return isNaN(num) ? null : num
}
