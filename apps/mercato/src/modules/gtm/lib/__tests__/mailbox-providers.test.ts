import { createGmailMailboxReader } from '../inbound/providers/gmail'
import { createImapMailboxReader, imapIncrementalSearch, selectIncrementalUids } from '../inbound/providers/imap'
import { createOutlookMailboxReader } from '../inbound/providers/outlook'
import {
  headerAddress,
  MailboxProviderCursorExpiredError,
  normalizeHeaderMap,
  parseDeliveryStatus,
} from '../inbound/providers/types'

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

  it('drops the highest-UID echo an N:* search always returns (RFC 3501 quirk)', () => {
    // After UID 918 was the last ingested, `919:*` still returns 918 (or,
    // once 918 is expunged, the previous message 900): neither may be
    // re-imported.
    expect(selectIncrementalUids([918, 921, 919, 920], 918, 100)).toEqual([919, 920, 921])
    expect(selectIncrementalUids([900], 918, 100)).toEqual([])
    expect(selectIncrementalUids([919, 920, 921], 918, 2)).toEqual([919, 920])
  })

  it('stores exactly one From mailbox and rejects smuggled address lists', () => {
    expect(headerAddress('Person <person@example.com>')).toBe('person@example.com')
    expect(headerAddress('PERSON@Example.com')).toBe('person@example.com')
    // api-send-privacy M5: a bracketed list must not become a comma-joined
    // recipient that dodges suppression and mails an extra address.
    expect(headerAddress('<prospect@x.com, victim@z.com>')).toBe('')
    expect(headerAddress('a@x.com, b@y.com')).toBe('')
    expect(headerAddress('<a@x.com> <b@y.com>')).toBe('')
    expect(headerAddress('not an address')).toBe('')
  })

  it('persists only the allow-listed headers, keeping Authentication-Results', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ name: `x-junk-${i}`, value: 'x'.repeat(100) }))
    const headers = normalizeHeaderMap([
      { name: 'From', value: 'Person <person@example.com>' },
      { name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.i=@example.com' },
      { name: 'ARC-Authentication-Results', value: 'i=1; mx.google.com; spf=pass smtp.mailfrom=example.com' },
      { name: 'In-Reply-To', value: '<sent@noli.test>' },
      { name: 'X-Mailer', value: 'Evil 1.0' },
      ...many,
    ])
    expect(Object.keys(headers).sort()).toEqual([
      'arc-authentication-results',
      'authentication-results',
      'from',
      'in-reply-to',
    ])
  })

  it('parses the delivery-status part of a Gmail bounce into action/status', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(jsonResponse({
        historyId: '105',
        history: [{ id: '105', messagesAdded: [{ message: { id: 'dsn-1', threadId: 't-9' } }] }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        id: 'dsn-1',
        threadId: 't-9',
        internalDate: '1786996800000',
        payload: {
          mimeType: 'multipart/report',
          headers: [
            { name: 'From', value: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>' },
            { name: 'Subject', value: 'Delivery Status Notification (Delay)' },
            { name: 'In-Reply-To', value: '<sent@noli.test>' },
          ],
          parts: [
            { mimeType: 'text/plain', body: { data: Buffer.from('Delayed').toString('base64url') } },
            {
              mimeType: 'message/delivery-status',
              body: {
                data: Buffer.from(
                  'Reporting-MTA: dns; googlemail.com\r\n\r\nFinal-Recipient: rfc822; someone@example.com\r\nAction: delayed\r\nStatus: 4.4.1\r\n',
                ).toString('base64url'),
              },
            },
          ],
        },
      }))
    const reader = createGmailMailboxReader({ accessToken: 'token', fetch: fetchMock })
    const page = await reader.readPage(JSON.stringify({ startHistoryId: '100' }))
    expect(page.messages[0]).toMatchObject({
      fromAddress: 'mailer-daemon@googlemail.com',
      dsn: { action: 'delayed', status: '4.4.1' },
    })
    expect(parseDeliveryStatus('Action: failed\nStatus: 5.1.1 (bad destination)')).toEqual({
      action: 'failed',
      status: '5.1.1',
    })
    expect(parseDeliveryStatus('nothing here')).toBeNull()
  })

  it('can constrain an owned-mailbox rehearsal to one exact reply header', () => {
    expect(imapIncrementalSearch(918, '<owned-send@example.com>')).toEqual({
      uid: '919:*',
      header: { 'In-Reply-To': '<owned-send@example.com>' },
    })
    expect(imapIncrementalSearch(918)).toEqual({ uid: '919:*' })
  })
})
