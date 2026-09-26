import {
  DEFAULT_DEAL_STAGES,
  OTHER_STAGES_COLUMN_KEY,
  buildDealBoard,
  dealStageNames,
  openDealStageNames,
  parsePipelineStageNames,
  type BoardDeal,
} from '../deal-board'

function deal(id: string, stage: string | null, status: string | null, value = 100): BoardDeal {
  return { id, title: id, value_amount: value, pipeline_stage: stage, status, updated_at: '2026-09-25T00:00:00.000Z' }
}

describe('dealStageNames (one source for the board and the New Deal dialog)', () => {
  it('uses the organization\'s own stages', () => {
    const profile = { pipeline_stages: JSON.stringify([{ name: 'Inquiry' }, { name: 'Showing' }, { name: 'Under Contract' }, { name: 'Closed' }]) }
    expect(dealStageNames(profile)).toEqual(['Inquiry', 'Showing', 'Under Contract', 'Closed'])
    expect(dealStageNames({ pipeline_stages: ['A', { name: 'B' }] })).toEqual(['A', 'B'])
  })

  it('falls back to the defaults when fewer than two stages are set', () => {
    expect(dealStageNames(null)).toEqual([...DEFAULT_DEAL_STAGES])
    expect(dealStageNames({ pipeline_stages: [{ name: 'Only' }] })).toEqual([...DEFAULT_DEAL_STAGES])
    expect(parsePipelineStageNames('not json')).toBeNull()
  })
})

describe('openDealStageNames (what a new deal can start in)', () => {
  it('drops Won/Lost-type stages and keeps the rest in order', () => {
    expect(openDealStageNames(['Inquiry', 'Showing', 'Under Contract', 'Closed', 'Fell through'])).toEqual(['Inquiry', 'Showing', 'Under Contract'])
    expect(openDealStageNames([...DEFAULT_DEAL_STAGES])).toEqual(['New Lead', 'Contacted', 'Qualified', 'Proposal', 'Negotiation'])
  })
})

describe('buildDealBoard', () => {
  const stages = ['New Lead', 'Proposal', 'Won', 'Lost']

  it('puts open deals in their stage column (case-insensitive)', () => {
    const board = buildDealBoard(stages, [deal('a', 'proposal', 'open'), deal('b', 'New Lead', 'open')])
    expect(board.map((column) => [column.name, column.deals.map((d) => d.id)])).toEqual([
      ['New Lead', ['b']],
      ['Proposal', ['a']],
      ['Won', []],
      ['Lost', []],
    ])
  })

  it('shows won and lost deals in the Won and Lost columns, legacy spellings included', () => {
    const board = buildDealBoard(stages, [
      deal('w1', 'Won', 'win'),
      deal('w2', 'Negotiation', 'won'),
      deal('l1', 'Lost', 'lost'),
      deal('l2', 'Proposal', 'loose'),
    ])
    const byName = Object.fromEntries(board.map((column) => [column.name, column.deals.map((d) => d.id)]))
    expect(byName.Won).toEqual(['w1', 'w2'])
    expect(byName.Lost).toEqual(['l1', 'l2'])
    expect(byName.Proposal).toEqual([])
  })

  it('counts only open deals toward the pipeline totals', () => {
    const board = buildDealBoard(stages, [deal('a', 'Proposal', 'open', 500), deal('w', 'Won', 'win', 900)])
    const won = board.find((column) => column.name === 'Won')!
    expect(won).toMatchObject({ kind: 'won', count: 1, totalValue: 900, openCount: 0, openValue: 0 })
    const openValue = board.reduce((sum, column) => sum + column.openValue, 0)
    expect(openValue).toBe(500)
  })

  it('keeps an open deal whose stage is not in the list visible in "Other stages" instead of dropping it', () => {
    const board = buildDealBoard(stages, [deal('orphan', 'Qualified', 'open'), deal('none', null, 'open')])
    const other = board[board.length - 1]
    expect(other.key).toBe(OTHER_STAGES_COLUMN_KEY)
    expect(other.kind).toBe('other')
    expect(other.deals.map((d) => d.id)).toEqual(['orphan', 'none'])
    expect(buildDealBoard(stages, [deal('a', 'Proposal', 'open')]).some((column) => column.kind === 'other')).toBe(false)
  })

  it('leaves a closed deal off a board that has no column of its kind', () => {
    const board = buildDealBoard(['New Lead', 'Proposal'], [deal('w', 'Won', 'win')])
    expect(board.flatMap((column) => column.deals)).toEqual([])
  })
})
