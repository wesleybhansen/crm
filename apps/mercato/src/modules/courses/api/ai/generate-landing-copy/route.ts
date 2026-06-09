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
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { courseId, courseTitle, courseDescription, modules: inlineModules, targetAudience, isFree, price } = body

    let courseData: any
    let moduleDetails: string
    let totalLessons: number
    let totalMinutes: number
    let enrollmentCount = 0

    if (courseId) {
      // Load from DB
      courseData = await knex('courses').where('id', courseId).where('organization_id', auth.orgId).first()
      if (!courseData) return NextResponse.json({ ok: false, error: 'Course not found' }, { status: 404 })
      const modules = await knex('course_modules').where('course_id', courseId).orderBy('sort_order')
      for (const mod of modules) {
        mod.lessons = await knex('course_lessons').where('module_id', mod.id).orderBy('sort_order').select('title', 'content_type', 'duration_minutes', 'description')
      }
      const [{ count }] = await knex('course_enrollments').where('course_id', courseId).where('status', 'active').count()
      enrollmentCount = Number(count)
      totalLessons = modules.reduce((s: number, m: any) => s + (m.lessons?.length || 0), 0)
      totalMinutes = modules.reduce((s: number, m: any) => s + m.lessons.reduce((ls: number, l: any) => ls + (l.duration_minutes || 0), 0), 0)
      moduleDetails = modules.map((m: any) => `${m.title}: ${(m.lessons || []).map((l: any) => l.title).join(', ')}`).join('\n')
    } else if (courseTitle || inlineModules) {
      // Inline data from wizard (course doesn't exist yet)
      courseData = { title: courseTitle || 'Untitled Course', description: courseDescription || '', is_free: isFree !== false, price: price || null }
      const mods = inlineModules || []
      totalLessons = mods.reduce((s: number, m: any) => s + (m.lessons?.length || 0), 0)
      totalMinutes = totalLessons * 10
      moduleDetails = mods.map((m: any) => `${m.title}: ${(m.lessons || []).map((l: any) => l.title).join(', ')}`).join('\n')
    } else {
      return NextResponse.json({ ok: false, error: 'courseId or courseTitle required' }, { status: 400 })
    }

    const profile = await knex('business_profiles').where('organization_id', auth.orgId).first()

    const prompt = `You are a direct-response copywriter writing a high-converting course landing page. Use the PAS framework (Problem-Agitation-Solution) throughout. Your copy must be specific, urgent, and benefit-driven — never vague or generic.

COURSE DATA:
Title: ${courseData.title}
Description: ${courseData.description || '(Infer from curriculum below)'}
Price: ${courseData.is_free ? 'Free' : `$${Number(courseData.price || 0).toFixed(2)}`}
Scope: ${totalLessons} lessons, ~${totalMinutes || totalLessons * 10} min
${Number(enrollmentCount) > 0 ? `Students enrolled: ${Number(enrollmentCount)}` : ''}
${profile?.business_name ? `Instructor: ${profile.business_name}` : ''}

CURRICULUM:
${moduleDetails}

COPYWRITING PRINCIPLES TO FOLLOW:
1. HEADLINE: Lead with the outcome, not the process. "Get X Without Y" or "The [Timeframe] Path to [Result]". Must be specific to this course.
2. SUBHEADLINE: First sentence agitates a specific pain the reader feels right now. Second sentence positions this course as the bridge to their desired state. Use "you" language.
3. VALUE BULLETS: Each one answers "After this course, I can ___". Title is 2-4 words (the benefit). Description is one sentence (how they get it). Be concrete — reference actual curriculum topics.
4. HIGHLIGHTS: Sell the FORMAT, not the topic. What makes this learning experience different? (e.g., "real-world projects in every module" not "learn marketing"). Exactly 4 highlights.
5. FAQ: Handle the top objections a buyer has BEFORE they think them. Be honest and direct — no corporate speak.
6. WHO IS THIS FOR: Paint a picture of someone who recognizes themselves. Include their current situation AND desired outcome.
7. CTA: Use first-person action language ("Get My Access" not "Sign Up").

BANNED PHRASES: "unlock your potential", "take it to the next level", "comprehensive guide", "empower yourself", "game-changer", "deep dive", "cutting-edge", "world-class", "transform your", "revolutionize"

Return ONLY valid JSON (no markdown, no explanation):
{
  "headline": "MAXIMUM 10 words. Outcome-driven, specific to this course. Shorter is better.",
  "subheadline": "Exactly 2 sentences, no more. Sentence 1 = their pain. Sentence 2 = how this course solves it.",
  "valueBullets": [
    {"title": "2-4 Word Benefit", "description": "After this course, you'll be able to [specific thing from curriculum]"},
    {"title": "Another Benefit", "description": "Concrete skill or capability they gain"},
    {"title": "Time/Money Saved", "description": "What this replaces or eliminates from their life"},
    {"title": "Confidence Gained", "description": "How their professional identity changes"}
  ],
  "highlights": [
    {"title": "3-4 word format benefit", "description": "Why this format works — be specific about exercises, templates, etc."},
    {"title": "Another format benefit", "description": "What makes the learning experience practical"},
    {"title": "Third format benefit", "description": "Access, pacing, or support benefit"},
    {"title": "Fourth format benefit", "description": "Completion, tracking, or community benefit"}
  ],
  "ctaText": "First-person CTA, 3-5 words (e.g. 'Get My Access Now')",
  "faq": [
    {"question": "Short buyer objection (max 10 words)", "answer": "2 sentences max. Be direct, no fluff."},
    {"question": "Time/commitment concern (max 10 words)", "answer": "2 sentences max."},
    {"question": "Skill level concern (max 10 words)", "answer": "2 sentences max."},
    {"question": "Access/format question (max 10 words)", "answer": "2 sentences max."}
  ],
  "whoIsThisFor": [
    {"title": "2-3 word role (e.g. 'The Freelancer')", "description": "One sentence, max 20 words. Their situation + goal."},
    {"title": "2-3 word role", "description": "One sentence, max 20 words."},
    {"title": "2-3 word role", "description": "One sentence, max 20 words."}
  ]
}`

    const aiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`,
      {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': aiKey },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 4000, temperature: 0.8 } }),
      },
    )

    const aiData = await aiRes.json()
    let text = aiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || ''
    text = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return NextResponse.json({ ok: false, error: 'AI returned invalid format' }, { status: 500 })

    const landingCopy = JSON.parse(jsonMatch[0])

    void meterCustomersAi(auth, {
      model: 'gemini-2.5-flash',
      tokensIn: aiData?.usageMetadata?.promptTokenCount || 0,
      tokensOut: aiData?.usageMetadata?.candidatesTokenCount || 0,
      feature: 'courses-generate-landing-copy',
      byoKey: !!gate.byoApiKey,
    })

    // Save to course if it exists
    if (courseId) {
      await knex('courses').where('id', courseId).update({ landing_copy: JSON.stringify(landingCopy), updated_at: new Date() })
    }

    return NextResponse.json({ ok: true, data: landingCopy })
  } catch (error) {
    console.error('[courses.ai.generate-landing-copy]', error)
    return NextResponse.json({ ok: false, error: 'Failed to generate copy' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Courses',
  summary: 'AI landing page copy generation',
  methods: { POST: { summary: 'Generate landing page copy with AI', tags: ['Courses'] } },
}
