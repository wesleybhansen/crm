import crypto from 'crypto'
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'

/*
 * Central voice-profile push (Noli U-4: one voice profile, used everywhere).
 *
 * The hub learns how the user writes from real samples and pushes the
 * structured profile here. Unlike seed-profile's merge-fill, this OVERWRITES
 * business_profiles.brand_voice_profile — the hub copy is canonical and the
 * user just re-saved it. The drafter (buildVoicePromptSection) and every
 * voice-aware surface pick it up on the next generation.
 *
 * Auth: shared NOLI_INTERNAL_SERVICE_SECRET, server-to-server only.
 */
export const metadata = {
  path: '/internal/voice-profile',
  POST: { requireAuth: false },
}

export async function POST(req: Request) {
  const secret = process.env.NOLI_INTERNAL_SERVICE_SECRET
  const authBuf = Buffer.from((req.headers.get('authorization') || '').trim())
  const expectedBuf = Buffer.from(secret ? `Bearer ${secret}` : '')
  // Compare BYTE lengths (a multibyte char with matching string length would
  // make timingSafeEqual throw -> unhandled 500 instead of 401).
  if (!secret || authBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(authBuf, expectedBuf)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const body = (await req.json().catch(() => ({}))) as {
    noliUserId?: string
    voiceProfile?: {
      styleSummary?: string
      samplePhrases?: string[]
      formality?: number
      avgSentenceLength?: number
      usesEmoji?: boolean
      greetingStyle?: string
      closingStyle?: string
      vocabularyNotes?: string
      toneDescriptors?: string[]
    }
  }
  const noliUserId = typeof body.noliUserId === 'string' ? body.noliUserId.trim().slice(0, 80) : ''
  const vp = body.voiceProfile
  if (!noliUserId || !vp?.styleSummary) {
    return NextResponse.json({ ok: false, error: 'noliUserId and voiceProfile.styleSummary required' }, { status: 400 })
  }

  try {
    const { findNoliUserById } = await import('@open-mercato/shared/lib/noli/core-client')
    const noliUser = await findNoliUserById(noliUserId)
    if (!noliUser?.clerk_user_id) {
      return NextResponse.json({ ok: false, error: 'Noli user not found' }, { status: 404 })
    }
    const { resolveClerkUserToAuthContext } = await import('@open-mercato/shared/lib/auth/clerk')
    const auth = await resolveClerkUserToAuthContext(noliUser.clerk_user_id)
    if (!auth || !auth.userId || !auth.orgId || !auth.tenantId) {
      return NextResponse.json({ ok: false, error: 'User has no CRM access' }, { status: 403 })
    }

    const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
    const { CustomerBusinessProfile } = await import('@open-mercato/core/modules/customers/data/entities')

    const profile = await em.findOne(CustomerBusinessProfile, {
      organizationId: auth.orgId as string,
      tenantId: auth.tenantId as string,
    })
    if (!profile) {
      return NextResponse.json({ ok: false, error: 'No business profile yet — open the CRM once first' }, { status: 404 })
    }

    // Map to the exact shape buildVoicePromptSection reads.
    profile.brandVoiceProfile = {
      style_summary: String(vp.styleSummary).slice(0, 600),
      sample_phrases: (vp.samplePhrases ?? []).map(String).slice(0, 6),
      formality_score: Math.min(5, Math.max(1, Number(vp.formality) || 3)),
      avg_sentence_length: Math.max(1, Number(vp.avgSentenceLength) || 15),
      uses_emoji: Boolean(vp.usesEmoji),
      greeting_style: String(vp.greetingStyle ?? '').slice(0, 120),
      closing_style: String(vp.closingStyle ?? '').slice(0, 120),
      // buildVoicePromptSection has no tone slot — fold tone into vocab notes.
      vocabulary_notes: [
        String(vp.vocabularyNotes ?? '').slice(0, 340),
        (vp.toneDescriptors ?? []).length ? `Tone: ${(vp.toneDescriptors ?? []).map(String).join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('. ')
        .slice(0, 400),
    }
    await em.persistAndFlush(profile)

    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[internal/voice-profile]', e)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
