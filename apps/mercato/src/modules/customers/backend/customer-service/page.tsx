'use client'

import { useState, useEffect } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Switch } from '@open-mercato/ui/primitives/switch'
import { Badge } from '@open-mercato/ui/primitives/badge'
import { Headphones, Mail, Check, FileEdit, Send, Sparkles, ArrowRight, BookOpen, MessageSquareQuote, FileText, Trash2, Plus } from 'lucide-react'

type ReplyMode = 'draft' | 'auto' | 'hybrid'
type EmailConnection = { id: string; provider: string; email_address: string; is_primary: boolean }
type Settings = {
  enabled: boolean
  watchedConnectionIds: string[] | null
  replyMode: ReplyMode
  hybridConfidenceThreshold: number
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
  const [signature, setSignature] = useState('')

  const [connections, setConnections] = useState<EmailConnection[]>([])

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
    ]).then(([settingsRes, connRes, kbRes]) => {
      if (cancelled) return
      if (settingsRes?.ok && settingsRes.data) {
        const s: Settings = settingsRes.data
        setEnabled(!!s.enabled)
        setWatchedIds(Array.isArray(s.watchedConnectionIds) ? s.watchedConnectionIds : null)
        setReplyMode(s.replyMode === 'auto' || s.replyMode === 'hybrid' ? s.replyMode : 'draft')
        if (typeof s.hybridConfidenceThreshold === 'number' && Number.isFinite(s.hybridConfidenceThreshold)) {
          setHybridThreshold(Math.min(1, Math.max(0, s.hybridConfidenceThreshold)))
        }
        setSignature(s.signature || '')
      }
      if (connRes?.ok) setConnections(connRes.data || [])
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
                  Upload a .txt, .md, or .csv file, or paste text. For PDF or Word, paste the text in for now.
                </p>
              </div>
              <div className="px-4 py-3 space-y-3">
                <input value={docTitle} onChange={e => setDocTitle(e.target.value)}
                  placeholder="Title (optional), e.g. Shipping policy"
                  className="w-full rounded-md border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring" />
                <input type="file" accept=".txt,.md,.markdown,.csv,text/plain,text/markdown,text/csv"
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
