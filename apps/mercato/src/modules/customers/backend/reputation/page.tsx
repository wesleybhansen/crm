'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Badge } from '@open-mercato/ui/primitives/badge'
import { Label } from '@open-mercato/ui/primitives/label'
import {
  Star, Send, Search, Loader2, Check, ExternalLink,
  Link as LinkIcon, Mail, TrendingUp, CalendarDays, Zap,
} from 'lucide-react'

// ── Types ──

type ReviewRequest = {
  id: string
  contact_id: string
  contact_name: string | null
  contact_email: string | null
  channel: string
  status: string
  sent_at: string
  rule_id: string | null
  rule_name: string | null
}

type ContactHit = {
  id: string
  display_name: string | null
  primary_email: string | null
}

const PLATFORMS = [
  { value: 'google', label: 'Google' },
  { value: 'facebook', label: 'Facebook' },
  { value: 'yelp', label: 'Yelp' },
  { value: 'other', label: 'Other' },
] as const

const fmtDateTime = (d: string | null) =>
  d ? new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-'

// House palette tinted tiles (light/dark) for summary stat icons.
const STAT_COLORS = {
  violet: { icon: 'text-[#7c3aed] dark:text-[#a78bfa]', tile: 'bg-[rgba(124,58,237,0.10)] dark:bg-[rgba(139,92,246,0.16)]' },
  blue: { icon: 'text-[#1d4ed8] dark:text-[#60a5fa]', tile: 'bg-[rgba(37,99,235,0.10)] dark:bg-[rgba(59,130,246,0.15)]' },
  green: { icon: 'text-[#047857] dark:text-[#34d399]', tile: 'bg-[rgba(16,185,129,0.10)] dark:bg-[rgba(16,185,129,0.14)]' },
} as const

export default function ReputationPage() {
  const [loading, setLoading] = useState(true)

  // Settings
  const [reviewUrl, setReviewUrl] = useState('')
  const [reviewPlatform, setReviewPlatform] = useState('google')
  const [savedReviewUrl, setSavedReviewUrl] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saved' | 'error'>('idle')

  // Stats + history
  const [sent30, setSent30] = useState(0)
  const [sent90, setSent90] = useState(0)
  const [recent, setRecent] = useState<ReviewRequest[]>([])

  // Quick action
  const [search, setSearch] = useState('')
  const [searching, setSearching] = useState(false)
  const [hits, setHits] = useState<ContactHit[]>([])
  const [sendingId, setSendingId] = useState<string | null>(null)
  const [sendMessage, setSendMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Load data ──
  const loadStats = useCallback(async () => {
    try {
      const res = await fetch('/api/sequences/reputation', { credentials: 'include' })
      const d = await res.json()
      if (d.ok) {
        setSent30(d.data.sent30 || 0)
        setSent90(d.data.sent90 || 0)
        setRecent(d.data.recent || [])
      }
    } catch { /* silent */ }
  }, [])

  const loadSettings = useCallback(async () => {
    try {
      const res = await fetch('/api/customers/business-profile', { credentials: 'include' })
      const d = await res.json()
      if (d.ok && d.data) {
        setReviewUrl(d.data.review_url || '')
        setSavedReviewUrl(d.data.review_url || null)
        if (d.data.review_platform) setReviewPlatform(d.data.review_platform)
      }
    } catch { /* silent */ }
  }, [])

  useEffect(() => {
    Promise.all([loadSettings(), loadStats()]).finally(() => setLoading(false))
  }, [loadSettings, loadStats])

  // ── Save settings ──
  const saveSettings = async () => {
    setSaving(true)
    setSaveState('idle')
    try {
      const res = await fetch('/api/customers/business-profile', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ review_url: reviewUrl.trim(), review_platform: reviewPlatform }),
      })
      const d = await res.json()
      if (d.ok) {
        setSavedReviewUrl(d.data?.review_url || null)
        setSaveState('saved')
        setTimeout(() => setSaveState('idle'), 2500)
      } else {
        setSaveState('error')
      }
    } catch {
      setSaveState('error')
    }
    setSaving(false)
  }

  // ── Contact search (debounced) ──
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current)
    const q = search.trim()
    if (q.length < 2) { setHits([]); setSearching(false); return }
    setSearching(true)
    searchTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/customers/people?search=${encodeURIComponent(q)}&pageSize=8`, { credentials: 'include' })
        const d = await res.json()
        let items: ContactHit[] = d.items || []
        if (items.length === 0) {
          // display_name can be encrypted server-side, so ?search= may miss.
          // Fall back to a small fetch + client-side filter on decrypted names.
          const res2 = await fetch('/api/customers/people?pageSize=100', { credentials: 'include' })
          const d2 = await res2.json()
          const needle = q.toLowerCase()
          items = (d2.items || []).filter((c: ContactHit) =>
            (c.display_name || '').toLowerCase().includes(needle) ||
            (c.primary_email || '').toLowerCase().includes(needle)
          ).slice(0, 8)
        }
        setHits(items)
      } catch {
        setHits([])
      }
      setSearching(false)
    }, 300)
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current) }
  }, [search])

  // ── Send review request ──
  const sendRequest = async (contact: ContactHit) => {
    setSendingId(contact.id)
    setSendMessage(null)
    try {
      const res = await fetch('/api/sequences/reputation/send', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId: contact.id }),
      })
      const d = await res.json()
      if (d.ok) {
        setSendMessage({ kind: 'ok', text: `Review request sent to ${contact.display_name || contact.primary_email}.` })
        setSearch('')
        setHits([])
        loadStats()
      } else {
        setSendMessage({ kind: 'error', text: d.error || 'Send failed.' })
      }
    } catch {
      setSendMessage({ kind: 'error', text: 'Send failed.' })
    }
    setSendingId(null)
  }

  const hasLink = Boolean(savedReviewUrl)
  const platformLabel = PLATFORMS.find(p => p.value === reviewPlatform)?.label || 'Other'

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Star className="size-6" /> Reputation
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Collect more reviews. Set your review link once and every review-request email, manual or automated, uses it.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        {[
          { label: 'Requests sent, last 30 days', value: String(sent30), icon: <Mail className="size-4" />, color: 'violet' as const },
          { label: 'Requests sent, last 90 days', value: String(sent90), icon: <TrendingUp className="size-4" />, color: 'blue' as const },
          { label: 'Review link', value: hasLink ? platformLabel : 'Not set', icon: <LinkIcon className="size-4" />, color: 'green' as const },
        ].map(m => {
          const c = STAT_COLORS[m.color]
          return (
            <div key={m.label} className="bg-card rounded-xl border px-4 py-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">{m.label}</span>
                <span className={`size-7 rounded-lg flex items-center justify-center ${c.tile}`}>
                  <span className={c.icon}>{m.icon}</span>
                </span>
              </div>
              <p className="text-xl font-bold">{m.value}</p>
            </div>
          )
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        {/* Settings card */}
        <div className="bg-card rounded-xl border p-5">
          <h2 className="font-semibold mb-1 flex items-center gap-2"><LinkIcon className="size-4" /> Review link</h2>
          <p className="text-xs text-muted-foreground mb-4">
            Where should customers leave their review? Paste your public review link. For Google, use your Business Profile review link.
          </p>
          <div className="space-y-3">
            <div>
              <Label htmlFor="rep-platform" className="text-xs mb-1.5 block">Platform</Label>
              <select
                id="rep-platform"
                value={reviewPlatform}
                onChange={(e) => setReviewPlatform(e.target.value)}
                className="w-full h-9 rounded-md border bg-background px-3 text-sm"
              >
                {PLATFORMS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
            <div>
              <Label htmlFor="rep-url" className="text-xs mb-1.5 block">Review link</Label>
              <Input
                id="rep-url"
                value={reviewUrl}
                onChange={(e) => setReviewUrl(e.target.value)}
                placeholder="https://g.page/r/your-business/review"
              />
            </div>
            <div className="flex items-center gap-3 pt-1">
              <Button type="button" size="sm" onClick={saveSettings} disabled={saving}>
                {saving ? <Loader2 className="size-4 mr-1.5 animate-spin" /> : saveState === 'saved' ? <Check className="size-4 mr-1.5" /> : null}
                {saveState === 'saved' ? 'Saved' : 'Save'}
              </Button>
              {savedReviewUrl && (
                <a href={savedReviewUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
                  <ExternalLink className="size-3" /> Open saved link
                </a>
              )}
              {saveState === 'error' && <span className="text-xs text-red-600">Save failed. Check the link and try again.</span>}
            </div>
            {!hasLink && (
              <p className="text-xs text-amber-700 dark:text-amber-400 bg-[rgba(217,119,6,.08)] dark:bg-[rgba(245,158,11,.10)] rounded-md px-3 py-2">
                Review-request automations are paused until a link is saved, so customers never receive an email with a missing link.
              </p>
            )}
          </div>
        </div>

        {/* Quick action card */}
        <div className="bg-card rounded-xl border p-5">
          <h2 className="font-semibold mb-1 flex items-center gap-2"><Send className="size-4" /> Request a review now</h2>
          <p className="text-xs text-muted-foreground mb-4">
            Search a contact by name or email and send them the review-request email right away.
          </p>
          <div className="relative">
            <Search className="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search contacts..."
              className="pl-9"
              disabled={!hasLink}
            />
          </div>
          {!hasLink && (
            <p className="text-xs text-muted-foreground mt-2">Save your review link first.</p>
          )}
          {searching && <p className="text-xs text-muted-foreground mt-2 flex items-center gap-1.5"><Loader2 className="size-3 animate-spin" /> Searching...</p>}
          {hits.length > 0 && (
            <div className="mt-2 rounded-lg border divide-y overflow-hidden">
              {hits.map(c => (
                <div key={c.id} className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-muted/40">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{c.display_name || c.primary_email || c.id}</p>
                    {c.primary_email && <p className="text-xs text-muted-foreground truncate">{c.primary_email}</p>}
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs shrink-0"
                    disabled={sendingId === c.id || !c.primary_email}
                    onClick={() => sendRequest(c)}
                  >
                    {sendingId === c.id ? <Loader2 className="size-3 mr-1 animate-spin" /> : <Send className="size-3 mr-1" />}
                    {c.primary_email ? 'Send request' : 'No email'}
                  </Button>
                </div>
              ))}
            </div>
          )}
          {sendMessage && (
            <p className={`text-xs mt-3 ${sendMessage.kind === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600'}`}>
              {sendMessage.text}
            </p>
          )}
        </div>
      </div>

      {/* Automations hint */}
      <div className="rounded-xl border bg-card px-4 py-3 mb-6 flex items-center gap-3 text-sm">
        <span className="size-7 rounded-lg flex items-center justify-center bg-[rgba(124,58,237,0.10)] dark:bg-[rgba(139,92,246,0.16)] shrink-0">
          <Zap className="size-4 text-[#7c3aed] dark:text-[#a78bfa]" />
        </span>
        <p className="text-muted-foreground">
          Put this on autopilot: install the <span className="font-medium text-foreground">Payment Thank You + Review Request</span> or{' '}
          <span className="font-medium text-foreground">Review Request (2 Weeks After Payment)</span> template in{' '}
          <a href="/backend/automations-v2" className="underline hover:text-foreground">Automations</a>.
        </p>
      </div>

      {/* Recent requests */}
      <div className="bg-card rounded-xl border">
        <div className="px-5 py-4 border-b">
          <h2 className="font-semibold flex items-center gap-2"><CalendarDays className="size-4" /> Recent review requests</h2>
        </div>
        {recent.length === 0 ? (
          <div className="p-10 text-center">
            <Star className="size-8 mx-auto text-muted-foreground/20 mb-3" />
            <p className="text-sm text-muted-foreground">No review requests sent yet. Send one above or install a review automation.</p>
          </div>
        ) : (
          <div className="divide-y">
            {recent.map(r => (
              <div key={r.id} className="flex items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{r.contact_name || r.contact_email || 'Contact'}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {r.rule_name ? `Automation: ${r.rule_name}` : 'Sent manually'}
                  </p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <Badge variant={r.status === 'sent' ? 'green' : 'secondary'}>{r.status}</Badge>
                  <span className="text-xs text-muted-foreground tabular-nums">{fmtDateTime(r.sent_at)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
