import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { buildPersonaPrompt, getPersonaForOrg, buildVoicePromptSection } from '../persona'

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const { contactName, contactEmail, purpose, context } = body

    if (!contactName) {
      return NextResponse.json({ ok: false, error: 'contactName required' }, { status: 400 })
    }

    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY
    if (!apiKey) {
      // Fallback without AI
      return NextResponse.json({
        ok: true,
        subject: `Following up — ${contactName}`,
        body: `Hi ${contactName.split(' ')[0]},\n\nI wanted to follow up with you.\n\nBest regards`,
      })
    }

    // Load persona for tone matching
    let toneInstruction = 'Friendly but professional tone'
    try {
      const auth = await getAuthFromCookies()
      if (auth?.orgId) {
        const container = await createRequestContainer()
        const em = container.resolve('em') as EntityManager
        const knex = em.getKnex()
        const profile = await getPersonaForOrg(knex, auth.orgId)
        if (profile) {
          // Brand voice profile takes precedence over generic persona style
          if (profile.brand_voice_profile?.style_summary) {
            toneInstruction = buildVoicePromptSection(profile.brand_voice_profile)
          } else {
            const style = profile.ai_persona_style || 'professional'
            if (style === 'professional') toneInstruction = 'Professional, direct, and efficient tone'
            else if (style === 'casual') toneInstruction = 'Warm, friendly, and conversational tone'
            else if (style === 'minimal') toneInstruction = 'Extremely concise and no-nonsense tone'
          }
          if (profile.ai_custom_instructions) {
            toneInstruction += `\nAdditional style rules: ${profile.ai_custom_instructions}`
          }
        }
      }
    } catch {}

    const prompt = `Write a short email for a solopreneur/small business owner.

TO: ${contactName} (${contactEmail || 'no email'})
PURPOSE: ${purpose || 'general follow-up'}
${context ? `CONTEXT: ${context}` : ''}

RULES:
- Keep it under 100 words
- ${toneInstruction}
- No fluff or filler
- Include a clear next step or call to action
- Don't use overly formal language like "I hope this email finds you well"
- Return JSON only: {"subject": "...", "body": "..."}
- The body should use \\n for line breaks
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
    if (data.error) {
      // Fallback on error
      return NextResponse.json({
        ok: true,
        subject: `Following up — ${contactName}`,
        body: `Hi ${contactName.split(' ')[0]},\n\nI wanted to reach out and connect.\n\nBest regards`,
      })
    }

    let text = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
    text = text.trim()
    if (text.startsWith('```')) text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')

    try {
      const parsed = JSON.parse(text)
      return NextResponse.json({ ok: true, subject: parsed.subject, body: parsed.body })
    } catch {
      return NextResponse.json({
        ok: true,
        subject: `Following up — ${contactName}`,
        body: `Hi ${contactName.split(' ')[0]},\n\n${text.substring(0, 500)}`,
      })
    }
  } catch (error) {
    console.error('[ai.draft-email]', error)
    return NextResponse.json({ ok: false, error: 'Failed to draft email' }, { status: 500 })
  }
}
