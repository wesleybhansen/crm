export const metadata = { POST: { requireAuth: false } }

import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { meterCustomersAi } from '@/lib/usage/meter'
import { checkCustomersAiAllowance } from '@/lib/usage/allowance'

// Modest abuse guard: per-session sliding-window message cap (in-memory, resets on restart).
const TUTOR_MESSAGES_PER_HOUR = 30
const tutorRate = new Map<string, { count: number; windowStart: number }>()
function tutorRateLimited(sessionToken: string): boolean {
  const now = Date.now()
  const entry = tutorRate.get(sessionToken)
  if (!entry || now - entry.windowStart > 60 * 60 * 1000) {
    tutorRate.set(sessionToken, { count: 1, windowStart: now })
    return false
  }
  entry.count += 1
  return entry.count > TUTOR_MESSAGES_PER_HOUR
}

export async function POST(req: Request) {
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // Validate session
    const cookies = req.headers.get('cookie') || ''
    const sessionMatch = cookies.match(/course_session=([^;]+)/)
    if (!sessionMatch) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 })

    const session = await knex('course_student_sessions')
      .where('session_token', sessionMatch[1])
      .where('expires_at', '>', new Date())
      .first()
    if (!session) return NextResponse.json({ ok: false, error: 'Session expired' }, { status: 401 })

    if (tutorRateLimited(sessionMatch[1])) {
      return NextResponse.json({ ok: false, error: 'Too many messages — please take a short break and try again.' }, { status: 429 })
    }

    const body = await req.json()
    const { courseId, lessonId, message, history } = body

    if (!courseId || !message?.trim()) {
      return NextResponse.json({ ok: false, error: 'courseId and message required' }, { status: 400 })
    }

    // Load course context — must belong to the session's org
    const course = await knex('courses')
      .where('id', courseId)
      .where('organization_id', session.organization_id)
      .whereNull('deleted_at')
      .first()
    if (!course) return NextResponse.json({ ok: false, error: 'Course not found' }, { status: 404 })

    // Verify the student is actively enrolled in THIS course
    const enrollment = await knex('course_enrollments')
      .where('student_email', session.email)
      .where('course_id', course.id)
      .where('status', 'active')
      .first()
    if (!enrollment) return NextResponse.json({ ok: false, error: 'Not enrolled' }, { status: 403 })

    // Allowance gate + BYOK fall-through — tutoring runs on the course org's pooled allowance
    const orgAuth = { orgId: session.organization_id as string }
    const gate = await checkCustomersAiAllowance(orgAuth)
    if (!gate.allowed) {
      return NextResponse.json({ ok: false, error: 'The AI tutor is unavailable right now. Please try again later.' }, { status: 402 })
    }

    const aiKey = gate.byoApiKey || process.env.GOOGLE_GENERATIVE_AI_API_KEY
    if (!aiKey) return NextResponse.json({ ok: false, error: 'AI not configured' }, { status: 400 })

    const modules = await knex('course_modules').where('course_id', courseId).orderBy('sort_order')
    for (const mod of modules) {
      mod.lessons = await knex('course_lessons').where('module_id', mod.id).orderBy('sort_order')
        .select('id', 'title', 'content', 'description')
    }

    // Build course outline for context
    let courseOutline = ''
    for (const mod of modules) {
      courseOutline += `
Module: ${mod.title}
`
      for (const les of mod.lessons || []) {
        courseOutline += `  - ${les.title}${les.description ? `: ${les.description}` : ''}
`
      }
    }

    // Get current lesson content if provided
    let lessonContext = ''
    if (lessonId) {
      const lesson = await knex('course_lessons').where('id', lessonId).first()
      if (lesson) {
        lessonContext = `

--- CURRENT LESSON: ${lesson.title} ---
${(lesson.content || '').substring(0, 6000)}
`
      }
    }

    // Build conversation history for multi-turn
    const conversationHistory = (history || []).slice(-10).map((msg: any) => ({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content }],
    }))

    const systemPrompt = `You are an expert AI tutor for the course "${course.title}". Your role is to help students understand the material deeply.

TEACHING APPROACH:
- Be warm, encouraging, and patient — like a great teacher who genuinely cares about the student's success
- Give clear, specific answers grounded in the course material
- Use analogies and real-world examples to explain complex concepts
- When appropriate, ask follow-up questions to check understanding
- If a student is confused, break the concept down into smaller pieces
- Reference specific lessons or modules when relevant
- Keep responses focused and concise (2-4 paragraphs max unless the student asks for more detail)
- Use markdown formatting for readability (bold for key terms, bullet points for lists)

COURSE CONTEXT:
Title: ${course.title}
Description: ${course.description || ''}

CURRICULUM:
${courseOutline}${lessonContext}

RULES:
- Stay on topic — only answer questions related to this course's subject matter
- If asked something outside the course scope, acknowledge it and redirect back to the course material
- Never make up information — if you're not sure about something specific to this course, say so
- Encourage the student to complete lessons and practice what they learn`

    const contents = [
      { role: 'user', parts: [{ text: systemPrompt }] },
      { role: 'model', parts: [{ text: 'I understand. I\'m ready to help students learn this course material. How can I help?' }] },
      ...conversationHistory,
      { role: 'user', parts: [{ text: message }] },
    ]

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': aiKey },
        body: JSON.stringify({
          contents,
          generationConfig: { maxOutputTokens: 2000, temperature: 0.7 },
        }),
      },
    )

    const aiData = await res.json()
    const reply = aiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim()

    if (!reply) {
      return NextResponse.json({ ok: false, error: 'AI could not generate a response' }, { status: 500 })
    }

    void meterCustomersAi(orgAuth, {
      model: 'gemini-2.5-flash',
      tokensIn: aiData?.usageMetadata?.promptTokenCount || 0,
      tokensOut: aiData?.usageMetadata?.candidatesTokenCount || 0,
      feature: 'course-tutor',
      byoKey: !!gate.byoApiKey,
    })

    return NextResponse.json({ ok: true, data: { reply } })
  } catch (error) {
    console.error('[courses.student.chat]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
