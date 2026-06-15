'use client'

import { useState, useEffect } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Switch } from '@open-mercato/ui/primitives/switch'
import { Badge } from '@open-mercato/ui/primitives/badge'
import { Input } from '@open-mercato/ui/primitives/input'
import { Headphones, Mail, Check, FileEdit, Send, Sparkles, ArrowRight, BookOpen, MessageSquareQuote, FileText, Trash2, Plus, Server, X as XIcon } from 'lucide-react'

type ReplyMode = 'draft' | 'auto' | 'hybrid'
type EmailConnection = { id: string; provider: string; email_address: string; is_primary: boolean; purpose?: string | null }
type SourceMode = { mode: ReplyMode; threshold: number }
type SourceModes = Record<string, SourceMode>
type Settings = {
  enabled: boolean
  watchedConnectionIds: string[] | null
  replyMode: ReplyMode
  hybridConfidenceThreshold: number
  sourceModes: SourceModes | null
  signature: string | null
}
type KnowledgeEntry = {
  id: string
  kind: 'model_answer' | 'document'
  title: string
  sourceFilename: string | null
  contentPreview: string
  createdAt: string
}

export default function CustomerServiceSettingsPage() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  const [enabled, setEnabled] = useState(false)
  // null = watch all connected mailboxes. An array = only those ids.
  const [watchedIds, setWatchedIds] = useState<string[] | null>(null)
  const [replyMode, setReplyMode] = useState<ReplyMode>('draft')
  const [hybridThreshold, setHybridThreshold] = useState(0.8)
  // Per-mailbox overrides, keyed by connection id. Absent key = use account default.
  const [sourceModes, setSourceModes] = useState<SourceModes>({})
  const [signature, setSignature] = useState('')

  const [connections, setConnections] = useState<EmailConnection[]>([])

  // Dedicated customer-service inboxes (purpose = 'customer_service').
  const [csInboxes, setCsInboxes] = useState<EmailConnection[]>([])
  const [csDisconnecting, setCsDisconnecting] = useState<string | null>(null)
  // Connect-a-support-inbox form (SMTP/IMAP, App Password).
  const [supportEmail, setSupportEmail] = useState('')
  const [supportPassword, setSupportPassword] = useState('')
  const [supportShowAdvanced, setSupportShowAdvanced] = useState(false)
  const [supportImapHost, setSupportImapHost] = useState('')
  const [supportImapPort, setSupportImapPort] = useState('993')
  const [supportSmtpHost, setSupportSmtpHost] = useState('')
  const [supportSmtpPort, setSupportSmtpPort] = useState('587')
  const [supportSaving, setSupportSaving] = useState(false)
  const [supportError, setSupportError] = useState('')
  const [supportSuccess, setSupportSuccess] = useState(false)
  // Whether to also let the personal Inbox mailboxes be watched by CS.
  const [showSharedMailboxes, setShowSharedMailboxes] = useState(false)

  async function reloadConnections() {
    const [allRes, csRes] = await Promise.all([
      fetch('/api/email/connections', { credentials: 'include' }).then(r => r.json()).catch(() => null),
      fetch('/api/email/connections?purpose=customer_service', { credentials: 'include' }).then(r => r.json()).catch(() => null),
    ])
    if (allRes?.ok) setConnections(allRes.data || [])
    if (csRes?.ok) setCsInboxes(csRes.data || [])
  }

  async function connectSupportInbox() {
    setSupportError('')
    setSupportSuccess(false)
    if (!supportEmail || !supportPassword) { setSupportError('Enter the support email address and its App Password.'); return }
    setSupportSaving(true)
    try {
      const body: Record<string, any> = { emailAddress: supportEmail, password: supportPassword, purpose: 'customer_service' }
      if (supportShowAdvanced) {
        if (supportImapHost) { body.imapHost = supportImapHost; body.imapPort = Number(supportImapPort) }
        if (supportSmtpHost) { body.smtpHost = supportSmtpHost; body.smtpPort = Number(supportSmtpPort) }
      }
      const res = await fetch('/api/email/smtp', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (data.ok) {
        setSupportSuccess(true)
        setSupportEmail(''); setSupportPassword('')
        setSupportImapHost(''); setSupportImapPort('993')
        setSupportSmtpHost(''); setSupportSmtpPort('587')
        setSupportShowAdvanced(false)
        await reloadConnections()
        setTimeout(() => setSupportSuccess(false), 3000)
      } else {
        setSupportError(data.error || 'Failed to connect the support inbox.')
      }
    } catch {
      setSupportError('Failed to connect the support inbox.')
    }
    setSupportSaving(false)
  }

  async function disconnectSupportInbox(id: string, address: string) {
    if (!confirm(`Disconnect ${address}? Customer Service will stop watching this support inbox.`)) return
    setCsDisconnecting(id)
    try {
      await fetch(`/api/email/smtp?id=${id}`, { method: 'DELETE', credentials: 'include' })
      setCsInboxes(prev => prev.filter(c => c.id !== id))
      setConnections(prev => prev.filter(c => c.id !== id))
      // Drop it from the watched list if it was explicitly selected.
      setWatchedIds(prev => (prev === null ? prev : prev.filter(x => x !== id)))
    } catch {}
    setCsDisconnecting(null)
  }

  // Knowledge and model answers (grounding library).
  const [knowledge, setKnowledge] = useState<KnowledgeEntry[]>([])
  const [kbError, setKbError] = useState('')
  const [kbSaving, setKbSaving] = useState(false)
  const [maTitle, setMaTitle] = useState('')
  const [maContent, setMaContent] = useState('')
  const [docTitle, setDocTitle] = useState('')
  const [docContent, setDocContent] = useState('')
  const [docFile, setDocFile] = useState<File | null>(null)

  async function loadKnowledge() {
    const res = await fetch('/api/customer-service/knowledge', { credentials: 'include' }).then(r => r.json()).catch(() => null)
    if (res?.ok) setKnowledge(res.data || [])
  }

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch('/api/customer-service/settings', { credentials: 'include' }).then(r => r.json()).catch(() => null),
      fetch('/api/email/connections', { credentials: 'include' }).then(r => r.json()).catch(() => null),
      fetch('/api/customer-service/knowledge', { credentials: 'include' }).then(r => r.json()).catch(() => null),
      fetch('/api/email/connections?purpose=customer_service', { credentials: 'include' }).then(r => r.json()).catch(() => null),
    ]).then(([settingsRes, connRes, kbRes, csConnRes]) => {
      if (cancelled) return
      if (settingsRes?.ok && settingsRes.data) {
        const s: Settings = settingsRes.data
        setEnabled(!!s.enabled)
        setWatchedIds(Array.isArray(s.watchedConnectionIds) ? s.watchedConnectionIds : null)
        setReplyMode(s.replyMode === 'auto' || s.replyMode === 'hybrid' ? s.replyMode : 'draft')
        if (typeof s.hybridConfidenceThreshold === 'number' && Number.isFinite(s.hybridConfidenceThreshold)) {
          setHybridThreshold(Math.min(1, Math.max(0, s.hybridConfidenceThreshold)))
        }
        setSourceModes(s.sourceModes && typeof s.sourceModes === 'object' ? s.sourceModes : {})
        setSignature(s.signature || '')
      }
      if (connRes?.ok) setConnections(connRes.data || [])
      if (csConnRes?.ok) setCsInboxes(csConnRes.data || [])
      if (kbRes?.ok) setKnowledge(kbRes.data || [])
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  async function addModelAnswer() {
    setKbError('')
    if (!maContent.trim()) { setKbError('Enter the answer text first.'); return }
    setKbSaving(true)
    try {
      const res = await fetch('/api/customer-service/knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ kind: 'model_answer', title: maTitle.trim() || undefined, content: maContent.trim() }),
      })
      const data = await res.json()
      if (data.ok) {
        setMaTitle(''); setMaContent('')
        await loadKnowledge()
      } else {
        setKbError(data.error || 'Failed to add model answer.')
      }
    } catch {
      setKbError('Failed to add model answer.')
    }
    setKbSaving(false)
  }

  async function addDocument() {
    setKbError('')
    if (!docFile && !docContent.trim()) { setKbError('Upload a file or paste the document text.'); return }
    setKbSaving(true)
    try {
      let res: Response
      if (docFile) {
        const form = new FormData()
        form.append('kind', 'document')
        if (docTitle.trim()) form.append('title', docTitle.trim())
        form.append('file', docFile)
        if (docContent.trim()) form.append('content', docContent.trim())
        res = await fetch('/api/customer-service/knowledge', { method: 'POST', credentials: 'include', body: form })
      } else {
        res = await fetch('/api/customer-service/knowledge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ kind: 'document', title: docTitle.trim() || undefined, content: docContent.trim() }),
        })
      }
      const data = await res.json()
      if (data.ok) {
        setDocTitle(''); setDocContent(''); setDocFile(null)
        await loadKnowledge()
      } else {
        setKbError(data.error || 'Failed to add document.')
      }
    } catch {
      setKbError('Failed to add document.')
    }
    setKbSaving(false)
  }

  async function deleteKnowledge(id: string) {
    setKbError('')
    const prev = knowledge
    setKnowledge(prev.filter(k => k.id !== id))
    try {
      const res = await fetch(`/api/customer-service/knowledge/${id}`, { method: 'DELETE', credentials: 'include' })
      const data = await res.json()
      if (!data.ok) { setKnowledge(prev); setKbError(data.error || 'Failed to delete.') }
    } catch {
      setKnowledge(prev); setKbError('Failed to delete.')
    }
  }

  function toggleMailbox(id: string) {
    setWatchedIds(prev => {
      // Starting from "all": selecting one mailbox narrows to just that one.
      if (prev === null) return [id]
      const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
      // Empty selection means watch all again.
      return next.length === 0 ? null : next
    })
    // Drop any per-source override when a mailbox is unchecked.
    setSourceModes(prev => {
      if (watchingAll) return prev
      if (watchedIds?.includes(id)) {
        const next = { ...prev }
        delete next[id]
        return next
      }
      return prev
    })
  }

  // "" = use the account default; otherwise an explicit per-mailbox mode.
  function setSourceMode(id: string, value: '' | ReplyMode) {
    setSourceModes(prev => {
      const next = { ...prev }
      if (value === '') {
        delete next[id]
      } else {
        next[id] = { mode: value, threshold: prev[id]?.threshold ?? hybridThreshold }
      }
      return next
    })
  }

  function setSourceThreshold(id: string, threshold: number) {
    setSourceModes(prev => {
      const cur = prev[id]
      if (!cur) return prev
      return { ...prev, [id]: { ...cur, threshold: Math.min(1, Math.max(0, threshold)) } }
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
          replyMode,
          hybridConfidenceThreshold: hybridThreshold,
          // Only send overrides for currently-watched mailboxes. When watching
          // all, the server can't constrain to ids, so send what we have.
          sourceModes: watchedIds === null
            ? sourceModes
            : Object.fromEntries(Object.entries(sourceModes).filter(([k]) => watchedIds.includes(k))),
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
  // Personal Inbox mailboxes are everything that is not a dedicated support inbox.
  const personalMailboxes = connections.filter(c => c.purpose !== 'customer_service')
  // The watch list shows the dedicated support inboxes by default. The user can
  // opt in to also watch their personal Inbox mailboxes.
  const visibleMailboxes = showSharedMailboxes ? connections : csInboxes

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
        Let Noli reply to incoming customer emails. Choose whether replies wait for your approval, send automatically, or send only when they are confident and safe.
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
                  <p className="text-sm font-medium mb-0.5">Reply to customer emails</p>
                  <p className="text-xs text-muted-foreground">
                    When on, incoming emails get an AI reply. How it is handled depends on the reply mode you choose below.
                  </p>
                </div>
                <Switch checked={enabled} onCheckedChange={setEnabled} />
              </div>
            </div>
          </section>

          {/* Dedicated support inbox */}
          <section className="mb-8">
            <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
              <Mail className="size-4 text-muted-foreground" /> Dedicated support inbox
            </h2>
            <p className="text-xs text-muted-foreground mb-3">
              Connect a mailbox used only for customer support, such as support@yourbusiness.com. It stays separate from your personal Inbox. Customer Service watches it on its own.
            </p>

            {/* Connected support inboxes */}
            <div className="rounded-lg border divide-y mb-3">
              {csInboxes.length === 0 ? (
                <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                  No dedicated support inbox yet. Connect one below.
                </div>
              ) : (
                csInboxes.map(conn => (
                  <div key={conn.id} className="flex items-center justify-between px-4 py-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <Mail className="size-4 text-muted-foreground shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate flex items-center gap-2">
                          {conn.email_address}
                          <Badge variant="violet">Support</Badge>
                        </p>
                        <p className="text-xs text-muted-foreground">Dedicated to Customer Service (IMAP/SMTP)</p>
                      </div>
                    </div>
                    <Button type="button" variant="outline" size="sm"
                      disabled={csDisconnecting === conn.id}
                      onClick={() => disconnectSupportInbox(conn.id, conn.email_address)}>
                      {csDisconnecting === conn.id ? 'Disconnecting...' : <><XIcon className="size-3 mr-1" /> Disconnect</>}
                    </Button>
                  </div>
                ))
              )}
            </div>

            {/* Connect a new dedicated support inbox */}
            <div className="rounded-lg border">
              <div className="px-4 py-3 border-b">
                <p className="text-sm font-medium flex items-center gap-2">
                  <Server className="size-4 text-muted-foreground" /> Connect a dedicated support inbox
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Works with Gmail, Outlook, or any provider that supports IMAP/SMTP. Use an App Password, not your normal password.
                </p>
              </div>
              <div className="px-4 py-3 space-y-2">
                {supportError && (
                  <p className="text-xs text-[#b91c1c] dark:text-[#f87171]">{supportError}</p>
                )}
                {supportSuccess && (
                  <p className="text-xs text-[#047857] dark:text-[#34d399] flex items-center gap-1"><Check className="size-3" /> Support inbox connected.</p>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <Input value={supportEmail} onChange={e => setSupportEmail(e.target.value)}
                    placeholder="support@yourbusiness.com" className="h-8 text-xs" type="email" />
                  <Input value={supportPassword} onChange={e => setSupportPassword(e.target.value)}
                    type="password" placeholder="App Password" className="h-8 text-xs" />
                </div>
                <button type="button" className="text-xs text-muted-foreground underline block"
                  onClick={() => setSupportShowAdvanced(v => !v)}>
                  {supportShowAdvanced ? 'Hide advanced settings' : 'Advanced: custom server settings'}
                </button>
                {supportShowAdvanced && (
                  <div className="grid grid-cols-2 gap-2 p-3 rounded-md bg-muted/40 border">
                    <Input value={supportImapHost} onChange={e => setSupportImapHost(e.target.value)}
                      placeholder="IMAP host (auto-detected)" className="h-8 text-xs" />
                    <Input value={supportImapPort} onChange={e => setSupportImapPort(e.target.value)}
                      placeholder="IMAP port (993)" className="h-8 text-xs" />
                    <Input value={supportSmtpHost} onChange={e => setSupportSmtpHost(e.target.value)}
                      placeholder="SMTP host (auto-detected)" className="h-8 text-xs" />
                    <Input value={supportSmtpPort} onChange={e => setSupportSmtpPort(e.target.value)}
                      placeholder="SMTP port (587)" className="h-8 text-xs" />
                  </div>
                )}
                <Button type="button" variant="outline" size="sm" onClick={connectSupportInbox}
                  disabled={supportSaving || !supportEmail || !supportPassword}>
                  {supportSaving ? 'Testing connection...' : 'Connect support inbox'}
                </Button>
                <p className="text-[11px] text-muted-foreground">
                  Need help getting an App Password? The Email section in Settings has step-by-step guides for Gmail, Outlook, Yahoo, and iCloud.
                </p>
              </div>
            </div>
          </section>

          {/* Source mailboxes */}
          <section className="mb-8">
            <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
              <Mail className="size-4 text-muted-foreground" /> Mailboxes to watch
            </h2>
            <div className="rounded-lg border divide-y">
              <div className="px-4 py-3 flex items-start justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  Your dedicated support inboxes are watched automatically. Leave everything unchecked to watch every support inbox, or check specific ones to narrow it down.
                </p>
                {personalMailboxes.length > 0 && (
                  <label className="flex items-center gap-1.5 shrink-0 cursor-pointer">
                    <input type="checkbox" checked={showSharedMailboxes}
                      onChange={e => setShowSharedMailboxes(e.target.checked)}
                      className="size-3.5 rounded border-input accent-[#2563eb]" />
                    <span className="text-[11px] text-muted-foreground">Also watch personal Inbox mailboxes</span>
                  </label>
                )}
              </div>
              {visibleMailboxes.length === 0 ? (
                <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                  No support inbox connected yet. Connect one above to get started.
                </div>
              ) : (
                visibleMailboxes.map(conn => {
                  const checked = watchingAll ? false : (watchedIds?.includes(conn.id) ?? false)
                  const override = sourceModes[conn.id]
                  const selectValue = override?.mode ?? ''
                  return (
                    <div key={conn.id}>
                      <label className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-muted/30 transition">
                        <div className="flex items-center gap-3 min-w-0">
                          <input type="checkbox" checked={checked} onChange={() => toggleMailbox(conn.id)}
                            className="size-4 rounded border-input accent-[#2563eb]" />
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{conn.email_address}</p>
                            <p className="text-xs text-muted-foreground capitalize">{conn.provider}</p>
                          </div>
                        </div>
                        {conn.purpose === 'customer_service'
                          ? <Badge variant="violet">Support</Badge>
                          : conn.is_primary && <Badge variant="secondary">Primary</Badge>}
                      </label>
                      {checked && (
                        <div className="px-4 pb-3 pl-11 flex flex-wrap items-center gap-2">
                          <span className="text-[11px] text-muted-foreground">Reply mode for this mailbox:</span>
                          <select
                            value={selectValue}
                            onChange={e => setSourceMode(conn.id, e.target.value as '' | ReplyMode)}
                            className="rounded-md border bg-card px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                          >
                            <option value="">
                              Use account default ({replyMode === 'auto' ? 'Auto-send' : replyMode === 'hybrid' ? 'Hybrid' : 'Draft for approval'})
                            </option>
                            <option value="draft">Draft for approval</option>
                            <option value="auto">Auto-send</option>
                            <option value="hybrid">Hybrid</option>
                          </select>
                          {override?.mode === 'hybrid' && (
                            <span className="flex items-center gap-1.5">
                              <span className="text-[11px] text-muted-foreground">Threshold</span>
                              <input
                                type="number"
                                min={0}
                                max={1}
                                step={0.05}
                                value={override.threshold}
                                onChange={e => {
                                  const v = Number(e.target.value)
                                  if (Number.isFinite(v)) setSourceThreshold(conn.id, v)
                                }}
                                className="w-20 rounded-md border bg-card px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                              />
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })
              )}
              {visibleMailboxes.length > 0 && (
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
              {([
                {
                  mode: 'draft' as ReplyMode,
                  icon: FileEdit,
                  title: 'Draft for approval',
                  desc: 'Every reply is drafted and waits in your review queue until you approve it. Nothing sends on its own.',
                  rounded: 'rounded-t-lg',
                },
                {
                  mode: 'auto' as ReplyMode,
                  icon: Send,
                  title: 'Auto-send',
                  desc: 'Every drafted reply is sent automatically as soon as it is written. Use this only when you trust replies to go out without review.',
                  rounded: '',
                },
                {
                  mode: 'hybrid' as ReplyMode,
                  icon: Sparkles,
                  title: 'Hybrid',
                  desc: 'Auto-send only confident, safe replies. Anything sensitive or uncertain, such as refunds, complaints, or billing, waits in your review queue.',
                  rounded: 'rounded-b-lg',
                },
              ]).map(({ mode, icon: Icon, title, desc, rounded }) => {
                const selected = replyMode === mode
                return (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setReplyMode(mode)}
                    className={`w-full text-left flex items-center justify-between px-4 py-3 transition ${rounded} ${selected ? 'selected-card' : 'hover:bg-muted/30'}`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <Icon className={`size-4 shrink-0 ${selected ? 'text-accent' : 'text-muted-foreground'}`} />
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{title}</p>
                        <p className="text-xs text-muted-foreground">{desc}</p>
                      </div>
                    </div>
                    {selected && <Check className="size-4 text-accent shrink-0" />}
                  </button>
                )
              })}
            </div>

            {replyMode === 'hybrid' && (
              <div className="mt-3 rounded-lg border px-4 py-3">
                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">
                  Confidence threshold
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={hybridThreshold}
                    onChange={e => {
                      const v = Number(e.target.value)
                      if (Number.isFinite(v)) setHybridThreshold(Math.min(1, Math.max(0, v)))
                    }}
                    className="w-24 rounded-md border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                  <span className="text-xs text-muted-foreground">0 to 1. Default 0.8.</span>
                </div>
                <p className="text-[11px] text-muted-foreground mt-2">
                  A reply auto-sends only when Noli is at least this confident in its answer and judges it safe to send. Everything else waits for your approval. Higher values send fewer replies on their own.
                </p>
              </div>
            )}
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

          <div className="flex items-center gap-3 mb-10">
            <Button type="button" onClick={save} disabled={saving}>
              {saving ? 'Saving...' : 'Save settings'}
            </Button>
            {saved && <span className="text-xs text-[#047857] dark:text-[#34d399] flex items-center gap-1"><Check className="size-3" /> Saved</span>}
          </div>

          {/* Knowledge and model answers */}
          <section className="mb-8">
            <h2 className="text-sm font-semibold mb-1 flex items-center gap-2">
              <BookOpen className="size-4 text-muted-foreground" /> Knowledge and model answers
            </h2>
            <p className="text-xs text-muted-foreground mb-3">
              Give Noli example answers and reference documents to draw from. Drafted replies will reuse and adapt them when relevant.
            </p>

            {kbError && (
              <div className="mb-3 rounded-lg border border-[rgba(239,68,68,.26)] bg-[rgba(239,68,68,.10)] px-4 py-2 text-sm text-[#b91c1c] dark:text-[#f87171]">
                {kbError}
              </div>
            )}

            {/* Existing entries */}
            <div className="rounded-lg border divide-y mb-4">
              {knowledge.length === 0 ? (
                <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                  No entries yet. Add a model answer or a reference document below.
                </div>
              ) : (
                knowledge.map(entry => (
                  <div key={entry.id} className="flex items-start justify-between px-4 py-3 gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-0.5">
                        <Badge variant="secondary" className="shrink-0">
                          {entry.kind === 'model_answer' ? (
                            <span className="flex items-center gap-1"><MessageSquareQuote className="size-3" /> Model answer</span>
                          ) : (
                            <span className="flex items-center gap-1"><FileText className="size-3" /> Document</span>
                          )}
                        </Badge>
                        <p className="text-sm font-medium truncate">{entry.title}</p>
                      </div>
                      <p className="text-xs text-muted-foreground line-clamp-2">{entry.contentPreview}</p>
                      {entry.sourceFilename && (
                        <p className="text-[11px] text-muted-foreground mt-0.5">From {entry.sourceFilename}</p>
                      )}
                    </div>
                    <button type="button" onClick={() => deleteKnowledge(entry.id)}
                      className="shrink-0 text-muted-foreground hover:text-[#b91c1c] transition p-1" title="Delete entry">
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                ))
              )}
            </div>

            {/* Add a model answer */}
            <div className="rounded-lg border mb-4">
              <div className="px-4 py-3 border-b">
                <p className="text-sm font-medium flex items-center gap-2">
                  <MessageSquareQuote className="size-4 text-muted-foreground" /> Add a model answer
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">An example reply Noli can reuse or adapt for similar questions.</p>
              </div>
              <div className="px-4 py-3 space-y-3">
                <input value={maTitle} onChange={e => setMaTitle(e.target.value)}
                  placeholder="Title (optional), e.g. Refund request"
                  className="w-full rounded-md border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring" />
                <textarea value={maContent} onChange={e => setMaContent(e.target.value)}
                  placeholder="Write the model answer here..."
                  className="w-full rounded-md border bg-card px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring h-28" />
                <Button type="button" size="sm" onClick={addModelAnswer} disabled={kbSaving}>
                  <Plus className="size-3.5 mr-1" /> Add model answer
                </Button>
              </div>
            </div>

            {/* Add a reference document */}
            <div className="rounded-lg border">
              <div className="px-4 py-3 border-b">
                <p className="text-sm font-medium flex items-center gap-2">
                  <FileText className="size-4 text-muted-foreground" /> Add a reference document
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Upload a PDF, Word (.docx), or text (.txt, .md, .csv) file, or paste text. The text is pulled out automatically.
                </p>
              </div>
              <div className="px-4 py-3 space-y-3">
                <input value={docTitle} onChange={e => setDocTitle(e.target.value)}
                  placeholder="Title (optional), e.g. Shipping policy"
                  className="w-full rounded-md border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring" />
                <input type="file" accept=".pdf,.docx,.txt,.md,.markdown,.csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown,text/csv"
                  onChange={e => setDocFile(e.target.files?.[0] || null)}
                  className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border file:bg-card file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-muted/50" />
                <p className="text-[11px] text-muted-foreground">Or paste the document text:</p>
                <textarea value={docContent} onChange={e => setDocContent(e.target.value)}
                  placeholder="Paste reference text here..."
                  className="w-full rounded-md border bg-card px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring h-28" />
                <Button type="button" size="sm" onClick={addDocument} disabled={kbSaving}>
                  <Plus className="size-3.5 mr-1" /> Add document
                </Button>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  )
}
