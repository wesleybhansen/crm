/* One tenant per customer (CRM_TENANT_PER_CUSTOMER): tenant-wide rows of the
 * caller's own tenant (roles, price kinds) are that customer's to manage, so
 * its admin may write them. Rows of another tenant, global rows (tenantId
 * null) and the tenants themselves stay super-admin only, and a refused
 * write happens before anything is written. */

jest.mock('#generated/entities.ids.generated', () => ({
  E: {
    auth: { user: 'auth:user', role: 'auth:role' },
    directory: { organization: 'directory:organization', tenant: 'directory:tenant' },
    catalog: { catalog_price_kind: 'catalog:catalog_price_kind' },
  },
}))

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: async () => ({ translate: (_key: string, fallback?: string) => fallback ?? _key }),
}))

import '@open-mercato/core/modules/auth/commands/roles'
import '@open-mercato/core/modules/directory/commands/tenants'
import '@open-mercato/core/modules/catalog/commands/priceKinds'
import { commandRegistry } from '@open-mercato/shared/lib/commands/registry'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'

const TENANT = '22560ecc-0000-4000-8000-000000000000'
const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const OTHER_TENANT = '33333333-0000-4000-8000-000000000000'
const PRICE_KIND = 'cccccccc-0000-4000-8000-000000000001'
const ROLE = 'dddddddd-0000-4000-8000-000000000001'

function ctxFor(superAdmin: boolean, rowTenant: string | null = TENANT) {
  const writes: string[] = []
  const em = {
    fork: () => em,
    findOne: async () => ({ id: PRICE_KIND, tenantId: rowTenant, organizationId: null, code: 'retail', title: 'Retail', name: 'sales' }),
    find: async () => [],
    count: async () => 0,
    getReference: (_e: unknown, id: string) => ({ id }),
    persist: () => { writes.push('persist') },
    persistAndFlush: async () => { writes.push('persistAndFlush') },
    flush: async () => { writes.push('flush') },
    remove: () => { writes.push('remove') },
    nativeDelete: async () => { writes.push('nativeDelete'); return 0 },
    create: (_e: unknown, data: unknown) => data,
  }
  const dataEngine = {
    createOrmEntity: async () => { writes.push('create'); return { id: 'new' } },
    updateOrmEntity: async () => { writes.push('update'); return { id: 'x' } },
    deleteOrmEntity: async () => { writes.push('delete'); return { id: 'x' } },
    setCustomFields: async () => undefined,
    markOrmEntityChange: () => undefined,
    flushOrmEntityChanges: async () => undefined,
  }
  const container = {
    resolve: (token: string) => {
      if (token === 'em') return em
      if (token === 'dataEngine') return dataEngine
      if (token === 'rbacService') return { loadAcl: async () => ({ isSuperAdmin: superAdmin, features: ['*'], organizations: null }) }
      throw new Error(`Unexpected dependency: ${token}`)
    },
  }
  const ctx: CommandRuntimeContext = {
    container: container as never,
    auth: { sub: superAdmin ? 'root' : 'admin-a', tenantId: TENANT, orgId: superAdmin ? null : ORG_A } as never,
    organizationScope: null,
    selectedOrganizationId: ORG_A,
    organizationIds: [ORG_A],
    request: undefined as never,
  }
  return { ctx, writes }
}

function run(id: string, input: unknown, ctx: CommandRuntimeContext) {
  const handler = commandRegistry.get(id) as CommandHandler<unknown, unknown>
  expect(handler).toBeDefined()
  return handler.execute(input as never, ctx)
}

const refused: Array<[string, unknown, string | null]> = [
  ['auth.roles.create', { name: 'global-role', tenantId: null }, TENANT],
  ['auth.roles.create', { name: 'foreign-role', tenantId: OTHER_TENANT }, TENANT],
  ['auth.roles.update', { id: ROLE, name: 'renamed' }, OTHER_TENANT],
  ['auth.roles.update', { id: ROLE, name: 'renamed' }, null],
  ['auth.roles.update', { id: ROLE, tenantId: OTHER_TENANT }, TENANT],
  ['auth.roles.delete', { body: { id: ROLE }, query: {} }, OTHER_TENANT],
  ['auth.roles.delete', { body: { id: ROLE }, query: {} }, null],
  ['directory.tenants.create', { name: 'Another tenant' }, TENANT],
  ['directory.tenants.update', { id: TENANT, name: 'Renamed', isActive: false }, TENANT],
  ['directory.tenants.delete', { body: { id: TENANT }, query: {} }, TENANT],
  ['catalog.priceKinds.create', { tenantId: OTHER_TENANT, code: 'vip', title: 'VIP', displayMode: 'excluding-tax' }, TENANT],
  ['catalog.priceKinds.update', { id: PRICE_KIND, title: 'Hijacked', isActive: false }, OTHER_TENANT],
  ['catalog.priceKinds.delete', { body: { id: PRICE_KIND }, query: {} }, OTHER_TENANT],
]

describe('tenant-wide rows: own tenant for its admin, everything else super-admin only', () => {
  it.each(refused)('%s is refused for a customer admin (%j)', async (id, input, rowTenant) => {
    const { ctx, writes } = ctxFor(false, rowTenant)
    await expect(run(id, input, ctx)).rejects.toMatchObject({ status: 403 })
    expect(writes).toEqual([])
  })

  it('a customer admin creates a role in its own tenant (TC-AUTH-012)', async () => {
    const { ctx, writes } = ctxFor(false)
    await run('auth.roles.create', { name: 'sales-lead' }, ctx)
    expect(writes).toContain('create')
  })

  it('a customer admin names its own tenant explicitly', async () => {
    const { ctx, writes } = ctxFor(false)
    await run('auth.roles.create', { name: 'sales-lead', tenantId: TENANT }, ctx)
    expect(writes).toContain('create')
  })

  it('a customer admin renames and deletes a role of its own tenant', async () => {
    const renamed = ctxFor(false)
    await run('auth.roles.update', { id: ROLE, name: 'renamed' }, renamed.ctx).catch(() => undefined)
    expect(renamed.writes).toContain('update')
    const removed = ctxFor(false)
    await run('auth.roles.delete', { body: { id: ROLE }, query: {} }, removed.ctx).catch(() => undefined)
    expect(removed.writes).toContain('delete')
  })

  it('a super admin passes the guard for a global role', async () => {
    const { ctx, writes } = ctxFor(true)
    await run('auth.roles.create', { name: 'global-role', tenantId: null }, ctx)
    expect(writes).toContain('create')
  })
})
