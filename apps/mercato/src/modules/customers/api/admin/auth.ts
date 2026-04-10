import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'

const PLATFORM_ADMINS = ['wesley.b.hansen@gmail.com']

export async function getAdminAuth() {
  const auth = await getAuthFromCookies()
  const userId = auth?.sub
  if (!userId || !auth?.email) return null

  if (!PLATFORM_ADMINS.includes(auth.email)) return null

  return { userId, tenantId: auth.tenantId, orgId: auth.orgId, email: auth.email }
}
