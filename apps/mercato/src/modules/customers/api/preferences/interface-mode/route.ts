export const metadata = { path: '/preferences/interface-mode', GET: { requireAuth: true }, PUT: { requireAuth: true } }
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'

export async function GET() {
  const cookieStore = await cookies()
  const mode = cookieStore.get('crm_interface_mode')?.value || 'simple'
  return NextResponse.json({ ok: true, mode })
}

export async function PUT(req: Request) {
  const body = await req.json()
  const mode = body.mode === 'advanced' ? 'advanced' : 'simple'

  const response = NextResponse.json({ ok: true, mode })
  response.cookies.set('crm_interface_mode', mode, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365, // 1 year
    sameSite: 'lax',
  })

  return response
}
