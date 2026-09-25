import type { EntityManager } from '@mikro-orm/postgresql'
import type { AwilixContainer } from 'awilix'
import type { Module } from '@open-mercato/shared/modules/registry'
import { Tenant, Organization } from '../../directory/data/entities'
import { Role } from '../data/entities'
import { EncryptionMap } from '../../entities/data/entities'
import { DEFAULT_ENCRYPTION_MAPS } from '../../entities/lib/encryptionDefaults'
import { createKmsService } from '@open-mercato/shared/lib/encryption/kms'
import { isTenantDataEncryptionEnabled } from '@open-mercato/shared/lib/encryption/toggles'
import { templateTenantId as envTemplateTenantId } from '@open-mercato/shared/lib/runtime/tenancy'
import { ensureDefaultRoleAcls, seedTenantBaseline } from './setup-app'

/**
 * One tenant per Noli customer.
 *
 * createCustomerTenant  inserts the tenant and its first organization inside
 *                       the caller's transaction, so a sign-in that fails
 *                       part-way leaves neither behind (and the loser of a
 *                       concurrent first sign-in rolls its tenant back too).
 * ensureTenantSeeded    brings a tenant up to CURRENT_TENANT_SEED_VERSION:
 *                       roles and role ACLs, encryption maps, feature toggle
 *                       overrides, every module's seedDefaults (never
 *                       seedExamples), onTenantCreated hooks, the org
 *                       hierarchy and the tenant key. Idempotent; concurrent
 *                       callers are serialized on an advisory lock (see
 *                       withTenantSeedLock) and the version is stored in
 *                       tenants.seed_version, so a crash between provisioning
 *                       and seeding heals on the next sign-in.
 *
 * tenants.seed_version is read and written with raw SQL only (it is not an
 * entity property), so deploying this code before the migration has run
 * cannot break every Tenant query.
 */

/** Bump when the seeding steps change in a way existing tenants must receive. */
export const CURRENT_TENANT_SEED_VERSION = 1

export const DEFAULT_TENANT_ROLE_NAMES = ['superadmin', 'admin', 'employee'] as const

export type CreateCustomerTenantInput = {
  name: string
  noliOrgId: string | null
  /**
   * Enabled modules. When given, the default role ACLs (admin, employee;
   * never super-admin) are written in the same transaction as the roles, so
   * a seed that fails after commit can never leave the first admin with a
   * role that grants nothing (2026-09-25 review, M5).
   */
  modules?: Module[]
}

export async function createCustomerTenant(
  tem: EntityManager,
  input: CreateCustomerTenantInput,
): Promise<{ tenant: Tenant; organization: Organization }> {
  const name = (input.name || '').trim() || 'Workspace'
  const now = new Date()
  const tenant = tem.create(Tenant, {
    name,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  })
  tem.persist(tenant)
  await tem.flush()
  const organization = tem.create(Organization, {
    name,
    tenant,
    noliOrgId: input.noliOrgId ?? null,
    isActive: true,
    depth: 0,
    ancestorIds: [],
    childIds: [],
    descendantIds: [],
    createdAt: now,
    updatedAt: now,
  })
  tem.persist(organization)
  await tem.flush()
  // The admin role must exist before the user is granted it in the same
  // transaction, and so must its ACL: a role with no ACL grants nothing.
  // ensureTenantSeeded re-applies the ACLs after commit (idempotent).
  await ensureTenantRoles(tem, String(tenant.id))
  if (input.modules?.length) {
    await ensureDefaultRoleAcls(tem, String(tenant.id), input.modules, { includeSuperadminRole: false })
    await tem.flush()
  }
  return { tenant, organization }
}

/**
 * Create the default roles inside one tenant. Unlike setup-app's
 * ensureRolesInContext this never adopts a global (tenant_id null) role:
 * adopting one would move it, and every user linked to it, into this tenant.
 */
export async function ensureTenantRoles(
  tem: EntityManager,
  tenantId: string,
  names: readonly string[] = DEFAULT_TENANT_ROLE_NAMES,
): Promise<Role[]> {
  const out: Role[] = []
  for (const name of names) {
    let role = await tem.findOne(Role, { name, tenantId })
    if (!role) {
      role = tem.create(Role, { name, tenantId, createdAt: new Date() })
      tem.persist(role)
    }
    out.push(role)
  }
  await tem.flush()
  return out
}

export type EnsureTenantSeededOptions = {
  tenantId: string
  organizationId: string
  modules: Module[]
  container?: AwilixContainer | null
  /** Tenant whose feature-toggle overrides are copied. Defaults to CRM_TENANT_TEMPLATE_ID. */
  templateTenantId?: string | null
  /** Re-run every step even when the stored version is current. */
  force?: boolean
  log?: (line: string) => void
}

export type EnsureTenantSeededResult = {
  tenantId: string
  seeded: boolean
  version: number
  failures: Array<{ step: string; error: string }>
}

type Row = Record<string, unknown>

async function readSeedVersion(em: EntityManager, tenantId: string): Promise<number | null> {
  // em.execute (not getConnection().execute) so a transactional em reads
  // inside its own transaction.
  const rows = (await em.execute(
    'select seed_version from tenants where id = ? and deleted_at is null',
    [tenantId],
  )) as Row[]
  if (!rows.length) return null
  return Number(rows[0].seed_version ?? 0)
}

/** Cheap check for the sign-in path: true when the tenant still needs seeding. */
export async function tenantNeedsSeeding(em: EntityManager, tenantId: string): Promise<boolean> {
  const version = await readSeedVersion(em, tenantId)
  return version !== null && version < CURRENT_TENANT_SEED_VERSION
}

async function ensureEncryptionMaps(tem: EntityManager, tenantId: string, organizationId: string): Promise<void> {
  if (!isTenantDataEncryptionEnabled()) return
  for (const spec of DEFAULT_ENCRYPTION_MAPS) {
    const existing = await tem.findOne(EncryptionMap, {
      entityId: spec.entityId,
      tenantId,
      organizationId,
      deletedAt: null,
    })
    if (existing) continue
    tem.persist(
      tem.create(EncryptionMap, {
        entityId: spec.entityId,
        tenantId,
        organizationId,
        fieldsJson: spec.fields,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    )
  }
  await tem.flush()
}

async function copyFeatureToggleOverrides(tem: EntityManager, fromTenantId: string | null, toTenantId: string): Promise<number> {
  if (!fromTenantId || fromTenantId === toTenantId) return 0
  const rows = (await tem.execute(
    `insert into feature_toggle_overrides (id, toggle_id, tenant_id, value, created_at, updated_at)
     select gen_random_uuid(), o.toggle_id, ?, o.value, now(), now()
       from feature_toggle_overrides o
      where o.tenant_id = ?
        and not exists (select 1 from feature_toggle_overrides x where x.toggle_id = o.toggle_id and x.tenant_id = ?)
     returning id`,
    [toTenantId, fromTenantId, toTenantId],
  )) as Row[]
  return rows.length
}

function errorText(err: unknown): string {
  const e = err as { message?: string; code?: string }
  return [e?.code, e?.message].filter(Boolean).join(' ') || String(err)
}

type LockConnection = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }> }

const SEED_LOCK_WAIT_MS = 120_000
const SEED_LOCK_POLL_MS = 150

/**
 * Hold a session-level advisory lock for one tenant's seeding on a dedicated
 * pooled connection. Seeding itself runs outside any wrapping transaction on
 * purpose: several modules' seedDefaults write through the global knex, which
 * would block forever on rows an enclosing, uncommitted transaction inserted.
 * Waiters poll with pg_try_advisory_lock and give the connection back between
 * tries, so a burst of teammates signing in cannot drain the pool.
 */
async function withTenantSeedLock<T>(
  em: EntityManager,
  tenantId: string,
  isDone: () => Promise<boolean>,
  fn: () => Promise<T>,
): Promise<{ ran: true; value: T } | { ran: false }> {
  const client = (em.getKnex() as unknown as { client: { acquireConnection(): Promise<LockConnection>; releaseConnection(c: LockConnection): Promise<void> } }).client
  const key = `seed:${tenantId}`
  const deadline = Date.now() + SEED_LOCK_WAIT_MS
  for (;;) {
    const conn = await client.acquireConnection()
    let locked = false
    try {
      const res = await conn.query('select pg_try_advisory_lock(hashtext($1)) as locked', [key])
      locked = res.rows[0]?.locked === true
      if (locked) {
        try {
          if (await isDone()) return { ran: false }
          return { ran: true, value: await fn() }
        } finally {
          await conn.query('select pg_advisory_unlock(hashtext($1))', [key]).catch(() => {})
        }
      }
    } finally {
      await client.releaseConnection(conn)
    }
    if (await isDone()) return { ran: false }
    if (Date.now() > deadline) throw new Error(`TENANT_SEED_LOCK_TIMEOUT:${tenantId}`)
    await new Promise((resolve) => setTimeout(resolve, SEED_LOCK_POLL_MS))
  }
}

export async function ensureTenantSeeded(
  em: EntityManager,
  options: EnsureTenantSeededOptions,
): Promise<EnsureTenantSeededResult> {
  const { tenantId, organizationId, modules } = options
  const log = options.log ?? (() => {})
  const current = await readSeedVersion(em, tenantId)
  if (current === null) throw new Error(`TENANT_NOT_FOUND:${tenantId}`)
  if (!options.force && current >= CURRENT_TENANT_SEED_VERSION) {
    return { tenantId, seeded: false, version: current, failures: [] }
  }

  const failures: Array<{ step: string; error: string }> = []
  const isDone = async () => {
    if (options.force) return false
    const v = await readSeedVersion(em.fork(), tenantId)
    return v !== null && v >= CURRENT_TENANT_SEED_VERSION
  }

  const outcome = await withTenantSeedLock(em, tenantId, isDone, async () => {
    const work = em.fork()
    // A failing optional step is reported, not fatal; the version is only
    // bumped when every step succeeded, so the next sign-in retries.
    const step = async (name: string, fn: (sem: EntityManager) => Promise<void>) => {
      try {
        await fn(work)
        await work.flush()
      } catch (err) {
        failures.push({ step: name, error: errorText(err) })
        console.error(`[tenant-seed] step ${name} failed for tenant ${tenantId}: ${errorText(err)}`)
        work.clear()
      }
    }

    // 1. Roles (tenant-scoped; never the global tenantId=null ones) and
    // 2. encryption maps, before anything that writes encrypted rows.
    await work.transactional(async (tem) => {
      await ensureTenantRoles(tem as EntityManager, tenantId)
      await ensureEncryptionMaps(tem as EntityManager, tenantId, organizationId)
    })
    // 3. Role ACLs, hierarchy and onTenantCreated hooks. A customer tenant
    //    never gets a super-admin ACL: that flag reaches across tenants.
    await step('baseline', (sem) =>
      seedTenantBaseline(sem, { tenantId, organizationId, modules, includeSuperadminRole: false }),
    )
    // 4. Feature toggle overrides from the template tenant.
    const template = options.templateTenantId === undefined ? envTemplateTenantId() : options.templateTenantId
    await step('feature_toggle_overrides', async (sem) => {
      const copied = await copyFeatureToggleOverrides(sem, template, tenantId)
      if (copied) log(`copied ${copied} feature toggle overrides`)
    })
    // 5. Structural module defaults (dictionaries, currencies, pipelines,
    //    statuses, dashboards, units). Never seedExamples.
    for (const mod of modules) {
      const seed = mod.setup?.seedDefaults
      if (!seed) continue
      await step(`seedDefaults:${mod.id}`, (sem) =>
        seed({ em: sem, tenantId, organizationId, container: options.container as AwilixContainer }),
      )
    }
    // 6. Tenant key. A no-op under the derived scheme; under Vault only when
    //    no key exists yet (creating one would replace the tenant's key).
    await step('tenant_dek', async () => {
      if (!isTenantDataEncryptionEnabled()) return
      const kms = createKmsService()
      if (!kms.isHealthy()) throw new Error('KMS unhealthy')
      const existing = await kms.getTenantDek(tenantId)
      if (!existing) await kms.createTenantDek(tenantId)
    })

    if (failures.length === 0) {
      await work.execute('update tenants set seed_version = ?, updated_at = now() where id = ?', [
        CURRENT_TENANT_SEED_VERSION,
        tenantId,
      ])
      return CURRENT_TENANT_SEED_VERSION
    }
    return current
  })

  if (!outcome.ran) {
    const v = await readSeedVersion(em.fork(), tenantId)
    return { tenantId, seeded: false, version: v ?? current, failures: [] }
  }
  log(`tenant ${tenantId} seeded to version ${outcome.value} (${failures.length} failed steps)`)
  return { tenantId, seeded: failures.length === 0, version: outcome.value, failures }
}
