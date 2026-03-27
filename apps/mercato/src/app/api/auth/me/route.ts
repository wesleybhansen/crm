import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'

export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.sub) return NextResponse.json({ ok: false }, { status: 401 })
  return NextResponse.json({ ok: true, id: auth.sub, orgId: auth.orgId, tenantId: auth.tenantId })
}
