/**
 * Contact notes and contact deletes on a real Postgres (MCP sweep 2026-09-25):
 *  - findContactDependents / softDeleteContactDependents / restore: a contact
 *    delete takes its tasks, legacy notes and reminders with it, in its own
 *    org only, and undo brings back exactly those rows;
 *  - purgeContactDependents: the privacy erasure hard-deletes them all;
 *  - cleanupOrphanedContactData: the one-off repair for rows left behind by
 *    earlier deletes (dry run first, then apply, search entries dropped);
 *  - mergeLegacyNotesIntoComments: legacy contact_notes become customer
 *    comments (the Notes tab), encrypted, with their author and timestamps.
 *
 * Runs only when CUSTOMER_SEARCH_TEST_DATABASE_URL (or TENANT_TEST_DATABASE_URL)
 * points at a disposable database (own schema, dropped afterwards).
 */
import crypto from 'crypto'
import { Pool } from 'pg'
import { MikroORM } from '@mikro-orm/postgresql'
import * as customerEntities from '../../data/entities'
import * as queryIndexEntities from '../../../query_index/data/entities'
import { E } from '#generated/entities.ids.generated'
import { registerEntityIds } from '@open-mercato/shared/lib/encryption/entityIds'
import { TenantDataEncryptionService } from '@open-mercato/shared/lib/encryption/tenantDataEncryptionService'
import { registerTenantEncryptionSubscriber } from '@open-mercato/shared/lib/encryption/subscriber'
import { createKmsService } from '@open-mercato/shared/lib/encryption/kms'
import { isEncryptedEnvelope } from '@open-mercato/shared/lib/encryption/envelopeFormat'
import { resetSearchKeyCacheForTests } from '@open-mercato/shared/lib/encryption/searchKey'
import { resetSearchTokensTableCacheForTests } from '@open-mercato/shared/lib/encryption/searchIndex'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import {
  contactDependentIndexEntries,
  findContactDependents,
  purgeContactDependents,
  restoreContactDependents,
  softDeleteContactDependents,
} from '../contactDependents'
import {
  cleanupOrphanedContactData,
  mergeLegacyNotesIntoComments,
  type CleanupDb,
  type CleanupSql,
  type EncryptCommentRow,
} from '../contactDataCleanup'

const URL = process.env.CUSTOMER_SEARCH_TEST_DATABASE_URL || process.env.TENANT_TEST_DATABASE_URL
const d = URL ? describe : describe.skip

const T1 = '11111111-1111-4111-8111-111111111111'
const O1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const O2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
const uuid = () => crypto.randomUUID()

d('contact dependents, orphan cleanup and legacy note merge (Postgres)', () => {
  const schema = `ccd_${crypto.randomBytes(4).toString('hex')}`
  let orm: MikroORM
  let pool: Pool
  let db: CleanupDb
  let encryptComment: EncryptCommentRow
  const prevKey = process.env.TENANT_DATA_ENCRYPTION_KEY

  beforeAll(async () => {
    process.env.TENANT_DATA_ENCRYPTION_KEY = 'contact-cleanup-test-key'
    resetSearchKeyCacheForTests()
    resetSearchTokensTableCacheForTests()
    registerEntityIds(E as any)
    pool = new Pool({ connectionString: URL, max: 2, options: `-c search_path=${schema}` })
    await pool.query(`create schema ${schema}`)
    const classes = (mod: Record<string, unknown>) => Object.values(mod).filter((v) => typeof v === 'function') as any[]
    orm = await MikroORM.init({
      clientUrl: URL,
      driverOptions: { connection: { options: `-c search_path=${schema}` } },
      entities: [...classes(customerEntities), ...classes(queryIndexEntities)],
      discovery: { warnWhenNoEntities: false },
      debug: false,
      allowGlobalContext: true,
    })
    await orm.schema.createSchema()
    const conn = orm.em.getConnection()
    await conn.execute(`create table encryption_maps (id uuid primary key default gen_random_uuid(), entity_id text, tenant_id uuid,
      organization_id uuid, fields_json jsonb, is_active boolean default true, deleted_at timestamptz)`)
    await conn.execute(`insert into encryption_maps (entity_id, fields_json) values ('customers:customer_comment', '[{"field":"body"}]')`)
    const service = new TenantDataEncryptionService(orm.em as any, { kms: createKmsService() })
    registerTenantEncryptionSubscriber(orm.em as any, service)
    // The script's adapter: `?` placeholders over node-postgres.
    const toPg = (sql: string) => { let n = 0; return sql.replace(/\?/g, () => `$${++n}`) }
    const run = (client: { query: Pool['query'] }): CleanupSql => ({
      async query<T>(sql: string, params: unknown[] = []) { return (await client.query(toPg(sql), params)).rows as T[] },
    })
    db = {
      ...run(pool),
      async transaction(fn) {
        const client = await pool.connect()
        try {
          await client.query('begin')
          const out = await fn(run(client as any))
          await client.query('commit')
          return out
        } catch (err) {
          await client.query('rollback')
          throw err
        } finally {
          client.release()
        }
      },
    }
    encryptComment = async (row, tenantId, organizationId) =>
      service.encryptEntityPayload('customers:customer_comment', row, tenantId, organizationId, { em: orm.em as any, requireMap: true })
  })

  afterAll(async () => {
    await orm?.close(true)
    await pool?.query(`drop schema if exists ${schema} cascade`)
    await pool?.end()
    if (prevKey === undefined) delete process.env.TENANT_DATA_ENCRYPTION_KEY
    else process.env.TENANT_DATA_ENCRYPTION_KEY = prevKey
    resetSearchKeyCacheForTests()
  })

  const knex = () => orm.em.getKnex()
  const now = () => new Date()

  async function seedContact(org: string, name: string): Promise<string> {
    const id = uuid()
    await knex()('customer_entities').insert({
      id, organization_id: org, tenant_id: T1, kind: 'person', display_name: name,
      is_active: true, created_at: now(), updated_at: now(),
    })
    return id
  }
  async function seedDependents(org: string, contactId: string) {
    const taskId = uuid()
    const noteId = uuid()
    const reminderId = uuid()
    const taskReminderId = uuid()
    await knex()('tasks').insert({ id: taskId, organization_id: org, tenant_id: T1, title: 'Call back', contact_id: contactId, is_done: false, created_at: now(), updated_at: now() })
    await knex()('contact_notes').insert({ id: noteId, organization_id: org, tenant_id: T1, contact_id: contactId, content: `note for ${contactId}`, author_user_id: USER, created_at: new Date('2026-01-02T03:04:05Z'), updated_at: new Date('2026-01-02T03:04:05Z') })
    await knex()('reminders').insert({ id: reminderId, organization_id: org, tenant_id: T1, user_id: USER, entity_type: 'contact', entity_id: contactId, message: 'ping', remind_at: now(), sent: false, created_at: now(), updated_at: now() })
    await knex()('reminders').insert({ id: taskReminderId, organization_id: org, tenant_id: T1, user_id: USER, entity_type: 'task', entity_id: taskId, message: 'task ping', remind_at: now(), sent: false, created_at: now(), updated_at: now() })
    return { taskId, noteId, reminderId, taskReminderId }
  }
  const deletedAt = async (table: string, id: string) =>
    (await knex()(table).where('id', id).first('deleted_at'))?.deleted_at ?? null

  it('a contact delete takes its tasks, legacy notes and reminders along, and undo restores exactly those', async () => {
    const contact = await seedContact(O1, 'Pat')
    const other = await seedContact(O1, 'Other')
    const mine = await seedDependents(O1, contact)
    const theirs = await seedDependents(O1, other)
    const scope = { tenantId: T1, organizationId: O1 }

    const found = await findContactDependents(orm.em, contact, scope)
    expect(found).toEqual({
      taskIds: [mine.taskId],
      noteIds: [mine.noteId],
      reminderIds: expect.arrayContaining([mine.reminderId, mine.taskReminderId]),
    })
    // Another org's scope sees nothing of this contact.
    expect(await findContactDependents(orm.em, contact, { tenantId: T1, organizationId: O2 })).toEqual({ taskIds: [], noteIds: [], reminderIds: [] })
    expect(contactDependentIndexEntries(found, scope)).toEqual([
      { entityType: 'customers:customer_task', recordId: mine.taskId, ...scope },
      { entityType: 'customers:customer_contact_note', recordId: mine.noteId, ...scope },
    ])

    const counts = await softDeleteContactDependents(orm.em, found, scope)
    expect(counts).toEqual({ tasks: 1, notes: 1, reminders: 2 })
    for (const [table, id] of [['tasks', mine.taskId], ['contact_notes', mine.noteId], ['reminders', mine.reminderId]] as const) {
      expect(await deletedAt(table, id)).not.toBeNull()
    }
    // The other contact's rows are untouched.
    for (const [table, id] of [['tasks', theirs.taskId], ['contact_notes', theirs.noteId], ['reminders', theirs.reminderId]] as const) {
      expect(await deletedAt(table, id)).toBeNull()
    }

    await restoreContactDependents(orm.em, found, scope)
    for (const [table, id] of [['tasks', mine.taskId], ['contact_notes', mine.noteId], ['reminders', mine.reminderId]] as const) {
      expect(await deletedAt(table, id)).toBeNull()
    }
  })

  it('cleans up rows orphaned by earlier deletes: dry run first, then apply, per org', async () => {
    const live = await seedContact(O2, 'Live')
    const liveRows = await seedDependents(O2, live)
    const goneId = uuid() // a contact deleted before the cascade existed
    const gone = await seedDependents(O2, goneId)
    await knex()('search_tokens').insert({ id: uuid(), entity_type: 'customers:customer_contact_note', entity_id: gone.noteId, organization_id: O2, tenant_id: T1, field: 'content', token_hash: 'h', created_at: now() })
    await knex()('entity_indexes').insert({ id: uuid(), entity_type: 'customers:customer_task', entity_id: gone.taskId, organization_id: O2, tenant_id: T1, doc: JSON.stringify({ title: 'Call back' }), created_at: now(), updated_at: now() })

    const dry = await cleanupOrphanedContactData(db, { organizationId: O2 })
    expect(dry).toEqual({ tasks: 1, notes: 1, reminders: 2, comments: 0, activities: 0, indexEntriesRemoved: 0, applied: false })
    expect(await deletedAt('tasks', gone.taskId)).toBeNull()

    const applied = await cleanupOrphanedContactData(db, { organizationId: O2, apply: true })
    expect(applied).toMatchObject({ tasks: 1, notes: 1, reminders: 2, applied: true })
    expect(applied.indexEntriesRemoved).toBe(2)
    for (const [table, id] of [['tasks', gone.taskId], ['contact_notes', gone.noteId], ['reminders', gone.reminderId], ['reminders', gone.taskReminderId]] as const) {
      expect(await deletedAt(table, id)).not.toBeNull()
    }
    for (const [table, id] of [['tasks', liveRows.taskId], ['contact_notes', liveRows.noteId], ['reminders', liveRows.reminderId]] as const) {
      expect(await deletedAt(table, id)).toBeNull()
    }
    // Idempotent.
    expect(await cleanupOrphanedContactData(db, { organizationId: O2, apply: true })).toMatchObject({ tasks: 0, notes: 0, reminders: 0 })
  })

  it('merges legacy notes into encrypted customer comments and hides the legacy rows', async () => {
    const org = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'
    const contact = await seedContact(org, 'Merge me')
    const rows = await seedDependents(org, contact)
    const orphan = await seedDependents(org, uuid())

    const dry = await mergeLegacyNotesIntoComments(db, encryptComment, { organizationId: org })
    expect(dry).toMatchObject({ legacyNotes: 2, merged: 1, skippedNoContact: 1, applied: false })
    expect(await knex()('customer_comments').where('organization_id', org).count('* as n').first()).toMatchObject({ n: '0' })

    const applied = await mergeLegacyNotesIntoComments(db, encryptComment, { organizationId: org, apply: true })
    expect(applied).toMatchObject({ merged: 1, applied: true })
    const [raw] = await knex()('customer_comments').where('organization_id', org)
    expect(raw).toMatchObject({ entity_id: contact, tenant_id: T1, author_user_id: USER })
    expect(new Date(raw.created_at).toISOString()).toBe('2026-01-02T03:04:05.000Z')
    expect(isEncryptedEnvelope(raw.body)).toBe(true)
    const [decrypted] = await findWithDecryption(orm.em.fork(), customerEntities.CustomerComment, { id: raw.id }, {}, { tenantId: T1, organizationId: org })
    expect(decrypted.body).toBe(`note for ${contact}`)
    expect(await deletedAt('contact_notes', rows.noteId)).not.toBeNull()
    expect(await deletedAt('contact_notes', orphan.noteId)).toBeNull()

    // Re-running moves nothing twice.
    expect(await mergeLegacyNotesIntoComments(db, encryptComment, { organizationId: org, apply: true })).toMatchObject({ legacyNotes: 1, merged: 0 })
  })
  async function seedCommentAndActivity(org: string, contactId: string) {
    const commentId = uuid()
    const activityId = uuid()
    await knex()('customer_comments').insert({ id: commentId, organization_id: org, tenant_id: T1, entity_id: contactId, body: 'x', created_at: now(), updated_at: now() })
    await knex()('customer_activities').insert({ id: activityId, organization_id: org, tenant_id: T1, entity_id: contactId, activity_type: 'call', created_at: now(), updated_at: now() })
    return { commentId, activityId }
  }

  it('cleans up comments and activities of a soft-deleted (anonymized) contact, not of live ones', async () => {
    const org = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4'
    const live = await seedContact(org, 'Live')
    const removed = await seedContact(org, 'Removed')
    const liveRows = await seedCommentAndActivity(org, live)
    const removedRows = await seedCommentAndActivity(org, removed)
    await knex()('customer_entities').where('id', removed).update({ deleted_at: now() })
    await knex()('search_tokens').insert({ id: uuid(), entity_type: 'customers:customer_comment', entity_id: removedRows.commentId, organization_id: org, tenant_id: T1, field: 'body', token_hash: 'h', created_at: now() })

    expect(await cleanupOrphanedContactData(db, { organizationId: org })).toMatchObject({ comments: 1, activities: 1, applied: false })
    const applied = await cleanupOrphanedContactData(db, { organizationId: org, apply: true })
    expect(applied).toMatchObject({ comments: 1, activities: 1, indexEntriesRemoved: 1 })
    expect(await deletedAt('customer_comments', removedRows.commentId)).not.toBeNull()
    expect(await knex()('customer_activities').where('id', removedRows.activityId).first()).toBeUndefined()
    expect(await deletedAt('customer_comments', liveRows.commentId)).toBeNull()
    expect(await knex()('customer_activities').where('id', liveRows.activityId).first()).toBeDefined()
  })

  it('privacy erasure hard-deletes every dependent of the contacts, in their org only', async () => {
    const org = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5'
    const target = await seedContact(org, 'Erase me')
    const keep = await seedContact(org, 'Keep me')
    const t = { ...(await seedDependents(org, target)), ...(await seedCommentAndActivity(org, target)) }
    const k = { ...(await seedDependents(org, keep)), ...(await seedCommentAndActivity(org, keep)) }
    await knex()('entity_indexes').insert({ id: uuid(), entity_type: 'customers:customer_task', entity_id: t.taskId, organization_id: org, tenant_id: T1, doc: JSON.stringify({}), created_at: now(), updated_at: now() })

    // Wrong org: nothing happens.
    expect(await purgeContactDependents(orm.em as any, [target], { tenantId: T1, organizationId: O1 })).toMatchObject({ tasks: 0, notes: 0, comments: 0 })
    const counts = await purgeContactDependents(orm.em as any, [target], { tenantId: T1, organizationId: org })
    expect(counts).toEqual({ tasks: 1, notes: 1, reminders: 2, comments: 1, activities: 1, indexEntries: 1 })
    for (const [table, id] of [['tasks', t.taskId], ['contact_notes', t.noteId], ['reminders', t.reminderId], ['reminders', t.taskReminderId], ['customer_comments', t.commentId], ['customer_activities', t.activityId]] as const) {
      expect(await knex()(table).where('id', id).first()).toBeUndefined()
    }
    for (const [table, id] of [['tasks', k.taskId], ['contact_notes', k.noteId], ['reminders', k.reminderId], ['customer_comments', k.commentId], ['customer_activities', k.activityId]] as const) {
      expect(await knex()(table).where('id', id).first()).toBeDefined()
    }
  })
})
