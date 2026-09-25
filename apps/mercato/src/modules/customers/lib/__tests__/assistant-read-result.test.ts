import { fetchListForAssistant, fetchJsonForAssistant, readFailure, contextSectionUnavailable, upcomingOnly } from '../assistant-read-result'

function mockFetch(status: number, body: unknown, opts: { badJson?: boolean; throws?: boolean } = {}) {
  return jest.fn(async () => {
    if (opts.throws) throw new Error('network down')
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (opts.badJson) throw new SyntaxError('Unexpected token')
        return body
      },
    } as unknown as Response
  }) as unknown as typeof fetch
}

describe('fetchListForAssistant', () => {
  it('returns items on success', async () => {
    const out = await fetchListForAssistant('/api/crm-events', 'events', mockFetch(200, { ok: true, data: [{ id: 1 }] }))
    expect(out).toEqual({ ok: true, items: [{ id: 1 }], body: { ok: true, data: [{ id: 1 }] } })
  })

  it('accepts { items } list bodies', async () => {
    const out = await fetchListForAssistant('/api/x', 'things', mockFetch(200, { items: [] }))
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.items).toEqual([])
  })

  it('reports a 500 as a failure, not an empty list', async () => {
    const out = await fetchListForAssistant('/api/crm-events', 'events', mockFetch(500, { ok: false, error: 'Failed' }))
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.failure.ok).toBe(false)
      expect(out.failure.message).toContain('Could not load events')
      expect(out.failure.message).toContain('Do not say there are none')
    }
  })

  it('reports ok:false bodies, bad JSON, network errors and missing lists as failures', async () => {
    expect((await fetchListForAssistant('/a', 'x', mockFetch(200, { ok: false }))).ok).toBe(false)
    expect((await fetchListForAssistant('/a', 'x', mockFetch(200, null, { badJson: true }))).ok).toBe(false)
    expect((await fetchListForAssistant('/a', 'x', mockFetch(200, null, { throws: true }))).ok).toBe(false)
    expect((await fetchListForAssistant('/a', 'x', mockFetch(200, { ok: true }))).ok).toBe(false)
  })
})

describe('fetchJsonForAssistant', () => {
  it('passes a good body through and flags failures', async () => {
    expect(await fetchJsonForAssistant('/a', 'x', mockFetch(200, { ok: true, data: { n: 1 } }))).toEqual({ ok: true, body: { ok: true, data: { n: 1 } } })
    expect((await fetchJsonForAssistant('/a', 'x', mockFetch(502, {}))).ok).toBe(false)
    expect((await fetchJsonForAssistant('/a', 'x', mockFetch(200, null, { throws: true }))).ok).toBe(false)
  })
})

describe('messages', () => {
  it('failure and context lines never read as "none"', () => {
    expect(readFailure('your calendar').message).toMatch(/^Could not load your calendar right now/)
    expect(contextSectionUnavailable('UPCOMING EVENTS', 'events')).toContain('could not be loaded')
  })
})

describe('upcomingOnly', () => {
  it('drops past and cancelled events and sorts soonest first', () => {
    const now = new Date('2026-09-25T12:00:00Z')
    const rows = [
      { id: 'late', start_time: '2026-10-05T10:00:00Z', status: 'published' },
      { id: 'past', start_time: '2026-09-01T10:00:00Z', status: 'published' },
      { id: 'soon', start_time: '2026-09-26T10:00:00Z', status: 'draft' },
      { id: 'cancelled', start_time: '2026-09-27T10:00:00Z', status: 'cancelled' },
    ]
    expect(upcomingOnly(rows, now).map((r) => r.id)).toEqual(['soon', 'late'])
  })
})
