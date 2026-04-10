import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'

bootstrap()

export async function POST(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const aiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY
  if (!aiKey) return NextResponse.json({ ok: false, error: 'AI not configured' }, { status: 400 })

  try {
    const body = await req.json()
    const { title, description, eventType, locationName, startTime, endTime, isFree, price, capacity } = body

    const dateStr = startTime ? new Date(startTime).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : ''
    const timeStr = startTime ? new Date(startTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : ''

    const prompt = `You are a direct-response copywriter creating a landing page for an event. Write compelling, specific copy.

EVENT: ${title}
DESCRIPTION: ${description || '(Infer from title)'}
TYPE: ${eventType || 'in-person'}
LOCATION: ${locationName || 'TBD'}
DATE: ${dateStr} at ${timeStr}
PRICE: ${isFree ? 'Free' : `$${Number(price || 0).toFixed(2)}`}
CAPACITY: ${capacity ? `${capacity} spots` : 'Unlimited'}

RULES:
- Headline: max 10 words, outcome-driven
- Subheadline: 2 sentences max using PAS framework
- Value bullets: 4 items with {title, description} — short title, one-sentence benefit
- Highlights: 4 items about the event format/experience
- FAQ: 4 items, direct answers, 2 sentences max
- whoIsThisFor: 3 items with {title, description} — who + why they should attend
- CTA: first-person, 3-5 words

BANNED: "unlock your potential", "take it to the next level", "game-changer", "deep dive"

Return ONLY valid JSON:
{
  "headline": "max 10 words",
  "subheadline": "2 sentences",
  "valueBullets": [{"title":"short","description":"benefit"}],
  "highlights": [{"title":"format benefit","description":"why it matters"}],
  "faq": [{"question":"short question","answer":"2 sentences max"}],
  "whoIsThisFor": [{"title":"persona","description":"why attend"}],
  "ctaText": "3-5 word CTA"
}`

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${aiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 3000, temperature: 0.8 } }) },
    )
    const aiData = await res.json()
    let text = aiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || ''
    text = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return NextResponse.json({ ok: false, error: 'AI returned invalid format' }, { status: 500 })

    const copy = JSON.parse(jsonMatch[0])
    return NextResponse.json({ ok: true, data: copy })
  } catch (error: any) {
    console.error('[crm-events.ai]', error?.message)
    return NextResponse.json({ ok: false, error: 'Failed to generate copy' }, { status: 500 })
  }
}
