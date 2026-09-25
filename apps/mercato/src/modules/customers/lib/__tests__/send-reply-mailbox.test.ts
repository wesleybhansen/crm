/** @jest-environment node */
import type { Knex } from 'knex'

const mockSendEmailForOrg = jest.fn()
jest.mock('../../../email/lib/email-router', () => ({
  sendEmailForOrg: (...args: unknown[]) => mockSendEmailForOrg(...args),
}))
jest.mock('../../../../lib/inbox-conversation', () => ({ upsertInboxConversation: jest.fn(async () => undefined) }))

import { sendReply } from '../send-reply'
import { OWN_MAILBOX_REQUIRED_MESSAGE } from '../../../email/lib/routing-service'

type Row = Record<string, any>
function fakeKnex(tables: Record<string, Row[]>) {
  return ((name: string) => {
    const filters: Array<(row: Row) => boolean> = []
    const q: any = {
      where: (field: string, value: any) => { filters.push((row) => row[field] === value); return q },
      orderBy: () => q,
      first: async () => (tables[name] ?? []).find((row) => filters.every((f) => f(row))),
      select: async () => (tables[name] ?? []).filter((row) => filters.every((f) => f(row))),
      insert: async () => undefined,
    }
    return q
  }) as unknown as Knex
}

const ORG = 'org-1'
const ANA = { id: 'c-ana', organization_id: ORG, user_id: 'user-ana', is_active: true, provider: 'gmail', email_address: 'ana@team.test', purpose: null }
const BEN = { id: 'c-ben', organization_id: ORG, user_id: 'user-ben', is_active: true, provider: 'gmail', email_address: 'ben@team.test', purpose: null }
const INPUT = { to: 'client@example.test', subject: 'Re: hi', body: 'Thanks', skipTracking: true }

beforeEach(() => {
  mockSendEmailForOrg.mockReset()
  mockSendEmailForOrg.mockResolvedValue({ ok: true, messageId: 'm-1', sentVia: 'gmail', fromAddress: 'x' })
})

describe('sendReply picks the acting user’s own mailbox', () => {
  it('sends from the approver’s mailbox, not the first one in the org', async () => {
    const res = await sendReply(fakeKnex({ email_connections: [ANA, BEN] }), ORG, 't-1', { ...INPUT, sentByUserId: 'user-ben' })
    expect(res.ok).toBe(true)
    expect(mockSendEmailForOrg).toHaveBeenCalledWith(expect.anything(), ORG, 't-1', 'user-ben', expect.objectContaining({ connectionId: 'c-ben' }))
  })

  it('refuses with a clear message when the approver has no mailbox of their own', async () => {
    const res = await sendReply(fakeKnex({ email_connections: [ANA] }), ORG, 't-1', { ...INPUT, sentByUserId: 'user-cam' })
    expect(res.ok).toBe(false)
    expect(res.error).toBe(OWN_MAILBOX_REQUIRED_MESSAGE)
    expect(mockSendEmailForOrg).not.toHaveBeenCalled()
  })

  it('an unattended reply uses the shared Customer Service mailbox when there is one', async () => {
    const support = { ...ANA, id: 'c-sup', email_address: 'help@team.test', purpose: 'customer_service' }
    const res = await sendReply(fakeKnex({ email_connections: [ANA, BEN, support] }), ORG, 't-1', INPUT)
    expect(res.ok).toBe(true)
    expect(mockSendEmailForOrg).toHaveBeenCalledWith(expect.anything(), ORG, 't-1', 'user-ana', expect.objectContaining({ connectionId: 'c-sup' }))
  })

  it('an unattended reply in a multi-person org with nothing designated is refused', async () => {
    const res = await sendReply(fakeKnex({ email_connections: [ANA, BEN] }), ORG, 't-1', INPUT)
    expect(res.ok).toBe(false)
    expect(res.error).toBe(OWN_MAILBOX_REQUIRED_MESSAGE)
  })
})
