import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const { businessType, description } = body

    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY
    if (!apiKey) {
      // Fallback stages
      return NextResponse.json({
        ok: true,
        stages: [
          { name: 'New Lead', order: 1 },
          { name: 'Contacted', order: 2 },
          { name: 'Qualified', order: 3 },
          { name: 'Proposal', order: 4 },
          { name: 'Won', order: 5 },
          { name: 'Lost', order: 6 },
        ],
      })
    }

    const prompt = `Suggest 5-7 sales pipeline stages for this business. Return JSON array only.

Business type: ${businessType || 'general'}
Description: ${description || 'small business'}

Rules:
- 5-7 stages, ordered from first contact to closed
- Last two should be a positive outcome and a negative outcome (like Won/Lost or Enrolled/Declined)
- Use simple, clear names that a solopreneur would understand
- Return ONLY JSON: [{"name": "Stage Name", "order": 1}, ...]
- No markdown fences`

    const model = process.env.AI_MODEL || 'gemini-2.0-flash'
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 512 },
        }),
        signal: controller.signal,
      }
    )
    clearTimeout(timeout)

    const data = await response.json()
    let text = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
    text = text.trim()
    if (text.startsWith('```')) text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')

    try {
      const stages = JSON.parse(text)
      return NextResponse.json({ ok: true, stages })
    } catch {
      return NextResponse.json({
        ok: true,
        stages: [
          { name: 'New Lead', order: 1 },
          { name: 'Contacted', order: 2 },
          { name: 'Qualified', order: 3 },
          { name: 'Proposal', order: 4 },
          { name: 'Won', order: 5 },
          { name: 'Lost', order: 6 },
        ],
      })
    }
  } catch (error) {
    console.error('[ai.suggest-pipeline]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
