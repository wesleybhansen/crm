import type { NotificationTypeDefinition } from '@open-mercato/shared/modules/notifications/types'

export const notificationTypes: NotificationTypeDefinition[] = [
  {
    type: 'payments.payment.received',
    module: 'payments',
    titleKey: 'payments.notifications.payment_received.title',
    bodyKey: 'payments.notifications.payment_received.body',
    icon: 'dollar-sign',
    severity: 'success',
    actions: [
      {
        id: 'view',
        labelKey: 'common.view',
        variant: 'outline',
        href: '/backend/payments',
        icon: 'external-link',
      },
    ],
    linkHref: '/backend/payments',
    expiresAfterHours: 336,
  },
  {
    type: 'payments.payment.failed',
    module: 'payments',
    titleKey: 'payments.notifications.payment_failed.title',
    bodyKey: 'payments.notifications.payment_failed.body',
    icon: 'alert-circle',
    severity: 'warning',
    actions: [
      {
        id: 'view',
        labelKey: 'common.view',
        variant: 'outline',
        href: '/backend/payments',
        icon: 'external-link',
      },
    ],
    linkHref: '/backend/payments',
    expiresAfterHours: 168,
  },
]

export default notificationTypes
