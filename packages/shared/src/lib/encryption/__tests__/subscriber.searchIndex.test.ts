import { afterEach, beforeAll, describe, expect, it } from '@jest/globals'
import { registerEntityIds } from '../entityIds'
import { TenantEncryptionSubscriber } from '../subscriber'
import { resetSearchTokensTableCacheForTests, searchBlindIndex } from '../searchIndex'
import { resetSearchKeyCacheForTests } from '../searchKey'
import { FakeSearchDb, fakeService } from './helpers/fakeSearchDb'

/**
 * The ORM write path: the tenant-encryption subscriber snapshots searchable
 * plaintext in its after-hooks and writes blind-index tokens in afterFlush.
 * Encryption is switched off here so the subscriber's own encrypt/decrypt is a
 * no-op and only the search-index wiring is exercised.
 */
const T1 = '11111111-1111-4111-8111-111111111111'
const O1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const C1 = '00000000-0000-4000-8000-000000000001'
const D1 = '00000000-0000-4000-8000-000000000002'

beforeAll(() => {
  registerEntityIds({ customers: { customer_entity: 'customers:customer_entity', customer_deal: 'customers:customer_deal' } })
})
afterEach(() => { resetSearchKeyCacheForTests(); resetSearchTokensTableCacheForTests(); delete process.env.TENANT_DATA_ENCRYPTION })

function harness() {
  process.env.TENANT_DATA_ENCRYPTION = 'false'
  const db = new FakeSearchDb()
  const service = fakeService()
  const subscriber = new TenantEncryptionSubscriber({ ...service, isEnabled: () => false } as any)
  const uow = {}
  const em = {
    getUnitOfWork: () => uow,
    getTransactionContext: () => undefined,
    getConnection: () => ({ execute: (sql: string, params: unknown[]) => db.query(sql, params) }),
    getMetadata: () => ({}),
  }
  const meta = (className: string) => ({ className, name: className, properties: {} }) as any
  return { db, subscriber, em, uow, meta }
}

async function find(db: FakeSearchDb, query: string, entityTypes?: Array<'person' | 'company' | 'deal'>) {
  // The same key the subscriber's service resolves (its DEK source).
  const { resolveSearchKey } = await import('../searchKey')
  const key = (await resolveSearchKey(T1, fakeService()))!
  return (await searchBlindIndex(db, key, { tenantId: T1, organizationIds: [O1], query, entityTypes })).hits.map((h) => h.entityId)
}

describe('TenantEncryptionSubscriber keeps the blind index current', () => {
  it('create, update and remove of a contact', async () => {
    const { db, subscriber, em, uow, meta } = harness()
    db.tables.customer_entities.push({ id: C1, tenant_id: T1, organization_id: O1, kind: 'person', deleted_at: null })
    const contact: Record<string, unknown> = {
      id: C1, tenantId: T1, organizationId: O1, kind: 'person',
      displayName: 'Katherine Johnson', primaryEmail: 'kj@nasa.gov', primaryPhone: '757 555 0101', deletedAt: null,
    }
    await subscriber.beforeFlush({ em, uow } as any)
    await subscriber.afterCreate({ entity: contact, meta: meta('CustomerEntity'), em } as any)
    await subscriber.afterFlush({ em, uow } as any)
    expect(await find(db, 'katherine')).toEqual([C1])
    expect(await find(db, '0101')).toEqual([C1])

    contact.displayName = 'Katherine Goble'
    await subscriber.beforeFlush({ em, uow } as any)
    await subscriber.afterUpdate({ entity: contact, meta: meta('CustomerEntity'), em } as any)
    await subscriber.afterFlush({ em, uow } as any)
    expect(await find(db, 'johnson')).toEqual([])
    expect(await find(db, 'goble')).toEqual([C1])

    await subscriber.beforeFlush({ em, uow } as any)
    await subscriber.afterDelete({ entity: contact, meta: meta('CustomerEntity'), em } as any)
    await subscriber.afterFlush({ em, uow } as any)
    expect(db.tokens.filter((t) => t.entity_id === C1)).toEqual([])
  })

  it('deal titles', async () => {
    const { db, subscriber, em, uow, meta } = harness()
    db.tables.customer_deals.push({ id: D1, tenant_id: T1, organization_id: O1, deleted_at: null })
    const deal = { id: D1, tenantId: T1, organizationId: O1, title: 'Orbital mechanics contract', deletedAt: null }
    await subscriber.beforeFlush({ em, uow } as any)
    await subscriber.afterCreate({ entity: deal, meta: meta('CustomerDeal'), em } as any)
    await subscriber.afterFlush({ em, uow } as any)
    expect(await find(db, 'orbital contract', ['deal'])).toEqual([D1])
  })

  it('writes nothing when the flush never completes', async () => {
    const { db, subscriber, em, uow, meta } = harness()
    const deal = { id: D1, tenantId: T1, organizationId: O1, title: 'Rolled back', deletedAt: null }
    await subscriber.beforeFlush({ em, uow } as any)
    await subscriber.afterCreate({ entity: deal, meta: meta('CustomerDeal'), em } as any)
    // The flush failed: no afterFlush. The next flush starts with beforeFlush.
    await subscriber.beforeFlush({ em, uow } as any)
    await subscriber.afterFlush({ em, uow } as any)
    expect(db.tokens).toEqual([])
  })

  it('ignores entities that are not search sources', async () => {
    const { db, subscriber, em, uow } = harness()
    await subscriber.beforeFlush({ em, uow } as any)
    await subscriber.afterCreate({ entity: { id: C1, tenantId: T1, name: 'x' }, meta: { className: 'SomethingElse', properties: {} } as any, em } as any)
    await subscriber.afterFlush({ em, uow } as any)
    expect(db.tokens).toEqual([])
  })
})
