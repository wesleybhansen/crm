import type { NotificationTypeDefinition } from '@open-mercato/shared/modules/notifications/types'
import { INTEGRATIONS_HOME } from '../../lib/legacy-redirects'

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
        href: INTEGRATIONS_HOME,
        icon: 'external-link',
      },
    ],
    linkHref: INTEGRATIONS_HOME,
    expiresAfterHours: 72,
  },
]

export default notificationTypes
