import { isDealClosedTransition, isDealClosedWon } from '../dealClosed'
import {
  LOST_STATUS_VALUES,
  WON_STATUS_VALUES,
  canonicalDealStatus,
  classifyDealStage,
  dealStatusOutcome,
  statusForStageMove,
  winRatePercent,
} from '../dealStatus'

describe('dealStatusOutcome', () => {
  it.each([
    ['win', 'won'],
    ['won', 'won'],
    ['Closed Won', 'won'],
    ['lost', 'lost'],
    ['loose', 'lost'],
    ['lose', 'lost'],
    ['closed_lost', 'lost'],
    ['open', 'open'],
    ['in_progress', 'open'],
    ['closed', 'open'],
    [null, 'open'],
  ])('%s -> %s', (status, expected) => {
    expect(dealStatusOutcome(status)).toBe(expected)
  })
})

describe('canonicalDealStatus', () => {
  it('stores lost as lost, whatever spelling was sent (the legacy dictionary value was loose)', () => {
    expect(canonicalDealStatus('loose')).toBe('lost')
    expect(canonicalDealStatus('lose')).toBe('lost')
    expect(canonicalDealStatus('Lost')).toBe('lost')
  })

  it('stores won as win, the value reports and the status dictionary use', () => {
    expect(canonicalDealStatus('won')).toBe('win')
    expect(canonicalDealStatus('win')).toBe('win')
  })

  it('keeps every other status as sent', () => {
    expect(canonicalDealStatus('open')).toBe('open')
    expect(canonicalDealStatus('in_progress')).toBe('in_progress')
    expect(canonicalDealStatus('closed')).toBe('closed')
  })

  it('writes only values the report lists count', () => {
    for (const legacy of ['loose', 'lose', 'lost']) expect(LOST_STATUS_VALUES).toContain(canonicalDealStatus(legacy))
    for (const legacy of ['won', 'win']) expect(WON_STATUS_VALUES).toContain(canonicalDealStatus(legacy))
  })
})

describe('classifyDealStage', () => {
  it.each([
    ['Won', 'won'],
    ['Closed Won', 'won'],
    ['closed-won', 'won'],
    ['Closed', 'won'],
    ['Sold', 'won'],
    ['Lost', 'lost'],
    ['Closed Lost', 'lost'],
    ['loose', 'lost'],
    ['Fell through', 'lost'],
    ['Negotiation', null],
    ['Closing', null],
    ['Under Contract', null],
    ['', null],
    [null, null],
  ])('%s -> %s', (stage, expected) => {
    expect(classifyDealStage(stage)).toBe(expected)
  })
})

describe('statusForStageMove (a drag on the pipeline board)', () => {
  it('marks a deal dragged into Won as won', () => {
    expect(statusForStageMove('open', 'Won')).toBe('win')
  })

  it('marks a deal dragged into Lost as lost (never loose)', () => {
    expect(statusForStageMove('open', 'Lost')).toBe('lost')
    expect(statusForStageMove('win', 'Closed Lost')).toBe('lost')
  })

  it('reopens a won or lost deal dragged back to an ordinary stage', () => {
    expect(statusForStageMove('win', 'Negotiation')).toBe('open')
    expect(statusForStageMove('lost', 'Proposal')).toBe('open')
    expect(statusForStageMove('loose', 'Proposal')).toBe('open')
  })

  it('leaves the status alone when it already fits', () => {
    expect(statusForStageMove('open', 'Qualified')).toBeNull()
    expect(statusForStageMove('in_progress', 'Qualified')).toBeNull()
    expect(statusForStageMove('win', 'Won')).toBeNull()
    expect(statusForStageMove('won', 'Closed Won')).toBeNull()
    expect(statusForStageMove('lost', 'Lost')).toBeNull()
  })

  it('agrees with the deal-closed event: a drag into a won stage is one close transition', () => {
    for (const stage of ['Won', 'Closed', 'Closed Won', 'Sold']) {
      const after = { status: statusForStageMove('open', stage), pipelineStage: stage }
      expect(isDealClosedWon(after)).toBe(true)
      expect(isDealClosedTransition({ status: 'open', pipelineStage: 'Negotiation' }, after)).toBe(true)
      // Re-saving the now-won deal is not a second close.
      expect(isDealClosedTransition(after, after)).toBe(false)
    }
    for (const stage of ['Lost', 'Closed Lost', 'Fell through']) {
      expect(isDealClosedWon({ status: statusForStageMove('open', stage), pipelineStage: stage })).toBe(false)
    }
  })
})

describe('winRatePercent', () => {
  it('counts legacy loose rows as losses (they used to inflate the win rate)', () => {
    const statuses = ['win', 'win', 'loose', 'loose', 'lost', 'open']
    const won = statuses.filter((status) => dealStatusOutcome(status) === 'won').length
    const lost = statuses.filter((status) => dealStatusOutcome(status) === 'lost').length
    expect(won).toBe(2)
    expect(lost).toBe(3)
    expect(winRatePercent(won, lost)).toBe(40)
    // What the old report did: count only 'win' and 'lose'/'lost' -> 67%.
    const oldWon = statuses.filter((status) => status === 'win').length
    const oldLost = statuses.filter((status) => status === 'lose' || status === 'lost').length
    expect(winRatePercent(oldWon, oldLost)).toBe(67)
    // The report's SQL lists match the same rows.
    expect(statuses.filter((status) => WON_STATUS_VALUES.includes(status))).toHaveLength(won)
    expect(statuses.filter((status) => LOST_STATUS_VALUES.includes(status))).toHaveLength(lost)
  })

  it('is 0 when nothing was decided', () => {
    expect(winRatePercent(0, 0)).toBe(0)
  })

  it('rounds to a whole percent', () => {
    expect(winRatePercent(1, 2)).toBe(33)
  })
})
