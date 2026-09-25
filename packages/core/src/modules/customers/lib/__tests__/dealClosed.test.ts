import {
  DEAL_CLOSED_EVENT_ID,
  emitDealClosedIfTransitioned,
  isDealClosedTransition,
  isDealClosedWon,
} from '../dealClosed'

describe('isDealClosedWon', () => {
  it.each([
    [{ status: 'win' }, true],
    [{ status: 'won' }, true],
    [{ status: 'closed' }, true],
    [{ status: 'closed_won' }, true],
    [{ status: 'open', pipelineStage: 'Won' }, true],
    [{ status: 'open', pipelineStage: 'Closed' }, true],
    [{ status: 'open', pipelineStage: 'Closed Won' }, true],
    [{ status: 'open', pipelineStage: 'closed-won' }, true],
    [{ status: 'open', pipelineStage: 'Sold' }, true],
    [{ status: 'open', pipelineStage: 'Negotiation' }, false],
    [{ status: 'open', pipelineStage: 'Closing' }, false],
    [{ status: 'open', pipelineStage: 'Under Contract' }, false],
    [{ status: 'loose' }, false],
    [{ status: 'lost' }, false],
    [{ status: 'closed', pipelineStage: 'Closed Lost' }, false],
    [{ status: 'win', pipelineStage: 'Lost' }, false],
    [{ status: 'open', pipelineStage: 'Fell through' }, false],
    [{ status: null, pipelineStage: null }, false],
  ])('%j -> %s', (deal, expected) => {
    expect(isDealClosedWon(deal)).toBe(expected)
  })

  it('treats a missing deal as not closed', () => {
    expect(isDealClosedWon(null)).toBe(false)
  })
})

describe('isDealClosedTransition', () => {
  it('is true only when the deal moves into a closed state', () => {
    expect(isDealClosedTransition({ status: 'open', pipelineStage: 'Negotiation' }, { status: 'open', pipelineStage: 'Won' })).toBe(true)
    expect(isDealClosedTransition({ status: 'open' }, { status: 'win' })).toBe(true)
    expect(isDealClosedTransition({ status: 'win' }, { status: 'win', pipelineStage: 'Won' })).toBe(false)
    expect(isDealClosedTransition({ status: 'open', pipelineStage: 'Won' }, { status: 'win', pipelineStage: 'Won' })).toBe(false)
    expect(isDealClosedTransition({ status: 'open' }, { status: 'loose' })).toBe(false)
  })
})

describe('emitDealClosedIfTransitioned', () => {
  const ids = { id: 'deal-1', organizationId: 'org-1', tenantId: 'ten-1' }

  it('emits one persistent customers.deal.closed on a close', async () => {
    const emitEvent = jest.fn().mockResolvedValue(undefined)
    const closedAt = new Date('2026-09-28T17:00:00.000Z')
    const emitted = await emitDealClosedIfTransitioned({ emitEvent }, {
      ...ids,
      before: { status: 'open', pipelineStage: 'Offer' },
      after: { status: 'open', pipelineStage: 'Closed' },
      closedAt,
    })
    expect(emitted).toBe(true)
    expect(emitEvent).toHaveBeenCalledTimes(1)
    expect(emitEvent).toHaveBeenCalledWith(
      DEAL_CLOSED_EVENT_ID,
      { ...ids, closedAt: closedAt.toISOString(), status: 'open', stage: 'Closed' },
      { persistent: true },
    )
  })

  it('does not emit for an edit of a deal that was already closed', async () => {
    const emitEvent = jest.fn()
    const emitted = await emitDealClosedIfTransitioned({ emitEvent }, {
      ...ids,
      before: { status: 'win', pipelineStage: 'Won' },
      after: { status: 'win', pipelineStage: 'Won' },
    })
    expect(emitted).toBe(false)
    expect(emitEvent).not.toHaveBeenCalled()
  })

  it('never throws when the bus fails or is missing', async () => {
    const failing = { emitEvent: jest.fn().mockRejectedValue(new Error('bus down')) }
    await expect(emitDealClosedIfTransitioned(failing, { ...ids, before: { status: 'open' }, after: { status: 'win' } })).resolves.toBe(false)
    await expect(emitDealClosedIfTransitioned(null, { ...ids, before: { status: 'open' }, after: { status: 'win' } })).resolves.toBe(false)
  })
})
