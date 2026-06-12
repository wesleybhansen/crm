'use client'

import { useState, useEffect } from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { translateWithFallback } from '@open-mercato/shared/lib/i18n/translate'
import { Button } from '@open-mercato/ui/primitives/button'
import { Mail, Send, Inbox } from 'lucide-react'
import { EmailComposeModal } from '@/components/EmailComposeModal'

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
}

export default function EmailPage() {
  const t = useT()
  const translate = (key: string, fallback: string) => translateWithFallback(t, key, fallback)
  const [messages, setMessages] = useState<EmailMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'all' | 'inbound' | 'outbound'>('all')
  const [showCompose, setShowCompose] = useState(false)
  const [composeTo, setComposeTo] = useState('')
  const [composeSubject, setComposeSubject] = useState('')
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
      setShowCompose(true)
      // Clean up URL
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [])

  useEffect(() => {
    const params = filter !== 'all' ? `?direction=${filter}` : ''
    fetch(`/api/email/messages${params}`)
      .then((r) => r.json())
      .then((d) => { if (d.ok) setMessages(d.data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [filter])

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
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold">{translate('email.messages.title', 'Email')}</h1>
          <p className="text-sm text-muted-foreground mt-1">{messages.length} messages</p>
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

      <div className="flex gap-2 mb-4">
        {(['all', 'inbound', 'outbound'] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium border transition ${
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

      {loading ? (
        <div className="text-muted-foreground text-sm">Loading...</div>
      ) : messages.length === 0 ? (
        <div className="rounded-lg border p-12 text-center">
          <Mail className="size-10 mx-auto mb-3 text-muted-foreground/50" />
          <p className="text-muted-foreground">{translate('email.messages.empty', 'No emails yet')}</p>
        </div>
      ) : (
        <div className="rounded-lg border divide-y">
          {messages.map((msg) => (
            <div key={msg.id} className="flex items-center gap-4 px-4 py-3 hover:bg-muted/30 cursor-pointer">
              <div className={`size-8 rounded-full flex items-center justify-center text-xs ${
                msg.direction === 'inbound' ? 'bg-[rgba(37,99,235,.08)] text-[#1d4ed8] dark:bg-[rgba(59,130,246,.15)] dark:text-[#93c5fd]' : 'bg-[rgba(16,185,129,.10)] text-[#047857] dark:bg-[rgba(16,185,129,.14)] dark:text-[#34d399]'
              }`}>
                {msg.direction === 'inbound' ? <Inbox className="size-4" /> : <Send className="size-4" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">{msg.subject}</span>
                  <span className={`inline-flex h-[21px] items-center px-2 rounded-full border font-mono text-[10px] font-semibold uppercase tracking-[.07em] ${statusColors[msg.status] || 'bg-[rgba(16,16,18,.07)] text-[rgba(16,16,18,.62)] border-[rgba(16,16,18,.16)] dark:bg-[rgba(255,255,255,.10)] dark:text-[rgba(255,255,255,.6)] dark:border-[rgba(255,255,255,.14)]'}`}>{msg.status}</span>
                </div>
                <div className="text-xs text-muted-foreground truncate">
                  {msg.direction === 'inbound' ? `From: ${msg.from_address}` : `To: ${msg.to_address}`}
                </div>
              </div>
              <div className="text-xs text-muted-foreground whitespace-nowrap">
                {new Date(msg.created_at).toLocaleDateString()}
              </div>
            </div>
          ))}
        </div>
      )}

      {showCompose && (
        <EmailComposeModal
          contactName={composeName}
          contactEmail={composeTo}
          contactId={composeContactId || undefined}
          initialSubject={composeSubject}
          onClose={() => { setShowCompose(false); setComposeTo(''); setComposeSubject(''); setComposeContactId(''); setComposeName('') }}
          onSent={() => { setShowCompose(false); setComposeTo(''); setComposeSubject(''); setComposeContactId(''); setComposeName(''); loadMessages() }}
        />
      )}
    </div>
  )

  function loadMessages() {
    const params = filter !== 'all' ? `?direction=${filter}` : ''
    fetch(`/api/email/messages${params}`, { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => { if (d.ok) setMessages(d.data) })
      .catch(() => {})
  }
}
