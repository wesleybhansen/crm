import { createModuleEvents } from '@open-mercato/shared/modules/events'

const events = [
  { id: 'sequences.sequence.completed', label: 'Sequence Completed for Contact', entity: 'sequence_run', category: 'lifecycle' },
] as const

export const eventsConfig = createModuleEvents({
  moduleId: 'sequences',
  events,
})

export const emitSequencesEvent = eventsConfig.emit

export type SequencesEventId = typeof events[number]['id']

export default eventsConfig
