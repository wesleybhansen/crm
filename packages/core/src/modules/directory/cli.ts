import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { getCliModules } from '@open-mercato/shared/modules/registry'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { CURRENT_TENANT_SEED_VERSION, ensureTenantSeeded } from '../auth/lib/provision-tenant'

/**
 * Platform tooling for one tenant per customer.
 *
 *   mercato directory tenants:list                      tenant, orgs, users, seed_version
 *   mercato directory tenants:reseed --tenant <uuid>    bring one tenant up to the current seed
 *   mercato directory tenants:reseed --unseeded         every tenant below the current seed version
 *   ... [--force]                                       re-run every (idempotent) step anyway
 *
 * Prints ids, names of organizations and counts only.
 */

type Row = Record<string, any>

function parseArgs(rest: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (!a?.startsWith('--')) continue
    const [k, v] = a.replace(/^--/, '').split('=')
    if (v !== undefined) args[k] = v
    else if (rest[i + 1] && !rest[i + 1]!.startsWith('--')) { args[k] = rest[i + 1]!; i++ }
    else args[k] = true
  }
  return args
}

async function hasSeedVersion(em: EntityManager): Promise<boolean> {
  const rows = (await em.execute(
    `select 1 from information_schema.columns where table_schema = current_schema() and table_name = 'tenants' and column_name = 'seed_version'`,
  )) as Row[]
  return rows.length > 0
}

const listTenants: ModuleCli = {
  command: 'tenants:list',
  async run() {
    const { resolve } = await createRequestContainer()
    const em = resolve<EntityManager>('em')
    const seeded = await hasSeedVersion(em)
    const tenants = (await em.execute(
      `select t.id::text as id, t.name, t.is_active, t.deleted_at is not null as deleted,
              ${seeded ? 't.seed_version' : 'null::int as seed_version'},
              (select count(*)::int from organizations o where o.tenant_id = t.id and o.deleted_at is null) as orgs,
              (select count(*)::int from users u where u.tenant_id = t.id and u.deleted_at is null) as users
         from tenants t order by t.created_at`,
    )) as Row[]
    const orgs = (await em.execute(
      `select o.tenant_id::text as tenant_id, o.id::text as id, o.name, o.noli_org_id is not null as linked
         from organizations o where o.deleted_at is null order by o.created_at`,
    )) as Row[]
    console.log(`tenants=${tenants.length} current_seed_version=${CURRENT_TENANT_SEED_VERSION}`)
    for (const t of tenants) {
      const state = t.deleted ? 'deleted' : t.is_active ? 'active' : 'inactive'
      console.log(`${t.id}  ${state}  seed=${t.seed_version ?? 'n/a'}  orgs=${t.orgs}  users=${t.users}  ${t.name}`)
      for (const o of orgs.filter((x) => x.tenant_id === t.id)) {
        console.log(`    org ${o.id}${o.linked ? ' (noli)' : ''}  ${o.name}`)
      }
    }
  },
}

const reseedTenants: ModuleCli = {
  command: 'tenants:reseed',
  async run(rest) {
    const args = parseArgs(rest)
    const tenantArg = typeof args.tenant === 'string' ? args.tenant : null
    const unseeded = args.unseeded === true
    const force = args.force === true
    if (!tenantArg && !unseeded) {
      console.error('Usage: mercato directory tenants:reseed (--tenant <uuid> | --unseeded) [--force]')
      return
    }
    const container = await createRequestContainer()
    const em = container.resolve<EntityManager>('em')
    if (!(await hasSeedVersion(em))) {
      console.error('tenants.seed_version is missing: run `mercato db migrate` first.')
      process.exitCode = 2
      return
    }
    const tenants = (await em.execute(
      tenantArg
        ? `select id::text as id, seed_version from tenants where id = ? and deleted_at is null`
        : `select id::text as id, seed_version from tenants where deleted_at is null and seed_version < ? order by created_at`,
      [tenantArg ?? CURRENT_TENANT_SEED_VERSION],
    )) as Row[]
    if (!tenants.length) {
      console.log('No tenant to seed.')
      return
    }
    const modules = getCliModules()
    const rbac = (() => {
      try {
        return container.resolve<{ invalidateTenantCache?: (tenantId: string) => Promise<void> }>('rbacService')
      } catch {
        return null
      }
    })()
    let failed = 0
    for (const t of tenants) {
      const orgs = (await em.execute(
        `select id::text as id from organizations where tenant_id = ? and deleted_at is null order by depth asc, created_at asc`,
        [t.id],
      )) as Row[]
      if (!orgs.length) {
        console.log(`${t.id}: no live organization, skipped`)
        continue
      }
      // The first org seeds the tenant; further orgs of the same tenant get
      // their per-org defaults with a forced (idempotent) re-run.
      for (let i = 0; i < orgs.length; i++) {
        const result = await ensureTenantSeeded(em.fork(), {
          tenantId: t.id,
          organizationId: orgs[i].id,
          modules,
          container: container as never,
          force: force || i > 0,
          log: (l) => console.log(`  ${l}`),
        })
        const status = result.failures.length
          ? `INCOMPLETE (${result.failures.map((f) => f.step).join(', ')})`
          : result.seeded ? 'seeded' : 'already current'
        console.log(`${t.id} org ${orgs[i].id}: ${status} (version ${result.version})`)
        if (result.failures.length) failed++
      }
      await rbac?.invalidateTenantCache?.(t.id)
    }
    if (failed) process.exitCode = 3
  },
}

export default [listTenants, reseedTenants]
