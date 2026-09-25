'use client'

import { useState, useEffect, useCallback } from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { translateWithFallback } from '@open-mercato/shared/lib/i18n/translate'
import { Button } from '@open-mercato/ui/primitives/button'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@open-mercato/ui/primitives/dialog'
import { Mail, Send, Inbox, ChevronLeft, ChevronRight, Reply } from 'lucide-react'
import { EmailComposeModal } from '@/components/EmailComposeModal'
import { inboxMessagesQuery, inboxPageSummary, inboxRangeLabel, messageCountLabel } from '../../lib/inboxPaging'

const PAGE_SIZE = 20

type EmailMessage = {
  id: string
  direction: string
  from_address: string
  to_address: string
  subject: string
  status: string
  created_at: string
  sent_at: string | null
  opened_at: string | null
  clicked_at: string | null
  cc?: string | null
  body_html?: string | null
  body_text?: string | null
}

type MessagesResponse = {
  ok: boolean
  data: EmailMessage[]
  pagination?: { page: number; pageSize: number; total: number; totalPages: number }
}

/**
 * The message body in a sandboxed frame: no scripts, no same-origin access,
 * links open in a new tab. Inbound HTML is sanitised on ingest; the sandbox is
 * a second wall.
 */
function MessageBody({ msg }: { msg: EmailMessage }) {
  if (msg.body_html && msg.body_html.trim()) {
    const doc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>body{font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:12px;color:#111;word-wrap:break-word;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}</style></head><body>${msg.body_html}</body></html>`
    return (
      <iframe
        title="Email content"
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        srcDoc={doc}
        className="w-full min-h-[45vh] rounded-md border bg-white"
      />
    )
  }
  if (msg.body_text && msg.body_text.trim()) {
    return <div className="whitespace-pre-wrap break-words text-sm leading-relaxed rounded-md border px-3 py-2.5">{msg.body_text}</div>
  }
  return <p className="text-sm text-muted-foreground">This email has no content.</p>
}

type FirstValueResponse = {
  ok: boolean
  data: { ready: true; subject: string; body: string } | null
}

export default function EmailPage() {
  const t = useT()
  const translate = (key: string, fallback: string) => translateWithFallback(t, key, fallback)
  const [messages, setMessages] = useState<EmailMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [filter, setFilter] = useState<'all' | 'inbound' | 'outbound'>('all')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [openMessage, setOpenMessage] = useState<EmailMessage | null>(null)
  const [showCompose, setShowCompose] = useState(false)
  const [composeTo, setComposeTo] = useState('')
  const [composeSubject, setComposeSubject] = useState('')
  const [composeBody, setComposeBody] = useState('')
  const [composeContactId, setComposeContactId] = useState('')
  const [composeName, setComposeName] = useState('')

  useEffect(() => {
    // Check for compose query params (from "Follow up" button, etc.)
    const params = new URLSearchParams(window.location.search)
    if (params.get('compose') === 'true') {
      setComposeTo(params.get('to') || '')
      setComposeSubject(params.get('subject') || '')
      setComposeContactId(params.get('contactId') || '')
      setComposeName(params.get('name') || '')
      const template = params.get('template')
      if (template === 'first-value') {
        apiCall<FirstValueResponse>('/api/onboarding/first-value', { credentials: 'include' })
          .then(({ result }) => {
            if (result?.ok && result.data?.ready) {
              setComposeSubject(result.data.subject || '')
              setComposeBody(result.data.body || '')
            }
            setShowCompose(true)
          })
          .catch(() => setShowCompose(true))
      } else {
        setShowCompose(true)
      }
    }
  }, [])

  const closeCompose = () => {
    setShowCompose(false)
    setComposeTo('')
    setComposeSubject('')
    setComposeBody('')
    setComposeContactId('')
    setComposeName('')
    window.history.replaceState({}, '', window.location.pathname)
  }

  const loadMessages = useCallback(() => {
    setLoading(true)
    setLoadError('')
    fetch(`/api/email/messages?${inboxMessagesQuery({ page, pageSize: PAGE_SIZE, direction: filter })}`, { credentials: 'include' })
      .then((r) => r.json() as Promise<MessagesResponse>)
      .then((d) => {
        if (d.ok) {
          setMessages(d.data)
          setTotal(d.pagination?.total ?? d.data.length)
        } else {
          setLoadError('Could not load your email. Try again in a moment.')
        }
      })
      .catch(() => setLoadError('Could not load your email. Try again in a moment.'))
      .finally(() => setLoading(false))
  }, [page, filter])

  useEffect(() => { loadMessages() }, [loadMessages])

  const summary = inboxPageSummary({ page, pageSize: PAGE_SIZE, total })

  const replyTo = (msg: EmailMessage) => {
    setOpenMessage(null)
    setComposeTo(msg.direction === 'inbound' ? msg.from_address : msg.to_address)
    setComposeSubject(/^re:/i.test(msg.subject || '') ? msg.subject : `Re: ${msg.subject || ''}`.trim())
    setComposeBody('')
    setComposeContactId('')
    setComposeName('')
    setShowCompose(true)
  }

  const statusColors: Record<string, string> = {
    draft: 'bg-[rgba(16,16,18,.07)] text-[rgba(16,16,18,.62)] border-[rgba(16,16,18,.16)] dark:bg-[rgba(255,255,255,.10)] dark:text-[rgba(255,255,255,.6)] dark:border-[rgba(255,255,255,.14)]',
    queued: 'bg-[rgba(217,119,6,.10)] text-[#b45309] border-[rgba(217,119,6,.26)] dark:bg-[rgba(245,158,11,.13)] dark:text-[#fbbf24] dark:border-[rgba(245,158,11,.30)]',
    sent: 'bg-[rgba(37,99,235,.08)] text-[#1d4ed8] border-[rgba(37,99,235,.22)] dark:bg-[rgba(59,130,246,.15)] dark:text-[#93c5fd] dark:border-[rgba(59,130,246,.30)]',
    delivered: 'bg-[rgba(37,99,235,.08)] text-[#1d4ed8] border-[rgba(37,99,235,.22)] dark:bg-[rgba(59,130,246,.15)] dark:text-[#93c5fd] dark:border-[rgba(59,130,246,.30)]',
    opened: 'bg-[rgba(16,185,129,.10)] text-[#047857] border-[rgba(16,185,129,.26)] dark:bg-[rgba(16,185,129,.14)] dark:text-[#34d399] dark:border-[rgba(16,185,129,.30)]',
    clicked: 'bg-[rgba(16,185,129,.10)] text-[#047857] border-[rgba(16,185,129,.26)] dark:bg-[rgba(16,185,129,.14)] dark:text-[#34d399] dark:border-[rgba(16,185,129,.30)]',
    bounced: 'bg-[rgba(239,68,68,.10)] text-[#b91c1c] border-[rgba(239,68,68,.24)] dark:bg-[rgba(239,68,68,.13)] dark:text-[#f87171] dark:border-[rgba(239,68,68,.30)]',
    failed: 'bg-[rgba(239,68,68,.10)] text-[#b91c1c] border-[rgba(239,68,68,.24)] dark:bg-[rgba(239,68,68,.13)] dark:text-[#f87171] dark:border-[rgba(239,68,68,.30)]',
  }

  return (
    <div className="p-4 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-6">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">{translate('email.messages.title', 'Email')}</h1>
          <p className="text-sm text-muted-foreground mt-1">{loading && !total ? 'Loading...' : messageCountLabel(total)}</p>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => window.location.href = '/backend/campaigns'}>
            <Mail className="size-4 mr-2" /> Campaigns
          </Button>
          <Button type="button" onClick={() => setShowCompose(true)}>
            <Send className="size-4 mr-2" /> {translate('email.messages.compose', 'Compose')}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mb-4" role="group" aria-label="Filter messages">
        {(['all', 'inbound', 'outbound'] as const).map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => { setFilter(f); setPage(1) }}
            className={`inline-flex items-center min-h-10 sm:min-h-0 px-3 py-1.5 rounded-full text-xs font-medium border transition ${
              filter === f ? 'bg-accent/10 border-accent text-accent' : 'border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            {f === 'all' && <Mail className="size-3 inline mr-1" />}
            {f === 'inbound' && <Inbox className="size-3 inline mr-1" />}
            {f === 'outbound' && <Send className="size-3 inline mr-1" />}
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {loadError ? (
        <div className="rounded-lg border px-4 py-6 text-sm text-[#b91c1c] dark:text-[#f87171] flex items-center justify-between gap-3">
          <span>{loadError}</span>
          <Button type="button" size="sm" variant="outline" onClick={loadMessages}>Try again</Button>
        </div>
      ) : loading && messages.length === 0 ? (
        <div className="text-muted-foreground text-sm">Loading...</div>
      ) : messages.length === 0 ? (
        <div className="rounded-lg border p-12 text-center">
          <Mail className="size-10 mx-auto mb-3 text-muted-foreground/50" />
          <p className="text-muted-foreground">{translate('email.messages.empty', 'No emails yet')}</p>
        </div>
      ) : (
        <>
        <div className={`rounded-lg border divide-y ${loading ? 'opacity-60' : ''}`}>
          {messages.map((msg) => (
            <button
              key={msg.id}
              type="button"
              onClick={() => setOpenMessage(msg)}
              aria-label={`Open email: ${msg.subject || '(no subject)'}`}
              className="w-full text-left flex items-center gap-3 sm:gap-4 px-3 sm:px-4 py-3 hover:bg-muted/30 focus-visible:outline-none focus-visible:bg-muted/40 cursor-pointer"
            >
              <div className={`size-8 shrink-0 rounded-full flex items-center justify-center text-xs ${
                msg.direction === 'inbound' ? 'bg-[rgba(37,99,235,.08)] text-[#1d4ed8] dark:bg-[rgba(59,130,246,.15)] dark:text-[#93c5fd]' : 'bg-[rgba(16,185,129,.10)] text-[#047857] dark:bg-[rgba(16,185,129,.14)] dark:text-[#34d399]'
              }`}>
                {msg.direction === 'inbound' ? <Inbox className="size-4" /> : <Send className="size-4" />}
              </div>
              <div className="flex-1 min-w-0">
                {/* Phone: subject wraps to two lines and the status sits under it. */}
                <div className="flex flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-2">
                  <span className="text-sm font-medium line-clamp-2 sm:line-clamp-1 break-words min-w-0 max-w-full">{msg.subject || '(no subject)'}</span>
                  <span className={`shrink-0 inline-flex h-[21px] items-center px-2 rounded-full border font-mono text-[10px] font-semibold uppercase tracking-[.07em] ${statusColors[msg.status] || 'bg-[rgba(16,16,18,.07)] text-[rgba(16,16,18,.62)] border-[rgba(16,16,18,.16)] dark:bg-[rgba(255,255,255,.10)] dark:text-[rgba(255,255,255,.6)] dark:border-[rgba(255,255,255,.14)]'}`}>{msg.status}</span>
                </div>
                <div className="text-xs text-muted-foreground truncate">
                  {msg.direction === 'inbound' ? `From: ${msg.from_address}` : `To: ${msg.to_address}`}
                </div>
              </div>
              <div className="text-xs text-muted-foreground whitespace-nowrap self-start sm:self-center">
                {new Date(msg.created_at).toLocaleDateString()}
              </div>
            </button>
          ))}
        </div>
        {summary.totalPages > 1 && (
          <nav aria-label="Email pages" className="flex items-center justify-between gap-3 mt-4">
            <span className="text-xs text-muted-foreground">{inboxRangeLabel(summary, total)}</span>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" className="min-h-10 sm:min-h-0"
                aria-label="Previous page" disabled={!summary.hasPrev || loading}
                onClick={() => setPage(summary.page - 1)}>
                <ChevronLeft className="size-4" /><span className="hidden sm:inline ml-1">Previous</span>
              </Button>
              <span className="text-xs text-muted-foreground whitespace-nowrap">Page {summary.page} of {summary.totalPages}</span>
              <Button type="button" variant="outline" size="sm" className="min-h-10 sm:min-h-0"
                aria-label="Next page" disabled={!summary.hasNext || loading}
                onClick={() => setPage(summary.page + 1)}>
                <span className="hidden sm:inline mr-1">Next</span><ChevronRight className="size-4" />
              </Button>
            </div>
          </nav>
        )}
        </>
      )}

      <Dialog open={!!openMessage} onOpenChange={(open) => { if (!open) setOpenMessage(null) }}>
        {openMessage && (
          <DialogContent className="sm:max-w-2xl max-h-[90vh]">
            <DialogHeader className="pr-8 text-left">
              <DialogTitle className="leading-snug break-words">{openMessage.subject || '(no subject)'}</DialogTitle>
              <DialogDescription asChild>
                <div className="space-y-0.5 text-xs break-words">
                  <div>From: {openMessage.from_address || 'Not recorded'}</div>
                  <div>To: {openMessage.to_address || 'Not recorded'}</div>
                  {openMessage.cc ? <div>Cc: {openMessage.cc}</div> : null}
                  <div>{new Date(openMessage.sent_at || openMessage.created_at).toLocaleString()} · <span className="uppercase tracking-[.05em]">{openMessage.status}</span></div>
                </div>
              </DialogDescription>
            </DialogHeader>
            <MessageBody msg={openMessage} />
            <div className="flex justify-end">
              <Button type="button" size="sm" className="min-h-10 sm:min-h-0" onClick={() => replyTo(openMessage)}>
                <Reply className="size-4 mr-1" /> {openMessage.direction === 'inbound' ? 'Reply' : 'Follow up'}
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>

      {showCompose && (
        <EmailComposeModal
          contactName={composeName}
          contactEmail={composeTo}
          contactId={composeContactId || undefined}
          initialSubject={composeSubject}
          initialBody={composeBody}
          onClose={closeCompose}
          onSent={() => { closeCompose(); loadMessages() }}
        />
      )}
    </div>
  )
}
