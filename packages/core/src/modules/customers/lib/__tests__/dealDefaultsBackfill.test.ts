import { Migration20260925153000 } from '../../migrations/Migration20260925153000'
import { DEAL_STATUS_DEFAULTS, PIPELINE_STAGE_DEFAULTS } from '../dealDefaultsData'

async function collectSql(): Promise<string[]> {
  const migration = new Migration20260925153000({} as any, {} as any)
  await migration.up()
  return migration.getQueries().map((query) => String(query))
}

describe('Migration20260925153000 (deal defaults backfill)', () => {
  it('has no `?` (knex would bind it) and every insert is guarded', async () => {
    const sql = await collectSql()
    expect(sql).toHaveLength(5)
    for (const statement of sql) {
      expect(statement).not.toContain('?')
      expect(/not exists|on conflict/.test(statement)).toBe(true)
      expect(statement).toContain('"deleted_at" is null')
    }
  })

  it('seeds the shared default stages, statuses and currencies', async () => {
    const sql = (await collectSql()).join('\n')
    for (const stage of PIPELINE_STAGE_DEFAULTS) expect(sql).toContain(`'${stage.label}'`)
    for (const status of DEAL_STATUS_DEFAULTS) expect(sql).toContain(`'${status.value}'`)
    expect(sql).toContain("'Default Pipeline'")
    expect(sql).toContain("'USD'")
    expect(sql).toContain("'currency'")
  })
})
