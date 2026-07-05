import { NextResponse } from 'next/server'
import { loadPageWithHistory, historyPromptBlock, appendRevision } from '@/lib/landing-page-wizard/revision-history'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { meterCustomersAi } from '@/lib/usage/meter'
import { checkCustomersAiAllowance } from '@/lib/usage/allowance'
import { BASE_CRAFT_RULES } from '@/lib/landing-page-wizard/constants'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['landing_pages.edit'] },
}

export async function POST(req: Request) {
  try {
    const auth = await getAuthFromCookies()
    if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

    const gate = await checkCustomersAiAllowance(auth)
    if (!gate.allowed) {
      return NextResponse.json({ ok: false, error: gate.message }, { status: 402 })
    }

    const body = await req.json()
    const { currentHtml, feedback, pageId } = body

    if (!currentHtml || !feedback) {
      return NextResponse.json({ ok: false, error: 'currentHtml and feedback required' }, { status: 400 })
    }

    const apiKey = gate.byoApiKey || process.env.GOOGLE_GENERATIVE_AI_API_KEY
    if (!apiKey) {
      return NextResponse.json({ ok: false, error: 'AI API key not configured' }, { status: 500 })
    }

    // Extract just the body to reduce tokens
    const bodyMatch = currentHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i)
    const headMatch = currentHtml.match(/([\s\S]*<\/head>)/i)
    const bodyContent = bodyMatch ? bodyMatch[1] : currentHtml
    const headSection = headMatch ? headMatch[1] : ''

    const withHistory = pageId ? await loadPageWithHistory(pageId, auth.orgId!) : null

    const prompt = `You are an expert direct response landing page copywriter. The user wants to revise their page. Make the requested changes thoroughly and completely.
${withHistory ? historyPromptBlock(withHistory.history) : ''}
USER'S REQUEST: "${feedback}"

COPYWRITING RULES (apply to every line you rewrite — never let an edit drift the page back toward generic copy):
${BASE_CRAFT_RULES}
- Match the page's existing tone and voice exactly — infer it from the current copy, unless the user's request explicitly asks for a tone change.
- Never invent stats, client names, testimonials, or quotes that are not already on the page or in the user's request.

IMPORTANT:
- Make SIGNIFICANT changes to fulfill the request — don't just tweak one word
- If they ask to "make it more urgent", rewrite headlines AND body copy to create urgency
- If they ask to "add" something, add a full section with proper content
- If they ask to "remove" something, completely remove that HTML section
- If they ask to change the tone, rewrite ALL the copy in the new tone
- Keep HTML tags, classes, and CSS unchanged — only modify visible text content
- If they reference a specific section (headline, testimonials, CTA, etc.), focus there but consider the full page
- Return ONLY the revised HTML body content. No markdown fences. No explanation.

CURRENT PAGE BODY:
${bodyContent}`

    const model = process.env.AI_MODEL || 'gemini-3.5-flash'
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 90000)
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 16384 },
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
      feature: 'landing-revise',
      byoKey: !!gate.byoApiKey,
    })
    if (data.error) {
      return NextResponse.json({ ok: false, error: `AI error: ${data.error.message}` }, { status: 500 })
    }

    let html = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
    html = html.trim()
    if (html.startsWith('```')) {
      html = html.replace(/^```(?:html)?\n?/, '').replace(/\n?```$/, '')
    }

    // Re-assemble if AI returned just body content
    if (!html.includes('<!DOCTYPE') && !html.includes('<html')) {
      html = `<!DOCTYPE html>\n<html lang="en">\n${headSection}\n<body>\n${html}\n</body>\n</html>`
    }

    // Re-attach scripts
    const scriptMatch = currentHtml.match(/<script[\s\S]*<\/script>/gi)
    if (scriptMatch && !html.includes('<script')) {
      html = html.replace('</body>', scriptMatch.join('\n') + '\n</body>')
    }

    if (withHistory) {
      await appendRevision(pageId, auth.orgId!, withHistory.config, {
        at: new Date().toISOString(),
        scope: 'page',
        instruction: String(feedback).slice(0, 500),
      }).catch(() => {})
    }

    return NextResponse.json({ ok: true, html })
  } catch (error) {
    console.error('[ai.revise]', error)
    return NextResponse.json({ ok: false, error: 'Revision failed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Landing Pages', summary: 'AI revision',
  methods: { POST: { summary: 'Revise landing page based on feedback', tags: ['Landing Pages'] } },
}
