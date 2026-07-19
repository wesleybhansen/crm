import crypto from 'crypto'
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { meterCustomersAi } from '@/lib/usage/meter'
import { checkCustomersAiAllowance } from '@/lib/usage/allowance'

/* Internal service endpoint (shared NOLI_INTERNAL_SERVICE_SECRET) that learns the
 * user's writing voice from their own sent mail (or pasted samples) and stores it
 * as business_profiles.brand_voice_profile — the same profile the drafter reads
 * (draft-reply.ts buildVoicePromptSection). This is the "read my message history
 * to learn how I write" feature, driven from the dashboard Guidance & style tab.
 * Mirrors the session-authed /ai/learn-voice route but keyed by the noli user id.
 * Kept self-contained so it can't regress the CRM UI. */

export const metadata = {
  path: '/internal/learn-voice',
  POST: { requireAuth: false },
}

const ANALYSIS_PROMPT = `Analyze the following writing samples and extract a detailed writing style profile. These are emails written by a real person — capture their unique voice.

Return a JSON object with these fields:
- style_summary: A 2-3 sentence description of the writer's style, written as instructions for another AI to mimic it. Be specific about tone, formality, and personality.
- sample_phrases: Array of 5-8 characteristic phrases or expressions the writer actually uses
- formality_score: 1-5 (1=very casual with slang/emoji, 3=balanced, 5=very formal/corporate)
- avg_sentence_length: estimated average words per sentence (number)
- uses_emoji: boolean — whether they use emoji in professional writing
- greeting_style: how they typically open emails (e.g. "Hey [name]," or "Hi there," or "Good morning,")
- closing_style: how they typically close emails (e.g. "Best,\\n[name]" or "Thanks!" or "Cheers,")
- vocabulary_notes: notable vocabulary patterns — words they favor, words they avoid, any industry jargon

Return ONLY valid JSON. No markdown fences, no explanation.

WRITING SAMPLES:
`

const MAX_SAMPLE_CHARS = 12000
const MIN_SAMPLE_CHARS = 200

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}

function stripHtml(html: string): string {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Drop quoted history + signatures so we learn the user's ORIGINAL words, not
// the thread they replied on top of.
function cleanReply(text: string): string {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  for (const line of lines) {
    const t = line.trim()
    if (/^>+/.test(t)) continue // quoted line
    if (/^on .+ wrote:$/i.test(t)) break // reply header — everything below is quoted
    if (/^-{2,}\s*original message\s*-{2,}/i.test(t)) break
    if (/^from:\s.+/i.test(t) && out.length > 0) break // forwarded header block
    out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

type Auth = { userId: string; orgId: string; tenantId: string }

async function resolveAuth(noliUserId: string): Promise<Auth | null> {
  const { findNoliUserById } = await import('@open-mercato/shared/lib/noli/core-client')
  const noliUser = await findNoliUserById(noliUserId)
  if (!noliUser?.clerk_user_id) return null
  const { resolveClerkUserToAuthContext } = await import('@open-mercato/shared/lib/auth/clerk')
  const a = await resolveClerkUserToAuthContext(noliUser.clerk_user_id)
  if (!a?.userId || !a?.orgId || !a?.tenantId) return null
  return { userId: String(a.userId), orgId: String(a.orgId), tenantId: String(a.tenantId) }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Knex = any

// Pull the user's own sent replies from their personal mailbox as writing samples.
async function gatherSentSamples(knex: Knex, auth: Auth): Promise<{ text: string; count: number }> {
  const mine = (await knex('email_connections')
    .where('organization_id', auth.orgId)
    .where('user_id', auth.userId)
    .where('is_active', true)
    .whereNull('purpose')
    .pluck('email_address')) as string[]
  const mineLower = mine.map((a) => String(a || '').toLowerCase()).filter(Boolean)

  let q = knex('email_messages')
    .where('organization_id', auth.orgId)
    .where('direction', 'outbound')
    .orderBy('created_at', 'desc')
    .limit(60)
    .select('from_address', 'body_text', 'body_html')
  if (mineLower.length) {
    q = q.where((qb: Knex) => qb.whereRaw('lower(from_address) = any(?)', [mineLower]))
  }
  const rows = (await q) as Array<{ from_address?: string; body_text?: string; body_html?: string }>

  const parts: string[] = []
  let total = 0
  let count = 0
  for (const r of rows) {
    const raw = String(r.body_text || '').trim() || stripHtml(String(r.body_html || ''))
    const cleaned = cleanReply(raw)
    if (cleaned.length < 40) continue // skip one-liners / empty
    parts.push(cleaned)
    count += 1
    total += cleaned.length
    if (total >= MAX_SAMPLE_CHARS) break
  }
  return { text: parts.join('\n\n---\n\n').slice(0, MAX_SAMPLE_CHARS), count }
}

async function loadProfile(knex: Knex, orgId: string) {
  const row = await knex('business_profiles')
    .where('organization_id', orgId)
    .select('brand_voice_profile', 'brand_voice_updated_at', 'brand_voice_source')
    .first()
  return {
    profile: row?.brand_voice_profile ?? null,
    updatedAt: row?.brand_voice_updated_at ?? null,
    source: row?.brand_voice_source ?? null,
  }
}

export async function POST(req: Request) {
  const secret = process.env.NOLI_INTERNAL_SERVICE_SECRET
  const authHeader = (req.headers.get('authorization') || '').trim()
  if (!secret || !safeEq(authHeader, `Bearer ${secret}`)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const op = typeof body.op === 'string' ? body.op : ''
  const noliUserId = typeof body.noliUserId === 'string' ? body.noliUserId.trim() : ''
  if (!op || !noliUserId) return NextResponse.json({ ok: false, error: 'op and noliUserId are required' }, { status: 400 })

  try {
    const auth = await resolveAuth(noliUserId)
    if (!auth) return NextResponse.json({ ok: false, error: 'no CRM account for this user' }, { status: 404 })
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex() as Knex

    if (op === 'get') {
      return NextResponse.json({ ok: true, data: await loadProfile(knex, auth.orgId) })
    }

    if (op === 'learn') {
      const gate = await checkCustomersAiAllowance({ orgId: auth.orgId })
      if (!gate.allowed) return NextResponse.json({ ok: false, error: gate.message || 'AI limit reached' }, { status: 402 })

      // Prefer the user's real sent mail; fall back to pasted samples.
      const pasted = typeof body.documentContent === 'string' ? body.documentContent.trim() : ''
      let samples = ''
      let source = 'inbox_history'
      let sampleCount = 0
      if (pasted) {
        samples = pasted.slice(0, MAX_SAMPLE_CHARS)
        source = 'document'
      } else {
        const gathered = await gatherSentSamples(knex, auth)
        samples = gathered.text
        sampleCount = gathered.count
      }

      if (samples.length < MIN_SAMPLE_CHARS) {
        return NextResponse.json({
          ok: false,
          error: pasted
            ? 'That was too short to learn from. Paste a few full emails you have written.'
            : 'We could not find enough of your sent mail to learn from yet. Send a few replies from your connected inbox, or paste some emails you have written.',
        }, { status: 400 })
      }

      const apiKey = gate.byoApiKey || process.env.GOOGLE_GENERATIVE_AI_API_KEY
      if (!apiKey) return NextResponse.json({ ok: false, error: 'AI not configured' }, { status: 500 })

      const aiRes = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: ANALYSIS_PROMPT + samples }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 2000 },
        }),
      })
      if (!aiRes.ok) {
        const err = await aiRes.text().catch(() => '')
        console.error('[internal.learn-voice] Gemini error:', aiRes.status, err)
        return NextResponse.json({ ok: false, error: 'Could not analyze your writing. Try again.' }, { status: 502 })
      }
      const aiData = await aiRes.json()
      const rawText = aiData.candidates?.[0]?.content?.parts?.[0]?.text || ''
      const cleaned = rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
      let voiceProfile: unknown
      try {
        voiceProfile = JSON.parse(cleaned)
      } catch {
        console.error('[internal.learn-voice] parse failed:', cleaned.slice(0, 200))
        return NextResponse.json({ ok: false, error: 'The analysis came back malformed. Try again.' }, { status: 502 })
      }

      const now = new Date()
      const existing = await knex('business_profiles').where('organization_id', auth.orgId).first()
      if (existing) {
        await knex('business_profiles').where('organization_id', auth.orgId).update({
          brand_voice_profile: JSON.stringify(voiceProfile),
          brand_voice_updated_at: now,
          brand_voice_source: source,
          updated_at: now,
        })
      } else {
        // Match the proven insert shape (digest settings): let the table default
        // id + timestamps; only set tenant/org + the voice columns.
        await knex('business_profiles').insert({
          tenant_id: auth.tenantId,
          organization_id: auth.orgId,
          brand_voice_profile: JSON.stringify(voiceProfile),
          brand_voice_updated_at: now,
          brand_voice_source: source,
        })
      }

      void meterCustomersAi({ orgId: auth.orgId }, {
        model: 'gemini-2.5-flash',
        tokensIn: aiData?.usageMetadata?.promptTokenCount || 0,
        tokensOut: aiData?.usageMetadata?.candidatesTokenCount || 0,
        feature: 'learn-voice',
        byoKey: !!gate.byoApiKey,
      })

      return NextResponse.json({ ok: true, data: { profile: voiceProfile, source, sampleCount } })
    }

    return NextResponse.json({ ok: false, error: 'unknown op' }, { status: 400 })
  } catch (error) {
    console.error('[internal.learn-voice]', op, error)
    return NextResponse.json({ ok: false, error: 'Server error' }, { status: 500 })
  }
}
