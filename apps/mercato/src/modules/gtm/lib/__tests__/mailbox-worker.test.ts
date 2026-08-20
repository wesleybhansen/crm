import handle, { metadata } from '../../workers/mailbox-ingest'

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
