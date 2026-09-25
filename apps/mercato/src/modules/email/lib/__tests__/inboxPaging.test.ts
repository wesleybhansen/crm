import { inboxMessagesQuery, inboxPageSummary, inboxRangeLabel, messageCountLabel } from '../inboxPaging'

describe('inboxPageSummary', () => {
  it('pages 444 messages 20 at a time', () => {
    const first = inboxPageSummary({ page: 1, pageSize: 20, total: 444 })
    expect(first).toEqual({ page: 1, totalPages: 23, from: 1, to: 20, hasPrev: false, hasNext: true })
    const last = inboxPageSummary({ page: 23, pageSize: 20, total: 444 })
    expect(last).toEqual({ page: 23, totalPages: 23, from: 441, to: 444, hasPrev: true, hasNext: false })
  })

  it('clamps a page past the end and handles an empty inbox', () => {
    expect(inboxPageSummary({ page: 99, pageSize: 20, total: 45 }).page).toBe(3)
    expect(inboxPageSummary({ page: 1, pageSize: 20, total: 0 })).toEqual({ page: 1, totalPages: 1, from: 0, to: 0, hasPrev: false, hasNext: false })
  })

  it('treats bad input as page 1 of size 20', () => {
    expect(inboxPageSummary({ page: 0, pageSize: 0, total: 30 })).toMatchObject({ page: 1, totalPages: 2, to: 20 })
  })
})

describe('labels', () => {
  it('pluralises the message count and shows the real total', () => {
    expect(messageCountLabel(1)).toBe('1 message')
    expect(messageCountLabel(0)).toBe('0 messages')
    expect(messageCountLabel(1444)).toBe('1,444 messages')
  })

  it('describes the visible range', () => {
    expect(inboxRangeLabel(inboxPageSummary({ page: 2, pageSize: 20, total: 444 }), 444)).toBe('21 to 40 of 444')
    expect(inboxRangeLabel(inboxPageSummary({ page: 1, pageSize: 20, total: 0 }), 0)).toBe('')
  })
})

describe('inboxMessagesQuery', () => {
  it('always sends page and size, and the direction unless showing all', () => {
    expect(inboxMessagesQuery({ page: 3, pageSize: 20, direction: 'all' })).toBe('page=3&pageSize=20')
    expect(inboxMessagesQuery({ page: 1, pageSize: 20, direction: 'inbound' })).toBe('page=1&pageSize=20&direction=inbound')
  })
})
