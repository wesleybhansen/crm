// ORM-SKIP: complex multi-table JOINs — raw SQL more maintainable
export const metadata = { path: '/admin/organizations', GET: { requireAuth: true }, PUT: { requireAuth: true } }
import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { getAdminAuth } from '../auth'
import { decryptRowFieldsByRowScope } from '@open-mercato/shared/lib/encryption/decryptRows'
import { computeEmailHash } from '@open-mercato/core/modules/auth/lib/emailHash'

export async function GET(request: NextRequest) {
  const admin = await getAdminAuth()
  if (!admin) return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })

  const search = request.nextUrl.searchParams.get('search') || ''
  const currentMonth = new Date().toISOString().slice(0, 7)

  let sql = `
    SELECT o.id, o.tenant_id, o.name, o.max_seats, o.created_at,
      bp.business_name,
      u_owner.name as owner_name, u_owner.email as owner_email,
      u_owner.tenant_id as owner_tenant_id, u_owner.organization_id as owner_org_id,
      (SELECT COUNT(*)::int FROM users WHERE organization_id = o.id AND deleted_at IS NULL) as user_count,
      (SELECT COALESCE(au.call_count, 0) FROM ai_usage au WHERE au.organization_id = o.id AND au.month = $1) as ai_calls
    FROM organizations o
    LEFT JOIN business_profiles bp ON bp.organization_id = o.id
    LEFT JOIN users u_owner ON u_owner.id = o.owner_user_id
    WHERE o.deleted_at IS NULL
  `
  const params: (string | number)[] = [currentMonth]

  if (search) {
    // users.email is encrypted at rest: match the owner's email by lookup hash.
    sql += ` AND (o.name ILIKE $2 OR u_owner.email_hash = $3)`
    params.push(`%${search}%`, computeEmailHash(search))
  }

  sql += ` ORDER BY o.created_at DESC`

  const rows = await query(sql, params)
  await decryptRowFieldsByRowScope(null, 'auth:user', rows, [], {
    tenantColumn: 'owner_tenant_id',
    orgColumn: 'owner_org_id',
    aliases: { owner_email: 'email' },
  })
  const data = rows.map(({ owner_tenant_id: _t, owner_org_id: _o, ...row }: Record<string, unknown>) => row)

  return NextResponse.json({ ok: true, data })
}

export async function PUT(request: NextRequest) {
  const admin = await getAdminAuth()
  if (!admin) return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })

  const body = await request.json()
  const { orgId, maxSeats } = body

  if (!orgId || typeof maxSeats !== 'number' || maxSeats < 1) {
    return NextResponse.json({ ok: false, error: 'Invalid input' }, { status: 400 })
  }

  await query(
    `UPDATE organizations SET max_seats = $1, updated_at = now() WHERE id = $2`,
    [maxSeats, orgId]
  )

  return NextResponse.json({ ok: true })
}
