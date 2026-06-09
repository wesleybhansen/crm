import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'

// Configurable via PLATFORM_ADMIN_EMAILS (comma-separated); falls back to the
// founder address so a missing env var never opens or breaks the admin surface.
const PLATFORM_ADMINS = (process.env.PLATFORM_ADMIN_EMAILS || 'wesley.b.hansen@gmail.com')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean)

export async function getAdminAuth() {
  const auth = await getAuthFromCookies()
  const userId = auth?.sub
  if (!userId || !auth?.email) return null

  if (!PLATFORM_ADMINS.includes(auth.email.toLowerCase())) return null

  return { userId, tenantId: auth.tenantId, orgId: auth.orgId, email: auth.email }
}
