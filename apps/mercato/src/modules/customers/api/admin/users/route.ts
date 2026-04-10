export const metadata = { GET: { requireAuth: true } }
import { NextRequest, NextResponse } from 'next/server'
import { query, queryOne } from '@/app/api/funnels/db'
import { getAdminAuth } from '../auth'

export async function GET(request: NextRequest) {
  const admin = await getAdminAuth()
  if (!admin) return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })

  const search = request.nextUrl.searchParams.get('search') || ''
  const page = parseInt(request.nextUrl.searchParams.get('page') || '1', 10)
  const pageSize = Math.min(parseInt(request.nextUrl.searchParams.get('pageSize') || '50', 10), 100)
  const offset = (page - 1) * pageSize

  let countSql = `SELECT COUNT(*)::int as total FROM users u WHERE u.deleted_at IS NULL`
  let sql = `
    SELECT u.id, u.name, u.email, u.created_at, u.last_login_at,
      o.name as org_name, bp.business_name,
      r.name as role_name
    FROM users u
    LEFT JOIN organizations o ON o.id = u.organization_id
    LEFT JOIN business_profiles bp ON bp.organization_id = u.organization_id
    LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.deleted_at IS NULL
    LEFT JOIN roles r ON r.id = ur.role_id
    WHERE u.deleted_at IS NULL
  `
  const params: (string | number)[] = []

  if (search) {
    const searchClause = ` AND (u.name ILIKE $1 OR u.email ILIKE $1)`
    countSql += searchClause
    sql += searchClause
    params.push(`%${search}%`)
  }

  sql += ` ORDER BY u.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`

  const countParams = [...params]
  params.push(pageSize, offset)

  const [countRow, rows] = await Promise.all([
    queryOne(countSql, countParams),
    query(sql, params),
  ])

  return NextResponse.json({
    ok: true,
    data: rows,
    pagination: {
      page,
      pageSize,
      total: countRow?.total ?? 0,
      totalPages: Math.ceil((countRow?.total ?? 0) / pageSize),
    },
  })
}
