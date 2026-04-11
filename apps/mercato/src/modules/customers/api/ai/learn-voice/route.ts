export const metadata = { path: '/ai/learn-voice', GET: { requireAuth: true }, POST: { requireAuth: true } }
/**
 * Brand Voice Engine — Learn Voice
 * POST: Analyze writing samples (Gmail sent emails or uploaded document) and generate voice profile
 * GET: Return current voice profile
 */
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { query, queryOne } from '@/lib/db'
// Gmail-based voice learning is disabled pending Tier 1 OAuth verification.
// Re-add these imports when restoring the Gmail source path:
// import { getGmailTokenRaw, fetchGmailSentMessages } from '@/modules/email/lib/gmail-helpers'

const ANALYSIS_PROMPT = `Analyze the following writing samples and extract a detailed writing style profile. These are emails written by a real person — capture their unique voice.

Return a JSON object with these fields:
- style_summary: A 2-3 sentence description of the writer's style, written as instructions for another AI to mimic it. Be specific about tone, formality, and personality.
- sample_phrases: Array of 5-8 characteristic phrases or expressions the writer actually uses
- formality_score: 1-5 (1=very casual with slang/emoji, 3=balanced, 5=very formal/corporate)
- avg_sentence_length: estimated average words per sentence (number)
- uses_emoji: boolean — whether they use emoji in professional writing
- greeting_style: how they typically open emails (e.g. "Hey [name]," or "Hi there," or "Good morning,")
- closing_style: how they typically close emails (e.g. "Best,\n[name]" or "Thanks!" or "Cheers,")
- vocabulary_notes: notable vocabulary patterns — words they favor, words they avoid, any industry jargon

Return ONLY valid JSON. No markdown fences, no explanation.

WRITING SAMPLES:
`

export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const profile = await queryOne(
      'SELECT brand_voice_profile, brand_voice_updated_at, brand_voice_source FROM business_profiles WHERE organization_id = $1',
      [auth.orgId]
    )

    return NextResponse.json({
      ok: true,
      data: {
        profile: profile?.brand_voice_profile || null,
        updatedAt: profile?.brand_voice_updated_at || null,
        source: profile?.brand_voice_source || null,
      },
    })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed to load voice profile' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  const userId = auth?.sub
  if (!auth?.orgId || !userId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const body = await req.json()
    const { source, documentContent } = body as { source: 'gmail' | 'outlook' | 'email' | 'document'; documentContent?: string }

    if (!source) return NextResponse.json({ ok: false, error: 'source required' }, { status: 400 })

    let writingSamples = ''
    let resolvedSource = source

    if (source === 'gmail' || source === 'outlook' || source === 'email') {
      // Gmail sent-mail learning is disabled pending Tier 1 OAuth verification.
      // gmail.readonly is a restricted scope requiring CASA. Users should upload
      // a document with their writing samples instead. Re-enable this path after
      // verification + App Password fallback ships.
      return NextResponse.json({
        ok: false,
        error: 'Gmail voice learning is temporarily unavailable while Launch OS completes Google verification. Please upload a document with sample writing instead.',
      }, { status: 503 })
    } else if (source === 'document') {
      if (!documentContent?.trim()) return NextResponse.json({ ok: false, error: 'documentContent required for document source' }, { status: 400 })
      writingSamples = documentContent.slice(0, 12000)
      resolvedSource = 'document'
    } else {
      return NextResponse.json({ ok: false, error: 'source must be email, gmail, outlook, or document' }, { status: 400 })
    }

    // Analyze with Gemini
    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY
    if (!apiKey) return NextResponse.json({ ok: false, error: 'AI not configured' }, { status: 500 })

    const aiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: ANALYSIS_PROMPT + writingSamples }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 2000 },
        }),
      }
    )

    if (!aiRes.ok) {
      const err = await aiRes.text().catch(() => '')
      console.error('[learn-voice] Gemini error:', aiRes.status, err)
      return NextResponse.json({ ok: false, error: 'AI analysis failed' }, { status: 500 })
    }

    const aiData = await aiRes.json()
    const rawText = aiData.candidates?.[0]?.content?.parts?.[0]?.text || ''

    // Parse the JSON response — strip markdown fences if present
    const cleaned = rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
    let voiceProfile
    try {
      voiceProfile = JSON.parse(cleaned)
    } catch {
      console.error('[learn-voice] Failed to parse AI response:', cleaned.slice(0, 200))
      return NextResponse.json({ ok: false, error: 'AI returned invalid format. Try again.' }, { status: 500 })
    }

    // Store the profile
    await query(
      `UPDATE business_profiles SET brand_voice_profile = $1, brand_voice_updated_at = now(), brand_voice_source = $2, updated_at = now() WHERE organization_id = $3`,
      [JSON.stringify(voiceProfile), resolvedSource, auth.orgId]
    )

    return NextResponse.json({ ok: true, data: voiceProfile })
  } catch (error) {
    console.error('[learn-voice]', error)
    const msg = error instanceof Error ? error.message : 'Failed'
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
