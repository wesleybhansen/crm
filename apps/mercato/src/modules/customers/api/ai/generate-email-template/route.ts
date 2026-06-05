// ORM-SKIP: AI generation/analysis — complex prompt construction, not CRUD
export const metadata = { path: '/ai/generate-email-template', POST: { requireAuth: true } }
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { meterCustomersAi } from '@/lib/usage/meter'
import { checkCustomersAiAllowance } from '@/lib/usage/allowance'

export async function POST(req: Request) {
  try {
    const auth = await getAuthFromCookies()
    if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

    const gate = await checkCustomersAiAllowance(auth)
    if (!gate.allowed) {
      return NextResponse.json({ ok: false, error: gate.message }, { status: 402 })
    }

    const body = await req.json()
    const { brandColors, logoUrl, tone, layoutPreference } = body

    const primary = brandColors?.primary || '#3B82F6'
    const secondary = brandColors?.secondary || '#1E40AF'
    const background = brandColors?.background || '#ffffff'

    const apiKey = gate.byoApiKey || process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY
    if (!apiKey) {
      return NextResponse.json({ ok: false, error: 'AI not configured' }, { status: 503 })
    }

    const prompt = `Generate a complete, production-ready responsive HTML email template.

REQUIREMENTS:
- Brand primary color: ${primary}
- Brand secondary color: ${secondary}
- Background color: ${background}
${logoUrl ? `- Logo URL: ${logoUrl}` : '- Include a text-based logo placeholder that says "Your Logo"'}
- Tone: ${tone || 'professional'}
- Layout preference: ${layoutPreference || 'standard single column'}

TECHNICAL REQUIREMENTS:
- Use table-based layout for Outlook compatibility
- ALL CSS must be inline (no external stylesheets)
- Include responsive media queries in a <style> tag in the <head>
- Use web-safe fonts with fallbacks (Helvetica Neue, Helvetica, Arial, sans-serif)
- Must be valid XHTML for email clients

STRUCTURE (all sections required):
1. Header - ${logoUrl ? 'logo image' : 'text logo placeholder'} centered
2. Hero section - large headline area with subtext, using the primary brand color
3. Body section - use {{content}} as the placeholder where email content will be injected
4. CTA button - styled with the primary brand color, bold text
5. Footer - include {{unsubscribe_url}} link, {{preference_url}} link, and social media icon placeholders

PLACEHOLDERS TO INCLUDE:
- {{subject}} in the preheader text (hidden span at top of body)
- {{content}} where the main email body goes
- {{unsubscribe_url}} in the footer unsubscribe link
- {{preference_url}} in the footer preferences link
- {{brand_primary}} set to ${primary}
- {{brand_secondary}} set to ${secondary}
- {{brand_bg}} set to ${background}

OUTPUT: Return ONLY the raw HTML. No markdown fences, no explanation. Just the complete HTML document starting with <!DOCTYPE html> and ending with </html>.`

    const model = process.env.AI_MODEL || 'gemini-3.5-flash'
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000)

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 8192 },
        }),
        signal: controller.signal,
      }
    )
    clearTimeout(timeout)

    const data = await response.json()
    void meterCustomersAi(auth, {
      model,
      tokensIn: data?.usageMetadata?.promptTokenCount || 0,
      tokensOut: data?.usageMetadata?.candidatesTokenCount || 0,
      feature: 'generate-email-template',
      byoKey: !!gate.byoApiKey,
    })
    if (data.error) {
      console.error('[ai.generate-email-template] Gemini error:', data.error)
      return NextResponse.json({ ok: false, error: 'AI generation failed' }, { status: 502 })
    }

    let htmlTemplate = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
    htmlTemplate = htmlTemplate.trim()
    if (htmlTemplate.startsWith('```')) {
      htmlTemplate = htmlTemplate.replace(/^```(?:html)?\n?/, '').replace(/\n?```$/, '')
    }

    if (!htmlTemplate.includes('<!DOCTYPE') && !htmlTemplate.includes('<html')) {
      return NextResponse.json({ ok: false, error: 'AI did not produce valid HTML' }, { status: 502 })
    }

    return NextResponse.json({ ok: true, htmlTemplate })
  } catch (error) {
    console.error('[ai.generate-email-template]', error)
    return NextResponse.json({ ok: false, error: 'Failed to generate template' }, { status: 500 })
  }
}

export const openApi = {
  tag: 'AI',
  summary: 'Generate a custom HTML email template using AI',
  methods: ['POST'],
}
