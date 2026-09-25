/** @jest-environment node */
import { isEncryptedEnvelope } from '@open-mercato/shared/lib/encryption/aes'
import { contactLookupHasher } from '@open-mercato/shared/lib/encryption/lookupKey'

/* 2026-09-25 review, M11: event registrations (name, email) were stored in
 * plaintext from a public route, outside the encryption maps. */

const MAP = { entity_id: 'customers:event_attendee', fields_json: [{ field: 'attendee_name' }, { field: 'attendee_email' }] }
const em = {
  getTransactionContext: () => undefined,
  getConnection: () => ({
    async execute(_sql: string, params: unknown[]) {
      return params[0] === MAP.entity_id && params[1] !== null && params[2] !== null ? [MAP] : []
    },
  }),
}
jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: async () => ({ resolve: () => em }),
}))

import { attendeeEmailHashes, decryptAttendeesForSend, encryptAttendeeRow, whereAttendeeEmail } from '../event-attendees'

const saved = { ...process.env }
beforeAll(() => {
  process.env.TENANT_DATA_ENCRYPTION_KEY = 'event-attendee-test-key'
  delete process.env.TENANT_DATA_ENCRYPTION
})
afterAll(() => { process.env = saved })

describe('event attendee encryption', () => {
  it('encrypts name and email and fills the keyed email hash', async () => {
    const row = await encryptAttendeeRow({ id: 'a1', attendee_name: 'Ada Lovelace', attendee_email: 'Ada@Example.com ', status: 'registered' }, 't1', 'o1')
    expect(isEncryptedEnvelope(row.attendee_name)).toBe(true)
    expect(isEncryptedEnvelope(row.attendee_email)).toBe(true)
    expect(row.attendee_email_hash).toBe((await contactLookupHasher('t1')).write('ada@example.com'))
    expect(row.status).toBe('registered')

    const { rows, unreadable } = await decryptAttendeesForSend([row, { ...row, id: 'bad', attendee_email: 'aXY=:Y3Q=:dGFn:v2:0011aabb' }], 't1', 'o1')
    expect(unreadable).toBe(1)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ attendee_name: 'Ada Lovelace', attendee_email: 'Ada@Example.com ' })
  })

  it('whereAttendeeEmail returns the builder synchronously (a knex builder is thenable)', async () => {
    const hashes = await attendeeEmailHashes(' Ada@Example.com', 't1')
    expect(hashes[0]).toBe((await contactLookupHasher('t1')).write('ada@example.com'))
    const qb: any = { where: jest.fn(() => qb), whereRaw: jest.fn(() => qb), first: jest.fn() }
    const out = whereAttendeeEmail(qb, 'ada@example.com', hashes)
    expect(out).toBe(qb)
    expect(typeof (out as any).then).toBe('undefined')
  })
})
