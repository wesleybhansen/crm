import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import crypto from 'crypto'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['courses.manage'] },
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) + '-' + Math.random().toString(36).substring(2, 6)
}

export async function POST(req: Request, ctx: any) {
  const auth = ctx?.auth
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const aiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY
  if (!aiKey) return NextResponse.json({ ok: false, error: 'AI not configured' }, { status: 400 })

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { topic, targetAudience, depth, style, notes, outline: preBuiltOutline, sourceDocuments, isFree, price, landingCopy, landingStyle } = body

    if (!topic?.trim() && !preBuiltOutline) return NextResponse.json({ ok: false, error: 'Topic is required' }, { status: 400 })

    let referenceContext = ''
    if (sourceDocuments && Array.isArray(sourceDocuments) && sourceDocuments.length > 0) {
      referenceContext = '\nReference Material:\n'
      for (const doc of sourceDocuments.slice(0, 5)) {
        const content = (doc.content || '').substring(0, 4000).replace(/`/g, "'").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
        referenceContext += `--- ${(doc.title || 'Document').replace(/`/g, "'")} ---\n${content}\n`
      }
    }

    // Step 1: Use pre-built outline or generate one
    let outline: any
    if (preBuiltOutline) {
      outline = preBuiltOutline
    } else {
      const depthGuide: Record<string, string> = {
        quick: '3-5 lessons total across 1-2 modules.',
        standard: '5-8 lessons across 2-3 modules.',
        comprehensive: '8-15 lessons across 3-5 modules.',
      }

      const outlinePrompt = `You are a course curriculum designer. Create a course outline.

Topic: ${topic}
Audience: ${targetAudience || 'General audience'}
Depth: ${depth || 'standard'} — ${depthGuide[depth || 'standard'] || depthGuide.standard}
${notes ? `Context: ${notes}` : ''}${referenceContext}

Return ONLY valid JSON (no markdown fences):
{
  "title": "Course Title",
  "description": "Course description (2-3 sentences)",
  "modules": [
    {
      "title": "Module Title",
      "description": "Module description",
      "lessons": [{ "title": "Lesson Title", "description": "What this lesson covers", "durationEstimate": 10 }]
    }
  ]
}`

      const outlineRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${aiKey}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: outlinePrompt }] }], generationConfig: { maxOutputTokens: 4000 } }) },
      )
      const outlineData = await outlineRes.json()
      let outlineText = outlineData.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || ''
      outlineText = outlineText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
      const jsonMatch = outlineText.match(/\{[\s\S]*\}/)
      if (!jsonMatch) return NextResponse.json({ ok: false, error: 'AI failed to generate outline' }, { status: 500 })
      outline = JSON.parse(jsonMatch[0])
    }

    // Step 2: Create course in DB
    const courseId = crypto.randomUUID()
    const slug = slugify(outline.title || topic)

    await knex('courses').insert({
      id: courseId,
      tenant_id: auth.tenantId,
      organization_id: auth.orgId,
      title: outline.title || topic,
      description: outline.description || '',
      slug,
      is_free: isFree !== false,
      price: isFree === false && price ? price : null,
      is_published: false,
      landing_copy: landingCopy ? JSON.stringify(landingCopy) : null,
      landing_style: landingStyle || 'warm',
      teaching_style: style || 'professional',
      target_audience: targetAudience || '',
      generation_status: 'generating',
      created_at: new Date(),
      updated_at: new Date(),
    })

    // Step 3: Create modules and lessons (empty content)
    const lessonIds: Array<{ id: string; title: string; description: string; moduleTitle: string }> = []

    for (let mi = 0; mi < (outline.modules || []).length; mi++) {
      const mod = outline.modules[mi]
      const moduleId = crypto.randomUUID()
      await knex('course_modules').insert({
        id: moduleId,
        course_id: courseId,
        title: mod.title,
        description: mod.description || '',
        sort_order: mi,
        created_at: new Date(),
      })

      for (let li = 0; li < (mod.lessons || []).length; li++) {
        const lesson = mod.lessons[li]
        const lessonId = crypto.randomUUID()
        await knex('course_lessons').insert({
          id: lessonId,
          module_id: moduleId,
          title: lesson.title,
          content_type: 'text',
          content: '',
          sort_order: li,
          duration_minutes: lesson.durationEstimate || 10,
          created_at: new Date(),
        })
        lessonIds.push({ id: lessonId, title: lesson.title, description: lesson.description || '', moduleTitle: mod.title })
      }
    }

    // Step 4: Generate content for each lesson (fire and forget — runs in background)
    const styleGuide: Record<string, string> = {
      professional: 'Clear, authoritative, structured.',
      conversational: 'Warm, friendly, uses "you" language.',
      'example-heavy': 'Lead with examples and case studies.',
      'step-by-step': 'Numbered steps, checklists, actionable.',
      motivational: 'Energizing, action-oriented, inspiring. Use powerful language that motivates the reader to take action. Include affirmations and momentum-building phrases.',
    }
    // If style doesn't match a preset, treat it as a custom style description
    const styleInstruction = styleGuide[style || 'professional'] || style || styleGuide.professional

    // Background task with its own DB connection
    ;(async () => {
      let bgKnex: any
      try {
        const bgContainer = await createRequestContainer()
        bgKnex = (bgContainer.resolve('em') as EntityManager).getKnex()

        for (const lesson of lessonIds) {
          const lessonPrompt = `Write a complete lesson for: "${lesson.title}"
Course: ${outline.title}
Module: ${lesson.moduleTitle}
Focus: ${lesson.description}
Audience: ${targetAudience || 'General'}
Style: ${styleInstruction}${referenceContext}

Write thorough, practical markdown content: start with a brief intro (2-3 sentences), then the core teaching with real examples, then 3-5 key takeaways as bullet points, and end with one actionable exercise. Base content on reference material if provided. No title header — jump straight into the intro.`

          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), 60000)
          try {
            const res = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${aiKey}`,
              { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
                body: JSON.stringify({ contents: [{ parts: [{ text: lessonPrompt }] }], generationConfig: { maxOutputTokens: 10000, temperature: 0.7 } }) },
            )
            clearTimeout(timeout)
            const data = await res.json()
            const content = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || ''
            if (content) {
              await bgKnex('course_lessons').where('id', lesson.id).update({ content })
            }
          } catch (lessonErr: any) {
            clearTimeout(timeout)
            console.error(`[generate-full-course] Lesson "${lesson.title}" failed:`, lessonErr?.message || lessonErr)
          }
        }
        await bgKnex('courses').where('id', courseId).update({ generation_status: 'complete', updated_at: new Date() })
      } catch (err) {
        console.error('[courses.ai.generate-full-course] background generation failed', err)
        try {
          const fallbackContainer = await createRequestContainer()
          const fallbackKnex = (fallbackContainer.resolve('em') as EntityManager).getKnex()
          await fallbackKnex('courses').where('id', courseId).update({ generation_status: 'failed', updated_at: new Date() })
        } catch {}
      }
    })()

    return NextResponse.json({
      ok: true,
      data: { courseId, title: outline.title, slug, lessonCount: lessonIds.length },
    }, { status: 201 })
  } catch (error) {
    console.error('[courses.ai.generate-full-course]', error)
    const detail = error instanceof Error ? error.message : 'Failed to generate course'
    return NextResponse.json({ ok: false, error: `Failed to generate course: ${detail}` }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Courses',
  summary: 'AI full course generation',
  methods: { POST: { summary: 'Generate a complete course with AI (outline + all lesson content)', tags: ['Courses'] } },
}
