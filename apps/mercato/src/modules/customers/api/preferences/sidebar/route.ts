export const metadata = {
  path: '/preferences/sidebar',
  GET: { requireAuth: true },
  PUT: { requireAuth: true },
}

import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'

const COOKIE_NAME = 'crm_hidden_sidebar'

export async function GET() {
  const store = await cookies()
  const raw = store.get(COOKIE_NAME)?.value || ''
  let hidden: string[] = []
  try {
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) hidden = parsed.filter((x) => typeof x === 'string')
    }
  } catch { /* ignore malformed */ }
  return NextResponse.json({ ok: true, hidden })
}

export async function PUT(req: Request) {
  const body = await req.json().catch(() => ({}))
  const input = Array.isArray(body?.hidden) ? body.hidden : []
  const hidden = input.filter((x: unknown): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, 200)
  const response = NextResponse.json({ ok: true, hidden })
  response.cookies.set(COOKIE_NAME, JSON.stringify(hidden), {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
  })
  return response
}
