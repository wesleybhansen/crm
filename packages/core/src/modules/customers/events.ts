import { createModuleEvents } from '@open-mercato/shared/modules/events'

/**
 * Customers Module Events
 *
 * Declares all events that can be emitted by the customers module.
 */
const events = [
  // People
  { id: 'customers.person.created', label: 'Customer (Person) Created', entity: 'person', category: 'crud' },
  { id: 'customers.person.updated', label: 'Customer (Person) Updated', entity: 'person', category: 'crud' },
  { id: 'customers.person.deleted', label: 'Customer (Person) Deleted', entity: 'person', category: 'crud' },
  { id: 'customers.person.stage_changed', label: 'Contact Lifecycle Stage Changed', entity: 'person', category: 'lifecycle' },

  // Companies
  { id: 'customers.company.created', label: 'Customer (Company) Created', entity: 'company', category: 'crud' },
  { id: 'customers.company.updated', label: 'Customer (Company) Updated', entity: 'company', category: 'crud' },
  { id: 'customers.company.deleted', label: 'Customer (Company) Deleted', entity: 'company', category: 'crud' },

  // Deals
  { id: 'customers.deal.created', label: 'Deal Created', entity: 'deal', category: 'crud' },
  { id: 'customers.deal.updated', label: 'Deal Updated', entity: 'deal', category: 'crud' },
  { id: 'customers.deal.deleted', label: 'Deal Deleted', entity: 'deal', category: 'crud' },
  { id: 'customers.deal.stage_changed', label: 'Deal Stage Changed', entity: 'deal', category: 'lifecycle' },

  // Comments
  { id: 'customers.comment.created', label: 'Comment Created', entity: 'comment', category: 'crud' },
  { id: 'customers.comment.updated', label: 'Comment Updated', entity: 'comment', category: 'crud' },
  { id: 'customers.comment.deleted', label: 'Comment Deleted', entity: 'comment', category: 'crud' },

  // Addresses
  { id: 'customers.address.created', label: 'Address Created', entity: 'address', category: 'crud' },
  { id: 'customers.address.updated', label: 'Address Updated', entity: 'address', category: 'crud' },
  { id: 'customers.address.deleted', label: 'Address Deleted', entity: 'address', category: 'crud' },

  // Activities
  { id: 'customers.activity.created', label: 'Activity Created', entity: 'activity', category: 'crud' },
  { id: 'customers.activity.updated', label: 'Activity Updated', entity: 'activity', category: 'crud' },
  { id: 'customers.activity.deleted', label: 'Activity Deleted', entity: 'activity', category: 'crud' },

  // Tags
  { id: 'customers.tag.created', label: 'Tag Created', entity: 'tag', category: 'crud' },
  { id: 'customers.tag.updated', label: 'Tag Updated', entity: 'tag', category: 'crud' },
  { id: 'customers.tag.deleted', label: 'Tag Deleted', entity: 'tag', category: 'crud' },
  { id: 'customers.tag.assigned', label: 'Tag Assigned', entity: 'tag', category: 'crud' },
  { id: 'customers.tag.removed', label: 'Tag Removed', entity: 'tag', category: 'crud' },

  // Todos
  { id: 'customers.todo.created', label: 'Todo Created', entity: 'todo', category: 'crud' },
  { id: 'customers.todo.updated', label: 'Todo Updated', entity: 'todo', category: 'crud' },
  { id: 'customers.todo.deleted', label: 'Todo Deleted', entity: 'todo', category: 'crud' },

  // Tier 0 events (SPEC-061 mercato rebuild)
  // Tasks
  { id: 'customers.task.created', label: 'Task Created', entity: 'task', category: 'crud' },
  { id: 'customers.task.updated', label: 'Task Updated', entity: 'task', category: 'crud' },
  { id: 'customers.task.deleted', label: 'Task Deleted', entity: 'task', category: 'crud' },
  { id: 'customers.task.completed', label: 'Task Completed', entity: 'task', category: 'lifecycle' },

  // Contact notes
  { id: 'customers.note.created', label: 'Contact Note Created', entity: 'note', category: 'crud' },
  { id: 'customers.note.updated', label: 'Contact Note Updated', entity: 'note', category: 'crud' },
  { id: 'customers.note.deleted', label: 'Contact Note Deleted', entity: 'note', category: 'crud' },

  // Contact attachments
  { id: 'customers.attachment.created', label: 'Contact Attachment Uploaded', entity: 'attachment', category: 'crud' },
  { id: 'customers.attachment.deleted', label: 'Contact Attachment Deleted', entity: 'attachment', category: 'crud' },

  // Engagement (scores derived from events; events are append-only)
  { id: 'customers.engagement.tracked', label: 'Engagement Event Tracked', entity: 'engagement', category: 'crud' },
  { id: 'customers.engagement.score_updated', label: 'Engagement Score Updated', entity: 'engagement', category: 'lifecycle' },

  // Reminders
  { id: 'customers.reminder.created', label: 'Reminder Created', entity: 'reminder', category: 'crud' },
  { id: 'customers.reminder.updated', label: 'Reminder Updated', entity: 'reminder', category: 'crud' },
  { id: 'customers.reminder.deleted', label: 'Reminder Deleted', entity: 'reminder', category: 'crud' },
  { id: 'customers.reminder.fired', label: 'Reminder Fired', entity: 'reminder', category: 'lifecycle' },

  // Task templates
  { id: 'customers.task_template.created', label: 'Task Template Created', entity: 'task_template', category: 'crud' },
  { id: 'customers.task_template.updated', label: 'Task Template Updated', entity: 'task_template', category: 'crud' },
  { id: 'customers.task_template.deleted', label: 'Task Template Deleted', entity: 'task_template', category: 'crud' },

  // Business profile (1:1 with org, no create/delete)
  { id: 'customers.business_profile.updated', label: 'Business Profile Updated', entity: 'business_profile', category: 'crud' },

  // Pipeline automation (SPEC-064)
  { id: 'customers.deal.auto_advanced', label: 'Deal Auto-Advanced by Automation', entity: 'deal', category: 'lifecycle' },
  { id: 'customers.person.auto_advanced', label: 'Contact Lifecycle Auto-Advanced by Automation', entity: 'person', category: 'lifecycle' },
] as const

export const eventsConfig = createModuleEvents({
  moduleId: 'customers',
  events,
})

/** Type-safe event emitter for customers module */
export const emitCustomersEvent = eventsConfig.emit

/** Event IDs that can be emitted by the customers module */
export type CustomersEventId = typeof events[number]['id']

export default eventsConfig
