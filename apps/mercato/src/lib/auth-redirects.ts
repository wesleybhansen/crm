/**
 * A same-origin path taken from a `redirect` query value, or the dashboard
 * when the value is missing, points off-site, or points back at /login
 * (which would loop).
 */
export function sameOriginPath(value: string | null | undefined): string {
  if (!value) return '/backend'
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/backend'
  if (value === '/login' || value.startsWith('/login?') || value.startsWith('/login/')) return '/backend'
  return value
}
