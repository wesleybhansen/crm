import { createModuleEvents } from '@open-mercato/shared/modules/events'

const events = [
  // Emitted once when someone books an appointment (the public booking page or
  // the AI receptionist). Automation rules and sequences with a booking_created
  // trigger run on it.
  { id: 'calendar.booking.created', label: 'Booking Created', entity: 'booking', category: 'lifecycle' as const },
] as const

export const eventsConfig = createModuleEvents({ moduleId: 'calendar', events })
export default eventsConfig
