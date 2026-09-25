/**
 * One tenant per customer, against a real Postgres: createCustomerTenant,
 * ensureTenantSeeded (idempotent, serialized) and the Clerk sign-in path with
 * CRM_TENANT_PER_CUSTOMER=1 (own tenant per Noli org, no shared-tenant
 * fallback, N teammates signing in at once get ONE tenant and ONE org).
 *
 * Runs only when TENANT_TEST_DATABASE_URL (or CUSTOMER_SEARCH_TEST_DATABASE_URL)
 * points at a disposable database; each run works in its own schema and drops
 * it. Skipped otherwise.
 *
 *   TENANT_TEST_DATABASE_URL=postgres://localhost:5432/crmtest yarn jest provision-tenant.pg
 */
import crypto from 'crypto'
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql'
import * as authEntities from '../../data/entities'
import * as directoryEntities from '../../../directory/data/entities'
import * as entitiesEntities from '../../../entities/data/entities'
import { registerModules } from '@open-mercato/shared/lib/modules/registry'
import type { Module } from '@open-mercato/shared/modules/registry'
import { TENANT_SPLIT_SCHEMA_SQL } from '../../../directory/lib/tenantSplitSchema'
import {
  CURRENT_TENANT_SEED_VERSION,
  createCustomerTenant,
  ensureTenantSeeded,
} from '../provision-tenant'

const URL = process.env.TENANT_TEST_DATABASE_URL || process.env.CUSTOMER_SEARCH_TEST_DATABASE_URL
const d = URL ? describe : describe.skip

const schema = `tpc_${crypto.randomBytes(4).toString('hex')}`
let orm: MikroORM

// Noli core: every Clerk id is an entitled user; teammates share one Noli org.
const noliOrgOf = new Map<string, string | null>()
jest.mock('@open-mercato/shared/lib/noli/core-client', () => ({
  findUserByClerkId: async (clerkUserId: string) => ({
    id: `noli-${clerkUserId}`,
    clerk_user_id: clerkUserId,
    email: `${clerkUserId}@example.com`,
    first_name: clerkUserId,
    last_name: null,
  }),
  isEntitled: async () => true,
  findPrimaryOrgIdForUser: async (noliUserId: string) => noliOrgOf.get(noliUserId.replace(/^noli-/, '')) ?? null,
}))
jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: async () => ({
    resolve: (name: string) => {
      if (name === 'em') return orm.em.fork()
      throw new Error(`not registered: ${name}`)
    },
  }),
}))

const seedCalls: string[] = []
const testModules: Module[] = [
  { id: 'auth', setup: { defaultRoleFeatures: { superadmin: ['directory.tenants.*'], admin: ['auth.*'], employee: ['auth.view'] } } } as Module,
  {
    id: 'demo',
    setup: {
      defaultRoleFeatures: { admin: ['demo.*'] },
      seedDefaults: async ({ em, tenantId, organizationId }: any) => {
        seedCalls.push(`${tenantId}:${organizationId}`)
        // Idempotent structural default, like the real modules.
        await em.execute(
          `insert into demo_defaults (tenant_id, organization_id) values (?, ?) on conflict do nothing`,
          [tenantId, organizationId],
        )
      },
    },
  } as unknown as Module,
]

const entityClasses = (mod: Record<string, unknown>) => Object.values(mod).filter((v) => typeof v === 'function') as any[]

d('one tenant per customer (Postgres)', () => {
  const prevFlag = process.env.CRM_TENANT_PER_CUSTOMER
  const prevNoliTenant = process.env.NOLI_TENANT_ID

  beforeAll(async () => {
    const { Pool } = await import('pg')
    const bootstrap = new Pool({ connectionString: URL, max: 1 })
    await bootstrap.query(`create schema ${schema}`)
    await bootstrap.end()
    orm = await MikroORM.init({
      clientUrl: URL,
      driverOptions: { connection: { options: `-c search_path=${schema}` } },
      entities: [...entityClasses(authEntities), ...entityClasses(directoryEntities), ...entityClasses(entitiesEntities)],
      discovery: { warnWhenNoEntities: false },
      pool: { min: 1, max: 12 },
      debug: false,
      allowGlobalContext: true,
    })
    await orm.schema.createSchema()
    const conn = orm.em.getConnection()
    for (const sql of TENANT_SPLIT_SCHEMA_SQL) await conn.execute(sql)
    await conn.execute(`create table feature_toggle_overrides (id uuid primary key default gen_random_uuid(), toggle_id uuid not null,
      tenant_id uuid not null, value jsonb not null, created_at timestamptz not null, updated_at timestamptz not null,
      unique (toggle_id, tenant_id))`)
    await conn.execute(`create table demo_defaults (tenant_id uuid not null, organization_id uuid not null, primary key (tenant_id, organization_id))`)
    registerModules(testModules)
  })

  afterAll(async () => {
    await orm?.close(true)
    const { Pool } = await import('pg')
    const pool = new Pool({ connectionString: URL, max: 1 })
    await pool.query(`drop schema if exists ${schema} cascade`)
    await pool.end()
    if (prevFlag === undefined) delete process.env.CRM_TENANT_PER_CUSTOMER
    else process.env.CRM_TENANT_PER_CUSTOMER = prevFlag
    if (prevNoliTenant === undefined) delete process.env.NOLI_TENANT_ID
    else process.env.NOLI_TENANT_ID = prevNoliTenant
  })

  const q = async (sql: string, params: unknown[] = []) => (await orm.em.getConnection().execute(sql, params)) as any[]
  const n = async (sql: string, params: unknown[] = []) => Number((await q(sql, params))[0]?.n ?? 0)

  it('ensureTenantSeeded runs once, is idempotent, and never grants a super-admin ACL', async () => {
    const em = orm.em.fork() as EntityManager
    let ids: { tenantId: string; orgId: string } = { tenantId: '', orgId: '' }
    await em.transactional(async (tem) => {
      const { tenant, organization } = await createCustomerTenant(tem as EntityManager, { name: 'Acme', noliOrgId: 'noli-acme' })
      ids = { tenantId: String(tenant.id), orgId: String(organization.id) }
    })
    expect(await n(`select seed_version as n from tenants where id = ?`, [ids.tenantId])).toBe(0)

    const toggle = crypto.randomUUID()
    const template = crypto.randomUUID()
    await q(`insert into feature_toggle_overrides (toggle_id, tenant_id, value, created_at, updated_at) values (?, ?, '"on"', now(), now())`, [toggle, template])

    seedCalls.length = 0
    const first = await ensureTenantSeeded(orm.em.fork() as EntityManager, {
      tenantId: ids.tenantId, organizationId: ids.orgId, modules: testModules, templateTenantId: template,
    })
    expect(first).toMatchObject({ seeded: true, version: CURRENT_TENANT_SEED_VERSION, failures: [] })
    expect(seedCalls).toEqual([`${ids.tenantId}:${ids.orgId}`])

    const snapshot = async () => ({
      roles: await n(`select count(*)::int as n from roles where tenant_id = ?`, [ids.tenantId]),
      acls: await n(`select count(*)::int as n from role_acls where tenant_id = ?`, [ids.tenantId]),
      superAcls: await n(`select count(*)::int as n from role_acls where tenant_id = ? and is_super_admin`, [ids.tenantId]),
      maps: await n(`select count(*)::int as n from encryption_maps where tenant_id = ? and organization_id = ?`, [ids.tenantId, ids.orgId]),
      toggles: await n(`select count(*)::int as n from feature_toggle_overrides where tenant_id = ?`, [ids.tenantId]),
      defaults: await n(`select count(*)::int as n from demo_defaults where tenant_id = ?`, [ids.tenantId]),
    })
    const after1 = await snapshot()
    expect(after1).toMatchObject({ roles: 3, superAcls: 0, toggles: 1, defaults: 1 })
    expect(after1.acls).toBeGreaterThanOrEqual(2) // admin + employee
    expect(after1.maps).toBeGreaterThan(0)

    // Second run: version is current, nothing runs, nothing changes.
    const second = await ensureTenantSeeded(orm.em.fork() as EntityManager, {
      tenantId: ids.tenantId, organizationId: ids.orgId, modules: testModules, templateTenantId: template,
    })
    expect(second.seeded).toBe(false)
    expect(seedCalls).toHaveLength(1)
    // Forced re-run: every step again, still no change (idempotent steps).
    await ensureTenantSeeded(orm.em.fork() as EntityManager, {
      tenantId: ids.tenantId, organizationId: ids.orgId, modules: testModules, templateTenantId: template, force: true,
    })
    expect(await snapshot()).toEqual(after1)
  })

  it('concurrent seeders of one tenant run the seed exactly once', async () => {
    const em = orm.em.fork() as EntityManager
    let ids = { tenantId: '', orgId: '' }
    await em.transactional(async (tem) => {
      const { tenant, organization } = await createCustomerTenant(tem as EntityManager, { name: 'Parallel', noliOrgId: null })
      ids = { tenantId: String(tenant.id), orgId: String(organization.id) }
    })
    seedCalls.length = 0
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        ensureTenantSeeded(orm.em.fork() as EntityManager, { tenantId: ids.tenantId, organizationId: ids.orgId, modules: testModules, templateTenantId: null }),
      ),
    )
    expect(results.filter((r) => r.seeded)).toHaveLength(1)
    expect(seedCalls).toEqual([`${ids.tenantId}:${ids.orgId}`])
    expect(await n(`select seed_version as n from tenants where id = ?`, [ids.tenantId])).toBe(CURRENT_TENANT_SEED_VERSION)
  })

  it('sign-in with the flag on: N teammates at once get one tenant, one org, N users, seeded; no shared-tenant fallback', async () => {
    process.env.CRM_TENANT_PER_CUSTOMER = '1'
    // A legacy shared tenant exists and NOLI_TENANT_ID points at it: the
    // per-customer path must ignore both.
    const shared = (await q(`insert into tenants (name, is_active, created_at, updated_at) values ('Noli', true, now(), now()) returning id`))[0].id
    process.env.NOLI_TENANT_ID = shared
    const { resolveClerkUserToAuthContext, resetSeededTenantCacheForTests } = await import('@open-mercato/shared/lib/auth/clerk')
    resetSeededTenantCacheForTests()

    const team = Array.from({ length: 5 }, (_, i) => `clerk_team_${i}`)
    for (const id of team) noliOrgOf.set(id, 'noli-org-team')
    const auths = await Promise.all(team.map((id) => resolveClerkUserToAuthContext(id)))
    expect(auths.every(Boolean)).toBe(true)
    const tenantIds = new Set(auths.map((a) => a!.tenantId))
    const orgIds = new Set(auths.map((a) => a!.orgId))
    expect(tenantIds.size).toBe(1)
    expect(orgIds.size).toBe(1)
    const [tenantId] = [...tenantIds]
    expect(tenantId).not.toBe(shared)
    expect(await n(`select count(*)::int as n from organizations where noli_org_id = 'noli-org-team'`)).toBe(1)
    expect(await n(`select count(*)::int as n from users where tenant_id = ?`, [tenantId])).toBe(5)
    expect(await n(`select count(*)::int as n from users where tenant_id = ?`, [shared])).toBe(0)
    // Only the winner's tenant survived: the losers' tenants rolled back with their transactions.
    expect(await n(`select count(*)::int as n from tenants t where not exists (select 1 from organizations o where o.tenant_id = t.id) and t.id <> ?`, [shared])).toBe(0)
    expect(await n(`select seed_version as n from tenants where id = ?`, [tenantId])).toBe(CURRENT_TENANT_SEED_VERSION)
    for (const auth of auths) expect(auth!.roles).toEqual(['admin'])
    // Every teammate's role is the tenant's own admin role.
    expect(await n(
      `select count(*)::int as n from user_roles ur join roles r on r.id = ur.role_id join users u on u.id = ur.user_id
        where u.tenant_id = ? and r.tenant_id = ? and r.name = 'admin'`, [tenantId, tenantId],
    )).toBe(5)

    // A second Noli org gets a different tenant.
    noliOrgOf.set('clerk_other', 'noli-org-other')
    const other = await resolveClerkUserToAuthContext('clerk_other')
    expect(other?.tenantId).toBeTruthy()
    expect(other?.tenantId).not.toBe(tenantId)
    expect(other?.tenantId).not.toBe(shared)

    // No Noli org at all: a personal tenant, and two parallel first sign-ins
    // of the same Clerk user still produce one user and one tenant.
    noliOrgOf.set('clerk_solo', null)
    const [s1, s2] = await Promise.all([resolveClerkUserToAuthContext('clerk_solo'), resolveClerkUserToAuthContext('clerk_solo')])
    expect(s1?.userId).toBe(s2?.userId)
    expect(await n(`select count(*)::int as n from users where clerk_user_id = 'clerk_solo'`)).toBe(1)
    expect(await n(`select count(*)::int as n from tenants t where not exists (select 1 from organizations o where o.tenant_id = t.id) and t.id <> ?`, [shared])).toBe(0)
  })

  it('maintenance mode: sign-in never provisions', async () => {
    process.env.CRM_TENANT_PER_CUSTOMER = '1'
    process.env.MAINTENANCE = '1'
    try {
      const { resolveClerkUserToAuthContext } = await import('@open-mercato/shared/lib/auth/clerk')
      noliOrgOf.set('clerk_during_maintenance', 'noli-org-maint')
      expect(await resolveClerkUserToAuthContext('clerk_during_maintenance')).toBeNull()
      expect(await n(`select count(*)::int as n from organizations where noli_org_id = 'noli-org-maint'`)).toBe(0)
    } finally {
      delete process.env.MAINTENANCE
    }
  })

  it('flag off keeps the legacy shared tenant (NOLI_TENANT_ID)', async () => {
    delete process.env.CRM_TENANT_PER_CUSTOMER
    const shared = process.env.NOLI_TENANT_ID!
    const { resolveClerkUserToAuthContext } = await import('@open-mercato/shared/lib/auth/clerk')
    noliOrgOf.set('clerk_legacy', 'noli-org-legacy')
    const auth = await resolveClerkUserToAuthContext('clerk_legacy')
    expect(auth?.tenantId).toBe(shared)
  })
})
