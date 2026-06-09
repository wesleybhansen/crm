import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['courses.manage'] },
}

export async function POST(req: Request, ctx: any) {
  const auth = ctx?.auth
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const aiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY
  if (!aiKey) return NextResponse.json({ ok: false, error: 'AI not configured' }, { status: 400 })

  try {
    const body = await req.json()
    const { topic, targetAudience, depth, style, notes, sourceDocuments } = body

    if (!topic?.trim()) return NextResponse.json({ ok: false, error: 'Topic is required' }, { status: 400 })

    // Build reference material from source documents
    let referenceContext = ''
    if (sourceDocuments && Array.isArray(sourceDocuments) && sourceDocuments.length > 0) {
      referenceContext = '\n\nReference Material (use these documents as the foundation for the course — prioritize this content, supplement only to fill gaps):\n'
      for (const doc of sourceDocuments.slice(0, 5)) {
        // Sanitize content: remove backticks, control chars, and truncate
        const raw = (doc.content || '').substring(0, 4000)
        const content = raw.replace(/`/g, "'").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
        referenceContext += `\n--- ${(doc.title || 'Document').replace(/`/g, "'")} ---\n${content}\n`
      }
    }

    const depthGuide: Record<string, string> = {
      quick: '3-5 lessons total across 1-2 modules. Keep it concise and focused.',
      standard: '5-8 lessons across 2-3 modules. Balance depth with brevity.',
      comprehensive: '8-15 lessons across 3-5 modules. Cover the topic thoroughly with examples and exercises.',
    }

    const styleGuide: Record<string, string> = {
      professional: 'Use a clear, professional tone. Data-driven, structured, authoritative.',
      conversational: 'Use a friendly, approachable tone. Speak directly to the student with "you" language.',
      'example-heavy': 'Lead with real-world examples, case studies, and practical scenarios.',
      'step-by-step': 'Break everything into numbered steps, checklists, and actionable instructions.',
    }

    const prompt = `You are a professional course curriculum designer. Create a detailed course outline.

Topic: ${topic}
Target Audience: ${targetAudience || 'General audience'}
Depth: ${depth || 'standard'} — ${depthGuide[depth || 'standard'] || depthGuide.standard}
Teaching Style: ${style || 'professional'} — ${styleGuide[style || 'professional'] || styleGuide.professional}
${notes ? `Additional Context: ${notes}` : ''}${referenceContext}

Return a JSON object with this exact structure (no markdown fences, just raw JSON):
{
  "title": "Course Title",
  "description": "2-3 sentence course description that sells the value of this course",
  "modules": [
    {
      "title": "Module Title",
      "description": "What this module covers",
      "lessons": [
        {
          "title": "Lesson Title",
          "contentType": "text",
          "durationEstimate": 10,
          "description": "Brief description of what this lesson teaches — used to generate content later"
        }
      ]
    }
  ]
}

Rules:
- Create a logical progression from fundamentals to advanced
- Each lesson should teach ONE clear concept
- Duration estimates in minutes (5-20 per lesson)
- Module descriptions should explain the learning outcome
- Lesson descriptions should be detailed enough to generate full content from
- Return ONLY valid JSON`

    const aiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': aiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 4000, temperature: 0.7 },
        }),
      },
    )

    const aiData = await aiRes.json()
    const blocked = aiData.candidates?.[0]?.finishReason
    if (blocked === 'SAFETY' || blocked === 'RECITATION') {
      console.error('[courses.ai.generate-outline] Blocked by safety filter:', blocked)
      return NextResponse.json({ ok: false, error: 'AI content filter blocked this request. Try simplifying your source documents or topic.' }, { status: 400 })
    }
    let text = aiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
    if (!text) {
      console.error('[courses.ai.generate-outline] Empty AI response:', JSON.stringify(aiData).substring(0, 500))
      return NextResponse.json({ ok: false, error: 'AI could not generate an outline. Try again or simplify your inputs.' }, { status: 500 })
    }

    // Strip markdown fences if present
    text = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').replace(/^[^{]*/, '').trim()

    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      console.error('[courses.ai.generate-outline] No JSON found in:', text.substring(0, 300))
      return NextResponse.json({ ok: false, error: 'AI returned an unexpected format. Try again.' }, { status: 500 })
    }

    let outline: any
    try { outline = JSON.parse(jsonMatch[0]) }
    catch { return NextResponse.json({ ok: false, error: 'AI returned malformed JSON. Try again.' }, { status: 500 }) }

    return NextResponse.json({ ok: true, data: outline })
  } catch (error) {
    console.error('[courses.ai.generate-outline]', error)
    return NextResponse.json({ ok: false, error: 'Failed to generate outline' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Courses',
  summary: 'AI course outline generation',
  methods: { POST: { summary: 'Generate course outline with AI', tags: ['Courses'] } },
}
