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

  useEffect(() => {
    const params = filter !== 'all' ? `?direction=${filter}` : ''
    fetch(`/api/email/messages${params}`)
      .then((r) => r.json())
      .then((d) => { if (d.ok) setMessages(d.data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [filter])

  const statusColors: Record<string, string> = {
    draft: 'text-muted-foreground',
    queued: 'text-amber-600 dark:text-amber-400',
    sent: 'text-blue-600 dark:text-blue-400',
    delivered: 'text-blue-600 dark:text-blue-400',
    opened: 'text-emerald-600 dark:text-emerald-400',
    clicked: 'text-emerald-700 dark:text-emerald-300',
    bounced: 'text-red-600 dark:text-red-400',
    failed: 'text-red-600 dark:text-red-400',
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold">{translate('email.messages.title', 'Email')}</h1>
          <p className="text-sm text-muted-foreground mt-1">{messages.length} messages</p>
        </div>
        <Button type="button" onClick={() => setShowCompose(true)}>
          <Send className="size-4 mr-2" /> {translate('email.messages.compose', 'Compose')}
        </Button>
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
                msg.direction === 'inbound' ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400' : 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400'
              }`}>
                {msg.direction === 'inbound' ? <Inbox className="size-4" /> : <Send className="size-4" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">{msg.subject}</span>
                  <span className={`text-xs ${statusColors[msg.status] || ''}`}>{msg.status}</span>
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
          contactName=""
          contactEmail=""
          onClose={() => setShowCompose(false)}
          onSent={() => { setShowCompose(false); loadMessages() }}
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
