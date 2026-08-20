import { createGmailMailboxReader } from '../inbound/providers/gmail'
import { createImapMailboxReader, imapIncrementalSearch } from '../inbound/providers/imap'
import { createOutlookMailboxReader } from '../inbound/providers/outlook'
import { MailboxProviderCursorExpiredError } from '../inbound/providers/types'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('cursor mailbox provider readers', () => {
  it('baselines Gmail without history loss claims and then reads messageAdded pages', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ historyId: '100' }))
      .mockResolvedValueOnce(jsonResponse({
        historyId: '104',
        history: [{ id: '104', messagesAdded: [{ message: { id: 'm-1', threadId: 't-1' } }] }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        id: 'm-1',
        threadId: 't-1',
        internalDate: '1786996800000',
        payload: {
          mimeType: 'multipart/alternative',
          headers: [
            { name: 'From', value: 'Person <person@example.com>' },
            { name: 'To', value: 'sender@example.com' },
            { name: 'Subject', value: 'Re: hello' },
            { name: 'In-Reply-To', value: '<sent@noli.test>' },
          ],
          parts: [{
            mimeType: 'text/plain',
            body: { data: Buffer.from('Interested').toString('base64url') },
          }],
        },
      }))
    const reader = createGmailMailboxReader({ accessToken: 'secret-token', fetch: fetchMock })
    const baseline = await reader.readPage(null)
    expect(baseline).toEqual({
      messages: [],
      nextCursor: JSON.stringify({ startHistoryId: '100' }),
      hasMore: false,
    })
    const page = await reader.readPage(baseline.nextCursor)
    expect(page.hasMore).toBe(false)
    expect(page.nextCursor).toBe(JSON.stringify({ startHistoryId: '104' }))
    expect(page.messages[0]).toMatchObject({
      provider: 'gmail',
      providerMessageId: 'm-1',
      fromAddress: 'person@example.com',
      bodyText: 'Interested',
      headers: { 'in-reply-to': '<sent@noli.test>' },
    })
    expect(JSON.stringify(page)).not.toContain('secret-token')
  })

  it('marks an expired Gmail history cursor for explicit resync', async () => {
    const reader = createGmailMailboxReader({
      accessToken: 'token',
      fetch: jest.fn(async () => jsonResponse({}, 404)),
    })
    await expect(reader.readPage(JSON.stringify({ startHistoryId: 'old' })))
      .rejects.toEqual(new MailboxProviderCursorExpiredError('gmail_history_expired'))
  })

  it('preserves opaque Graph next/delta links and rejects off-origin cursor URLs', async () => {
    const fetchMock = jest.fn(async () => jsonResponse({
      value: [{
        id: 'graph-1',
        internetMessageId: '<graph@example.com>',
        receivedDateTime: '2026-08-17T20:00:00.000Z',
        subject: 'Reply',
        body: { contentType: 'text', content: 'Hello' },
        from: { emailAddress: { address: 'person@example.com' } },
        toRecipients: [{ emailAddress: { address: 'sender@example.com' } }],
        internetMessageHeaders: [{ name: 'In-Reply-To', value: '<sent@noli.test>' }],
      }],
      '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=opaque',
    }))
    const reader = createOutlookMailboxReader({ accessToken: 'token', fetch: fetchMock })
    const page = await reader.readPage(null)
    expect(page.messages[0]).toMatchObject({
      provider: 'microsoft',
      providerMessageId: 'graph-1',
      bodyText: 'Hello',
    })
    expect(page.nextCursor).toContain('$deltatoken=opaque')
    await expect(reader.readPage('https://evil.example/delta')).rejects.toThrow('invalid graph delta cursor')
    await expect(reader.readPage('https://graph.microsoft.com/v1.0/users?$top=1'))
      .rejects.toThrow('invalid graph delta cursor')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('detects IMAP UIDVALIDITY changes before advancing the UID cursor', async () => {
    const reader = createImapMailboxReader(async () => ({ uidValidity: '2', messages: [] }))
    await expect(reader.readPage(JSON.stringify({ folder: 'INBOX', uidValidity: '1', lastUid: 7 })))
      .rejects.toEqual(new MailboxProviderCursorExpiredError('imap_uidvalidity_changed'))
  })

  it('baselines IMAP at provider metadata without importing historical messages', async () => {
    const source = jest.fn(async () => ({
      uidValidity: '42',
      baselineUid: 918,
      messages: [],
    }))
    const reader = createImapMailboxReader(source)

    const baseline = await reader.readPage(null)

    expect(source).toHaveBeenCalledWith({ afterUid: null, limit: 100 })
    expect(baseline).toEqual({
      messages: [],
      nextCursor: JSON.stringify({ folder: 'INBOX', uidValidity: '42', lastUid: 918 }),
      hasMore: false,
    })
  })

  it('can constrain an owned-mailbox rehearsal to one exact reply header', () => {
    expect(imapIncrementalSearch(918, '<owned-send@example.com>')).toEqual({
      uid: '919:*',
      header: { 'In-Reply-To': '<owned-send@example.com>' },
    })
    expect(imapIncrementalSearch(918)).toEqual({ uid: '919:*' })
  })
})
