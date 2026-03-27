import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const body = await req.json()
    const { subject } = body

    if (!subject?.trim()) {
      return NextResponse.json({ ok: false, error: 'subject is required' }, { status: 400 })
    }

    const apiKey = process.env.GEMINI_API_KEY || process.env.AI_API_KEY
    if (!apiKey) {
      return NextResponse.json({ ok: false, error: 'AI not configured' }, { status: 500 })
    }

    const prompt = `You are an email marketing expert. Analyze this email subject line and provide optimization suggestions.

Subject line: "${subject}"

Respond in this exact JSON format:
{
  "score": <number 1-10>,
  "feedback": "<one sentence explaining the score>",
  "issues": ["<list any issues like spam trigger words, too long, too vague>"],
  "alternatives": ["<3 improved subject line alternatives>"]
}

Scoring criteria:
- Length: optimal 30-50 characters (penalize over 60 or under 15)
- Spam triggers: words like "free", "buy now", "limited time", ALL CAPS
- Personalization: using {{firstName}} or similar
- Clarity: clear what the email is about
- Urgency/curiosity: creates reason to open without being clickbait
- Emoji: one emoji can help, too many hurts

Return ONLY valid JSON, no markdown.`

    const provider = process.env.AI_PROVIDER || 'google'
    let result: any

    if (provider === 'google') {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.7, maxOutputTokens: 500 },
          }),
        }
      )
      const data = await res.json()
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || ''
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (jsonMatch) result = JSON.parse(jsonMatch[0])
    }

    if (!result) {
      return NextResponse.json({ ok: false, error: 'AI failed to analyze subject line' }, { status: 500 })
    }

    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    console.error('[ai.optimize-subject]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'AI', summary: 'Subject line optimizer',
  methods: { POST: { summary: 'AI-powered email subject line analysis and suggestions', tags: ['AI'] } },
}
