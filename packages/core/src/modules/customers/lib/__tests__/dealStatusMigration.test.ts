import { Migration20260929120000 } from '../../migrations/Migration20260929120000'
import { DEAL_STATUS_DEFAULTS } from '../dealDefaultsData'

async function collectSql(): Promise<string> {
  const migration = new Migration20260929120000({} as any, {} as any)
  await migration.up()
  return migration.getQueries().map((query) => String(query)).join('\n')
}

describe('Migration20260929120000 (lost status + won/lost stage backfill)', () => {
  it('has no `?` (knex would bind it) and skips missing tables', async () => {
    const sql = await collectSql()
    expect(sql).not.toContain('?')
    expect(sql).toContain("to_regclass('public.customer_deals')")
    expect(sql).toContain("to_regclass('public.customer_dictionary_entries')")
  })

  it('renames loose/lose deals and the loose dictionary entry to lost', async () => {
    const sql = await collectSql()
    expect(sql).toContain("SET status = 'lost'\n   WHERE status IN ('loose', 'lose')")
    expect(sql).toContain("SET value = 'lost', normalized_value = 'lost'")
    expect(sql).toMatch(/DELETE FROM public\.customer_dictionary_entries e\s+WHERE e\.kind = 'deal_status' AND e\.normalized_value = 'loose'\s+AND EXISTS/)
  })

  it('gives open deals parked in a Won/Lost stage that status, and never touches updated_at on deals', async () => {
    const sql = await collectSql()
    expect(sql).toMatch(/SET status = 'win'\s+WHERE status = 'open'\s+AND lower\(trim\(pipeline_stage\)\) IN \('won', 'closed won'\)/)
    expect(sql).toMatch(/SET status = 'lost'\s+WHERE status = 'open'\s+AND lower\(trim\(pipeline_stage\)\) IN \('lost', 'closed lost'\)/)
    const dealStatements = sql.split('DO $$').filter((block) => block.includes('public.customer_deals SET'))
    for (const block of dealStatements) expect(block).not.toContain('updated_at')
  })

  it('matches the defaults new workspaces get', () => {
    expect(DEAL_STATUS_DEFAULTS.map((entry) => entry.value)).toContain('lost')
    expect(DEAL_STATUS_DEFAULTS.map((entry) => entry.value)).not.toContain('loose')
  })
})
