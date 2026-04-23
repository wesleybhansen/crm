/**
 * Public webhook event registry.
 *
 * These are the event names users subscribe to in the UI and receive
 * in the POST body's `event` field. They are stable, user-facing
 * identifiers — renaming one is a breaking change. Internal module
 * event IDs (e.g. `customers.person.created`) map to these via the
 * `internalEventId` field.
 *
 * When adding a new event:
 *  1. Add an entry here
 *  2. Add a subscriber in `subscribers/` that listens to the internal
 *     event and calls `dispatchWebhook(knex, orgId, '<public id>', payload)`
 *  3. Document the `data` shape in SPEC-062 §1.3
 */

export type WebhookEventDefinition = {
  /** Public event name. Stable — users subscribe to this. */
  id: string
  /** Human-readable label shown in the subscription UI. */
  label: string
  /** Group used for grouping in the UI. */
  category: 'Contacts' | 'Deals' | 'Tasks' | 'Forms' | 'Calendar' | 'Courses' | 'Sales' | 'System'
  /** Internal module event ID that triggers this webhook. */
  internalEventId: string
  /** One-line description of when the event fires. */
  description: string
}

export const WEBHOOK_EVENTS: readonly WebhookEventDefinition[] = [
  // Contacts
  { id: 'contact.created', label: 'Contact Created', category: 'Contacts', internalEventId: 'customers.person.created', description: 'A new person contact is added to the CRM.' },
  { id: 'contact.updated', label: 'Contact Updated', category: 'Contacts', internalEventId: 'customers.person.updated', description: 'An existing contact is edited.' },

  // Deals
  { id: 'deal.created', label: 'Deal Created', category: 'Deals', internalEventId: 'customers.deal.created', description: 'A new deal enters the pipeline.' },
  { id: 'deal.stage_changed', label: 'Deal Stage Changed', category: 'Deals', internalEventId: 'customers.deal.stage_changed', description: 'A deal moves to a different pipeline stage.' },
  { id: 'deal.won', label: 'Deal Won', category: 'Deals', internalEventId: 'customers.deal.won', description: 'A deal is marked as won.' },
  { id: 'deal.lost', label: 'Deal Lost', category: 'Deals', internalEventId: 'customers.deal.lost', description: 'A deal is marked as lost.' },

  // Tasks
  { id: 'task.created', label: 'Task Created', category: 'Tasks', internalEventId: 'customers.task.created', description: 'A new task is created.' },
  { id: 'task.completed', label: 'Task Completed', category: 'Tasks', internalEventId: 'customers.task.completed', description: 'A task is marked as completed.' },

  // Forms (inline-emitted from the form submit route — no ORM event bus)
  { id: 'form.submitted', label: 'Form Submitted', category: 'Forms', internalEventId: 'forms.submission.created', description: 'A public form receives a submission.' },

  // Calendar (inline-emitted from the booking route)
  { id: 'booking.created', label: 'Booking Created', category: 'Calendar', internalEventId: 'calendar.booking.created', description: 'A guest books a meeting via a booking page.' },

  // Courses (inline-emitted from the enrollment route)
  { id: 'course.enrollment.created', label: 'Course Enrollment', category: 'Courses', internalEventId: 'courses.enrollment.created', description: 'A student enrolls in a course.' },

  // Sales
  { id: 'invoice.created', label: 'Invoice Created', category: 'Sales', internalEventId: 'sales.invoice.created', description: 'A new invoice is issued.' },
  { id: 'invoice.paid', label: 'Invoice Paid', category: 'Sales', internalEventId: 'sales.invoice.paid', description: 'An invoice is marked as paid.' },

  // System — for users to test their endpoint wiring
  { id: 'webhooks.test', label: 'Test Event', category: 'System', internalEventId: 'webhooks.test', description: 'Fired when the user clicks "Send Test" in the subscription UI.' },
] as const

export function findPublicEventId(internalEventId: string): string | null {
  const match = WEBHOOK_EVENTS.find((e) => e.internalEventId === internalEventId)
  return match ? match.id : null
}

export function findEventByPublicId(publicId: string): WebhookEventDefinition | null {
  return WEBHOOK_EVENTS.find((e) => e.id === publicId) ?? null
}

export function groupedEvents(): Record<string, WebhookEventDefinition[]> {
  const out: Record<string, WebhookEventDefinition[]> = {}
  for (const event of WEBHOOK_EVENTS) {
    if (!out[event.category]) out[event.category] = []
    out[event.category].push(event)
  }
  return out
}
