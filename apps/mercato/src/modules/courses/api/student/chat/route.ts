export const metadata = { POST: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

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

    const body = await req.json()
    const { courseId, lessonId, message, history } = body

    if (!courseId || !message?.trim()) {
      return NextResponse.json({ ok: false, error: 'courseId and message required' }, { status: 400 })
    }

    const aiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY
    if (!aiKey) return NextResponse.json({ ok: false, error: 'AI not configured' }, { status: 400 })

    // Load course context
    const course = await knex('courses').where('id', courseId).first()
    if (!course) return NextResponse.json({ ok: false, error: 'Course not found' }, { status: 404 })

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
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${aiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

    return NextResponse.json({ ok: true, data: { reply } })
  } catch (error) {
    console.error('[courses.student.chat]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
