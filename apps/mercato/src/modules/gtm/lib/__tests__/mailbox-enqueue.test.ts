import { EmailConnection } from '../../../email/data/schema'
import { enqueueMailboxIngestion } from '../inbound/enqueue'
import { resolveGtmMailboxQueueStrategy } from '../inbound/queue-contract'
import { FakeEm } from './support/fake-em'

const ORG = '00000000-0000-4000-8000-000000000001'
const TENANT = '00000000-0000-4000-8000-000000000002'
const USER = '00000000-0000-4000-8000-000000000003'
const MAILBOX = '00000000-0000-4000-8000-000000000004'
const ctx = { organizationId: ORG, tenantId: TENANT, userId: USER }

async function seedMailbox(em: FakeEm, overrides: Partial<EmailConnection> = {}): Promise<void> {
  em.persist(em.create(EmailConnection, {
    id: MAILBOX,
    organizationId: ORG,
    tenantId: TENANT,
    userId: USER,
    provider: 'outlook',
    emailAddress: 'owned-fixture@example.test',
    isActive: true,
    ...overrides,
  }))
  await em.flush()
}

describe('GTM mailbox ingestion enqueue', () => {
  it('allows a GTM-only async queue without widening the global queue strategy', () => {
    expect(resolveGtmMailboxQueueStrategy({
      GTM_MAILBOX_QUEUE_STRATEGY: 'async',
      QUEUE_STRATEGY: undefined,
    })).toBe('async')
    expect(resolveGtmMailboxQueueStrategy({
      GTM_MAILBOX_QUEUE_STRATEGY: undefined,
      QUEUE_STRATEGY: 'async',
    })).toBe('async')
    expect(resolveGtmMailboxQueueStrategy({
      GTM_MAILBOX_QUEUE_STRATEGY: undefined,
      QUEUE_STRATEGY: undefined,
    })).toBe('local')
  })

  it('constructs no queue while ingestion or async strategy is disabled', async () => {
    const em = new FakeEm()
    await seedMailbox(em)
    const createQueue = jest.fn(() => ({ enqueue: jest.fn(), close: jest.fn() }))
    await expect(enqueueMailboxIngestion(em, ctx, { mailboxConnectionId: MAILBOX }, {
      ingestionEnabled: false,
      queueStrategy: 'async',
      createQueue,
    })).rejects.toMatchObject({ code: 'ingestion_disabled' })
    await expect(enqueueMailboxIngestion(em, ctx, { mailboxConnectionId: MAILBOX }, {
      ingestionEnabled: true,
      queueStrategy: 'local',
      createQueue,
    })).rejects.toMatchObject({ code: 'async_queue_required' })
    expect(createQueue).not.toHaveBeenCalled()
  })

  it('enqueues one credential-free scoped payload and closes the queue', async () => {
    const em = new FakeEm()
    await seedMailbox(em, { accessToken: 'secret-token', refreshToken: 'secret-refresh' })
    const enqueue = jest.fn(async () => 'opaque-job-1')
    const close = jest.fn(async () => {})
    const result = await enqueueMailboxIngestion(em, ctx, { mailboxConnectionId: MAILBOX }, {
      ingestionEnabled: true,
      queueStrategy: 'async',
      createQueue: () => ({ enqueue, close }),
    })
    expect(result).toEqual({
      jobId: 'opaque-job-1',
      mailboxConnectionId: MAILBOX,
      provider: 'microsoft',
      organizationId: ORG,
      tenantId: TENANT,
    })
    expect(enqueue).toHaveBeenCalledWith({
      organizationId: ORG,
      tenantId: TENANT,
      mailboxConnectionId: MAILBOX,
      requestedByUserId: USER,
    })
    expect(JSON.stringify(enqueue.mock.calls)).not.toContain('secret-token')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('keeps foreign, inactive, and unsupported mailboxes out of the queue', async () => {
    const em = new FakeEm()
    await seedMailbox(em, { provider: 'resend' })
    const createQueue = jest.fn(() => ({ enqueue: jest.fn(), close: jest.fn() }))
    await expect(enqueueMailboxIngestion(em, ctx, { mailboxConnectionId: MAILBOX }, {
      ingestionEnabled: true,
      queueStrategy: 'async',
      createQueue,
    })).rejects.toMatchObject({ code: 'mailbox_not_supported' })
    expect(createQueue).not.toHaveBeenCalled()

    const mailbox = await em.findOne(EmailConnection, { id: MAILBOX })
    if (!mailbox) throw new Error('fixture mailbox missing')
    mailbox.provider = 'gmail'
    mailbox.isActive = false
    await expect(enqueueMailboxIngestion(em, ctx, { mailboxConnectionId: MAILBOX }, {
      ingestionEnabled: true,
      queueStrategy: 'async',
      createQueue,
    })).rejects.toMatchObject({ code: 'mailbox_not_found' })
    expect(createQueue).not.toHaveBeenCalled()
  })

  it('closes the queue when enqueue fails and returns no provider detail', async () => {
    const em = new FakeEm()
    await seedMailbox(em)
    const close = jest.fn(async () => {})
    await expect(enqueueMailboxIngestion(em, ctx, { mailboxConnectionId: MAILBOX }, {
      ingestionEnabled: true,
      queueStrategy: 'async',
      createQueue: () => ({
        enqueue: jest.fn(async () => { throw new Error('synthetic queue failure') }),
        close,
      }),
    })).rejects.toMatchObject({
      code: 'queue_unavailable',
      message: 'Mailbox ingestion queue unavailable',
    })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('maps queue construction failure and does not treat close failure as a missing job', async () => {
    const em = new FakeEm()
    await seedMailbox(em)
    await expect(enqueueMailboxIngestion(em, ctx, { mailboxConnectionId: MAILBOX }, {
      ingestionEnabled: true,
      queueStrategy: 'async',
      createQueue: () => { throw new Error('synthetic Redis configuration failure') },
    })).rejects.toMatchObject({
      code: 'queue_unavailable',
      message: 'Mailbox ingestion queue unavailable',
    })

    await expect(enqueueMailboxIngestion(em, ctx, { mailboxConnectionId: MAILBOX }, {
      ingestionEnabled: true,
      queueStrategy: 'async',
      createQueue: () => ({
        enqueue: jest.fn(async () => 'acknowledged-job'),
        close: jest.fn(async () => { throw new Error('synthetic close failure') }),
      }),
    })).resolves.toMatchObject({ jobId: 'acknowledged-job' })
  })
})
