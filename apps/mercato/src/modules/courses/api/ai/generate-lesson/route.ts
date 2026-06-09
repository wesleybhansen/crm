import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { meterCustomersAi } from '@/lib/usage/meter'
import { checkCustomersAiAllowance } from '@/lib/usage/allowance'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['courses.manage'] },
}

export async function POST(req: Request, ctx: any) {
  const auth = ctx?.auth
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const gate = await checkCustomersAiAllowance(auth)
  if (!gate.allowed) return NextResponse.json({ ok: false, error: gate.message }, { status: 402 })

  const aiKey = gate.byoApiKey || process.env.GOOGLE_GENERATIVE_AI_API_KEY
  if (!aiKey) return NextResponse.json({ ok: false, error: 'AI not configured' }, { status: 400 })

  try {
    const body = await req.json()
    const { courseTitle, moduleTitle, lessonTitle, lessonDescription, style, targetAudience, sourceDocuments } = body

    if (!lessonTitle?.trim()) return NextResponse.json({ ok: false, error: 'Lesson title is required' }, { status: 400 })

    let referenceContext = ''
    if (sourceDocuments && Array.isArray(sourceDocuments) && sourceDocuments.length > 0) {
      referenceContext = '\n\nReference Material (base the lesson content on these documents — cite and expand on this material):\n'
      for (const doc of sourceDocuments.slice(0, 5)) {
        referenceContext += `\n--- ${doc.title} ---\n${(doc.content || '').substring(0, 8000)}\n`
      }
    }

    const styleGuide: Record<string, string> = {
      professional: 'Clear, authoritative, data-driven. Use formal language and structured explanations.',
      conversational: 'Warm, friendly, approachable. Use "you" language, analogies, and relatable examples.',
      'example-heavy': 'Lead with real-world examples and case studies. Show before you explain.',
      'step-by-step': 'Break everything into numbered steps and checklists. Practical, actionable.',
    }

    const prompt = `Write a complete lesson for an online course.

Course: ${courseTitle || 'Untitled Course'}
Module: ${moduleTitle || ''}
Lesson: ${lessonTitle}
${lessonDescription ? `Lesson Focus: ${lessonDescription}` : ''}
Target Audience: ${targetAudience || 'General audience'}${referenceContext}
Teaching Style: ${styleGuide[style || 'professional'] || styleGuide.professional}

Write the lesson content in markdown format. Structure it with:
1. **Introduction** — Hook the student, explain what they'll learn and why it matters
2. **Core Content** — The main teaching, broken into clear sections with headers
   - Use examples, analogies, or step-by-step instructions based on the teaching style
   - Include practical tips, common mistakes to avoid, or pro tips
3. **Key Takeaways** — Bullet-point summary of the most important points
4. **Action Item** — One specific thing the student should do after this lesson

Length: Write as much as the topic requires to be thorough. Don't cut short.
Format: Use markdown headers (##, ###), bullet points, numbered lists, bold text, and code blocks where appropriate.
Return ONLY the lesson content — no title header (the platform adds that), no meta-text.`

    const aiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': aiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 10000, temperature: 0.7 },
        }),
      },
    )

    const aiData = await aiRes.json()
    let content = aiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
    if (!content) return NextResponse.json({ ok: false, error: 'AI could not generate lesson content' }, { status: 500 })

    void meterCustomersAi(auth, {
      model: 'gemini-2.5-flash',
      tokensIn: aiData?.usageMetadata?.promptTokenCount || 0,
      tokensOut: aiData?.usageMetadata?.candidatesTokenCount || 0,
      feature: 'courses-generate-lesson',
      byoKey: !!gate.byoApiKey,
    })

    return NextResponse.json({ ok: true, data: { content } })
  } catch (error) {
    console.error('[courses.ai.generate-lesson]', error)
    return NextResponse.json({ ok: false, error: 'Failed to generate lesson' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Courses',
  summary: 'AI lesson content generation',
  methods: { POST: { summary: 'Generate lesson content with AI', tags: ['Courses'] } },
}
