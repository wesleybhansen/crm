import type { NotificationTypeDefinition } from '@open-mercato/shared/modules/notifications/types'

export const notificationTypes: NotificationTypeDefinition[] = [
  {
    type: 'email.sync.failed',
    module: 'email',
    titleKey: 'email.notifications.sync_failed.title',
    bodyKey: 'email.notifications.sync_failed.body',
    icon: 'alert-circle',
    severity: 'error',
    actions: [
      {
        id: 'view',
        labelKey: 'common.view',
        variant: 'outline',
        href: '/backend/integrations',
        icon: 'external-link',
      },
    ],
    linkHref: '/backend/integrations',
    expiresAfterHours: 72,
  },
]

export default notificationTypes
