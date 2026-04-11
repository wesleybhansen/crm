export const metadata = { path: '/org-switcher', GET: { requireAuth: true } }
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { query } from '@/app/api/funnels/db'

export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    // Get organizations for this user
    const orgs = await query(
      `SELECT o.id, o.name, o.tenant_id FROM organizations o
       JOIN user_organizations uo ON uo.organization_id = o.id
       WHERE uo.user_id = $1
       ORDER BY o.name`,
      [auth.sub]
    ).catch(() => [])

    // If no user_organizations, try getting orgs by tenant
    let items = orgs
    if (items.length === 0 && auth.tenantId) {
      items = await query('SELECT id, name, tenant_id FROM organizations WHERE tenant_id = $1 ORDER BY name', [auth.tenantId]).catch(() => [])
    }

    // Build tree (flat for simplicity)
    const nodes = items.map((o: any) => ({
      id: o.id,
      name: o.name || 'Organization',
      depth: 0,
      selectable: true,
      children: [],
    }))

    return NextResponse.json({
      items: nodes,
      selectedId: auth.orgId || (nodes[0]?.id ?? null),
      canManage: true,
      tenantId: auth.tenantId || null,
      tenants: [],
      isSuperAdmin: false,
    })
  } catch (error) {
    console.error('[org-switcher]', error)
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}
