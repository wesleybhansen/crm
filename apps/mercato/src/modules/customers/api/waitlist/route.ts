import { NextResponse } from 'next/server'

export const metadata = { path: '/waitlist', POST: { requireAuth: false } }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''

    if (!email || !EMAIL_RE.test(email) || email.length > 254) {
      return NextResponse.json({ ok: false, error: 'Invalid email' }, { status: 400 })
    }

    const timestamp = new Date().toISOString()
    const ip =
      req.headers.get('cf-connecting-ip') ||
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      'unknown'
    const userAgent = req.headers.get('user-agent') || 'unknown'

    // Structured log — captured by docker logs. Extract with:
    //   docker logs launchos-app 2>&1 | grep WAITLIST_SIGNUP
    console.log(
      `WAITLIST_SIGNUP ${JSON.stringify({ email, timestamp, ip, userAgent })}`
    )

    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: false, error: 'Server error' }, { status: 500 })
  }
}
