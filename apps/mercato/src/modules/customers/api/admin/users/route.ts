// ORM-SKIP: complex multi-table JOINs — raw SQL more maintainable
export const metadata = { path: '/admin/users', GET: { requireAuth: true } }
import { NextRequest, NextResponse } from 'next/server'
import { query, queryOne } from '@/lib/db'
import { getAdminAuth } from '../auth'
import { decryptRowFieldsByRowScope } from '@open-mercato/shared/lib/encryption/decryptRows'
import { computeEmailHash } from '@open-mercato/core/modules/auth/lib/emailHash'

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
      u.tenant_id, u.organization_id,
      u.tenant_id as scope_tenant_id, u.organization_id as scope_org_id,
      o.name as org_name, bp.business_name,
      r.name as role_name
    FROM users u
    LEFT JOIN organizations o ON o.id = u.organization_id
    LEFT JOIN business_profiles bp ON bp.organization_id = u.organization_id
    LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.deleted_at IS NULL
    LEFT JOIN roles r ON r.id = ur.role_id AND r.tenant_id = u.tenant_id
    WHERE u.deleted_at IS NULL
  `
  const params: (string | number)[] = []

  if (search) {
    // users.email is encrypted at rest, so an ILIKE on it matched ciphertext.
    // Emails match exactly through the lookup hash; names still match loosely.
    const searchClause = ` AND (u.name ILIKE $1 OR u.email_hash = $2)`
    countSql += searchClause
    sql += searchClause
    params.push(`%${search}%`, computeEmailHash(search))
  }

  sql += ` ORDER BY u.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`

  const countParams = [...params]
  params.push(pageSize, offset)

  const [countRow, rows] = await Promise.all([
    queryOne(countSql, countParams),
    query(sql, params),
  ])

  // Each row is decrypted with its own tenant/organisation key scope.
  await decryptRowFieldsByRowScope(null, 'auth:user', rows, ['email'], {
    tenantColumn: 'scope_tenant_id',
    orgColumn: 'scope_org_id',
  })
  const data = rows.map(({ scope_tenant_id: _t, scope_org_id: _o, ...row }: Record<string, unknown>) => row)

  return NextResponse.json({
    ok: true,
    data,
    pagination: {
      page,
      pageSize,
      total: countRow?.total ?? 0,
      totalPages: Math.ceil((countRow?.total ?? 0) / pageSize),
    },
  })
}
