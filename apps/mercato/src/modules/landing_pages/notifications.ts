import type { NotificationTypeDefinition } from '@open-mercato/shared/modules/notifications/types'

export const notificationTypes: NotificationTypeDefinition[] = [
  {
    type: 'landing_pages.form.submitted',
    module: 'landing_pages',
    titleKey: 'landing_pages.notifications.form_submitted.title',
    bodyKey: 'landing_pages.notifications.form_submitted.body',
    icon: 'clipboard-list',
    severity: 'info',
    actions: [
      {
        id: 'view',
        labelKey: 'common.view',
        variant: 'outline',
        href: '/backend/customers/people/{sourceEntityId}',
        icon: 'external-link',
      },
    ],
    linkHref: '/backend/customers/people/{sourceEntityId}',
    expiresAfterHours: 168,
  },
]

export default notificationTypes
