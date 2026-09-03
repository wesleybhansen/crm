import handle, { metadata, withCursorBusyRetry } from '../../workers/mailbox-ingest'
import { MailboxCursorError } from '../inbound/cursor'

describe('GTM mailbox worker', () => {
  const prior = process.env.GTM_MAILBOX_INGESTION_ENABLED

  afterEach(() => {
    if (prior == null) delete process.env.GTM_MAILBOX_INGESTION_ENABLED
    else process.env.GTM_MAILBOX_INGESTION_ENABLED = prior
  })

  it('declares a bounded I/O concurrency', () => {
    expect(metadata).toMatchObject({
      queue: 'gtm-mailbox-ingest',
      id: 'gtm:mailbox-ingest',
      concurrency: 5,
    })
  })

  it('waits and retries on a leased cursor instead of dying, then yields to the running job', async () => {
    const waits: number[] = []
    const sleep = async (ms: number) => {
      waits.push(ms)
    }
    let calls = 0
    const busyTwice = async () => {
      calls += 1
      if (calls <= 2) throw new MailboxCursorError('cursor_busy', 'leased')
      return 'ingested' as const
    }
    await expect(withCursorBusyRetry(busyTwice, { delaysMs: [1, 2, 3], sleep })).resolves.toBe('ingested')
    expect(waits).toEqual([1, 2])

    // Still busy after every retry: skip quietly (the running job covers the
    // same pages); never propagate as a job failure.
    const alwaysBusy = async () => {
      throw new MailboxCursorError('cursor_busy', 'leased')
    }
    await expect(withCursorBusyRetry(alwaysBusy, { delaysMs: [1], sleep })).resolves.toBe('cursor_busy')

    // Any other error still surfaces.
    const broken = async () => {
      throw new Error('provider down')
    }
    await expect(withCursorBusyRetry(broken, { delaysMs: [1], sleep })).rejects.toThrow('provider down')
  })

  it('resolves no dependency and performs no I/O while the ingestion gate is off', async () => {
    process.env.GTM_MAILBOX_INGESTION_ENABLED = 'false'
    const resolve = jest.fn(() => {
      throw new Error('must not resolve')
    })
    await handle({ payload: {} } as never, {
      jobId: 'job-1',
      attemptNumber: 1,
      queueName: 'gtm-mailbox-ingest',
      resolve,
    } as never)
    expect(resolve).not.toHaveBeenCalled()
  })
})
