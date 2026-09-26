import { applyStageRenames, planStageRenames, stageNamesOf } from '../pipelineStageRenames'

const stages = (...names: string[]) => names.map((name) => ({ name }))

describe('stageNamesOf', () => {
  it('reads names, { name } objects and JSON text', () => {
    expect(stageNamesOf(['A', { name: ' B ' }, { name: '' }, null])).toEqual(['A', 'B'])
    expect(stageNamesOf(JSON.stringify(stages('A', 'B')))).toEqual(['A', 'B'])
    expect(stageNamesOf('not json')).toEqual([])
    expect(stageNamesOf(null)).toEqual([])
  })
})

describe('planStageRenames', () => {
  const before = stages('New Lead', 'Qualified', 'Proposal', 'Won', 'Lost')

  it('uses the explicit rename the settings page sends', () => {
    const after = stages('New Lead', 'Hot Lead', 'Proposal', 'Won', 'Lost')
    expect(planStageRenames(before, after, [{ from: 'Qualified', to: 'Hot Lead' }])).toEqual([{ from: 'Qualified', to: 'Hot Lead' }])
  })

  it('infers a single in-place rename when none is sent (e.g. the assistant rewrote the list)', () => {
    const after = stages('New Lead', 'Hot Lead', 'Proposal', 'Won', 'Lost')
    expect(planStageRenames(before, after)).toEqual([{ from: 'Qualified', to: 'Hot Lead' }])
  })

  it('never moves rows out of a stage that is still in the list', () => {
    const after = stages('New Lead', 'Qualified', 'Proposal', 'Won', 'Lost', 'Hot Lead')
    expect(planStageRenames(before, after, [{ from: 'Qualified', to: 'Hot Lead' }])).toEqual([])
    // Swapping two positions is a reorder, not a rename.
    expect(planStageRenames(before, stages('Qualified', 'New Lead', 'Proposal', 'Won', 'Lost'))).toEqual([])
  })

  it('ignores adds, removes and case-only edits', () => {
    expect(planStageRenames(before, stages('New Lead', 'Qualified', 'Proposal', 'Won', 'Lost', 'Onboarding'))).toEqual([])
    expect(planStageRenames(before, stages('New Lead', 'Proposal', 'Won', 'Lost'))).toEqual([])
    expect(planStageRenames(before, stages('New Lead', 'qualified', 'Proposal', 'Won', 'Lost'))).toEqual([])
  })

  it('drops an explicit rename whose target is not in the saved list', () => {
    const after = stages('New Lead', 'Hot Lead', 'Proposal', 'Won', 'Lost')
    expect(planStageRenames(before, after, [{ from: 'Qualified', to: 'Somewhere else' }])).toEqual([])
    expect(planStageRenames(before, after, [{ from: 'Qualified' }, 'junk', null])).toEqual([])
  })

  it('an explicit empty list means no renames (no inference)', () => {
    const after = stages('New Lead', 'Hot Lead', 'Proposal', 'Won', 'Lost')
    expect(planStageRenames(before, after, [])).toEqual([])
  })
})

describe('applyStageRenames', () => {
  type Call = { table: string; where: Array<[string, unknown]>; nulls: string[]; raw: Array<[string, unknown[]]>; update?: Record<string, unknown> }

  function fakeKnex() {
    const calls: Call[] = []
    const trx = (table: string) => {
      const call: Call = { table, where: [], nulls: [], raw: [] }
      calls.push(call)
      const query = {
        where: (field: string, value: unknown) => { call.where.push([field, value]); return query },
        whereNull: (field: string) => { call.nulls.push(field); return query },
        whereRaw: (sql: string, bindings: unknown[]) => { call.raw.push([sql, bindings]); return query },
        update: async (values: Record<string, unknown>) => { call.update = values; return table === 'customer_deals' ? 3 : 2 },
      }
      return query
    }
    const knex = { transaction: async (fn: (t: typeof trx) => Promise<unknown>) => fn(trx) }
    return { knex, calls }
  }

  it('renames the stage on the organization\'s deals and contacts only, without touching updated_at', async () => {
    const { knex, calls } = fakeKnex()
    const result = await applyStageRenames(knex as never, { tenantId: 'ten-1', organizationId: 'org-1' }, [{ from: 'Qualified', to: 'Hot Lead' }])
    expect(result).toEqual({ deals: 3, contacts: 2 })
    expect(calls.map((call) => call.table)).toEqual(['customer_deals', 'customer_entities'])
    for (const call of calls) {
      expect(call.where).toEqual(expect.arrayContaining([['tenant_id', 'ten-1'], ['organization_id', 'org-1']]))
      expect(call.nulls).toContain('deleted_at')
      expect(call.raw[0][1]).toEqual(['Qualified'])
      expect(call.update).not.toHaveProperty('updated_at')
    }
    expect(calls[0].update).toEqual({ pipeline_stage: 'Hot Lead' })
    expect(calls[1].update).toEqual({ lifecycle_stage: 'Hot Lead' })
    expect(calls[1].where).toContainEqual(['kind', 'person'])
  })

  it('does nothing without renames', async () => {
    const { knex, calls } = fakeKnex()
    await expect(applyStageRenames(knex as never, { tenantId: 't', organizationId: 'o' }, [])).resolves.toEqual({ deals: 0, contacts: 0 })
    expect(calls).toHaveLength(0)
  })
})
