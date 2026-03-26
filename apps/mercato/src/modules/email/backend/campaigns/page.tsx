'use client'

import { useState, useEffect } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Plus, Send, Mail, X, Loader2, Users, Eye, Sparkles } from 'lucide-react'

type Campaign = {
  id: string; name: string; subject: string; status: string
  stats: string; created_at: string; sent_at: string | null
}

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [tagFilter, setTagFilter] = useState('')
  const [creating, setCreating] = useState(false)
  const [sending, setSending] = useState<string | null>(null)
  const [drafting, setDrafting] = useState(false)

  useEffect(() => { loadCampaigns() }, [])

  function loadCampaigns() {
    fetch('/api/campaigns', { credentials: 'include' })
      .then(r => r.json()).then(d => { if (d.ok) setCampaigns(d.data || []); setLoading(false) }).catch(() => setLoading(false))
  }

  async function createCampaign() {
    if (!name.trim() || !subject.trim() || !body.trim()) return
    setCreating(true)
    try {
      const res = await fetch('/api/campaigns', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({
          name, subject,
          bodyHtml: `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:20px">${body.replace(/\n/g, '<br>')}</body></html>`,
          segmentFilter: tagFilter ? { tag: tagFilter } : null,
        }),
      })
      const data = await res.json()
      if (data.ok) { setName(''); setSubject(''); setBody(''); setTagFilter(''); setShowCreate(false); loadCampaigns() }
    } catch {}
    setCreating(false)
  }

  async function sendCampaign(id: string) {
    if (!confirm('Send this campaign to all matching contacts?')) return
    setSending(id)
    try {
      const res = await fetch(`/api/campaigns/${id}/send`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      })
      const data = await res.json()
      if (data.ok) alert(`Campaign sent to ${data.data.sent} of ${data.data.total} contacts.`)
      else alert(data.error || 'Send failed')
      loadCampaigns()
    } catch { alert('Failed') }
    setSending(null)
  }

  async function draftWithAI() {
    if (!name.trim()) return
    setDrafting(true)
    try {
      const res = await fetch('/api/ai/draft-email', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ contactName: 'valued subscriber', purpose: 'campaign', context: `Campaign name: ${name}` }),
      })
      const data = await res.json()
      if (data.ok) { setSubject(data.subject); setBody(data.body) }
    } catch {}
    setDrafting(false)
  }

  const statusColors: Record<string, string> = {
    draft: 'bg-muted text-muted-foreground',
    sending: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
    sent: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-semibold">Email Campaigns</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Send broadcasts to your contact list</p>
        </div>
        <Button type="button" size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="size-3.5 mr-1.5" /> New Campaign
        </Button>
      </div>

      {/* Create Campaign */}
      {showCreate && (
        <div className="rounded-lg border bg-card p-5 mb-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">New Campaign</h3>
            <IconButton type="button" variant="ghost" size="sm" onClick={() => setShowCreate(false)} aria-label="Close"><X className="size-4" /></IconButton>
          </div>
          <div className="grid gap-3">
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Campaign Name</label>
                <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. March Newsletter" className="h-9 text-sm" autoFocus />
              </div>
              <div className="w-40">
                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Filter by Tag</label>
                <Input value={tagFilter} onChange={e => setTagFilter(e.target.value)} placeholder="e.g. newsletter" className="h-9 text-sm" />
              </div>
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Subject Line</label>
              <Input value={subject} onChange={e => setSubject(e.target.value)} placeholder="Your email subject" className="h-9 text-sm" />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Email Body</label>
                <Button type="button" variant="outline" size="sm" onClick={draftWithAI} disabled={drafting || !name.trim()} className="h-6 text-[10px] px-2">
                  {drafting ? <Loader2 className="size-3 animate-spin mr-1" /> : <Sparkles className="size-3 mr-1" />} AI Draft
                </Button>
              </div>
              <textarea value={body} onChange={e => setBody(e.target.value)}
                placeholder="Write your email... Use {{firstName}} for personalization."
                className="w-full rounded-md border bg-card px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring h-32" />
              <p className="text-[10px] text-muted-foreground mt-1">Variables: {'{{firstName}}'}, {'{{name}}'}, {'{{email}}'}</p>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2 border-t">
            <Button type="button" variant="outline" size="sm" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button type="button" size="sm" onClick={createCampaign} disabled={creating || !name.trim() || !subject.trim() || !body.trim()}>
              {creating ? <Loader2 className="size-3 animate-spin mr-1" /> : <Mail className="size-3 mr-1" />} Create Campaign
            </Button>
          </div>
        </div>
      )}

      {/* Campaign List */}
      {loading ? <div className="text-sm text-muted-foreground">Loading...</div> :
      campaigns.length === 0 ? (
        <div className="rounded-lg border p-12 text-center">
          <Mail className="size-8 mx-auto mb-3 text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">No campaigns yet. Create one to send a broadcast to your contacts.</p>
        </div>
      ) : (
        <div className="rounded-lg border divide-y">
          {campaigns.map(c => {
            const stats = typeof c.stats === 'string' ? JSON.parse(c.stats) : c.stats
            return (
              <div key={c.id} className="flex items-center gap-4 px-5 py-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{c.name}</p>
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${statusColors[c.status] || ''}`}>{c.status}</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">{c.subject}</p>
                </div>
                {c.status === 'sent' && stats && (
                  <div className="flex gap-4 text-xs text-muted-foreground tabular-nums shrink-0">
                    <span>{stats.sent || 0} sent</span>
                    <span>{stats.opened || 0} opened</span>
                    <span>{stats.clicked || 0} clicked</span>
                  </div>
                )}
                {c.status === 'draft' && (
                  <Button type="button" variant="outline" size="sm" onClick={() => sendCampaign(c.id)} disabled={sending === c.id}>
                    {sending === c.id ? <Loader2 className="size-3 animate-spin mr-1" /> : <Send className="size-3 mr-1" />} Send
                  </Button>
                )}
                <span className="text-xs text-muted-foreground shrink-0">{new Date(c.created_at).toLocaleDateString()}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
