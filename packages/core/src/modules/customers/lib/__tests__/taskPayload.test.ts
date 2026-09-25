import { normalizeTaskPayload } from '../taskPayload'

describe('normalizeTaskPayload', () => {
  it('maps snake_case task keys onto the camelCase schema keys', () => {
    expect(normalizeTaskPayload({ id: 't1', is_done: true })).toEqual({ id: 't1', isDone: true })
    expect(normalizeTaskPayload({ title: 'Call', due_date: '2026-09-30', contact_id: 'c1' })).toEqual({ title: 'Call', dueDate: '2026-09-30', contactId: 'c1' })
  })

  it('keeps an explicit camelCase value and leaves other keys alone', () => {
    expect(normalizeTaskPayload({ isDone: false, is_done: true, title: 'x' })).toEqual({ isDone: false, title: 'x' })
    expect(normalizeTaskPayload(null)).toEqual({})
  })
})
