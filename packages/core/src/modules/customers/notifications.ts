import type { NotificationTypeDefinition } from '@open-mercato/shared/modules/notifications/types'

export const notificationTypes: NotificationTypeDefinition[] = [
  {
    type: 'customers.person.created',
    module: 'customers',
    titleKey: 'customers.notifications.person.created.title',
    bodyKey: 'customers.notifications.person.created.body',
    icon: 'user-plus',
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
    expiresAfterHours: 336, // 14 days
  },
  {
    type: 'customers.person.stage_changed',
    module: 'customers',
    titleKey: 'customers.notifications.person.stage_changed.title',
    bodyKey: 'customers.notifications.person.stage_changed.body',
    icon: 'arrow-right',
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
  {
    type: 'customers.deal.stage_changed',
    module: 'customers',
    titleKey: 'customers.notifications.deal.stage_changed.title',
    bodyKey: 'customers.notifications.deal.stage_changed.body',
    icon: 'arrow-right',
    severity: 'info',
    actions: [
      {
        id: 'view',
        labelKey: 'common.view',
        variant: 'outline',
        href: '/backend/customers/deals/{sourceEntityId}',
        icon: 'external-link',
      },
    ],
    linkHref: '/backend/customers/deals/{sourceEntityId}',
    expiresAfterHours: 168, // 7 days
  },
  {
    type: 'customers.scout.action',
    module: 'customers',
    titleKey: 'customers.notifications.scout.action.title',
    bodyKey: 'customers.notifications.scout.action.body',
    icon: 'sparkles',
    severity: 'info',
    actions: [
      {
        id: 'view',
        labelKey: 'common.view',
        variant: 'outline',
        href: '/backend/assistant',
        icon: 'external-link',
      },
    ],
    linkHref: '/backend/assistant',
    expiresAfterHours: 72, // 3 days
  },
  {
    type: 'customers.deal.won',
    module: 'customers',
    titleKey: 'customers.notifications.deal.won.title',
    bodyKey: 'customers.notifications.deal.won.body',
    icon: 'trophy',
    severity: 'success',
    actions: [
      {
        id: 'view',
        labelKey: 'common.view',
        variant: 'outline',
        href: '/backend/customers/deals/{sourceEntityId}',
        icon: 'external-link',
      },
    ],
    linkHref: '/backend/customers/deals/{sourceEntityId}',
    expiresAfterHours: 168, // 7 days
  },
  {
    type: 'customers.deal.lost',
    module: 'customers',
    titleKey: 'customers.notifications.deal.lost.title',
    bodyKey: 'customers.notifications.deal.lost.body',
    icon: 'x-circle',
    severity: 'warning',
    actions: [
      {
        id: 'view',
        labelKey: 'common.view',
        variant: 'outline',
        href: '/backend/customers/deals/{sourceEntityId}',
        icon: 'external-link',
      },
    ],
    linkHref: '/backend/customers/deals/{sourceEntityId}',
    expiresAfterHours: 168, // 7 days
  },
]

export default notificationTypes
