export const metadata = { path: '/admin', GET: { requireAuth: true } }
import { NextResponse } from 'next/server'
import { query, queryOne } from '@/lib/db'
import { getAdminAuth } from './auth'

export async function GET() {
  const admin = await getAdminAuth()
  if (!admin) return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })

  const currentMonth = new Date().toISOString().slice(0, 7)

  const [orgsRow, usersRow, aiRow, activeRow, capRow] = await Promise.all([
    queryOne(`SELECT COUNT(*)::int as total FROM organizations WHERE deleted_at IS NULL`),
    queryOne(`SELECT COUNT(*)::int as total FROM users WHERE deleted_at IS NULL`),
    queryOne(`SELECT COALESCE(SUM(call_count), 0)::int as total FROM ai_usage WHERE month = $1`, [currentMonth]),
    queryOne(`SELECT COUNT(*)::int as total FROM users WHERE last_login_at >= NOW() - INTERVAL '7 days' AND deleted_at IS NULL`),
    queryOne(`SELECT setting_value FROM platform_settings WHERE setting_key = 'global_ai_monthly_cap'`),
  ])

  return NextResponse.json({
    ok: true,
    data: {
      totalOrgs: orgsRow?.total ?? 0,
      totalUsers: usersRow?.total ?? 0,
      aiCallsThisMonth: aiRow?.total ?? 0,
      globalAiCap: capRow?.setting_value ? parseInt(capRow.setting_value, 10) : null,
      activeThisWeek: activeRow?.total ?? 0,
    },
  })
}
