import { FakeEm } from './support/fake-em'
import { harness, internalRequest, readJson, resetHarness } from './support/route-harness'
import { HARNESS_ORG, HARNESS_TENANT, HARNESS_NOLI_USER } from './support/route-harness'
import { canonicalHash } from '../campaign/approve'
import { GtmEnrollment, GtmReply } from '../../data/entities'
import { EmailMessage } from '../../../email/data/schema'

jest.mock('@open-mercato/shared/lib/noli/core-client', () =>
  require('./support/route-harness').coreClientMock,
)
jest.mock('@open-mercato/shared/lib/auth/clerk', () => require('./support/route-harness').clerkMock)
jest.mock('@open-mercato/shared/lib/di/container', () =>
  require('./support/route-harness').containerMock,
)

// Sentinels stand in for the two transports so the test can assert WHICH
// module export the route hands to the reply sender (review H2).
const transportSentinels = {
  mailboxTransport: { kind: 'mailbox', send: jest.fn() },
  smtpTransport: { kind: 'smtp', send: jest.fn() },
  // The route builds a token-persisting wrapper around the mailbox transport;
  // the factory returns the mailbox sentinel so the assertion below still
  // proves the OAuth-capable path (never the SMTP-only one) is selected.
  createPersistingMailboxTransport: () => transportSentinels.mailboxTransport,
}
jest.mock('../execute/transport', () => transportSentinels)

const approveAndSendReply = jest.fn()
jest.mock('../replies/send', () => ({
  approveAndSendReply: (...args: unknown[]) => approveAndSendReply(...args),
}))

const REPLY_ID = '99999999-9999-4999-8999-999999999999'
const ENROLLMENT_ID = '88888888-8888-4888-8888-888888888888'

async function seedReply(
  em: FakeEm,
  overrides: Partial<{ id: string; draft: Record<string, unknown> | null; classification: string | null; createdAt: Date; emailMessageId: string | null }> = {},
): Promise<GtmReply> {
  const reply = em.create(GtmReply, {
    ...(overrides.id ? { id: overrides.id } : {}),
    organizationId: HARNESS_ORG,
    tenantId: HARNESS_TENANT,
    enrollmentId: ENROLLMENT_ID,
    channel: 'email',
    classification: overrides.classification ?? null,
    draftResponse: overrides.draft === undefined ? { subject: 'Re: hello', body: 'Thanks, happy to talk.' } : overrides.draft,
    draftStatus: overrides.draft === null ? 'none' : 'drafted',
    emailMessageId: overrides.emailMessageId ?? null,
    createdAt: overrides.createdAt ?? new Date('2026-08-01T00:00:00.000Z'),
  })
  em.persist(reply)
  await em.flush()
  return reply
}

describe('POST /internal/gtm/inbox', () => {
  beforeEach(() => {
    resetHarness({ features: ['gtm.view', 'gtm.edit', 'gtm.launch'] })
    approveAndSendReply.mockReset()
    approveAndSendReply.mockImplementation(async (_em, _ctx, input, deps) => ({
      reply: await harness.em.findOne(GtmReply, { id: (input as { replyId: string }).replyId }),
      attempt: null,
      dryRun: !deps.executionEnabled,
      alreadySent: false,
      outcome: deps.executionEnabled ? 'accepted' : 'dry_run',
    }))
    process.env.GTM_EXECUTION_ENABLED = 'true'
  })

  afterAll(() => {
    delete process.env.GTM_EXECUTION_ENABLED
  })

  it('sends approved replies through the mailbox transport, never the SMTP-only one', async () => {
    const { POST } = await import('../../api/internal/gtm-inbox/route')
    const reply = await seedReply(harness.em, { id: REPLY_ID })
    const hash = canonicalHash({ subject: 'Re: hello', body: 'Thanks, happy to talk.' })
    const response = await POST(
      internalRequest({
        op: 'approve-draft',
        noliUserId: HARNESS_NOLI_USER,
        replyId: reply.id,
        expected_draft_hash: hash,
      }),
    )
    expect(response.status).toBe(200)
    expect(approveAndSendReply).toHaveBeenCalledTimes(1)
    const deps = approveAndSendReply.mock.calls[0][3] as { executionEnabled: boolean; transport: unknown }
    expect(deps.executionEnabled).toBe(true)
    expect(deps.transport).toBe(transportSentinels.mailboxTransport)
    expect(deps.transport).not.toBe(transportSentinels.smtpTransport)
  })

  it('refuses approve-draft with a stale or missing draft hash (409) before anything is sent', async () => {
    const { POST } = await import('../../api/internal/gtm-inbox/route')
    const reply = await seedReply(harness.em, { id: REPLY_ID })
    const stale = await POST(
      internalRequest({
        op: 'approve-draft',
        noliUserId: HARNESS_NOLI_USER,
        replyId: reply.id,
        expected_draft_hash: 'b'.repeat(64),
      }),
    )
    expect(stale.status).toBe(409)
    expect(await readJson(stale)).toMatchObject({ code: 'stale_draft' })

    const missing = await POST(
      internalRequest({ op: 'approve-draft', noliUserId: HARNESS_NOLI_USER, replyId: reply.id }),
    )
    expect(missing.status).toBe(400)
    expect(approveAndSendReply).not.toHaveBeenCalled()
  })

  it('exposes draft_content_hash on the reply shape so the hub can echo it', async () => {
    const { POST } = await import('../../api/internal/gtm-inbox/route')
    await seedReply(harness.em, { id: REPLY_ID })
    const response = await POST(internalRequest({ op: 'list', noliUserId: HARNESS_NOLI_USER }))
    const json = await readJson(response)
    const rows = json.replies as Array<Record<string, unknown>>
    expect(rows[0].draft_content_hash).toBe(
      canonicalHash({ subject: 'Re: hello', body: 'Thanks, happy to talk.' }),
    )
  })

  it('lists newest first, capped at 100, with filter and search applied in the query', async () => {
    const { POST } = await import('../../api/internal/gtm-inbox/route')
    const em = harness.em
    em.persist(
      em.create(GtmEnrollment, {
        id: ENROLLMENT_ID,
        organizationId: HARNESS_ORG,
        tenantId: HARNESS_TENANT,
        campaignId: '77777777-7777-4777-8777-777777777777',
        campaignVersionId: '66666666-6666-4666-8666-666666666666',
        candidateId: '55555555-5555-4555-8555-555555555555',
        status: 'stopped',
      }),
    )
    const message = em.create(EmailMessage, {
      organizationId: HARNESS_ORG,
      tenantId: HARNESS_TENANT,
      direction: 'inbound',
      fromAddress: 'needle@fixture.example',
      toAddress: 'sender@fixture.example',
      subject: 'Re: Quick question',
      bodyHtml: '<p>hi</p>',
      bodyText: 'hi',
      metadata: {},
    })
    em.persist(message)
    await em.flush()
    for (let i = 0; i < 120; i += 1) {
      await seedReply(em, {
        classification: i % 3 === 0 ? 'interested' : null,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
        emailMessageId: i === 5 ? message.id : null,
      })
    }

    const all = await readJson(await POST(internalRequest({ op: 'list', noliUserId: HARNESS_NOLI_USER })))
    const rows = all.replies as Array<Record<string, unknown>>
    expect(rows).toHaveLength(100)
    expect(all.cap).toBe(100)
    const stamps = rows.map((row) => new Date(row.created_at as string).getTime())
    expect([...stamps].sort((a, b) => b - a)).toEqual(stamps)

    const interested = await readJson(
      await POST(internalRequest({ op: 'list', noliUserId: HARNESS_NOLI_USER, filter: 'interested' })),
    )
    expect((interested.replies as unknown[]).length).toBe(40)

    const unread = await readJson(
      await POST(internalRequest({ op: 'list', noliUserId: HARNESS_NOLI_USER, filter: 'unread' })),
    )
    expect((unread.replies as Array<Record<string, unknown>>).every((row) => row.classification === null)).toBe(true)

    const searched = await readJson(
      await POST(internalRequest({ op: 'list', noliUserId: HARNESS_NOLI_USER, query: 'NEEDLE@fixture' })),
    )
    const found = searched.replies as Array<Record<string, unknown>>
    expect(found).toHaveLength(1)
    expect(found[0].email_message_id).toBe(message.id)
  })

  it('never lists another tenant\'s replies', async () => {
    const { POST } = await import('../../api/internal/gtm-inbox/route')
    const foreign = harness.em.create(GtmReply, {
      organizationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      tenantId: HARNESS_TENANT,
      enrollmentId: ENROLLMENT_ID,
      channel: 'email',
      draftStatus: 'none',
    })
    harness.em.persist(foreign)
    await harness.em.flush()
    const json = await readJson(await POST(internalRequest({ op: 'list', noliUserId: HARNESS_NOLI_USER })))
    expect(json.replies).toEqual([])
  })
})
