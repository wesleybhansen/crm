/** @jest-environment node */
import type { Knex } from 'knex'
import {
  OWN_MAILBOX_REQUIRED_MESSAGE,
  hasSendingSetup,
  resolveSenderAddress,
  resolveSenderMailbox,
} from '../routing-service'
import { sendBulkEmailForOrg, sendEmailByPurpose } from '../email-router'
import { EMAIL_NOT_SENT_NOT_CONNECTED } from '../sending-readiness'

type Row = Record<string, any>

// Minimal knex stand-in: equality filters, first/select, insert.
function fakeKnex(tables: Record<string, Row[]>) {
  const knex = ((name: string) => {
    const table = name.split(' as ')[0]
    const filters: Array<(row: Row) => boolean> = []
    const q: any = {
      where: (field: any, value?: any) => {
        const key = String(field).split('.').pop()!
        filters.push((row) => row[key] === value)
        return q
      },
      whereNull: (field: string) => {
        filters.push((row) => row[field] == null)
        return q
      },
      whereRaw: () => q,
      join: () => q,
      orderBy: () => q,
      first: async () => (tables[table] ?? []).find((row) => filters.every((f) => f(row))),
      select: async () => (tables[table] ?? []).filter((row) => filters.every((f) => f(row))),
      insert: async () => undefined,
      update: async () => 1,
    }
    return q
  }) as unknown as Knex
  return knex
}

const ORG = 'org-1'
const mailbox = (id: string, userId: string, email: string, extra: Row = {}): Row => ({
  id, organization_id: ORG, user_id: userId, is_active: true, provider: 'gmail', email_address: email, purpose: null, is_primary: true, ...extra,
})
const ANA = mailbox('c-ana', 'user-ana', 'ana@team.test')
const BEN = mailbox('c-ben', 'user-ben', 'ben@team.test')

describe('resolveSenderMailbox: never a teammate’s personal mailbox', () => {
  it('an acting user sends from their own mailbox', async () => {
    const r = await resolveSenderMailbox(fakeKnex({ email_connections: [ANA, BEN] }), ORG, 'user-ben')
    expect(r.connection?.email_address).toBe('ben@team.test')
    expect(r.connection && r.via).toBe('own')
  })

  it('an acting user with no mailbox is refused even though a teammate has one', async () => {
    const r = await resolveSenderMailbox(fakeKnex({ email_connections: [ANA] }), ORG, 'user-cam')
    expect(r.connection).toBeNull()
    expect(r.connection === null && r.reason).toBe('no_own_mailbox')
  })

  it('prefers the acting user’s personal mailbox over their support mailbox', async () => {
    const support = mailbox('c-sup', 'user-ben', 'help@team.test', { purpose: 'customer_service', is_primary: false })
    const r = await resolveSenderMailbox(fakeKnex({ email_connections: [support, BEN] }), ORG, 'user-ben')
    expect(r.connection?.email_address).toBe('ben@team.test')
  })

  it('uses a mailbox the org designated in email routing', async () => {
    const knex = fakeKnex({
      email_connections: [ANA],
      email_routing: [{ organization_id: ORG, purpose: 'inbox', provider_type: 'connection', provider_id: 'c-ana' }],
    })
    const r = await resolveSenderMailbox(knex, ORG, 'user-cam', { routingPurpose: 'inbox' })
    expect(r.connection?.email_address).toBe('ana@team.test')
    expect(r.connection && r.via).toBe('designated')
  })

  it('uses the shared Customer Service mailbox only when allowed', async () => {
    const support = mailbox('c-sup', 'user-ana', 'help@team.test', { purpose: 'customer_service', is_primary: false })
    const knex = fakeKnex({ email_connections: [ANA, support] })
    expect((await resolveSenderMailbox(knex, ORG, 'user-cam')).connection).toBeNull()
    const r = await resolveSenderMailbox(knex, ORG, 'user-cam', { allowSupportMailbox: true })
    expect(r.connection?.email_address).toBe('help@team.test')
  })

  it('a system send uses the org’s only mailbox owner', async () => {
    const r = await resolveSenderMailbox(fakeKnex({ email_connections: [ANA] }), ORG, null)
    expect(r.connection?.email_address).toBe('ana@team.test')
    expect(r.connection && r.via).toBe('sole_owner')
  })

  it('a system send with several mailbox owners and nothing designated is refused', async () => {
    const r = await resolveSenderMailbox(fakeKnex({ email_connections: [ANA, BEN] }), ORG, null)
    expect(r.connection).toBeNull()
    expect(r.connection === null && r.reason).toBe('no_own_mailbox')
  })

  it('an org with no mailboxes reports no_mailbox', async () => {
    const r = await resolveSenderMailbox(fakeKnex({}), ORG, 'user-ana')
    expect(r.connection === null && r.reason).toBe('no_mailbox')
  })
})

describe('purpose routing uses the same rule', () => {
  it('marketing with no ESP: acting user without a mailbox gets the own-mailbox refusal', async () => {
    const knex = fakeKnex({ email_connections: [ANA] })
    expect(await hasSendingSetup(knex, ORG, 'marketing', 'user-cam')).toBe(false)
    const res = await sendEmailByPurpose(knex, ORG, 'tenant-1', 'marketing', {
      to: 'lead@example.test', subject: 'Hi', htmlBody: '<p>Hi</p>', actingUserId: 'user-cam',
    })
    expect(res.ok).toBe(false)
    expect(res.code).toBe('email_not_connected')
    expect(res.error).toBe(OWN_MAILBOX_REQUIRED_MESSAGE)
  })

  it('marketing with no ESP: the acting user’s own mailbox is the sender', async () => {
    const knex = fakeKnex({ email_connections: [ANA, BEN] })
    expect(await resolveSenderAddress(knex, ORG, 'marketing', 'user-ben')).toBe('ben@team.test')
  })

  it('an ESP is org-level and wins over any mailbox', async () => {
    const knex = fakeKnex({
      email_connections: [ANA],
      esp_connections: [{ id: 'esp-1', organization_id: ORG, is_active: true, provider: 'resend', default_sender_email: 'news@team.test' }],
    })
    expect(await resolveSenderAddress(knex, ORG, 'marketing', 'user-cam')).toBe('news@team.test')
  })

  it('system inbox send in a multi-owner org is refused, solo org is fine', async () => {
    expect(await hasSendingSetup(fakeKnex({ email_connections: [ANA, BEN] }), ORG, 'inbox')).toBe(false)
    expect(await resolveSenderAddress(fakeKnex({ email_connections: [ANA] }), ORG, 'inbox')).toBe('ana@team.test')
  })

  it('no mailboxes at all keeps the plain not-connected refusal', async () => {
    const res = await sendEmailByPurpose(fakeKnex({}), ORG, 'tenant-1', 'marketing', {
      to: 'lead@example.test', subject: 'Hi', htmlBody: '<p>Hi</p>', actingUserId: 'user-cam',
    })
    expect(res.ok).toBe(false)
    expect(res.code).toBe('email_not_connected')
    // The plain refusal, not the teammate-mailbox one (was a tautology:
    // `expect(<constant>).toBeTruthy()`).
    expect(res.error).toBe(EMAIL_NOT_SENT_NOT_CONNECTED)
    expect(res.error).not.toBe(OWN_MAILBOX_REQUIRED_MESSAGE)
  })
})

describe('sendBulkEmailForOrg', () => {
  it('refuses rather than sending from a teammate’s mailbox', async () => {
    const res = await sendBulkEmailForOrg(fakeKnex({ email_connections: [ANA] }), ORG, 'tenant-1', 'x@team.test', ['a@example.test'], 'Hi', '<p>Hi</p>', 'user-cam')
    expect(res.ok).toBe(false)
    expect(res.sent).toBe(0)
    expect(res.results[0].error).toBe(OWN_MAILBOX_REQUIRED_MESSAGE)
  })
})

describe('strict decrypt at the send boundary (2026-09-25 review, LOW)', () => {
  it('refuses to send to ciphertext or the undecryptable placeholder', async () => {
    const { undecryptedSendPart } = await import('../email-router')
    expect(undecryptedSendPart({ to: 'aXY=:Y3Q=:dGFn:v2:0011aabb' })).toBe('to')
    expect(undecryptedSendPart({ body: '<p>Hi This record could not be decrypted. Contact support.</p>' })).toBe('body')
    expect(undecryptedSendPart({ to: 'ada@example.com', subject: 'Hi', body: '<p>Hi</p>' })).toBeNull()
    const res = await sendEmailByPurpose(fakeKnex({ email_connections: [ANA] }), ORG, 'tenant-1', 'marketing', {
      to: 'aXY=:Y3Q=:dGFn:v2:0011aabb', subject: 'Hi', htmlBody: '<p>Hi</p>', actingUserId: 'user-ana',
    })
    expect(res).toMatchObject({ ok: false, code: 'undecryptable' })
  })
})
