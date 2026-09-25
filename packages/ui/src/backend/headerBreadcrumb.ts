export type HeaderCrumb = { label: string; href?: string }

const DASHBOARD_HREFS = new Set(['/backend', '/backend/dashboards'])

function isDashboardCrumb(crumb: HeaderCrumb | undefined, dashboardLabel: string): boolean {
  if (!crumb) return false
  if (crumb.href && DASHBOARD_HREFS.has(crumb.href)) return true
  const label = crumb.label?.trim().toLowerCase()
  if (!label) return false
  return label === dashboardLabel.trim().toLowerCase() || label === 'dashboard'
}

/**
 * The header trail always starts with a Dashboard link. The page's own trail
 * (or its title when it has no trail) follows, minus any crumb that repeats
 * the Dashboard root, so the dashboard reads "Dashboard" and never
 * "Dashboard / Dashboard".
 */
export function buildHeaderBreadcrumb(input: {
  dashboardLabel: string
  breadcrumb?: HeaderCrumb[]
  title?: string
}): HeaderCrumb[] {
  const root: HeaderCrumb = { label: input.dashboardLabel, href: '/backend' }
  const rest: HeaderCrumb[] = [...(input.breadcrumb ?? [])]
  while (rest.length && isDashboardCrumb(rest[0], input.dashboardLabel)) rest.shift()
  if (!rest.length && input.title && !isDashboardCrumb({ label: input.title }, input.dashboardLabel)) {
    rest.push({ label: input.title })
  }
  return [root, ...rest]
}
