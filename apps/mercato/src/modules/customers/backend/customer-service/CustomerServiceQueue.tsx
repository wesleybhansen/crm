'use client'

import { useState, useEffect } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Inbox, Send, X, Loader2, Settings, ChevronDown, ChevronUp } from 'lucide-react'

type QueueItem = {
  id: string
  proposalId: string
  createdAt: string
  summary: string | null
  contact: { id: string | null; name: string | null; email: string | null }
  conversationId: string | null
  lastInboundPreview: string | null
  lastInboundBody: string | null
  subject: string | null
  body: string | null
}

export type CustomerServiceQueueProps = {
  // When true, the queue shows a setup empty-state (no support inbox configured)
  // with a button that jumps to Settings instead of the default "no drafts" state.
  needsSetup?: boolean
  // Called when the user clicks the setup button in the empty-state.
  onGoToSettings?: () => void
}

export default function CustomerServiceQueue({ needsSetup = false, onGoToSettings }: CustomerServiceQueueProps) {
  const [loading, setLoading] = useState(true)
  const [items, setItems] = useState<QueueItem[]>([])
  // Edited reply bodies, keyed by item id.
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<Record<string, 'approve' | 'dismiss' | undefined>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  // Which items have the full incoming email expanded, keyed by item id.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  useEffect(() => {
    let cancelled = false
    fetch('/api/customer-service/queue', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (cancelled) return
        if (d.ok) {
          const list: QueueItem[] = d.data || []
          setItems(list)
          const initial: Record<string, string> = {}
          for (const it of list) initial[it.id] = it.body || ''
          setDrafts(initial)
        }
        setLoading(false)
      })
      .catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
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

  if (loading) {
    return (
      <div className="rounded-lg border px-4 py-10 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
        <Loader2 className="size-4 animate-spin" /> Loading queue...
      </div>
    )
  }

  // No support inbox configured yet: guide the user to Settings.
  if (needsSetup && items.length === 0) {
    return (
      <div className="rounded-lg border px-4 py-12 text-center">
        <Inbox className="size-8 text-muted-foreground/50 mx-auto mb-3" />
        <p className="text-sm font-medium mb-1">No customer service email set up yet</p>
        <p className="text-xs text-muted-foreground mb-4 max-w-sm mx-auto">
          Connect a support inbox so Noli can watch for incoming customer emails and draft replies for you.
        </p>
        <Button type="button" size="sm" onClick={onGoToSettings}>
          <Settings className="size-3.5 mr-1" />
          Set up your customer service email
        </Button>
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="rounded-lg border px-4 py-12 text-center">
        <Inbox className="size-8 text-muted-foreground/50 mx-auto mb-3" />
        <p className="text-sm font-medium mb-1">No drafts waiting</p>
        <p className="text-xs text-muted-foreground">
          New drafted replies will appear here when customers email you.
        </p>
      </div>
    )
  }

  return (
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

            {/* Incoming message preview, with an optional full-email expansion. */}
            {item.lastInboundPreview && (() => {
              const isExpanded = !!expanded[item.id]
              const fullBody = item.lastInboundBody || ''
              // Only offer the toggle when the full body adds something beyond the snippet.
              const canExpand = !!fullBody && fullBody.trim().length > (item.lastInboundPreview || '').trim().length
              return (
                <div className="px-4 py-3 bg-muted/30">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium mb-1.5">They wrote</p>
                  <p className="text-sm text-foreground/80 leading-relaxed whitespace-pre-wrap">
                    {isExpanded && canExpand ? fullBody : item.lastInboundPreview}
                  </p>
                  {canExpand && (
                    <button
                      type="button"
                      onClick={() => setExpanded(prev => ({ ...prev, [item.id]: !prev[item.id] }))}
                      className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition"
                    >
                      {isExpanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                      {isExpanded ? 'Show less' : 'Show full email'}
                    </button>
                  )}
                </div>
              )
            })()}

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
  )
}
