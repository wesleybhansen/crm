import { previousTenantIdsForOrganization, resetTenantMovesCacheForTests, resolveCurrentTenantForOrganization, type TenantMoveSql } from '../tenantMoves'

const ORG = 'aaaaaaaa-0000-4000-8000-000000000001'
const OLD = '22560ecc-0000-4000-8000-000000000000'
const NEW = '99999999-0000-4000-8000-000000000001'
const OTHER = '77777777-0000-4000-8000-000000000001'

function fakeSql(state: { table: boolean; orgTenant: string | null; moves: string[] }): TenantMoveSql {
  return async (sql) => {
    if (sql.includes('to_regclass')) return [{ t: state.table ? 'organization_tenant_moves' : null }]
    if (sql.includes('from organizations')) return state.orgTenant ? [{ tenant_id: state.orgTenant }] : []
    if (sql.includes('from organization_tenant_moves')) return state.moves.map((from_tenant_id) => ({ from_tenant_id }))
    throw new Error(`unexpected sql ${sql}`)
  }
}

describe('tenant move lookups', () => {
  beforeEach(() => resetTenantMovesCacheForTests())

  it('maps a claim naming the org\'s previous tenant to its current tenant', async () => {
    const sql = fakeSql({ table: true, orgTenant: NEW, moves: [OLD] })
    expect(await resolveCurrentTenantForOrganization(sql, ORG, OLD)).toBe(NEW)
    expect(await resolveCurrentTenantForOrganization(sql, ORG, NEW)).toBe(NEW)
  })

  it('never maps a tenant the org did not move from', async () => {
    const sql = fakeSql({ table: true, orgTenant: NEW, moves: [OLD] })
    expect(await resolveCurrentTenantForOrganization(sql, ORG, OTHER)).toBe(OTHER)
  })

  it('is a no-op before the migration (no table) and for unknown orgs', async () => {
    expect(await previousTenantIdsForOrganization(fakeSql({ table: false, orgTenant: NEW, moves: [OLD] }), ORG)).toEqual([])
    resetTenantMovesCacheForTests()
    expect(await resolveCurrentTenantForOrganization(fakeSql({ table: true, orgTenant: null, moves: [] }), ORG, OLD)).toBe(OLD)
  })
})
