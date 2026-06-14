// ORM-SKIP: uses raw pg query() — conversion requires SQL rewrite
export const metadata = { path: '/ai/tts', POST: { requireAuth: true } }
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { queryOne } from '@/lib/db'
import { meterCustomersAi } from '@/lib/usage/meter'
import { checkCustomersAiAllowance } from '@/lib/usage/allowance'

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.sub) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const { text, voice } = await req.json()
  if (!text?.trim()) return NextResponse.json({ ok: false, error: 'Text required' }, { status: 400 })

  // TTS is OpenAI-only (tts-1). Gate on the pooled allowance. Within the pool we
  // run on the platform key; over it we fall through to the org's OpenAI BYO key.
  const gate = await checkCustomersAiAllowance(auth, 'openai')

  // Try the BYO key from the gate first (over-allowance), then platform key,
  // then the user's legacy stored key. If still none, fall back to browser TTS.
  let apiKey = gate.byoApiKey || process.env.OPENAI_API_KEY || ''
  if (!apiKey) {
    try {
      const userKey = await queryOne(
        `SELECT setting_value FROM ai_settings WHERE setting_key = 'user_openai_key' AND user_id = $1`,
        [auth.sub]
      )
      if (userKey?.setting_value) apiKey = userKey.setting_value
    } catch {}
  }

  // Over allowance with no BYO/platform key available → don't burn platform
  // spend; the client transparently falls back to the browser's built-in TTS.
  if (!gate.allowed && !gate.byoApiKey) {
    return new NextResponse(null, { status: 204 })
  }

  if (!apiKey) {
    return new NextResponse(null, { status: 204 }) // Fallback to browser TTS
  }

  const input = text.slice(0, 4096)

  try {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1',
        voice: voice || 'nova',
        input,
        response_format: 'mp3',
      }),
    })

    if (!res.ok) {
      console.error('[tts] OpenAI error:', res.status, await res.text().catch(() => ''))
      return new NextResponse(null, { status: 204 })
    }

    // tts-1 is priced per character ($15/1M). Pass the input char count as
    // tokensIn so the shared logger computes the cost exactly. byoKey true only
    // when the gate routed us to the org's own OpenAI key.
    void meterCustomersAi(auth, {
      model: 'tts-1',
      tokensIn: input.length,
      tokensOut: 0,
      feature: 'tts',
      byoKey: !!gate.byoApiKey,
    })

    const audioBuffer = await res.arrayBuffer()
    return new NextResponse(audioBuffer, {
      status: 200,
      headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-cache' },
    })
  } catch (err) {
    console.error('[tts] Error:', err)
    return new NextResponse(null, { status: 204 })
  }
}
