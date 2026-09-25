export const metadata = {
  title: 'Email',
  group: 'Marketing',
  order: 20,
  icon: 'Mail',
  requireAuth: true,
  requireFeatures: ['email.view'],
  // Explicit trail so the header reads "Dashboard / Email", never just "Dashboard".
  breadcrumb: [{ label: 'Email' }],
}
