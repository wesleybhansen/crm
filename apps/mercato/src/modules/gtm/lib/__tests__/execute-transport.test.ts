import { EmailConnection } from '../../../email/data/schema'
import { buildGtmMimeMessage } from '../execute/mime'
import {
  createMailboxTransport,
  GtmSendTimeoutError,
  type GtmTransportSendArgs,
} from '../execute/transport'

function connection(provider: string): EmailConnection {
  const row = new EmailConnection()
  row.id = '10000000-0000-4000-8000-000000000001'
  row.organizationId = '10000000-0000-4000-8000-000000000002'
  row.tenantId = '10000000-0000-4000-8000-000000000003'
  row.userId = '10000000-0000-4000-8000-000000000004'
  row.provider = provider
  row.emailAddress = 'sender@example.com'
  row.accessToken = 'stored-access-token'
  row.refreshToken = 'stored-refresh-token'
  row.tokenExpiry = new Date('2026-08-18T00:00:00.000Z')
  row.updatedAt = new Date('2026-08-17T00:00:00.000Z')
  return row
}

function sendArgs(provider: string): GtmTransportSendArgs {
  return {
    connection: connection(provider),
    from: 'sender@example.com',
    to: 'recipient@example.net',
    subject: 'A useful idea',
    html: '<p>Hello there</p>',
    text: 'Hello there',
    headers: {
      'List-Unsubscribe': '<mailto:sender@example.com?subject=unsubscribe>, <https://example.com/unsubscribe/token>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
    messageId: '<attempt-1@example.com>',
  }
}

function recordingFetch(
  responder: (url: string, init: RequestInit | undefined, index: number) => Response | Promise<Response>,
) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)
    calls.push({ url, init })
    return responder(url, init, calls.length - 1)
  }
  return { fetchImpl, calls }
}

function decodeGmailRequest(body: BodyInit | null | undefined): string {
  const parsed = JSON.parse(String(body)) as { raw: string }
  return Buffer.from(parsed.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
}

describe('C2 mailbox MIME transports', () => {
  const originalGoogleClientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  const originalMicrosoftClientId = process.env.MICROSOFT_CLIENT_ID
  const originalMicrosoftClientSecret = process.env.MICROSOFT_CLIENT_SECRET

  beforeEach(() => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'google-client-fixture'
    process.env.MICROSOFT_CLIENT_ID = 'microsoft-client-fixture'
    process.env.MICROSOFT_CLIENT_SECRET = 'microsoft-secret-fixture'
  })

  afterAll(() => {
    if (originalGoogleClientId === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID
    else process.env.GOOGLE_OAUTH_CLIENT_ID = originalGoogleClientId
    if (originalMicrosoftClientId === undefined) delete process.env.MICROSOFT_CLIENT_ID
    else process.env.MICROSOFT_CLIENT_ID = originalMicrosoftClientId
    if (originalMicrosoftClientSecret === undefined) delete process.env.MICROSOFT_CLIENT_SECRET
    else process.env.MICROSOFT_CLIENT_SECRET = originalMicrosoftClientSecret
  })

  it('builds one injection-safe MIME envelope with the exact approved headers', () => {
    const mime = buildGtmMimeMessage(sendArgs('gmail'))
    expect(mime).toContain('From: sender@example.com\r\n')
    expect(mime).toContain('To: recipient@example.net\r\n')
    expect(mime).toContain('Message-ID: <attempt-1@example.com>\r\n')
    expect(mime).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n')
    expect(() => buildGtmMimeMessage({
      ...sendArgs('gmail'),
      subject: 'safe\r\nBcc: victim@example.org',
    })).toThrow('invalid subject')
  })

  it('sends Gmail raw MIME and preserves provider identity without exposing the token', async () => {
    const recorder = recordingFetch(() => new Response(
      JSON.stringify({ id: 'gmail-message-1', threadId: 'gmail-thread-1' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    const transport = createMailboxTransport({
      fetch: recorder.fetchImpl,
      now: () => new Date('2026-08-17T00:00:00.000Z'),
    })
    const result = await transport.send(sendArgs('gmail'))
    expect(result.providerMessageId).toBe('gmail-message-1')
    expect(result.receipt).toEqual({
      provider: 'gmail',
      http_status: 200,
      thread_id: 'gmail-thread-1',
      token_source: 'stored',
    })
    expect(recorder.calls).toHaveLength(1)
    expect(recorder.calls[0].url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send')
    expect(recorder.calls[0].init?.headers).toMatchObject({ Authorization: 'Bearer stored-access-token' })
    expect(decodeGmailRequest(recorder.calls[0].init?.body)).toContain('Message-ID: <attempt-1@example.com>')
    expect(JSON.stringify(result)).not.toContain('stored-access-token')
  })

  it('refreshes an expired Gmail token transiently without mutating the approved connection', async () => {
    const args = sendArgs('gmail')
    args.connection.tokenExpiry = new Date('2026-08-16T00:00:00.000Z')
    const originalUpdatedAt = args.connection.updatedAt
    const recorder = recordingFetch((_url, _init, index) => index === 0
      ? new Response(JSON.stringify({ access_token: 'transient-access-token' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      : new Response(JSON.stringify({ id: 'gmail-message-2' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }))
    const transport = createMailboxTransport({
      fetch: recorder.fetchImpl,
      now: () => new Date('2026-08-17T00:00:00.000Z'),
    })
    const result = await transport.send(args)
    expect(recorder.calls.map((call) => call.url)).toEqual([
      'https://oauth2.googleapis.com/token',
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    ])
    expect(recorder.calls[1].init?.headers).toMatchObject({ Authorization: 'Bearer transient-access-token' })
    expect(args.connection.accessToken).toBe('stored-access-token')
    expect(args.connection.updatedAt).toBe(originalUpdatedAt)
    expect(result.receipt).toMatchObject({ token_source: 'refreshed_transiently' })
  })

  it.each(['microsoft', 'outlook'])('sends %s through Graph MIME without inventing a provider id', async (provider) => {
    const recorder = recordingFetch(() => new Response(null, { status: 202 }))
    const transport = createMailboxTransport({
      fetch: recorder.fetchImpl,
      now: () => new Date('2026-08-17T00:00:00.000Z'),
    })
    const result = await transport.send(sendArgs(provider))
    expect(result.providerMessageId).toBeNull()
    expect(result.receipt).toEqual({
      provider: 'microsoft_graph',
      http_status: 202,
      rfc_message_id: '<attempt-1@example.com>',
      token_source: 'stored',
    })
    expect(recorder.calls[0].url).toBe('https://graph.microsoft.com/v1.0/me/sendMail')
    expect(recorder.calls[0].init?.headers).toMatchObject({ 'Content-Type': 'text/plain' })
    const mime = Buffer.from(String(recorder.calls[0].init?.body), 'base64').toString('utf8')
    expect(mime).toContain('Message-ID: <attempt-1@example.com>')
    expect(mime).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click')
  })

  it('separates known provider rejection from an unknown dispatch outcome', async () => {
    const known = recordingFetch(() => new Response(null, { status: 400 }))
    const ambiguous = recordingFetch(() => new Response(null, { status: 503 }))
    const now = () => new Date('2026-08-17T00:00:00.000Z')
    await expect(createMailboxTransport({ fetch: known.fetchImpl, now }).send(sendArgs('gmail')))
      .rejects.toThrow('gmail send failed (HTTP 400)')
    await expect(createMailboxTransport({ fetch: ambiguous.fetchImpl, now }).send(sendArgs('gmail')))
      .rejects.toBeInstanceOf(GtmSendTimeoutError)
  })

  it('rejects an unsupported mailbox provider without touching the network', async () => {
    const recorder = recordingFetch(() => new Response(null, { status: 200 }))
    await expect(createMailboxTransport({ fetch: recorder.fetchImpl }).send(sendArgs('resend')))
      .rejects.toThrow('sender connection provider is unsupported')
    expect(recorder.calls).toHaveLength(0)
  })
})
