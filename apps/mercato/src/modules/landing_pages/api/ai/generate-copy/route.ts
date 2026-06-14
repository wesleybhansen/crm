export const metadata = { POST: { requireAuth: true } }
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { callAIWithUsage, parseAIJsonResponse } from '@/lib/landing-page-wizard/ai-client'
import { meterCustomersAi } from '@/lib/usage/meter'
import { checkCustomersAiAllowance } from '@/lib/usage/allowance'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { SECTION_DEFINITIONS, OFFER_QUESTIONS, BASE_CRAFT_RULES, COPY_EXEMPLARS } from '@/lib/landing-page-wizard/constants'
import type {
  PageType,
  SubType,
  Framework,
  SectionType,
  BusinessContext,
  GeneratedSection,
} from '@/lib/landing-page-wizard/types'

interface GenerateCopyRequestBody {
  pageType: PageType
  subType: SubType
  framework: Framework
  sections: SectionType[]
  businessContext: BusinessContext
}

interface GenerateCopyResult {
  sections: GeneratedSection[]
  metaTitle: string
  metaDescription: string
  thankYouHeadline: string
  thankYouMessage: string
}

const SELL_PAGE_FRAMEWORKS: Framework[] = ['AIDA', 'PASTOR']

function isSellPageFramework(framework: Framework): boolean {
  return SELL_PAGE_FRAMEWORKS.includes(framework)
}

function buildSystemPrompt(framework: Framework, pageType: PageType, subType: SubType): string {
  if (pageType === 'upsell') {
    return `You are an expert direct response copywriter writing a one-time upsell offer page. The reader just purchased something and is seeing this offer immediately after checkout. Your copy should be congratulatory, create urgency, and clearly communicate the added value of this complementary upgrade. Frame it as the obvious next step. Keep it concise — this is a one-page offer, not a full sales page. Use the PAS framework.`
  }

  if (pageType === 'downsell') {
    return `You are an expert direct response copywriter writing a downsell page. The reader just declined an upsell offer. Open with empathy ("We understand..."), acknowledge their hesitation, and present a lighter version at a lower price point. The tone should be understanding and helpful, not pushy. This is their last chance before reaching the thank you page. Use the PAS framework.`
  }

  if (pageType === 'funnel-checkout') {
    return `You are writing copy for a branded checkout page. Keep it minimal and trust-focused. The hero should summarize what they're buying and reinforce the value with a clear headline. Testimonials should reduce purchase anxiety. FAQ should address common objections about payment, refunds, and delivery. Write with confidence and reassurance.`
  }

  if (isSellPageFramework(framework)) {
    return `You are an expert direct response copywriter writing a high-converting sales page. You write like Alex Hormozi, Ramit Sethi, and Joanna Wiebe. Your copy is specific, benefit-driven, and emotionally compelling. You never use generic filler. Every sentence earns the next.

The page is a ${pageType} page (${subType}) using the ${framework} framework.`
  }

  return `You are an expert direct response copywriter writing a high-converting landing page. You write like Alex Hormozi, Ramit Sethi, and Joanna Wiebe. Your copy is specific, benefit-driven, and emotionally compelling. You never use generic filler. Every sentence earns the next.

The page is a ${pageType} page (${subType}) using the ${framework} framework. The conversion goal is the page's primary action (an email signup, a booked call, an event registration, or a purchase). Sell that action with the same craft you would apply to a paid offer.`
}

function buildSellPageSectionSchema(sectionType: SectionType): string | null {
  switch (sectionType) {
    case 'pain-points':
      return `Section "pain-points" (Pain Points):
  {
    type: "pain-points" (always include),
    headline: string — empathetic section headline (e.g., "Sound familiar?"),
    items: array of { title, description } — write 3 pain points with 3-layer depth:
      - title: the surface problem (what they'd tell a friend)
      - description: the emotional consequence (how it makes them FEEL, be specific and vivid)
  }`

    case 'offer-breakdown':
      return `Section "offer-breakdown" (What You Get):
  {
    type: "offer-breakdown" (always include),
    headline: string — e.g., "Here's Everything You Get",
    items: array of { title, description } — name each component with a proprietary-sounding name.
      - title: a named framework/system (e.g., "The Client Acquisition Machine" not "Module 1")
      - description: what specific problem it solves and the result it creates (2 sentences max)
  }`

    case 'value-stack':
      return `Section "value-stack" (Value & Pricing):
  {
    type: "value-stack" (always include),
    headline: string — e.g., "Your Investment",
    valueItems: array of { name, description, value } — 3-5 items matching the offer-breakdown components:
      - name: same proprietary name from offer-breakdown
      - description: 1-sentence benefit recap
      - value: just the dollar amount (e.g., "$497 value"). Keep it short — no justification text here.,
    totalValue: string — sum of all individual values (e.g., "$2,482"),
    price: string — the actual price the user is charging,
    paymentPlan: string — payment plan option (e.g., "Or 3 payments of $187"),
    guaranteeText: string — specific guarantee (e.g., "30-Day Money-Back Guarantee. Do the work, see no results, get a full refund."),
    ctaText: string — benefit-driven CTA text (e.g., "Get Instant Access"),
    ctaVariants: string[] — 3 different CTA options (action-oriented, benefit-driven)
  }`

    case 'who-its-for':
      return `Section "who-its-for" (Who It's For):
  {
    type: "who-its-for" (always include),
    headline: string — e.g., "Is This Right For You?",
    forItems: string[] — 4-5 qualifying statements starting with "You..." (e.g., "You already have a business and want to scale past 6 figures"),
    notForItems: string[] — 3-4 disqualifying statements (e.g., "You're looking for a get-rich-quick scheme")
  }`

    case 'two-futures-close':
      return `Section "two-futures-close" (Closing CTA):
  {
    type: "two-futures-close" (always include),
    headline: string — e.g., "You Have Two Options",
    inactionText: string — 2-3 sentences painting what happens if they close this page. Be specific about the continued pain. Use future tense.,
    actionText: string — 2-3 sentences painting what life looks like if they act. Use sensory details and specific timeframes.,
    ctaText: string — final CTA text,
    ctaVariants: string[] — 3 different CTA options,
    guaranteeText: string — one-line guarantee reminder
  }`

    default:
      return null
  }
}

function buildDefaultSectionSchema(sectionType: SectionType): string {
  const def = SECTION_DEFINITIONS[sectionType]
  if (!def) return `"${sectionType}": unknown section type, use headline + body`

  const fieldDescriptions: string[] = [`type: "${sectionType}" (always include)`]

  for (const field of def.fields) {
    if (field.type === 'items') {
      if (sectionType === 'faq') {
        fieldDescriptions.push(`faqItems: array of { question: string, answer: string } — generate 4-6 relevant FAQs`)
      } else {
        fieldDescriptions.push(`items: array of { title: string, description: string } — generate 3-5 items`)
      }
    } else if (field.key === 'headline') {
      if (sectionType === 'hero' || sectionType === 'cta-block') {
        fieldDescriptions.push(`headline: string — your best headline`)
        fieldDescriptions.push(`headlineVariants: string[] — 3 different headline options (benefit-driven, varied angles)`)
      } else {
        fieldDescriptions.push(`headline: string — section headline`)
      }
    } else if (field.key === 'ctaText') {
      if (sectionType === 'hero' || sectionType === 'cta-block') {
        fieldDescriptions.push(`ctaText: string — your best CTA button text`)
        fieldDescriptions.push(`ctaVariants: string[] — 3 different CTA options (action-oriented, first-person preferred)`)
      } else {
        fieldDescriptions.push(`ctaText: string — button text`)
      }
    } else {
      fieldDescriptions.push(`${field.key}: string`)
    }
  }

  return `Section "${sectionType}" (${def.label}):
  { ${fieldDescriptions.join(', ')} }`
}

function buildSectionSchemas(sections: SectionType[], isSellPage: boolean): string[] {
  return sections.map(sectionType => {
    if (isSellPage) {
      const sellSchema = buildSellPageSectionSchema(sectionType)
      if (sellSchema) return sellSchema
    }
    return buildDefaultSectionSchema(sectionType)
  })
}

function buildCraftRules(isSellPage: boolean, price: string | undefined): string {
  const priceContext = isSellPage && price ? `
The user's price is ${price}. Match the copy tone to this price point: $47 = casual/accessible, $497 = confident/thorough, $5000+ = authoritative/exclusive.` : ''

  const offerRules = isSellPage
    ? `- Name every component in the offer with proprietary-sounding names (e.g., "The Silent Close Framework" not "Sales Training").
- Value-stack values must be defensible — justify with "based on comparable coaching/workshop/consulting rates".
- The total value should be 5-10x the actual price.
- For the two-futures close, be specific — name timeframes, describe specific scenarios, use sensory details.`
    : `- Treat the free or low-commitment offer (lead magnet, call, event seat, trial) with the same craft as a paid product: name it, spell out exactly what is inside it, and make the value of saying yes obvious.
- If the page includes a value or pricing section, anchor the offer's worth to what it would cost elsewhere (a paid consult, a course, an agency engagement) — never invent arbitrary numbers.
- For the final CTA section, restate the single next action and what happens immediately after they take it (e.g., what arrives in their inbox, what the call covers, what they get at the event).`

  return `
## Copywriting Craft Rules

- Write pain-points with emotional depth, not surface-level descriptions. Make the reader feel understood.
${offerRules}
- Every headline should pass the "so what?" test — if the reader can say "so what?" after reading it, rewrite it.
- Lead with transformation, not features. Features go in the body sections, not headlines.
- Use power words: "unlock", "eliminate", "transform", "proven", "guaranteed" — but only where they are earned.${priceContext}`
}

export async function POST(req: Request) {
  try {
    const auth = await getAuthFromCookies()
    if (!auth) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    }

    // callAI runs Gemini first (the live path), so gate on google. Over the
    // pool, the org's google BYO key is threaded into the call (no fallback).
    const gate = await checkCustomersAiAllowance(auth, 'google')
    if (!gate.allowed) {
      return NextResponse.json({ ok: false, error: gate.message }, { status: 402 })
    }

    const body: GenerateCopyRequestBody = await req.json()
    const { pageType, subType, framework, sections, businessContext } = body

    if (!pageType || !subType || !framework || !sections?.length || !businessContext?.businessName) {
      return NextResponse.json(
        { ok: false, error: 'pageType, subType, framework, sections, and businessContext.businessName are required' },
        { status: 400 }
      )
    }

    const isSellPage = isSellPageFramework(framework)

    // Layer 1: System prompt — framework-aware
    const systemPrompt = buildSystemPrompt(framework, pageType, subType)

    // Layer 2: Section schema — sell pages get specific copywriting instructions
    const sectionSchemas = buildSectionSchemas(sections, isSellPage)

    // Layer 3: Business context
    const toneLabel = businessContext.tone === 'custom' && businessContext.customTone
      ? businessContext.customTone
      : businessContext.tone
    const offerQuestions = OFFER_QUESTIONS[pageType]?.[subType] || []
    const offerLines = Object.entries(businessContext.offerAnswers)
      .filter(([, value]) => value && value.trim())
      .map(([key, value]) => {
        const question = offerQuestions.find(q => q.key === key)
        return `Q: ${question?.label || key}
A: ${value}`
      })
      .join('\n\n')

    // Extract price from offer answers for sell page context
    const userPrice = businessContext.offerAnswers.price?.trim() || undefined

    // Layer 4: Price context for sell pages
    const priceContext = isSellPage && userPrice
      ? `

Price point: ${userPrice}
Use this as the actual price in the value-stack section. Calculate a believable total value (5-10x this price). Generate an appropriate payment plan if the price is $200+.`
      : ''

    // Layer 5 + 6: Rules and output format combined into user prompt
    const baseRules = `- No fake testimonials. Only generate testimonial content if the user provided social proof data in their answers above. If no social proof was provided, use a placeholder headline like "What Our Customers Say" and set items to an empty array.
${BASE_CRAFT_RULES}
- For pricing sections, only include a price if the user provided one. Always include an "items" array with 4-6 bullet points summarizing what's included (e.g., [{title: "12 Video Modules", description: "Self-paced learning"}, ...]).`

    const craftRules = buildCraftRules(isSellPage, userPrice)

    const exemplars = COPY_EXEMPLARS[pageType]
    const exemplarBlock = exemplars ? `

## Quality Bar — Exemplars

These show the caliber of headline and CTA expected for a ${pageType} page. Do NOT copy them — match their specificity for this business:
Headlines:
${exemplars.headlines.map(h => `- "${h}"`).join('\n')}
CTAs:
${exemplars.ctas.map(c => `- "${c}"`).join('\n')}` : ''

    const userPrompt = `## Sections to generate

${sectionSchemas.join('\n\n')}

## Business Context

Business: ${businessContext.businessName}
Target audience: ${businessContext.targetAudience}
Tone: ${toneLabel}

Here's what they told us about their offer:

${offerLines || 'No additional details provided.'}${priceContext}

## Rules

${baseRules}${craftRules}${exemplarBlock}

## Output Format

Return a JSON object with this exact structure:
{
  "sections": [
    // One object per section listed above, in the same order, with the fields described
  ],
  "metaTitle": "SEO page title under 60 chars",
  "metaDescription": "SEO meta description under 155 chars",
  "thankYouHeadline": "Short thank-you heading shown after form submission (e.g., 'You're in!' or 'Check your inbox!')",
  "thankYouMessage": "One sentence shown after form submission, relevant to what the user signed up for (e.g., 'Your blueprint is on its way — check your email.' or 'We'll be in touch within 24 hours.')"
}

No markdown, no explanation, just valid JSON.`

    const ai = await callAIWithUsage(systemPrompt, userPrompt, {
      jsonMode: true,
      maxTokens: 8192,
      apiKey: gate.byoApiKey,
      provider: gate.byoApiKey ? 'google' : undefined,
    })
    void meterCustomersAi(auth, {
      model: ai.model,
      tokensIn: ai.usage.tokensIn,
      tokensOut: ai.usage.tokensOut,
      feature: 'lp-generate-copy',
      byoKey: !!gate.byoApiKey,
    })
    const result = parseAIJsonResponse<GenerateCopyResult>(ai.text)

    // Validate structure
    if (!result.sections || !Array.isArray(result.sections)) {
      throw new Error('AI response missing sections array')
    }

    // Ensure each section has a type field
    for (let i = 0; i < result.sections.length; i++) {
      if (!result.sections[i].type && sections[i]) {
        result.sections[i].type = sections[i]
      }
    }

    return NextResponse.json({
      ok: true,
      data: {
        sections: result.sections,
        metaTitle: result.metaTitle || `${businessContext.businessName}`,
        metaDescription: result.metaDescription || '',
        thankYouHeadline: result.thankYouHeadline || 'Thank you!',
        thankYouMessage: result.thankYouMessage || "We'll be in touch soon.",
      },
    })
  } catch (error) {
    console.error('[landing-page-ai.generate-copy]', error)
    const message = error instanceof Error ? error.message : 'Copy generation failed'
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Landing Pages',
  summary: 'AI copy generation',
  methods: {
    POST: {
      summary: 'Generate landing page copy using a copywriting framework',
      tags: ['Landing Pages'],
    },
  },
}
