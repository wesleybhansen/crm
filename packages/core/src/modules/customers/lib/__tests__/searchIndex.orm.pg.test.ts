/**
 * The ORM write path end to end on a real Postgres: MikroORM + the tenant
 * encryption subscriber encrypt the row and maintain customer_search_tokens;
 * search runs on the blind index. Covers create, update, update inside an
 * explicit transaction, soft delete (subscriber + trigger) and remove.
 *
 * Runs only when CUSTOMER_SEARCH_TEST_DATABASE_URL points at a disposable
 * database (its own schema, dropped afterwards). Skipped otherwise.
 */
import crypto from 'crypto'
import { Pool } from 'pg'
import { MikroORM } from '@mikro-orm/postgresql'
import * as customerEntities from '../../data/entities'
import { E } from '#generated/entities.ids.generated'
import { registerEntityIds } from '@open-mercato/shared/lib/encryption/entityIds'
import { TenantDataEncryptionService } from '@open-mercato/shared/lib/encryption/tenantDataEncryptionService'
import { registerTenantEncryptionSubscriber } from '@open-mercato/shared/lib/encryption/subscriber'
import { createKmsService } from '@open-mercato/shared/lib/encryption/kms'
import { isEncryptedEnvelope } from '@open-mercato/shared/lib/encryption/envelopeFormat'
import { resetSearchKeyCacheForTests } from '@open-mercato/shared/lib/encryption/searchKey'
import { resetSearchTokensTableCacheForTests } from '@open-mercato/shared/lib/encryption/searchIndex'
import { SEARCH_INDEX_SCHEMA_SQL } from '../searchIndexSchema'
import { blindSearchIds } from '../blindSearch'

const URL = process.env.CUSTOMER_SEARCH_TEST_DATABASE_URL
const d = URL ? describe : describe.skip

const T1 = '11111111-1111-4111-8111-111111111111'
const O1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'

d('blind index maintained by the ORM subscriber (Postgres)', () => {
  const schema = `cso_${crypto.randomBytes(4).toString('hex')}`
  let orm: MikroORM
  let pool: Pool
  const prevKey = process.env.TENANT_DATA_ENCRYPTION_KEY

  beforeAll(async () => {
    process.env.TENANT_DATA_ENCRYPTION_KEY = 'orm-search-test-key'
    resetSearchKeyCacheForTests()
    resetSearchTokensTableCacheForTests()
    registerEntityIds(E as any)
    pool = new Pool({ connectionString: URL, max: 1 })
    await pool.query(`create schema ${schema}`)
    orm = await MikroORM.init({
      clientUrl: URL,
      // Every connection works inside the throwaway schema (raw SQL included).
      driverOptions: { connection: { options: `-c search_path=${schema}` } },
      entities: Object.values(customerEntities).filter((v) => typeof v === 'function') as any[],
      discovery: { warnWhenNoEntities: false },
      debug: false,
      allowGlobalContext: true,
    })
    await orm.schema.createSchema()
    const conn = orm.em.getConnection()
    await conn.execute(`create table encryption_maps (id uuid primary key default gen_random_uuid(), entity_id text, tenant_id uuid,
      organization_id uuid, fields_json jsonb, is_active boolean default true, deleted_at timestamptz)`)
    await conn.execute(`insert into encryption_maps (entity_id, fields_json) values
      ('customers:customer_entity', '[{"field":"display_name"},{"field":"primary_email"},{"field":"primary_phone"}]'),
      ('customers:customer_person_profile', '[{"field":"first_name"},{"field":"last_name"},{"field":"job_title"}]'),
      ('customers:customer_deal', '[{"field":"title"},{"field":"description"}]')`)
    for (const sql of SEARCH_INDEX_SCHEMA_SQL) await conn.execute(sql)
    registerTenantEncryptionSubscriber(orm.em as any, new TenantDataEncryptionService(orm.em as any, { kms: createKmsService() }))
  })

  afterAll(async () => {
    await orm?.close(true)
    await pool?.query(`drop schema if exists ${schema} cascade`)
    await pool?.end()
    if (prevKey === undefined) delete process.env.TENANT_DATA_ENCRYPTION_KEY
    else process.env.TENANT_DATA_ENCRYPTION_KEY = prevKey
    resetSearchKeyCacheForTests()
  })

  const find = (query: string, entityTypes: Array<'person' | 'company' | 'deal'> = ['person', 'company']) =>
    blindSearchIds(orm.em.getKnex(), { tenantId: T1, organizationIds: [O1], entityTypes, query }).then((r) => r.ids)
  const tokenCount = async (entityId: string) =>
    Number((await orm.em.getConnection().execute(`select count(*)::int as n from customer_search_tokens where entity_id = ?`, [entityId]))[0].n)

  it('create, update (also inside a transaction), soft delete and remove', async () => {
    const em = orm.em.fork()
    const now = new Date()
    const contact = em.create(customerEntities.CustomerEntity, {
      organizationId: O1, tenantId: T1, kind: 'person', displayName: 'Grace Hopper',
      primaryEmail: 'grace.hopper@navy.mil', primaryPhone: '+1 202 555 0147', isActive: true, createdAt: now, updatedAt: now,
    } as any)
    em.create(customerEntities.CustomerPersonProfile, {
      organizationId: O1, tenantId: T1, entity: contact, firstName: 'Grace', lastName: 'Hopper', jobTitle: 'Rear Admiral',
      createdAt: now, updatedAt: now,
    } as any)
    await em.flush()

    const stored = (await orm.em.getConnection().execute(`select display_name from customer_entities where id = ?`, [contact.id]))[0]
    expect(isEncryptedEnvelope(stored.display_name)).toBe(true)
    expect(await find('grace hopper')).toEqual([contact.id])
    expect(await find('rear admiral')).toEqual([contact.id])
    expect(await find('grace.hopper@navy.mil')).toEqual([contact.id])
    expect(await find('0147')).toEqual([contact.id])

    const em2 = orm.em.fork()
    const loaded = await em2.findOneOrFail(customerEntities.CustomerEntity, { id: contact.id })
    loaded.displayName = 'Amazing Grace'
    await em2.flush()
    expect(await find('hopper')).toEqual([contact.id]) // still the profile's last name
    expect(await find('amazing')).toEqual([contact.id])
    expect(await find('grace hopper', ['person'])).toEqual([contact.id])

    await orm.em.fork().transactional(async (tem) => {
      const inTx = await tem.findOneOrFail(customerEntities.CustomerEntity, { id: contact.id })
      inTx.displayName = 'Commodore Grace'
    })
    expect(await find('amazing')).toEqual([])
    expect(await find('commodore')).toEqual([contact.id])

    const deal = em.create(customerEntities.CustomerDeal, {
      organizationId: O1, tenantId: T1, title: 'COBOL compiler licensing', status: 'open', createdAt: now, updatedAt: now,
    } as any)
    await em.flush()
    expect(await find('cobol compiler', ['deal'])).toEqual([deal.id])

    const em3 = orm.em.fork()
    const toDelete = await em3.findOneOrFail(customerEntities.CustomerEntity, { id: contact.id })
    ;(toDelete as any).deletedAt = new Date()
    await em3.flush()
    expect(await find('commodore')).toEqual([])
    expect(await tokenCount(contact.id)).toBe(0)

    const em4 = orm.em.fork()
    em4.remove(await em4.findOneOrFail(customerEntities.CustomerDeal, { id: deal.id }))
    await em4.flush()
    expect(await tokenCount(deal.id)).toBe(0)
  })
})
