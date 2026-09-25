// ORM-SKIP: uses raw pg query() — conversion requires SQL rewrite
export const metadata = { path: '/admin', GET: { requireAuth: true } }
import { NextResponse } from 'next/server'
import { query, queryOne } from '@/lib/db'
import { getAdminAuth } from './auth'
import { readGlobalAiCap } from './platform-settings'

export async function GET() {
  const admin = await getAdminAuth()
  if (!admin) return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })

  const currentMonth = new Date().toISOString().slice(0, 7)

  try {
    const [orgsRow, usersRow, aiRow, activeRow, globalAiCap] = await Promise.all([
      queryOne(`SELECT COUNT(*)::int as total FROM organizations WHERE deleted_at IS NULL`),
      queryOne(`SELECT COUNT(*)::int as total FROM users WHERE deleted_at IS NULL`),
      queryOne(`SELECT COALESCE(SUM(call_count), 0)::int as total FROM ai_usage WHERE month = $1`, [currentMonth]),
      queryOne(`SELECT COUNT(*)::int as total FROM users WHERE last_login_at >= NOW() - INTERVAL '7 days' AND deleted_at IS NULL`),
      readGlobalAiCap(),
    ])

    return NextResponse.json({
      ok: true,
      data: {
        totalOrgs: orgsRow?.total ?? 0,
        totalUsers: usersRow?.total ?? 0,
        aiCallsThisMonth: aiRow?.total ?? 0,
        globalAiCap,
        activeThisWeek: activeRow?.total ?? 0,
      },
    })
  } catch (error) {
    console.error('[admin.overview] failed', error)
    return NextResponse.json({ ok: false, error: 'Failed to load admin overview' }, { status: 500 })
  }
}
