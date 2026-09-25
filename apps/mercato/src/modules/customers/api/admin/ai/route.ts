// ORM-SKIP: security-critical auth flow — raw SQL conversion deferred for safety
export const metadata = { path: '/admin/ai', GET: { requireAuth: true }, PUT: { requireAuth: true } }
import { NextRequest, NextResponse } from 'next/server'
import { query, queryOne } from '@/lib/db'
import { getAdminAuth } from '../auth'
import { readGlobalAiCap, writeGlobalAiCap } from '../platform-settings'

export async function GET() {
  const admin = await getAdminAuth()
  if (!admin) return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })

  const currentMonth = new Date().toISOString().slice(0, 7)

  try {
    const [totalRow, globalCap, orgs] = await Promise.all([
      queryOne(
        `SELECT COALESCE(SUM(call_count), 0)::int as total_calls FROM ai_usage WHERE month = $1`,
        [currentMonth]
      ),
      readGlobalAiCap(),
      query(
        `SELECT o.id as org_id, o.name as org_name, bp.business_name,
          COALESCE(au.call_count, 0)::int as calls_used,
          ais.setting_value as org_cap_override,
          (SELECT COUNT(*) > 0 FROM ai_settings WHERE organization_id = o.id AND setting_key = 'user_ai_key') as has_byok
        FROM organizations o
        LEFT JOIN business_profiles bp ON bp.organization_id = o.id
        LEFT JOIN ai_usage au ON au.organization_id = o.id AND au.month = $1
        LEFT JOIN ai_settings ais ON ais.organization_id = o.id AND ais.setting_key = 'monthly_ai_cap'
        WHERE o.deleted_at IS NULL
        ORDER BY COALESCE(au.call_count, 0) DESC`,
        [currentMonth]
      ),
    ])

    return NextResponse.json({
      ok: true,
      data: {
        globalCap,
        totalCalls: totalRow?.total_calls ?? 0,
        orgs,
      },
    })
  } catch (error) {
    console.error('[admin.ai] failed', error)
    return NextResponse.json({ ok: false, error: 'Failed to load AI usage' }, { status: 500 })
  }
}

export async function PUT(request: NextRequest) {
  const admin = await getAdminAuth()
  if (!admin) return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })

  const body = await request.json()
  const { type } = body

  if (type === 'global') {
    const { cap } = body
    if (typeof cap !== 'number' || cap < 0) {
      return NextResponse.json({ ok: false, error: 'Invalid cap value' }, { status: 400 })
    }
    try {
      await writeGlobalAiCap(cap)
    } catch (error) {
      console.error('[admin.ai] global cap update failed', error)
      return NextResponse.json({ ok: false, error: 'Failed to save the cap' }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  }

  if (type === 'org') {
    const { orgId, cap } = body
    if (!orgId) {
      return NextResponse.json({ ok: false, error: 'Missing orgId' }, { status: 400 })
    }

    if (cap === null || cap === undefined) {
      await query(
        `DELETE FROM ai_settings WHERE organization_id = $1 AND setting_key = 'monthly_ai_cap'`,
        [orgId]
      )
    } else {
      if (typeof cap !== 'number' || cap < 0) {
        return NextResponse.json({ ok: false, error: 'Invalid cap value' }, { status: 400 })
      }
      await query(
        `DELETE FROM ai_settings WHERE organization_id = $1 AND setting_key = 'monthly_ai_cap'`,
        [orgId]
      )
      await query(
        `INSERT INTO ai_settings (id, tenant_id, organization_id, setting_key, setting_value, created_at, updated_at)
         VALUES (gen_random_uuid(), (SELECT tenant_id FROM organizations WHERE id = $1), $1, 'monthly_ai_cap', $2, now(), now())`,
        [orgId, String(cap)]
      )
    }
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ ok: false, error: 'Invalid type' }, { status: 400 })
}
