/* Tenant-wide rows that every Noli customer in the shared tenant uses
 * (tenants, roles, price kinds) may only be written by a super admin. A
 * customer admin (non-super) is refused before anything is written. */

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
const PRICE_KIND = 'cccccccc-0000-4000-8000-000000000001'

function ctxFor(superAdmin: boolean) {
  const writes: string[] = []
  const em = {
    fork: () => em,
    findOne: async () => ({ id: PRICE_KIND, tenantId: TENANT, organizationId: null, code: 'retail', title: 'Retail' }),
    find: async () => [],
    count: async () => 0,
    getReference: (_e: unknown, id: string) => ({ id }),
    persist: () => { writes.push('persist') },
    persistAndFlush: async () => { writes.push('persistAndFlush') },
    flush: async () => { writes.push('flush') },
    remove: () => { writes.push('remove') },
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

const cases: Array<[string, unknown]> = [
  ['auth.roles.create', { name: 'sales-lead' }],
  ['auth.roles.create', { name: 'global-role', tenantId: null }],
  ['directory.tenants.create', { name: 'Another tenant' }],
  ['directory.tenants.update', { id: TENANT, name: 'Renamed', isActive: false }],
  ['directory.tenants.delete', { body: { id: TENANT }, query: {} }],
  ['catalog.priceKinds.create', { tenantId: TENANT, code: 'vip', title: 'VIP', displayMode: 'excluding-tax' }],
  ['catalog.priceKinds.update', { id: PRICE_KIND, title: 'Hijacked', isActive: false }],
  ['catalog.priceKinds.delete', { body: { id: PRICE_KIND }, query: {} }],
]

describe('tenant-wide rows are super-admin only in the shared tenant', () => {
  it.each(cases)('%s is refused for a customer admin', async (id, input) => {
    const { ctx, writes } = ctxFor(false)
    await expect(run(id, input, ctx)).rejects.toMatchObject({ status: 403 })
    expect(writes).toEqual([])
  })

  it('a super admin passes the guard (role create)', async () => {
    const { ctx, writes } = ctxFor(true)
    await run('auth.roles.create', { name: 'sales-lead' }, ctx)
    expect(writes).toContain('create')
  })
})
