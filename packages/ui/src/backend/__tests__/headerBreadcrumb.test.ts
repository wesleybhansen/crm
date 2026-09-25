import { buildHeaderBreadcrumb } from '../headerBreadcrumb'

const root = { label: 'Dashboard', href: '/backend' }

describe('buildHeaderBreadcrumb', () => {
  it('shows only the root on the dashboard itself', () => {
    expect(buildHeaderBreadcrumb({ dashboardLabel: 'Dashboard', title: 'Dashboard' })).toEqual([root])
    expect(buildHeaderBreadcrumb({
      dashboardLabel: 'Dashboard',
      breadcrumb: [{ label: 'Dashboard', href: '/backend/dashboards' }],
      title: 'Dashboard',
    })).toEqual([root])
  })

  it('appends the page title when the page has no trail', () => {
    expect(buildHeaderBreadcrumb({ dashboardLabel: 'Dashboard', title: 'Billing' })).toEqual([
      root,
      { label: 'Billing' },
    ])
  })

  it('drops a leading crumb that repeats the root and keeps the rest', () => {
    expect(buildHeaderBreadcrumb({
      dashboardLabel: 'Dashboard',
      breadcrumb: [
        { label: 'Home', href: '/backend' },
        { label: 'Deals', href: '/backend/customers/deals' },
        { label: 'Sales Pipeline' },
      ],
      title: 'Sales Pipeline',
    })).toEqual([root, { label: 'Deals', href: '/backend/customers/deals' }, { label: 'Sales Pipeline' }])
  })

  it('falls back to the title when the trail held only the root', () => {
    expect(buildHeaderBreadcrumb({
      dashboardLabel: 'Pulpit',
      breadcrumb: [{ label: 'Dashboard' }],
      title: 'Settings',
    })).toEqual([{ label: 'Pulpit', href: '/backend' }, { label: 'Settings' }])
  })

  it('shows only the root when nothing is known about the page', () => {
    expect(buildHeaderBreadcrumb({ dashboardLabel: 'Dashboard' })).toEqual([root])
  })
})
