import { afterAll, beforeAll, describe, expect, it } from '@jest/globals'
import crypto from 'crypto'
import { isEncryptedEnvelope } from '../aes'
import { createKmsService } from '../kms'
import { encryptRowForRawWrite } from '../rawWrite'
import {
  REQUIRED_ENCRYPTION_ENTITY_IDS,
  TenantDataEncryptionMapMissingError,
  TenantDataEncryptionService,
} from '../tenantDataEncryptionService'

/*
 * 2026-09-25 review, H2: six of nine production user emails were plaintext.
 * Provisioning flushes the tenant's encryption maps and then the user inside
 * one transaction; the map lookup ran on another pooled connection, missed the
 * uncommitted maps, cached the miss process-wide for five minutes and handed
 * the email back in clear. These tests pin the three fixes: the lookup runs on
 * the transaction's connection, a miss inside a transaction is never cached,
 * and an entity every tenant must encrypt fails closed on a miss.
 */

const USER_MAP = { entity_id: 'auth:user', fields_json: [{ field: 'email', hashField: 'email_hash' }] }

type Exec = { sql: string; params: unknown[]; ctx: unknown }

/** An EntityManager whose maps exist only inside its (uncommitted) transaction. */
function transactionalEm(opts: { trx: unknown; mapVisibleInTrx: () => boolean }) {
  const calls: Exec[] = []
  const em = {
    getTransactionContext: () => opts.trx,
    getConnection: () => ({
      async execute(sql: string, params: unknown[], _method?: string, ctx?: unknown) {
        calls.push({ sql, params, ctx })
        const [entityId] = params
        // Outside the transaction (no ctx) the uncommitted map is invisible.
        if (ctx !== opts.trx || !opts.mapVisibleInTrx()) return []
        return entityId === USER_MAP.entity_id && params[1] !== null && params[2] !== null ? [USER_MAP] : []
      },
    }),
  }
  return { em, calls }
}

/** A plain EntityManager with no maps at all (committed state, no transaction). */
const emptyEm = {
  getTransactionContext: () => undefined,
  getConnection: () => ({ async execute() { return [] } }),
}

const saved = { ...process.env }
beforeAll(() => {
  process.env.TENANT_DATA_ENCRYPTION_KEY = 'map-lookup-test-key'
  delete process.env.TENANT_DATA_ENCRYPTION
})
afterAll(() => { process.env = saved })

describe('encryption map lookup inside a transaction', () => {
  it('finds a map flushed earlier in the same, uncommitted transaction', async () => {
    const tenant = crypto.randomUUID()
    const org = crypto.randomUUID()
    const trx = { id: 'trx-1' }
    const { em, calls } = transactionalEm({ trx, mapVisibleInTrx: () => true })
    const service = new TenantDataEncryptionService(em as any, { kms: createKmsService() })
    const out = await service.encryptEntityPayload('auth:user', { email: 'Ada@Example.com' }, tenant, org)
    expect(isEncryptedEnvelope(out.email)).toBe(true)
    expect(calls.every((c) => c.ctx === trx)).toBe(true)
  })

  it('uses the flushing EntityManager passed by the caller (the ORM subscriber path)', async () => {
    const tenant = crypto.randomUUID()
    const org = crypto.randomUUID()
    const trx = { id: 'trx-2' }
    const { em } = transactionalEm({ trx, mapVisibleInTrx: () => true })
    // The service itself was built on the root EntityManager (no transaction).
    const service = new TenantDataEncryptionService(emptyEm as any, { kms: createKmsService() })
    const out = await service.encryptEntityPayload('auth:user', { email: 'ada@example.com' }, tenant, org, { em })
    expect(isEncryptedEnvelope(out.email)).toBe(true)
  })

  it('never caches a miss seen inside a transaction', async () => {
    const tenant = crypto.randomUUID()
    const org = crypto.randomUUID()
    const trx = { id: 'trx-3' }
    let visible = false
    const { em } = transactionalEm({ trx, mapVisibleInTrx: () => visible })
    const service = new TenantDataEncryptionService(em as any, { kms: createKmsService() })
    const before = await service.encryptEntityPayload('auth:user', { email: 'ada@example.com' }, tenant, org)
    expect(before.email).toBe('ada@example.com')
    visible = true
    const after = await service.encryptEntityPayload('auth:user', { email: 'ada@example.com' }, tenant, org)
    expect(isEncryptedEnvelope(after.email)).toBe(true)
  })
})

describe('fail closed for entities every tenant must encrypt', () => {
  it('lists the default-mapped entities, users first', () => {
    expect(REQUIRED_ENCRYPTION_ENTITY_IDS.has('auth:user')).toBe(true)
    expect(REQUIRED_ENCRYPTION_ENTITY_IDS.has('customers:customer_entity')).toBe(true)
  })

  it('throws instead of returning plaintext when requireMap is set and no map resolves', async () => {
    const service = new TenantDataEncryptionService(emptyEm as any, { kms: createKmsService() })
    await expect(
      service.encryptEntityPayload('auth:user', { email: 'ada@example.com' }, crypto.randomUUID(), crypto.randomUUID(), { requireMap: true }),
    ).rejects.toBeInstanceOf(TenantDataEncryptionMapMissingError)
  })

  it('still passes an unmapped, optional entity through', async () => {
    const service = new TenantDataEncryptionService(emptyEm as any, { kms: createKmsService() })
    const out = await service.encryptEntityPayload('example:todo', { title: 't' }, crypto.randomUUID(), crypto.randomUUID())
    expect(out.title).toBe('t')
  })

  it('a raw write of a default-mapped entity with no map throws (never plaintext)', async () => {
    await expect(
      encryptRowForRawWrite('auth:user', { email: 'ada@example.com' }, crypto.randomUUID(), crypto.randomUUID(), emptyEm),
    ).rejects.toBeInstanceOf(TenantDataEncryptionMapMissingError)
  })
})

describe('map fallbacks', () => {
  it('encrypts a sub-organization row with a sibling organization map of the same tenant', async () => {
    const tenant = crypto.randomUUID()
    const rootOrg = crypto.randomUUID()
    const subOrg = crypto.randomUUID()
    const em = {
      getTransactionContext: () => undefined,
      getConnection: () => ({
        async execute(sql: string, params: unknown[]) {
          // Only the root org has maps (written at provisioning).
          if (/organization_id is not null/.test(sql)) return params[1] === tenant ? [USER_MAP] : []
          return params[1] === tenant && params[2] === rootOrg ? [USER_MAP] : []
        },
      }),
    }
    const service = new TenantDataEncryptionService(em as any, { kms: createKmsService() })
    const out = await service.encryptEntityPayload('auth:user', { email: 'ada@example.com' }, tenant, subOrg, { requireMap: true })
    expect(isEncryptedEnvelope(out.email)).toBe(true)
    const back = await service.decryptEntityPayload('auth:user', out, tenant, subOrg)
    expect(back.email).toBe('ada@example.com')
  })

  it('looks past a cached miss before refusing a required write', async () => {
    const tenant = crypto.randomUUID()
    const org = crypto.randomUUID()
    let committed = false
    const em = {
      getTransactionContext: () => undefined,
      getConnection: () => ({
        async execute(_sql: string, params: unknown[]) {
          return committed && params[1] === tenant && params[2] === org ? [USER_MAP] : []
        },
      }),
    }
    const service = new TenantDataEncryptionService(em as any, { kms: createKmsService() })
    // An optional write records the miss process-wide...
    expect((await service.encryptEntityPayload('auth:user', { email: 'a@b.c' }, tenant, org)).email).toBe('a@b.c')
    committed = true
    // ...and a required write right after still finds the committed map.
    const out = await service.encryptEntityPayload('auth:user', { email: 'a@b.c' }, tenant, org, { requireMap: true })
    expect(isEncryptedEnvelope(out.email)).toBe(true)
  })

  it('leaves an org-less (tenant-level) row alone even when required', async () => {
    const service = new TenantDataEncryptionService(emptyEm as any, { kms: createKmsService() })
    const out = await service.encryptEntityPayload('audit_logs:action_log', { comment: 'x' }, crypto.randomUUID(), null, { requireMap: true })
    expect(out.comment).toBe('x')
  })
})
