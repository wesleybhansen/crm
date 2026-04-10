export const metadata = { POST: { requireAuth: true } }
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { queryOne } from '@/app/api/funnels/db'

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.sub) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const { text, voice } = await req.json()
  if (!text?.trim()) return NextResponse.json({ ok: false, error: 'Text required' }, { status: 400 })

  // Try platform key first, then user's stored key
  let apiKey = process.env.OPENAI_API_KEY || ''
  if (!apiKey) {
    try {
      const userKey = await queryOne(
        `SELECT setting_value FROM ai_settings WHERE setting_key = 'user_openai_key' AND user_id = $1`,
        [auth.sub]
      )
      if (userKey?.setting_value) apiKey = userKey.setting_value
    } catch {}
  }

  if (!apiKey) {
    return new NextResponse(null, { status: 204 }) // Fallback to browser TTS
  }

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
        input: text.slice(0, 4096),
        response_format: 'mp3',
      }),
    })

    if (!res.ok) {
      console.error('[tts] OpenAI error:', res.status, await res.text().catch(() => ''))
      return new NextResponse(null, { status: 204 })
    }

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
