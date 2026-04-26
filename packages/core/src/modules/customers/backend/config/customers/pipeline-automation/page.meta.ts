export const metadata = {
  requireAuth: true,
  requireFeatures: ['pipeline_automation.configure'],
  pageTitle: 'Pipeline automation',
  pageGroup: 'Module Configs',
  pageGroupKey: 'settings.sections.moduleConfigs',
  pageOrder: 5,
  pageContext: 'settings' as const,
  breadcrumb: [
    { label: 'Pipeline automation' },
  ],
} as const
