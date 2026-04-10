export const metadata = { GET: { requireAuth: true } }
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { queryOne } from '@/app/api/funnels/db'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthFromCookies()
  const userId = auth?.sub
  if (!userId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const conv = await queryOne(
    'SELECT * FROM assistant_conversations WHERE id = $1 AND user_id = $2',
    [id, userId]
  )

  if (!conv) return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })

  return NextResponse.json({
    ok: true,
    data: {
      ...conv,
      messages: typeof conv.messages === 'string' ? JSON.parse(conv.messages) : conv.messages,
    },
  })
}
