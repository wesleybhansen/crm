/** @jest-environment node */
import { deleteAutomationRule } from '../automation-rule-delete'

type Call = { table: string; op: string; wheres: Array<[string, unknown]>; payload?: unknown }

function fakeKnex(opts: {
  rule?: { id: string; name: string } | undefined
  logColumns: Array<{ column_name: string; is_nullable: string }>
  scheduledTable: boolean
  logCount?: number
}) {
  const calls: Call[] = []
  const trx: any = (table: string) => {
    const call: Call = { table, op: 'select', wheres: [] }
    calls.push(call)
    const q: any = {
      where: (col: string, val: unknown) => { call.wheres.push([col, val]); return q },
      first: async () => opts.rule,
      update: async (payload: unknown) => { call.op = 'update'; call.payload = payload; return opts.logCount ?? 0 },
      del: async () => { call.op = 'delete'; return table === 'automation_rule_logs' ? (opts.logCount ?? 0) : 1 },
    }
    return q
  }
  trx.raw = async (sql: string) => {
    if (sql.includes('information_schema.columns')) return { rows: opts.logColumns }
    if (sql.includes('to_regclass')) return { rows: [{ reg: opts.scheduledTable ? 'automation_scheduled_steps' : null }] }
    throw new Error(`unexpected raw: ${sql}`)
  }
  const knex: any = { transaction: async (cb: (t: any) => Promise<unknown>) => cb(trx) }
  return { knex, calls }
}

const RULE = { id: 'rule-1', name: '[e2e] QA rule' }
const PRE_MIGRATION = [{ column_name: 'rule_id', is_nullable: 'NO' }]
const POST_MIGRATION = [{ column_name: 'rule_id', is_nullable: 'YES' }, { column_name: 'deleted_rule_name', is_nullable: 'YES' }]

describe('deleteAutomationRule', () => {
  it('returns not_found for a rule outside the organization and writes nothing', async () => {
    const { knex, calls } = fakeKnex({ rule: undefined, logColumns: POST_MIGRATION, scheduledTable: true })
    expect(await deleteAutomationRule(knex, 'org-2', 'rule-1')).toEqual({ status: 'not_found' })
    expect(calls).toHaveLength(1)
    expect(calls[0].wheres).toEqual([['id', 'rule-1'], ['organization_id', 'org-2']])
  })

  it('on the current production schema, deletes the logs (never writes the missing column)', async () => {
    const { knex, calls } = fakeKnex({ rule: RULE, logColumns: PRE_MIGRATION, scheduledTable: false, logCount: 3 })
    const result = await deleteAutomationRule(knex, 'org-1', 'rule-1')
    expect(result).toEqual({ status: 'deleted', logsKept: 0, logsDeleted: 3, scheduledStepsDeleted: 0 })
    expect(calls.some((c) => c.op === 'update')).toBe(false)
    expect(calls.find((c) => c.table === 'automation_rule_logs')?.op).toBe('delete')
    expect(calls.some((c) => c.table === 'automation_scheduled_steps')).toBe(false)
    const ruleDelete = calls.filter((c) => c.table === 'automation_rules' && c.op === 'delete')
    expect(ruleDelete).toHaveLength(1)
    expect(ruleDelete[0].wheres).toEqual([['id', 'rule-1'], ['organization_id', 'org-1']])
  })

  it('after the migration, keeps the logs unlinked and stamped with the rule name', async () => {
    const { knex, calls } = fakeKnex({ rule: RULE, logColumns: POST_MIGRATION, scheduledTable: true, logCount: 2 })
    const result = await deleteAutomationRule(knex, 'org-1', 'rule-1')
    expect(result).toMatchObject({ status: 'deleted', logsKept: 2, logsDeleted: 0 })
    const logUpdate = calls.find((c) => c.table === 'automation_rule_logs')
    expect(logUpdate?.op).toBe('update')
    expect(logUpdate?.payload).toEqual({ deleted_rule_name: '[e2e] QA rule', rule_id: null })
  })

  it('removes pending delayed steps for the rule, scoped to the organization', async () => {
    const { knex, calls } = fakeKnex({ rule: RULE, logColumns: POST_MIGRATION, scheduledTable: true })
    const result = await deleteAutomationRule(knex, 'org-1', 'rule-1')
    expect(result).toMatchObject({ status: 'deleted', scheduledStepsDeleted: 1 })
    const steps = calls.find((c) => c.table === 'automation_scheduled_steps')
    expect(steps?.op).toBe('delete')
    expect(steps?.wheres).toEqual([['rule_id', 'rule-1'], ['organization_id', 'org-1']])
  })

  it('deletes the rule last, after its dependents', async () => {
    const { knex, calls } = fakeKnex({ rule: RULE, logColumns: PRE_MIGRATION, scheduledTable: true })
    await deleteAutomationRule(knex, 'org-1', 'rule-1')
    const writes = calls.filter((c) => c.op !== 'select').map((c) => c.table)
    expect(writes).toEqual(['automation_rule_logs', 'automation_scheduled_steps', 'automation_rules'])
  })
})
