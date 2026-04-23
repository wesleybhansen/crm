'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiCall, apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Spinner } from '@open-mercato/ui/primitives/spinner'

type Subscription = {
  id: string
  event: string
  targetUrl: string
  secret: string | null
  isActive: boolean
  createdAt: string
  updatedAt: string
}

type EventDef = {
  id: string
  label: string
  category: string
  description: string
}

type Delivery = {
  id: string
  subscriptionId: string
  event: string
  statusCode: number | null
  responseBody: string | null
  attempt: number
  status: 'delivered' | 'failed' | 'pending'
  createdAt: string
}

export default function WebhooksSettingsPage() {
  const [subs, setSubs] = useState<Subscription[]>([])
  const [events, setEvents] = useState<EventDef[]>([])
  const [deliveries, setDeliveries] = useState<Delivery[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [newEvent, setNewEvent] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const [message, setMessage] = useState<string | null>(null)

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const [subsRes, eventsRes, deliveriesRes] = await Promise.all([
        apiCall<{ data: Subscription[] }>('/api/webhooks/subscriptions', undefined, { fallback: { data: [] } }),
        apiCall<{ data: EventDef[] }>('/api/webhooks/events', undefined, { fallback: { data: [] } }),
        apiCall<{ data: Delivery[] }>('/api/webhooks/deliveries?pageSize=20', undefined, { fallback: { data: [] } }),
      ])
      setSubs(subsRes?.data ?? [])
      setEvents(eventsRes?.data ?? [])
      setDeliveries(deliveriesRes?.data ?? [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadAll() }, [loadAll])

  const eventsByCategory = useMemo(() => {
    const grouped: Record<string, EventDef[]> = {}
    for (const event of events) {
      if (!grouped[event.category]) grouped[event.category] = []
      grouped[event.category].push(event)
    }
    return grouped
  }, [events])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setMessage(null)
    if (!newEvent || !newUrl) { setMessage('Pick an event and enter a URL.'); return }
    setCreating(true)
    try {
      await apiCallOrThrow('/api/webhooks/subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: newEvent, targetUrl: newUrl }),
      })
      setNewEvent('')
      setNewUrl('')
      await loadAll()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Failed to create subscription')
    } finally {
      setCreating(false)
    }
  }

  async function handleToggle(sub: Subscription) {
    await apiCallOrThrow('/api/webhooks/subscriptions', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: sub.id, isActive: !sub.isActive }),
    })
    await loadAll()
  }

  async function handleDelete(sub: Subscription) {
    if (!confirm(`Delete subscription for ${sub.event}?`)) return
    await apiCallOrThrow(`/api/webhooks/subscriptions?id=${sub.id}`, { method: 'DELETE' })
    await loadAll()
  }

  async function handleRotate(sub: Subscription) {
    if (!confirm('Rotate the signing secret? The old secret will stop working immediately.')) return
    const res = await apiCallOrThrow<{ data: { secret: string } }>(`/api/webhooks/subscriptions/${sub.id}/rotate-secret`, { method: 'POST' })
    alert(`New secret:\n\n${res.data.secret}\n\nStore this securely — it won't be shown again this way.`)
    await loadAll()
  }

  async function handleTest(sub: Subscription) {
    setMessage(`Sending test to ${sub.targetUrl}…`)
    try {
      const res = await apiCallOrThrow<{ data: { ok: boolean; status: number | null; body: string; error?: string } }>(
        `/api/webhooks/subscriptions/${sub.id}/test`,
        { method: 'POST' },
      )
      const d = res.data
      if (d.ok) setMessage(`Test delivered: HTTP ${d.status}`)
      else if (d.error) setMessage(`Test failed: ${d.error}`)
      else setMessage(`Test failed: HTTP ${d.status}`)
      await loadAll()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Test failed')
    }
  }

  if (loading) return <div className="p-6"><Spinner className="h-4 w-4" /></div>

  return (
    <div className="mx-auto max-w-4xl px-6 py-6 space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Webhooks</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Subscribe external URLs to CRM events. Each POST is signed with HMAC-SHA256 and retried up to 3 times on failure.
        </p>
      </header>

      {message && (
        <div className="rounded-lg border bg-accent/5 px-3 py-2 text-xs text-muted-foreground">{message}</div>
      )}

      <section className="rounded-xl border bg-card p-5">
        <h2 className="mb-4 text-sm font-semibold">Add Subscription</h2>
        <form onSubmit={handleCreate} className="space-y-3">
          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Event</label>
            <select
              value={newEvent}
              onChange={(e) => setNewEvent(e.target.value)}
              className="h-9 w-full rounded-lg border bg-background px-2 text-sm"
            >
              <option value="">— pick an event —</option>
              {Object.entries(eventsByCategory).map(([cat, evts]) => (
                <optgroup label={cat} key={cat}>
                  {evts.map((ev) => (
                    <option key={ev.id} value={ev.id}>{ev.label} ({ev.id})</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Target URL</label>
            <Input
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              placeholder="https://example.com/webhook"
              className="h-9 text-sm"
            />
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={creating}>
              {creating ? 'Creating…' : 'Create Subscription'}
            </Button>
          </div>
        </form>
      </section>

      <section className="rounded-xl border bg-card p-5">
        <h2 className="mb-4 text-sm font-semibold">Active Subscriptions ({subs.length})</h2>
        {subs.length === 0 ? (
          <p className="text-xs text-muted-foreground">No subscriptions yet.</p>
        ) : (
          <div className="space-y-2">
            {subs.map((sub) => (
              <div key={sub.id} className="rounded-lg border p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={`inline-block h-2 w-2 rounded-full ${sub.isActive ? 'bg-green-500' : 'bg-muted-foreground/40'}`} />
                      <span className="text-sm font-medium">{sub.event}</span>
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">{sub.targetUrl}</p>
                    {sub.secret && (
                      <p className="mt-1 text-[10px] font-mono text-muted-foreground/70">secret: {sub.secret.slice(0, 12)}…</p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button type="button" size="sm" variant="outline" onClick={() => handleTest(sub)}>Send Test</Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => handleToggle(sub)}>
                      {sub.isActive ? 'Pause' : 'Activate'}
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => handleRotate(sub)}>Rotate Secret</Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => handleDelete(sub)}>Delete</Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-xl border bg-card p-5">
        <h2 className="mb-4 text-sm font-semibold">Recent Deliveries ({deliveries.length})</h2>
        {deliveries.length === 0 ? (
          <p className="text-xs text-muted-foreground">No deliveries yet. Send a test or trigger an event to see entries here.</p>
        ) : (
          <div className="space-y-1.5 max-h-96 overflow-y-auto">
            {deliveries.map((d) => (
              <div key={d.id} className="rounded-md border px-3 py-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`inline-block h-1.5 w-1.5 rounded-full flex-shrink-0 ${d.status === 'delivered' ? 'bg-green-500' : d.status === 'failed' ? 'bg-red-500' : 'bg-yellow-500'}`} />
                    <span className="font-mono font-medium">{d.event}</span>
                    <span className="text-muted-foreground">attempt {d.attempt}</span>
                    {d.statusCode !== null && <span className="text-muted-foreground">HTTP {d.statusCode}</span>}
                  </div>
                  <span className="text-muted-foreground flex-shrink-0">{new Date(d.createdAt).toLocaleString()}</span>
                </div>
                {d.responseBody && <p className="mt-1 truncate text-muted-foreground/80">{d.responseBody}</p>}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
