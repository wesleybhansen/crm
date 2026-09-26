import {
  DEAL_CLOSED_EVENT_ID,
  DEAL_LOST_EVENT_ID,
  emitDealClosedIfTransitioned,
  emitDealLostIfTransitioned,
  isDealClosedTransition,
  isDealClosedWon,
  isDealLost,
  isDealLostTransition,
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

describe('isDealLost', () => {
  it.each([
    [{ status: 'lost' }, true],
    [{ status: 'loose' }, true],
    [{ status: 'lose' }, true],
    [{ status: 'closed_lost' }, true],
    [{ status: 'open', pipelineStage: 'Lost' }, true],
    [{ status: 'open', pipelineStage: 'Closed Lost' }, true],
    [{ status: 'open', pipelineStage: 'Fell through' }, true],
    [{ status: 'win', pipelineStage: 'Lost' }, true],
    [{ status: 'open', pipelineStage: 'Negotiation' }, false],
    [{ status: 'win', pipelineStage: 'Won' }, false],
    [{ status: 'open', pipelineStage: 'Closed' }, false],
    [{ status: null, pipelineStage: null }, false],
  ])('%j -> %s', (deal, expected) => {
    expect(isDealLost(deal)).toBe(expected)
  })

  it('never counts a deal both won and lost', () => {
    for (const deal of [{ status: 'win', pipelineStage: 'Lost' }, { status: 'lost', pipelineStage: 'Won' }, { status: 'closed', pipelineStage: 'Closed Lost' }]) {
      expect(isDealLost(deal) && isDealClosedWon(deal)).toBe(false)
    }
  })
})

describe('emitDealLostIfTransitioned', () => {
  const lostIds = { id: 'deal-9', organizationId: 'org-1', tenantId: 'tenant-1' }

  it('is a transition only when the deal moves into a lost state', () => {
    expect(isDealLostTransition({ status: 'open', pipelineStage: 'Offer' }, { status: 'lost', pipelineStage: 'Lost' })).toBe(true)
    expect(isDealLostTransition({ status: 'lost' }, { status: 'lost', pipelineStage: 'Lost' })).toBe(false)
    expect(isDealLostTransition({ status: 'lost' }, { status: 'open' })).toBe(false)
  })

  it('emits one customers.deal.lost for a move into Lost, and again after a reopen', async () => {
    const emitEvent = jest.fn()
    const lostAt = new Date('2026-09-30T16:00:00.000Z')
    await expect(emitDealLostIfTransitioned({ emitEvent }, {
      ...lostIds,
      before: { status: 'open', pipelineStage: 'Offer' },
      after: { status: 'lost', pipelineStage: 'Lost' },
      lostAt,
    })).resolves.toBe(true)
    expect(emitEvent).toHaveBeenCalledWith(
      DEAL_LOST_EVENT_ID,
      { ...lostIds, lostAt: lostAt.toISOString(), status: 'lost', stage: 'Lost' },
      { persistent: true },
    )
    await emitDealLostIfTransitioned({ emitEvent }, { ...lostIds, before: { status: 'lost', pipelineStage: 'Lost' }, after: { status: 'lost', pipelineStage: 'Lost' } })
    expect(emitEvent).toHaveBeenCalledTimes(1)
    await emitDealLostIfTransitioned({ emitEvent }, { ...lostIds, before: { status: 'open', pipelineStage: 'Offer' }, after: { status: 'lost', pipelineStage: 'Lost' } })
    expect(emitEvent).toHaveBeenCalledTimes(2)
  })

  it('does not emit a lost event for a win', async () => {
    const emitEvent = jest.fn()
    await emitDealLostIfTransitioned({ emitEvent }, { ...lostIds, before: { status: 'open' }, after: { status: 'win', pipelineStage: 'Won' } })
    expect(emitEvent).not.toHaveBeenCalled()
  })

  it('never throws when the bus fails or is missing', async () => {
    const failing = { emitEvent: jest.fn().mockRejectedValue(new Error('bus down')) }
    await expect(emitDealLostIfTransitioned(failing, { ...lostIds, before: { status: 'open' }, after: { status: 'lost' } })).resolves.toBe(false)
    await expect(emitDealLostIfTransitioned(null, { ...lostIds, before: { status: 'open' }, after: { status: 'lost' } })).resolves.toBe(false)
  })
})
