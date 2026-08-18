export type NormalizedMailboxMessage = {
  provider: 'gmail' | 'microsoft' | 'imap'
  providerMessageId: string
  providerEventId: string
  threadId: string | null
  rfcMessageId: string | null
  fromAddress: string
  toAddress: string
  cc: string | null
  subject: string
  bodyHtml: string
  bodyText: string | null
  receivedAt: Date
  headers: Record<string, string>
}

export type MailboxProviderPage = {
  messages: NormalizedMailboxMessage[]
  nextCursor: string
  hasMore: boolean
}

export class MailboxProviderCursorExpiredError extends Error {
  constructor(readonly reason: 'gmail_history_expired' | 'graph_delta_expired' | 'imap_uidvalidity_changed') {
    super(reason)
    this.name = 'MailboxProviderCursorExpiredError'
  }
}

export interface MailboxProviderReader {
  readPage(cursor: string | null): Promise<MailboxProviderPage>
}

export function normalizeHeaderMap(
  values: Array<{ name?: string | null; value?: string | null }>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const item of values) {
    const name = item.name?.trim().toLowerCase()
    const value = item.value?.trim()
    if (name && value && name.length <= 200 && value.length <= 4096) out[name] = value
  }
  return out
}

export function headerAddress(value: string | null | undefined): string {
  if (!value) return ''
  const bracketed = value.match(/<([^>]+)>/)?.[1]
  return (bracketed ?? value.split(',')[0] ?? '').trim().toLowerCase().slice(0, 320)
}

export function cleanMessageId(value: string | null | undefined): string | null {
  const clean = value?.replace(/[<>]/g, '').trim()
  return clean ? clean.slice(0, 998) : null
}

export function boundedText(value: string | null | undefined, max = 200_000): string {
  return (value ?? '').replace(/\0/g, '').slice(0, max)
}
