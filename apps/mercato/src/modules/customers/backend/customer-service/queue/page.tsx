'use client'

import { useState, useEffect } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Headphones, Inbox, Send, X, Check, Settings, Loader2 } from 'lucide-react'

type QueueItem = {
  id: string
  proposalId: string
  createdAt: string
  summary: string | null
  contact: { id: string | null; name: string | null; email: string | null }
  conversationId: string | null
  lastInboundPreview: string | null
  subject: string | null
  body: string | null
}

export default function CustomerServiceQueuePage() {
  const [loading, setLoading] = useState(true)
  const [items, setItems] = useState<QueueItem[]>([])
  // Edited reply bodies, keyed by item id.
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<Record<string, 'approve' | 'dismiss' | undefined>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    fetch('/api/customer-service/queue', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (d.ok) {
          const list: QueueItem[] = d.data || []
          setItems(list)
          const initial: Record<string, string> = {}
          for (const it of list) initial[it.id] = it.body || ''
          setDrafts(initial)
        }
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  function removeItem(id: string) {
    setItems(prev => prev.filter(i => i.id !== id))
  }

  async function approve(id: string) {
    setBusy(prev => ({ ...prev, [id]: 'approve' }))
    setErrors(prev => ({ ...prev, [id]: '' }))
    try {
      const res = await fetch(`/api/customer-service/drafts/${id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ body: drafts[id] ?? '' }),
      })
      const data = await res.json()
      if (data.ok) {
        removeItem(id)
      } else {
        setErrors(prev => ({ ...prev, [id]: data.error || 'Failed to send' }))
      }
    } catch {
      setErrors(prev => ({ ...prev, [id]: 'Failed to send reply' }))
    }
    setBusy(prev => ({ ...prev, [id]: undefined }))
  }

  async function dismiss(id: string) {
    setBusy(prev => ({ ...prev, [id]: 'dismiss' }))
    setErrors(prev => ({ ...prev, [id]: '' }))
    try {
      const res = await fetch(`/api/customer-service/drafts/${id}/dismiss`, {
        method: 'POST',
        credentials: 'include',
      })
      const data = await res.json()
      if (data.ok) {
        removeItem(id)
      } else {
        setErrors(prev => ({ ...prev, [id]: data.error || 'Failed to dismiss' }))
      }
    } catch {
      setErrors(prev => ({ ...prev, [id]: 'Failed to dismiss draft' }))
    }
    setBusy(prev => ({ ...prev, [id]: undefined }))
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <Headphones className="size-5 text-muted-foreground" /> Review queue
        </h1>
        <Button type="button" variant="outline" size="sm"
          onClick={() => window.location.href = '/backend/customer-service'}>
          <Settings className="size-3.5 mr-1" />
          Settings
        </Button>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Review each drafted reply, edit it if you like, then approve to send or dismiss it.
      </p>

      {loading ? (
        <div className="rounded-lg border px-4 py-10 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
          <Loader2 className="size-4 animate-spin" /> Loading queue...
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border px-4 py-12 text-center">
          <Inbox className="size-8 text-muted-foreground/50 mx-auto mb-3" />
          <p className="text-sm font-medium mb-1">No drafts waiting</p>
          <p className="text-xs text-muted-foreground">
            New drafted replies will appear here when customers email you.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {items.map(item => {
            const itemBusy = busy[item.id]
            return (
              <div key={item.id} className="rounded-lg border divide-y">
                {/* Contact header */}
                <div className="flex items-center justify-between px-4 py-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="size-8 rounded-full bg-primary/10 flex items-center justify-center text-xs font-semibold text-primary shrink-0">
                      {(item.contact.name || item.contact.email || '?')[0].toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{item.contact.name || item.contact.email || 'Unknown contact'}</p>
                      {item.contact.email && item.contact.name && (
                        <p className="text-xs text-muted-foreground truncate">{item.contact.email}</p>
                      )}
                    </div>
                  </div>
                  {item.subject && (
                    <span className="text-xs text-muted-foreground truncate max-w-[40%] hidden sm:block">{item.subject}</span>
                  )}
                </div>

                {/* Incoming message preview */}
                {item.lastInboundPreview && (
                  <div className="px-4 py-3 bg-muted/30">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium mb-1.5">They wrote</p>
                    <p className="text-sm text-foreground/80 leading-relaxed whitespace-pre-wrap">{item.lastInboundPreview}</p>
                  </div>
                )}

                {/* Editable drafted reply */}
                <div className="px-4 py-3">
                  <label className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium block mb-1.5">Drafted reply</label>
                  <textarea
                    value={drafts[item.id] ?? ''}
                    onChange={e => setDrafts(prev => ({ ...prev, [item.id]: e.target.value }))}
                    className="w-full rounded-md border bg-card px-3 py-2.5 text-sm leading-relaxed resize-y focus:outline-none focus:ring-1 focus:ring-ring min-h-[120px]"
                    disabled={!!itemBusy}
                  />
                  {errors[item.id] && (
                    <p className="text-xs text-[#b91c1c] dark:text-[#f87171] mt-2">{errors[item.id]}</p>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center justify-end gap-2 px-4 py-3">
                  <Button type="button" variant="ghost" size="sm" onClick={() => dismiss(item.id)} disabled={!!itemBusy}>
                    {itemBusy === 'dismiss' ? <Loader2 className="size-3.5 mr-1 animate-spin" /> : <X className="size-3.5 mr-1" />}
                    Dismiss
                  </Button>
                  <Button type="button" size="sm" onClick={() => approve(item.id)} disabled={!!itemBusy || !(drafts[item.id] ?? '').trim()}>
                    {itemBusy === 'approve' ? <Loader2 className="size-3.5 mr-1 animate-spin" /> : <Send className="size-3.5 mr-1" />}
                    Approve and send
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
