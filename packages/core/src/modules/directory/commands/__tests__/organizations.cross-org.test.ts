/* Two organisations in one tenant. A customer admin must never pull an
 * organisation it does not manage into its own subtree (which would widen
 * its access scope to it), neither as a child on create/update nor as a new
 * parent. Since each customer has its own tenant (CRM_TENANT_PER_CUSTOMER),
 * top-level organisations inside the actor's own tenant are its own to
 * create, move to and delete; another tenant is refused. */

jest.mock('#generated/entities.ids.generated', () => ({
  E: { directory: { organization: 'directory:organization', tenant: 'directory:tenant' } },
}))

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: async () => ({ translate: (_key: string, fallback?: string) => fallback ?? _key }),
}))

jest.mock('@open-mercato/core/modules/directory/lib/hierarchy', () => ({
  rebuildHierarchyForTenant: jest.fn(async () => undefined),
}))

import '@open-mercato/core/modules/directory/commands/organizations'
import { commandRegistry } from '@open-mercato/shared/lib/commands/registry'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'

const TENANT = '22560ecc-0000-4000-8000-000000000000'
const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const ORG_A1 = 'aaaaaaaa-0000-4000-8000-000000000002'
const ORG_B = 'bbbbbbbb-0000-4000-8000-000000000001'
const ORG_B1 = 'bbbbbbbb-0000-4000-8000-000000000002'

type OrgRow = {
  id: string
  tenant: { id: string }
  name: string
  slug: string | null
  isActive: boolean
  parentId: string | null
  ancestorIds: string[]
  childIds: string[]
  descendantIds: string[]
  deletedAt: Date | null
}

function org(id: string, parentId: string | null, extra: Partial<OrgRow> = {}): OrgRow {
  return {
    id,
    tenant: { id: TENANT },
    name: id,
    slug: id,
    isActive: true,
    parentId,
    ancestorIds: [],
    childIds: [],
    descendantIds: [],
    deletedAt: null,
    ...extra,
  }
}

function seed(): Map<string, OrgRow> {
  const rows = [
    org(ORG_A, null, { childIds: [ORG_A1], descendantIds: [ORG_A1] }),
    org(ORG_A1, ORG_A, { ancestorIds: [ORG_A] }),
    org(ORG_B, null, { childIds: [ORG_B1], descendantIds: [ORG_B1] }),
    org(ORG_B1, ORG_B, { ancestorIds: [ORG_B] }),
  ]
  return new Map(rows.map((row) => [row.id, row]))
}

function matches(row: OrgRow, filter: Record<string, unknown>): boolean {
  for (const [key, expected] of Object.entries(filter)) {
    const actual = key === 'tenant' ? row.tenant.id : (row as unknown as Record<string, unknown>)[key]
    if (expected && typeof expected === 'object' && '$in' in (expected as Record<string, unknown>)) {
      if (!((expected as { $in: unknown[] }).$in).includes(actual)) return false
      continue
    }
    if (expected === null) {
      if (actual !== null && actual !== undefined) return false
      continue
    }
    if (actual !== expected) return false
  }
  return true
}

function buildHarness(actor: { sub: string; orgId: string | null; superAdmin: boolean }) {
  const store = seed()
  let seq = 0
  const em = {
    fork: () => em,
    find: async (_entity: unknown, filter: Record<string, unknown>) =>
      Array.from(store.values()).filter((row) => matches(row, filter)),
    findOne: async (_entity: unknown, filter: Record<string, unknown>) =>
      Array.from(store.values()).find((row) => matches(row, filter)) ?? null,
    getReference: (_entity: unknown, id: string) => ({ id }),
    persistAndFlush: async () => undefined,
    flush: async () => undefined,
  }
  const dataEngine = {
    createOrmEntity: async ({ data }: { data: Record<string, unknown> }) => {
      seq += 1
      const id = `cccccccc-0000-4000-8000-00000000000${seq}`
      const row = org(id, (data.parentId as string | null) ?? null, {
        name: String(data.name),
        slug: (data.slug as string | null) ?? null,
      })
      store.set(id, row)
      return row
    },
    updateOrmEntity: async ({ where, apply }: { where: Record<string, unknown>; apply: (row: OrgRow) => void }) => {
      const row = Array.from(store.values()).find((r) => matches(r, where))
      if (!row) return null
      apply(row)
      return row
    },
    deleteOrmEntity: async ({ where }: { where: Record<string, unknown> }) => {
      const row = Array.from(store.values()).find((r) => matches(r, where))
      if (!row) return null
      row.deletedAt = new Date()
      return row
    },
    setCustomFields: async () => undefined,
    markOrmEntityChange: () => undefined,
    flushOrmEntityChanges: async () => undefined,
    emitOrmEntityEvent: async () => undefined,
  }
  const rbacService = {
    loadAcl: async () => ({
      isSuperAdmin: actor.superAdmin,
      features: ['directory.organizations.manage'],
      organizations: null,
    }),
  }
  const container = {
    resolve: (token: string) => {
      if (token === 'em') return em
      if (token === 'dataEngine') return dataEngine
      if (token === 'rbacService') return rbacService
      throw new Error(`Unexpected dependency: ${token}`)
    },
  }
  const ctx: CommandRuntimeContext = {
    container: container as never,
    auth: { sub: actor.sub, tenantId: TENANT, orgId: actor.orgId } as never,
    organizationScope: null,
    selectedOrganizationId: actor.orgId,
    organizationIds: actor.orgId ? [actor.orgId] : null,
    request: undefined as never,
  }
  return { store, ctx }
}

const customerA = { sub: 'user-a', orgId: ORG_A, superAdmin: false }
const superAdmin = { sub: 'root', orgId: null, superAdmin: true }

function handler(id: string) {
  const h = commandRegistry.get<Record<string, unknown>, unknown>(id) as CommandHandler<Record<string, unknown>, unknown>
  expect(h).toBeDefined()
  return h
}

async function expectForbidden(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({ status: 403 })
}

describe('directory.organizations: cross-customer adoption (two orgs, one tenant)', () => {
  it('create: refuses listing another customer\'s organization as a child', async () => {
    const { store, ctx } = buildHarness(customerA)
    await expectForbidden(
      handler('directory.organizations.create').execute({ name: 'Grab', parentId: ORG_A, childIds: [ORG_B] }, ctx),
    )
    expect(store.get(ORG_B)!.parentId).toBeNull()
    expect(store.size).toBe(4)
  })

  it('create: refuses another customer\'s sub-organization as a child', async () => {
    const { store, ctx } = buildHarness(customerA)
    await expectForbidden(
      handler('directory.organizations.create').execute({ name: 'Grab', parentId: ORG_A, childIds: [ORG_B1] }, ctx),
    )
    expect(store.get(ORG_B1)!.parentId).toBe(ORG_B)
  })

  it('create: refuses another customer\'s organization as the parent', async () => {
    const { ctx } = buildHarness(customerA)
    await expectForbidden(handler('directory.organizations.create').execute({ name: 'Nested', parentId: ORG_B }, ctx))
  })

  it('create: still allows re-homing the actor\'s own sub-organization', async () => {
    const { store, ctx } = buildHarness(customerA)
    const created = (await handler('directory.organizations.create').execute(
      { name: 'Region', parentId: ORG_A, childIds: [ORG_A1] },
      ctx,
    )) as OrgRow
    expect(created.parentId).toBe(ORG_A)
    expect(store.get(ORG_A1)!.parentId).toBe(created.id)
  })

  it('update: refuses adding another customer\'s organization as a child', async () => {
    const { store, ctx } = buildHarness(customerA)
    await expectForbidden(
      handler('directory.organizations.update').execute({ id: ORG_A, childIds: [ORG_A1, ORG_B] }, ctx),
    )
    expect(store.get(ORG_B)!.parentId).toBeNull()
  })

  it('update: refuses another customer\'s sub-organization as a child', async () => {
    const { store, ctx } = buildHarness(customerA)
    await expectForbidden(
      handler('directory.organizations.update').execute({ id: ORG_A1, parentId: ORG_A, childIds: [ORG_B1] }, ctx),
    )
    expect(store.get(ORG_B1)!.parentId).toBe(ORG_B)
  })

  it('update: refuses moving an own organization under another customer', async () => {
    const { store, ctx } = buildHarness(customerA)
    await expectForbidden(handler('directory.organizations.update').execute({ id: ORG_A1, parentId: ORG_B }, ctx))
    expect(store.get(ORG_A1)!.parentId).toBe(ORG_A)
  })

  it('update: refuses editing another customer\'s organization', async () => {
    const { ctx } = buildHarness(customerA)
    await expectForbidden(handler('directory.organizations.update').execute({ id: ORG_B, name: 'Mine now' }, ctx))
  })

  it('update: moves an own sub-organization to the top level of its own tenant', async () => {
    const { store, ctx } = buildHarness(customerA)
    await handler('directory.organizations.update').execute({ id: ORG_A1, parentId: null }, ctx)
    expect(store.get(ORG_A1)!.parentId).toBeNull()
  })

  it('create: allows a top-level organization in the own tenant, refuses another tenant', async () => {
    const { ctx } = buildHarness(customerA)
    const created = (await handler('directory.organizations.create').execute({ name: 'Second brand' }, ctx)) as OrgRow
    expect(created.parentId ?? null).toBeNull()
    await expectForbidden(
      handler('directory.organizations.create').execute(
        { name: 'Elsewhere', tenantId: '33333333-0000-4000-8000-000000000000' },
        ctx,
      ),
    )
  })

  it('update: a rename that omits parentId/childIds keeps the hierarchy', async () => {
    const { store, ctx } = buildHarness(customerA)
    await handler('directory.organizations.update').execute({ id: ORG_A, name: 'Renamed' }, ctx)
    expect(store.get(ORG_A)!.name).toBe('Renamed')
    expect(store.get(ORG_A1)!.parentId).toBe(ORG_A)
    await handler('directory.organizations.update').execute({ id: ORG_A1, name: 'Sub renamed' }, ctx)
    expect(store.get(ORG_A1)!.parentId).toBe(ORG_A)
  })

  it('delete: refuses another customer\'s organization, allows the own top-level one', async () => {
    const { store, ctx } = buildHarness(customerA)
    const del = handler('directory.organizations.delete')
    await expectForbidden(del.execute({ body: { id: ORG_B1 }, query: {} } as never, ctx))
    expect(store.get(ORG_B1)!.deletedAt).toBeNull()
    await del.execute({ body: { id: ORG_A }, query: {} } as never, ctx)
    expect(store.get(ORG_A)!.deletedAt).not.toBeNull()
  })

  it('super admin may still restructure across organizations', async () => {
    const { store, ctx } = buildHarness(superAdmin)
    await handler('directory.organizations.update').execute({ id: ORG_A, parentId: null, childIds: [ORG_A1, ORG_B1] }, ctx)
    expect(store.get(ORG_B1)!.parentId).toBe(ORG_A)
  })
})
