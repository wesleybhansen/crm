/**
 * Paging math for the Email inbox. The messages API pages by `page` and
 * `pageSize` and reports `total`; the inbox shows the real total and a
 * "1 to 20 of 444" range with Previous / Next.
 */
export type InboxPagination = { page: number; pageSize: number; total: number }

export type InboxPageSummary = {
  page: number
  totalPages: number
  from: number
  to: number
  hasPrev: boolean
  hasNext: boolean
}

function positiveInt(value: unknown, fallback: number): number {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function inboxPageSummary(input: InboxPagination): InboxPageSummary {
  const pageSize = positiveInt(input.pageSize, 20)
  const total = Math.max(0, Math.floor(Number(input.total)) || 0)
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const page = Math.min(positiveInt(input.page, 1), totalPages)
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(total, page * pageSize)
  return { page, totalPages, from, to, hasPrev: page > 1, hasNext: page < totalPages }
}

/** "1 message", "444 messages". */
export function messageCountLabel(total: number): string {
  const n = Math.max(0, Math.floor(Number(total)) || 0)
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'message' : 'messages'}`
}

/** "1 to 20 of 444"; empty when there is nothing to show. */
export function inboxRangeLabel(summary: InboxPageSummary, total: number): string {
  if (!total) return ''
  return `${summary.from.toLocaleString('en-US')} to ${summary.to.toLocaleString('en-US')} of ${Math.floor(total).toLocaleString('en-US')}`
}

/** Query string for the messages API. */
export function inboxMessagesQuery(opts: { page: number; pageSize: number; direction: 'all' | 'inbound' | 'outbound' }): string {
  const params = new URLSearchParams()
  params.set('page', String(positiveInt(opts.page, 1)))
  params.set('pageSize', String(positiveInt(opts.pageSize, 20)))
  if (opts.direction !== 'all') params.set('direction', opts.direction)
  return params.toString()
}
