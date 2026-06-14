'use client'

import { useState, useEffect } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Switch } from '@open-mercato/ui/primitives/switch'
import { Badge } from '@open-mercato/ui/primitives/badge'
import { Headphones, Mail, Check, FileEdit, Lock, ArrowRight } from 'lucide-react'

type EmailConnection = { id: string; provider: string; email_address: string; is_primary: boolean }
type Settings = {
  enabled: boolean
  watchedConnectionIds: string[] | null
  replyMode: 'draft'
  signature: string | null
}

export default function CustomerServiceSettingsPage() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  const [enabled, setEnabled] = useState(false)
  // null = watch all connected mailboxes. An array = only those ids.
  const [watchedIds, setWatchedIds] = useState<string[] | null>(null)
  const [signature, setSignature] = useState('')

  const [connections, setConnections] = useState<EmailConnection[]>([])

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch('/api/customer-service/settings', { credentials: 'include' }).then(r => r.json()).catch(() => null),
      fetch('/api/email/connections', { credentials: 'include' }).then(r => r.json()).catch(() => null),
    ]).then(([settingsRes, connRes]) => {
      if (cancelled) return
      if (settingsRes?.ok && settingsRes.data) {
        const s: Settings = settingsRes.data
        setEnabled(!!s.enabled)
        setWatchedIds(Array.isArray(s.watchedConnectionIds) ? s.watchedConnectionIds : null)
        setSignature(s.signature || '')
      }
      if (connRes?.ok) setConnections(connRes.data || [])
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  function toggleMailbox(id: string) {
    setWatchedIds(prev => {
      // Starting from "all": selecting one mailbox narrows to just that one.
      if (prev === null) return [id]
      const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
      // Empty selection means watch all again.
      return next.length === 0 ? null : next
    })
  }

  async function save() {
    setSaving(true)
    setSaved(false)
    setError('')
    try {
      const res = await fetch('/api/customer-service/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          enabled,
          watchedConnectionIds: watchedIds,
          replyMode: 'draft',
          signature: signature.trim() || undefined,
        }),
      })
      const data = await res.json()
      if (data.ok) {
        setSaved(true)
        setTimeout(() => setSaved(false), 3000)
      } else {
        setError(data.error || 'Failed to save')
      }
    } catch {
      setError('Failed to save settings')
    }
    setSaving(false)
  }

  const watchingAll = watchedIds === null

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <Headphones className="size-5 text-muted-foreground" /> Customer Service
        </h1>
        <Button type="button" variant="outline" size="sm"
          onClick={() => window.location.href = '/backend/customer-service/queue'}>
          Review queue
          <ArrowRight className="size-3.5 ml-1" />
        </Button>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Let Noli draft replies to incoming customer emails. Every reply waits for your approval before it sends.
      </p>

      {saved && (
        <div className="mb-4 rounded-lg border border-[rgba(16,185,129,.26)] bg-[rgba(16,185,129,.10)] px-4 py-2 text-sm text-[#047857] dark:text-[#34d399] flex items-center gap-2">
          <Check className="size-4" /> Settings saved.
        </div>
      )}
      {error && (
        <div className="mb-4 rounded-lg border border-[rgba(239,68,68,.26)] bg-[rgba(239,68,68,.10)] px-4 py-2 text-sm text-[#b91c1c] dark:text-[#f87171]">
          {error}
        </div>
      )}

      {loading ? (
        <div className="rounded-lg border px-4 py-10 text-center text-sm text-muted-foreground">Loading...</div>
      ) : (
        <>
          {/* Enable */}
          <section className="mb-8">
            <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
              <Headphones className="size-4 text-muted-foreground" /> Status
            </h2>
            <div className="rounded-lg border">
              <div className="flex items-center justify-between px-4 py-3">
                <div className="min-w-0 flex-1 pr-4">
                  <p className="text-sm font-medium mb-0.5">Draft replies to customer emails</p>
                  <p className="text-xs text-muted-foreground">
                    When on, incoming emails get a drafted reply added to your review queue. Nothing is sent automatically.
                  </p>
                </div>
                <Switch checked={enabled} onCheckedChange={setEnabled} />
              </div>
            </div>
          </section>

          {/* Source mailboxes */}
          <section className="mb-8">
            <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
              <Mail className="size-4 text-muted-foreground" /> Mailboxes to watch
            </h2>
            <div className="rounded-lg border divide-y">
              <div className="px-4 py-3">
                <p className="text-xs text-muted-foreground">
                  Choose which connected mailboxes get drafted replies. Leave all unchecked to watch every mailbox.
                </p>
              </div>
              {connections.length === 0 ? (
                <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                  No mailboxes connected yet. Connect Gmail, Outlook, or another account in Settings first.
                </div>
              ) : (
                connections.map(conn => {
                  const checked = watchingAll ? false : (watchedIds?.includes(conn.id) ?? false)
                  return (
                    <label key={conn.id} className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-muted/30 transition">
                      <div className="flex items-center gap-3 min-w-0">
                        <input type="checkbox" checked={checked} onChange={() => toggleMailbox(conn.id)}
                          className="size-4 rounded border-input accent-[#2563eb]" />
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{conn.email_address}</p>
                          <p className="text-xs text-muted-foreground capitalize">{conn.provider}</p>
                        </div>
                      </div>
                      {conn.is_primary && <Badge variant="secondary">Primary</Badge>}
                    </label>
                  )
                })
              )}
              {connections.length > 0 && (
                <div className="px-4 py-2.5 bg-muted/30">
                  <p className="text-[11px] text-muted-foreground">
                    {watchingAll ? 'Watching all connected mailboxes.' : `Watching ${watchedIds?.length} selected mailbox${watchedIds?.length === 1 ? '' : 'es'}.`}
                  </p>
                </div>
              )}
            </div>
          </section>

          {/* Reply mode */}
          <section className="mb-8">
            <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
              <FileEdit className="size-4 text-muted-foreground" /> Reply mode
            </h2>
            <div className="rounded-lg border divide-y">
              <div className="flex items-center justify-between px-4 py-3 selected-card rounded-t-lg">
                <div className="flex items-center gap-3 min-w-0">
                  <FileEdit className="size-4 text-accent shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">Draft for approval</p>
                    <p className="text-xs text-muted-foreground">Every reply is drafted and waits in your review queue until you approve it.</p>
                  </div>
                </div>
                <Check className="size-4 text-accent shrink-0" />
              </div>
              <div className="flex items-center justify-between px-4 py-3 opacity-60">
                <div className="flex items-center gap-3 min-w-0">
                  <Lock className="size-4 text-muted-foreground shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">Auto-send</p>
                    <p className="text-xs text-muted-foreground">Send approved-style replies automatically.</p>
                  </div>
                </div>
                <Badge variant="secondary">Coming soon</Badge>
              </div>
            </div>
          </section>

          {/* Signature */}
          <section className="mb-8">
            <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
              <Mail className="size-4 text-muted-foreground" /> Signature
            </h2>
            <div className="rounded-lg border">
              <div className="px-4 py-3">
                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">
                  Signature <span className="normal-case font-normal">(optional)</span>
                </label>
                <textarea value={signature} onChange={e => setSignature(e.target.value)}
                  placeholder={'e.g.\nThanks,\nThe Acme Team'}
                  className="w-full rounded-md border bg-card px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring h-24" />
                <p className="text-[11px] text-muted-foreground mt-1.5">Added to the end of drafted replies. You can still edit each draft before sending.</p>
              </div>
            </div>
          </section>

          <div className="flex items-center gap-3">
            <Button type="button" onClick={save} disabled={saving}>
              {saving ? 'Saving...' : 'Save settings'}
            </Button>
            {saved && <span className="text-xs text-[#047857] dark:text-[#34d399] flex items-center gap-1"><Check className="size-3" /> Saved</span>}
          </div>
        </>
      )}
    </div>
  )
}
