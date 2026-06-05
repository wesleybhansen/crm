import { NextResponse } from 'next/server'
import * as fs from 'fs'
import * as path from 'path'
import { TEMPLATES_DIR } from '../../../services/paths'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { meterCustomersAi } from '@/lib/usage/meter'
import { checkCustomersAiAllowance } from '@/lib/usage/allowance'
import type { ByoProvider } from '@open-mercato/shared/lib/noli/core-client'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['landing_pages.create'] },
}

export async function POST(req: Request) {
  try {
    const auth = await getAuthFromCookies()
    if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

    const provider = process.env.AI_PROVIDER || 'google'
    const gateProvider: ByoProvider = provider === 'openai' ? 'openai' : provider === 'anthropic' ? 'anthropic' : 'google'
    const gate = await checkCustomersAiAllowance(auth, gateProvider)
    if (!gate.allowed) {
      return NextResponse.json({ ok: false, error: gate.message }, { status: 402 })
    }

    const body = await req.json()
    const { templateId, messages, templateCategory } = body

    if (!templateId) {
      return NextResponse.json({ ok: false, error: 'templateId required' }, { status: 400 })
    }

    // Read the raw template HTML
    const htmlPath = path.join(TEMPLATES_DIR, templateId, 'index.html')
    if (!fs.existsSync(htmlPath)) {
      return NextResponse.json({ ok: false, error: `Template not found: ${templateId}` }, { status: 404 })
    }
    const fullHtml = fs.readFileSync(htmlPath, 'utf-8')

    // Split template: send only the body to AI, re-attach head/styles after
    // This reduces token usage by ~60-70%
    const headMatch = fullHtml.match(/([\s\S]*<\/head>)/i)
    const bodyMatch = fullHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i)
    const headSection = headMatch ? headMatch[1] : ''
    const bodyContent = bodyMatch ? bodyMatch[1] : fullHtml

    // Get user's business context from messages
    const userContext = Array.isArray(messages)
      ? messages.filter((m: any) => m.role === 'user').map((m: any) => m.content).join('\n')
      : String(messages)

    // Call Gemini to rewrite the template
    const apiKey = gate.byoApiKey || process.env.GOOGLE_GENERATIVE_AI_API_KEY

    if (!apiKey && provider === 'google') {
      return NextResponse.json({ ok: false, error: 'AI API key not configured. Add GOOGLE_GENERATIVE_AI_API_KEY to .env' }, { status: 500 })
    }

    // Build category-specific instructions
    const categoryGuidance = getCategoryGuidance(templateCategory || detectCategory(templateId))

    const prompt = `Rewrite all text in this HTML body for a ${categoryGuidance.pageType} page.

BUSINESS: ${userContext}

PAGE TYPE RULES:
${categoryGuidance.rules}

GENERAL RULES:
- Keep ALL HTML tags, classes, and structure unchanged. Only change visible text between tags.
- Make copy compelling, specific, and conversion-focused for this exact business.
- Replace any placeholder brand names (like "BrandName") with the actual business name.
- Update all stats/numbers to be believable for this business.
- Update testimonials to sound realistic for this business's industry.
- Form inputs: keep the input types/names but update placeholder text and labels to match the page purpose.
- Return ONLY the rewritten body content. No <html>/<head>/<body> wrapper tags. No markdown fences. No explanation.

${bodyContent}`

    let html: string

    if (provider === 'google') {
      const model = process.env.AI_MODEL || 'gemini-3.5-flash'
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 90000) // 90 second timeout
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.7, maxOutputTokens: 16384 },
          }),
          signal: controller.signal,
        }
      )
      clearTimeout(timeout)
      const data = await response.json()
      if (data.error) {
        console.error('[ai.generate] Gemini error:', data.error)
        return NextResponse.json({ ok: false, error: `AI error: ${data.error.message}` }, { status: 500 })
      }
      void meterCustomersAi(auth, {
        model,
        tokensIn: data?.usageMetadata?.promptTokenCount || 0,
        tokensOut: data?.usageMetadata?.candidatesTokenCount || 0,
        feature: 'landing-generate',
        byoKey: !!gate.byoApiKey,
      })
      html = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
    } else if (provider === 'anthropic') {
      const model = process.env.AI_MODEL || 'claude-haiku-4-5-20251001'
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey!, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 16384, messages: [{ role: 'user', content: prompt }] }),
      })
      const data = await response.json()
      void meterCustomersAi(auth, {
        model,
        tokensIn: data?.usage?.input_tokens || 0,
        tokensOut: data?.usage?.output_tokens || 0,
        feature: 'landing-generate',
        byoKey: !!gate.byoApiKey,
      })
      html = data.content?.[0]?.text || ''
    } else {
      const model = process.env.AI_MODEL || 'gpt-4o-mini'
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.7, max_tokens: 16384 }),
      })
      const data = await response.json()
      void meterCustomersAi(auth, {
        model,
        tokensIn: data?.usage?.prompt_tokens || 0,
        tokensOut: data?.usage?.completion_tokens || 0,
        feature: 'landing-generate',
        byoKey: !!gate.byoApiKey,
      })
      html = data.choices?.[0]?.message?.content || ''
    }

    // Clean up response — remove markdown fences if present
    html = html.trim()
    if (html.startsWith('```')) {
      html = html.replace(/^```(?:html)?\n?/, '').replace(/\n?```$/, '')
    }

    // If AI returned full HTML doc, use it. If just body content, re-assemble.
    if (html.includes('<!DOCTYPE') || html.includes('<html')) {
      // AI returned full document — use as-is
    } else {
      // Re-assemble: head from original template + rewritten body from AI
      html = `<!DOCTYPE html>\n<html lang="en">\n${headSection}\n<body>\n${html}\n</body>\n</html>`
    }

    // Re-attach the original script tags (form handlers, nav toggle, etc.)
    const scriptMatch = fullHtml.match(/<script[\s\S]*<\/script>/gi)
    if (scriptMatch && !html.includes('<script')) {
      html = html.replace('</body>', scriptMatch.join('\n') + '\n</body>')
    }

    return NextResponse.json({ ok: true, html })
  } catch (error) {
    console.error('[ai.generate]', error)
    const message = error instanceof Error ? error.message : 'Content generation failed'
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}

function detectCategory(templateId: string): string {
  const twoWord = ['lead-magnet', 'info-product', 'physical-product', 'thank-you']
  const parts = templateId.split('-')
  const prefix = parts.slice(0, 2).join('-')
  return twoWord.includes(prefix) ? prefix : parts[0]
}

function getCategoryGuidance(category: string): { pageType: string; rules: string } {
  const guides: Record<string, { pageType: string; rules: string }> = {
    'lead-magnet': {
      pageType: 'lead magnet / free resource download',
      rules: `- The page goal is to get visitors to exchange their email for a free resource (guide, checklist, template, etc.)
- The form should ONLY ask for name and email — nothing else. No "topic" or "booking" fields.
- Headlines should emphasize what they GET for free, not what they have to do.
- Feature sections should describe what's INSIDE the free resource.
- CTA buttons should say things like "Download Free Guide", "Get Your Copy", "Send It To Me".
- Stats should relate to downloads, ratings, or pages/chapters.
- Create urgency but keep it believable ("Limited time", "Join 500+ others").`,
    },
    'booking': {
      pageType: 'booking / consultation / appointment',
      rules: `- The page goal is to get visitors to book a call, meeting, or consultation.
- The form should ask for name, email, and optionally phone number. Include a topic/reason field if the template has one.
- Headlines should emphasize the VALUE of the consultation, not just "book a call".
- Feature sections should describe what happens during the call or what they'll walk away with.
- CTA buttons should say things like "Book Your Free Call", "Schedule a Consultation", "Reserve Your Spot".
- Stats should relate to clients helped, satisfaction rates, or years of experience.
- Address objections: "No obligation", "100% free", "No sales pitch".`,
    },
    'webinar': {
      pageType: 'webinar / live event registration',
      rules: `- The page goal is to get visitors to register for a live or recorded event.
- The form should ask for name and email only.
- Headlines should emphasize what they'll LEARN or GAIN from attending.
- Include event details: date, time, duration, what's covered.
- Feature sections should be "What you'll learn" or "Agenda" items.
- CTA buttons: "Reserve Your Spot", "Register Free", "Save My Seat".
- Create scarcity: "Limited spots", "Live only", "Replay available for 48 hours".`,
    },
    'services': {
      pageType: 'professional services',
      rules: `- The page goal is to showcase services and get visitors to inquire or start a project.
- The form should ask for name, email, and a brief description of what they need.
- Headlines should lead with the OUTCOME the client gets, not the service name.
- Feature sections should list specific services or process steps.
- CTA buttons: "Get a Free Quote", "Start Your Project", "Let's Talk".
- Include trust signals: years in business, clients served, industries worked with.
- Testimonials should mention specific results or ROI.`,
    },
    'saas': {
      pageType: 'software / SaaS product',
      rules: `- The page goal is to get signups, free trials, or demo requests.
- The form should ask for name and email (or just email for simplicity).
- Headlines should lead with the PROBLEM the software solves.
- Feature sections should highlight specific product capabilities with clear benefits.
- CTA buttons: "Start Free Trial", "Get Started Free", "Request a Demo".
- Stats: users, uptime, integrations, time saved.
- Keep it technical enough to be credible but accessible to non-technical buyers.`,
    },
    'physical-product': {
      pageType: 'physical product',
      rules: `- The page goal is to sell or pre-sell a physical product.
- Headlines should focus on the transformation or experience the product creates.
- Feature sections should highlight product specs, materials, what's included.
- CTA buttons: "Buy Now", "Order Today", "Add to Cart", "Get Yours".
- Include shipping info, guarantees, return policy mentions.
- Stats: units sold, customer reviews, satisfaction rate.`,
    },
    'info-product': {
      pageType: 'digital product / online course',
      rules: `- The page goal is to sell a digital product, course, or program.
- Headlines should emphasize the transformation or outcome students get.
- Feature sections should list modules, lessons, or what's included.
- CTA buttons: "Get Instant Access", "Enroll Now", "Join the Program".
- Include curriculum/module breakdown if the template has sections for it.
- Stats: students enrolled, completion rate, average rating.
- Address the "will this work for me?" objection.`,
    },
  }

  return guides[category] || {
    pageType: 'landing page',
    rules: `- Write compelling copy focused on getting the visitor to take the primary action.
- Headlines should lead with benefits, not features.
- CTA buttons should be action-oriented and specific.
- Update all placeholder content to match the specific business.`,
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Landing Pages', summary: 'AI content generation',
  methods: { POST: { summary: 'Generate landing page from template + business context', tags: ['Landing Pages'] } },
}
