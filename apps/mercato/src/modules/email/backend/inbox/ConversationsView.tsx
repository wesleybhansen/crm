'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { Badge } from '@open-mercato/ui/primitives/badge'
import {
  Search, Mail, MessageCircle, Smartphone, Send, X,
  Check, CheckCheck,
  Eye, Loader2, Inbox, Archive, ExternalLink,
  StickyNote, Sparkles, Plus, SquareCheck,
  Square, CheckCircle, RotateCcw, Pencil, Save,
  BookOpen, ChevronRight, Trash2, ArrowLeft, Menu, Contact,
} from 'lucide-react'

// ── Types ──
type AiState = 'draft' | 'flagged' | 'autosent' | 'skipped' | 'manual' | null

type InboxConv = {
  id: string; contactId: string | null; chatConversationId: string | null
  status: string; lastMessageAt: string | null; lastMessageChannel: string | null
  lastMessagePreview: string | null; lastMessageDirection: string | null
  unreadCount: number; displayName: string | null; avatarEmail: string | null; avatarPhone: string | null
  aiState?: AiState
}

type UnifiedMsg = {
  id: string; channel: 'email' | 'sms' | 'chat'; direction: 'inbound' | 'outbound'
  subject: string | null; body: string; bodyText: string | null
  fromAddress: string; toAddress: string; status: string
  openedAt: string | null; clickedAt: string | null; createdAt: string; isBot: boolean
}

type ConvDetail = {
  inboxConversationId: string
  contact: { id: string; displayName: string; email: string | null; phone: string | null; lifecycleStage: string | null; source: string | null } | null
  chatConversationId: string | null
  availableChannels: { email: boolean; sms: boolean; chat: boolean }
  status: string; messages: UnifiedMsg[]
}

type Note = { id: string; user_name: string; content: string; created_at: string }

// ── Helpers ──
const chIcon = (ch: string | null, sz = 'size-3.5') => ch === 'sms' ? <Smartphone className={sz} /> : ch === 'chat' ? <MessageCircle className={sz} /> : <Mail className={sz} />
const chLabel = (ch: string | null) => ch === 'sms' ? 'SMS' : ch === 'chat' ? 'Chat' : 'Email'
const chColor = (ch: string | null) => ch === 'email' ? 'text-[#1d4ed8] dark:text-[#93c5fd]' : ch === 'sms' ? 'text-[#047857] dark:text-[#34d399]' : ch === 'chat' ? 'text-[#6d28d9] dark:text-[#c4b5fd]' : 'text-muted-foreground'

function relTime(d: string | null): string {
  if (!d) return ''
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 604800) return `${Math.floor(s / 86400)}d`
  return new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function fmtTime(d: string): string {
  const dt = new Date(d)
  const t = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return dt.toDateString() === new Date().toDateString() ? t : `${dt.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${t}`
}

function ini(name: string | null): string {
  if (!name) return '?'
  const p = name.trim().split(/\s+/)
  return p.length >= 2 ? (p[0][0] + p[1][0]).toUpperCase() : (p[0][0]?.toUpperCase() || '?')
}

// Deterministic colored avatar drawn from the app palette.
const AV_COLORS = ['#6D4AFF', '#1E9E6A', '#0E7C93', '#B7791F', '#8E5BD0', '#C2557A', '#3E7BD0']
function avColor(name: string | null): string {
  const s = name || '?'
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return AV_COLORS[h % AV_COLORS.length]
}

// Channel badge: a soft-tinted mono micro-label (Email / SMS).
function ChannelBadge({ ch }: { ch: string | null }) {
  const styles: Record<string, string> = {
    email: 'bg-[rgba(109,74,255,.10)] text-[#5b3fd6] dark:text-[#c4b5fd]',
    sms: 'bg-[rgba(30,158,106,.12)] text-[#1e7a52] dark:text-[#34d399]',
    chat: 'bg-[rgba(14,124,147,.12)] text-[#0e7c93] dark:text-[#67e8f9]',
  }
  const key = ch === 'sms' ? 'sms' : ch === 'chat' ? 'chat' : 'email'
  return <span className={`font-mono text-[9px] font-bold uppercase tracking-[.05em] rounded px-1.5 py-0.5 ${styles[key]}`}>{chLabel(ch)}</span>
}

// AI-state badge for list rows + the reading header. Matches the mockup palette:
// draft = violet, flagged = amber, autosent = green, skipped = grey.
function StateBadge({ state }: { state: AiState }) {
  if (!state || state === 'manual') return null
  const map: Record<string, { label: string; cls: string }> = {
    draft: { label: 'Draft', cls: 'bg-[rgba(109,74,255,.10)] text-[#5b3fd6] dark:text-[#c4b5fd]' },
    flagged: { label: 'Flagged', cls: 'bg-[rgba(183,121,31,.14)] text-[#8a5a10] dark:text-[#fbbf24]' },
    autosent: { label: 'Sent by AI', cls: 'bg-[rgba(30,158,106,.12)] text-[#1e7a52] dark:text-[#34d399]' },
    skipped: { label: 'Skipped', cls: 'bg-[rgba(16,16,18,.06)] text-[rgba(16,16,18,.5)] dark:bg-[rgba(255,255,255,.08)] dark:text-[rgba(255,255,255,.5)]' },
  }
  const m = map[state]
  if (!m) return null
  return <span className={`font-mono text-[9px] font-bold uppercase tracking-[.05em] rounded px-1.5 py-0.5 ${m.cls}`}>{m.label}</span>
}

function sanitizeHtml(html: string): string {
  return html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '').replace(/\bon\w+\s*=\s*["'][^"']*["']/gi, '').replace(/javascript\s*:/gi, '')
}

const STAGES = ['lead', 'prospect', 'opportunity', 'customer', 'partner', 'churned']

type ListFilter = 'all' | 'review' | 'unread'

export default function ConversationsView({
  onAiSettingsSaved,
  onGoToSettings,
}: {
  onAiSettingsSaved?: () => void
  onGoToSettings?: () => void
}) {
  void onAiSettingsSaved
  // List
  const [conversations, setConversations] = useState<InboxConv[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [deepSearch, setDeepSearch] = useState(false)
  const [channelFilter, setChannelFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('open')
  // Mockup state filter: All / Needs review (drafts + flagged) / Unread.
  const [listFilter, setListFilter] = useState<ListFilter>('all')

  // Bulk select
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Detail
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ConvDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [notes, setNotes] = useState<Note[]>([])

  // Contact pane (right), collapsed by default; opened on demand.
  const [contactOpen, setContactOpen] = useState(false)
  const [sidebarData, setSidebarData] = useState<any>(null)
  const [editingStage, setEditingStage] = useState(false)
  const [stageValue, setStageValue] = useState('')
  const [newTag, setNewTag] = useState('')

  // Composer
  const [activeChannel, setActiveChannel] = useState<'email' | 'sms' | 'chat'>('email')
  const [replySubject, setReplySubject] = useState('')
  const [replyBody, setReplyBody] = useState('')
  // The reply area is state-aware. replyOpen reveals the composer for manual /
  // follow-up / reply-anyway / edit flows; for a pending draft it switches the
  // draft card into edit mode.
  const [replyOpen, setReplyOpen] = useState(false)
  // A pending AI-drafted reply for the open conversation (held in draft mode or
  // flagged for review).
  const [aiDraft, setAiDraft] = useState<{ id: string; body: string; flagged?: boolean; flagReasons?: string[] } | null>(null)
  // Why no draft (e.g. 'automated' = the assistant skipped a newsletter).
  const [aiSkipReason, setAiSkipReason] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [showNoteInput, setShowNoteInput] = useState(false)
  const [noteText, setNoteText] = useState('')
  const [addingNote, setAddingNote] = useState(false)

  // Compose new message
  const [composing, setComposing] = useState(false)
  const [composeChannel, setComposeChannel] = useState<'email' | 'sms'>('email')
  const [composeTo, setComposeTo] = useState('')
  const [composeContactId, setComposeContactId] = useState('')
  const [composeSubject, setComposeSubject] = useState('')
  const [composeCc, setComposeCc] = useState('')
  const [composeBcc, setComposeBcc] = useState('')
  const [showCcBcc, setShowCcBcc] = useState(false)
  const [composeBody, setComposeBody] = useState('')
  const [composeSearch, setComposeSearch] = useState('')
  const [composeContacts, setComposeContacts] = useState<Array<{ id: string; display_name: string; primary_email: string | null; primary_phone: string | null }>>([])
  const [composeDropdown, setComposeDropdown] = useState(false)
  const [composeSending, setComposeSending] = useState(false)
  const [composeNeedsManualAddress, setComposeNeedsManualAddress] = useState(false)

  // Toast
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)
  const showToast = (msg: string, type: 'success' | 'error' = 'success') => { setToast({ msg, type }); setTimeout(() => setToast(null), 4000) }

  // The reading pane MUST start scrolled to the TOP (it is an email reader, not
  // a chat). We scroll this ref to the top on open — no scroll-to-bottom.
  const readBodyRef = useRef<HTMLDivElement>(null)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Hide the CRM app sidebar while the inbox is open (mockup behaviour). ──
  // Dispatch once on mount so the inbox opens with the app nav collapsed; the
  // AppShell listener is wired separately.
  useEffect(() => {
    try { window.dispatchEvent(new CustomEvent('om:appnav:set', { detail: { collapsed: true } })) } catch {}
  }, [])
  const toggleAppNav = useCallback(() => {
    try { window.dispatchEvent(new CustomEvent('om:appnav:toggle')) } catch {}
  }, [])

  // ── Load conversations ──
  const loadConversations = useCallback(async () => {
    try {
      const p = new URLSearchParams()
      if (search) { p.set('search', search); if (deepSearch) p.set('deep', '1') }
      if (channelFilter !== 'all') p.set('channel', channelFilter)
      if (statusFilter !== 'all') p.set('status', statusFilter)
      const res = await fetch(`/api/inbox?${p}`, { credentials: 'include' })
      const d = await res.json()
      if (d.ok) setConversations(d.data || [])
    } catch { /* silent */ }
    setListLoading(false)
  }, [search, deepSearch, channelFilter, statusFilter])

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(loadConversations, 250)
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current) }
  }, [loadConversations])

  // Auto-refresh inbox list every 60 seconds
  useEffect(() => {
    const interval = setInterval(loadConversations, 60_000)
    return () => clearInterval(interval)
  }, [loadConversations])

  // ── Load detail ──
  const loadDetail = useCallback(async (id: string) => {
    setComposing(false)
    setSelectedId(id); setDetailLoading(true); setDetail(null); setSidebarData(null); setNotes([]); setShowNoteInput(false); setAiDraft(null); setAiSkipReason(null); setReplyOpen(false)
    try {
      const [convRes, notesRes] = await Promise.all([
        fetch(`/api/inbox/${id}`, { credentials: 'include' }),
        fetch(`/api/inbox/notes?conversationId=${id}`, { credentials: 'include' }),
      ])
      const d = await convRes.json()
      const n = await notesRes.json()
      if (d.ok) {
        setDetail(d.data)
        if (n.ok) setNotes(n.data || [])
        const msgs: UnifiedMsg[] = d.data.messages || []
        const lastIn = [...msgs].reverse().find((m: UnifiedMsg) => m.direction === 'inbound')
        if (lastIn) setActiveChannel(lastIn.channel)
        else if (d.data.availableChannels.email) setActiveChannel('email')
        else if (d.data.availableChannels.sms) setActiveChannel('sms')
        else if (d.data.availableChannels.chat) setActiveChannel('chat')
        const lastEmail = [...msgs].reverse().find((m: UnifiedMsg) => m.channel === 'email')
        setReplySubject(lastEmail?.subject ? (lastEmail.subject.startsWith('Re:') ? lastEmail.subject : `Re: ${lastEmail.subject}`) : '')
        setReplyBody('')
        // Surface a pending drafted reply for this conversation, if any.
        try {
          const dr = await fetch(`/api/inbox/draft?conversationId=${id}`, { credentials: 'include' })
          const dj = await dr.json()
          if (dj.ok && dj.data) {
            setAiDraft({ id: dj.data.id, body: dj.data.body || '', flagged: dj.data.flagged, flagReasons: dj.data.flagReasons })
            if (dj.data.body) setReplyBody(dj.data.body)
          } else if (dj.ok && dj.skipReason) {
            setAiSkipReason(dj.skipReason)
          }
        } catch { /* no pending draft */ }
        // Mark read
        fetch(`/api/inbox/${id}`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markRead: true }) }).catch(() => {})
        setConversations(prev => prev.map(c => c.id === id ? { ...c, unreadCount: 0 } : c))
        // Sidebar (contact pane data)
        if (d.data.contact?.id) {
          setStageValue(d.data.contact.lifecycleStage || '')
          Promise.all([
            fetch(`/api/pipeline/contact-detail?id=${d.data.contact.id}`, { credentials: 'include' }).then(r => r.json()),
            fetch(`/api/crm-contact-tags?contactId=${d.data.contact.id}`, { credentials: 'include' }).then(r => r.json()).catch(() => ({ ok: false })),
          ]).then(([detRes, tagRes]) => {
            if (detRes.ok) setSidebarData({ ...detRes.data, tags: tagRes.ok ? (tagRes.data || []) : [] })
          }).catch(() => {})
        }
      }
    } catch { /* silent */ }
    setDetailLoading(false)
    // Email reader: start at the TOP.
    setTimeout(() => { if (readBodyRef.current) readBodyRef.current.scrollTop = 0 }, 0)
  }, [])

  // Deselect → back to list-only.
  const closeDetail = useCallback(() => {
    setSelectedId(null); setDetail(null); setContactOpen(false); setReplyOpen(false); setShowNoteInput(false)
  }, [])

  // Derive the AI state of the OPEN conversation from the draft + thread.
  const openAiState = useCallback((): AiState => {
    if (!detail) return null
    if (aiDraft) return aiDraft.flagged ? 'flagged' : 'draft'
    if (aiSkipReason === 'automated') return 'skipped'
    // Auto-sent: the assistant already replied automatically — detect a bot
    // outbound message in the thread.
    const botReplied = detail.messages.some(m => m.direction === 'outbound' && m.isBot)
    if (botReplied) return 'autosent'
    return 'manual'
  }, [detail, aiDraft, aiSkipReason])

  // ── Actions ──
  const handleSend = async () => {
    if (!detail || !replyBody.trim()) return
    if (activeChannel === 'email' && !replySubject.trim()) return
    setSending(true)
    try {
      let ok = false
      if (activeChannel === 'email' && detail.contact?.email) {
        const r = await fetch('/api/email/messages', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: detail.contact.email, subject: replySubject, bodyHtml: `<p>${replyBody.replace(/\n/g, '<br>')}</p>`, bodyText: replyBody, contactId: detail.contact.id }) })
        ok = (await r.json()).ok
      } else if (activeChannel === 'sms' && detail.contact?.phone) {
        const r = await fetch('/api/sms', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: detail.contact.phone, message: replyBody, contactId: detail.contact.id }) })
        ok = (await r.json()).ok
      } else if (activeChannel === 'chat' && detail.chatConversationId) {
        const r = await fetch('/api/chat/messages', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId: detail.chatConversationId, message: replyBody }) })
        ok = (await r.json()).ok
      }
      if (ok) { setReplyBody(''); setReplyOpen(false); showToast('Message sent'); if (selectedId) loadDetail(selectedId); loadConversations() }
      else { showToast('Failed to send message', 'error') }
    } catch { showToast('Failed to send message', 'error') }
    setSending(false)
  }

  // Approve & send a pending AI draft (edited body + mark sent).
  const approveDraft = async () => {
    if (!aiDraft || !replyBody.trim() || sending) return
    setSending(true)
    try {
      const r = await fetch('/api/inbox/draft', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: aiDraft.id, action: 'approve', body: replyBody }) })
      const j = await r.json()
      if (j.ok) { setAiDraft(null); setReplyBody(''); setReplyOpen(false); showToast('Sent'); if (selectedId) loadDetail(selectedId); loadConversations() }
      else showToast(j.error || 'Failed to send', 'error')
    } catch { showToast('Failed to send', 'error') }
    setSending(false)
  }
  const dismissDraft = async () => {
    if (!aiDraft) return
    const id = aiDraft.id
    setAiDraft(null); setReplyBody(''); setReplyOpen(false)
    try { await fetch('/api/inbox/draft', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action: 'dismiss' }) }) } catch { /* ignore */ }
    showToast('Draft dismissed')
    loadConversations()
  }

  const toggleStatus = async () => {
    if (!selectedId || !detail) return
    const s = detail.status === 'open' ? 'closed' : 'open'
    try {
      await fetch(`/api/inbox/${selectedId}`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: s }) })
      setDetail(prev => prev ? { ...prev, status: s } : prev)
      showToast(`Conversation ${s === 'closed' ? 'closed' : 'reopened'}`)
      loadConversations()
    } catch { showToast('Failed to update status', 'error') }
  }

  const addNote = async () => {
    if (!noteText.trim() || !selectedId) return
    setAddingNote(true)
    try {
      const res = await fetch('/api/inbox/notes', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: selectedId, content: noteText }) })
      const d = await res.json()
      if (d.ok) { setNotes(prev => [...prev, d.data]); setNoteText(''); setShowNoteInput(false); showToast('Note added') }
      else { showToast('Failed to save note', 'error') }
    } catch { showToast('Failed to save note', 'error') }
    setAddingNote(false)
  }

  const handleBulkAction = async (action: 'close' | 'reopen' | 'markRead' | 'delete') => {
    if (selectedIds.size === 0) return
    if (action === 'delete') {
      const n = selectedIds.size
      const ok = window.confirm(`Delete ${n} conversation${n > 1 ? 's' : ''}? This removes them from your inbox. Underlying messages are kept.`)
      if (!ok) return
    }
    const count = selectedIds.size
    try {
      await fetch('/api/inbox', { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: Array.from(selectedIds), action }) })
      const verb = action === 'close' ? 'closed'
        : action === 'reopen' ? 'reopened'
        : action === 'markRead' ? 'marked as read'
        : 'deleted'
      showToast(`${count} conversation${count > 1 ? 's' : ''} ${verb}`)
    } catch { showToast('Failed to update conversations', 'error') }
    if (action === 'delete' && selectedId && selectedIds.has(selectedId)) {
      closeDetail()
    }
    setSelectedIds(new Set()); setSelectMode(false); loadConversations()
  }

  const updateStage = async (stage: string) => {
    if (!detail?.contact?.id) return
    await fetch(`/api/pipeline/contact-detail?id=${detail.contact.id}`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lifecycleStage: stage }) }).catch(() => {})
    setStageValue(stage); setEditingStage(false)
    fetch(`/api/contacts/${detail.contact.id}`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lifecycle_stage: stage }) }).catch(() => {})
  }

  const addTag = async (tagName: string) => {
    if (!detail?.contact?.id || !tagName.trim()) return
    await fetch('/api/crm-contact-tags', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contactId: detail.contact.id, name: tagName.trim() }) }).catch(() => {})
    setNewTag('')
    if (detail.contact.id) {
      fetch(`/api/crm-contact-tags?contactId=${detail.contact.id}`, { credentials: 'include' }).then(r => r.json()).then(d => {
        if (d.ok) setSidebarData((prev: any) => prev ? { ...prev, tags: d.data || [] } : prev)
      }).catch(() => {})
    }
  }

  // ── Compose ──
  const searchContacts = async (q: string) => {
    setComposeSearch(q)
    if (q.length < 2) { setComposeContacts([]); setComposeDropdown(false); return }
    try {
      const res = await fetch(`/api/inbox/contacts?q=${encodeURIComponent(q)}`, { credentials: 'include' })
      const d = await res.json()
      setComposeContacts(d.ok ? (d.data || []) : [])
      setComposeDropdown((d.data || []).length > 0)
    } catch { setComposeContacts([]) }
  }

  const selectComposeContact = (c: any) => {
    setComposeContactId(c.id)
    const addr = composeChannel === 'sms' ? (c.primary_phone || '') : (c.primary_email || '')
    setComposeTo(addr)
    setComposeSearch(c.display_name || c.primary_email || '')
    setComposeDropdown(false)
    setComposeNeedsManualAddress(!addr)
  }

  const handleComposeSend = async () => {
    if (!composeTo.trim() || !composeBody.trim()) return
    if (composeChannel === 'email' && !composeSubject.trim()) return
    setComposeSending(true)
    try {
      let ok = false
      if (composeChannel === 'email') {
        const r = await fetch('/api/email/messages', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: composeTo, cc: composeCc || undefined, bcc: composeBcc || undefined, subject: composeSubject, bodyHtml: `<p>${composeBody.replace(/\n/g, '<br>')}</p>`, bodyText: composeBody, contactId: composeContactId || undefined }) })
        ok = (await r.json()).ok
      } else {
        const r = await fetch('/api/sms', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: composeTo, message: composeBody, contactId: composeContactId || undefined }) })
        ok = (await r.json()).ok
      }
      if (ok) {
        showToast('Message sent')
        setComposing(false); setComposeTo(''); setComposeSubject(''); setComposeCc(''); setComposeBcc(''); setShowCcBcc(false); setComposeBody(''); setComposeContactId(''); setComposeSearch(''); setComposeNeedsManualAddress(false)
        loadConversations()
      } else { showToast('Failed to send message', 'error') }
    } catch { showToast('Failed to send message', 'error') }
    setComposeSending(false)
  }

  const startCompose = () => {
    setComposing(true); setSelectedId(null); setDetail(null); setContactOpen(false)
    setComposeTo(''); setComposeSubject(''); setComposeCc(''); setComposeBcc(''); setShowCcBcc(false)
    setComposeBody(''); setComposeContactId(''); setComposeSearch(''); setComposeChannel('email'); setComposeNeedsManualAddress(false)
  }

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  // Apply the mockup state filter on top of the server-filtered list.
  const visibleConvs = conversations.filter(c => {
    if (listFilter === 'review') return c.aiState === 'draft' || c.aiState === 'flagged'
    if (listFilter === 'unread') return c.unreadCount > 0
    return true
  })
  const reviewCount = conversations.filter(c => c.aiState === 'draft' || c.aiState === 'flagged').length

  const allSelected = visibleConvs.length > 0 && visibleConvs.every(c => selectedIds.has(c.id))
  const toggleSelectAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(visibleConvs.map(c => c.id)))
  }

  const selectedConv = conversations.find(c => c.id === selectedId)
  const listMode: 'full' | 'side' = (selectedId || composing) ? 'side' : 'full'

  // ── List (shared by list-only + side-column modes) ──
  const renderList = () => (
    <div className={`flex flex-col min-h-0 bg-card overflow-hidden ${listMode === 'side' ? 'w-[340px] shrink-0 border-r' : 'flex-1'} ${listMode === 'side' ? 'hidden md:flex' : 'flex'}`}>
      {/* Search + New Message */}
      <div className="p-3 pb-2 border-b">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder={deepSearch ? 'Search message content...' : 'Search conversations...'} className="pl-9 pr-9 h-9 text-sm" />
            <button type="button" onClick={() => setDeepSearch(!deepSearch)} title={deepSearch ? 'Deep search ON' : 'Search message content'}
              className={`absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded transition-colors ${deepSearch ? 'text-accent bg-accent/10' : 'text-muted-foreground/40 hover:text-muted-foreground'}`}>
              <BookOpen className="size-3.5" />
            </button>
          </div>
          <IconButton variant="outline" size="sm" type="button" aria-label="New message" title="Compose new message" onClick={startCompose}>
            <Pencil className="size-4" />
          </IconButton>
        </div>
      </div>

      {/* Filter chips: All / Needs review / Unread + channel + status */}
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 border-b">
        {([['all', 'All'], ['review', reviewCount > 0 ? `Needs review · ${reviewCount}` : 'Needs review'], ['unread', 'Unread']] as const).map(([k, l]) => (
          <button key={k} type="button" onClick={() => setListFilter(k as ListFilter)}
            className={`px-2.5 py-1 rounded-full border text-[11px] font-medium whitespace-nowrap transition-colors ${listFilter === k ? 'bg-foreground text-background border-foreground' : 'bg-card text-muted-foreground border-input hover:text-foreground'}`}>
            {l}
          </button>
        ))}
        <span className="w-px h-4 bg-border mx-0.5" />
        {(['all', 'email', 'sms'] as const).map(ch => (
          <button key={ch} type="button" onClick={() => setChannelFilter(ch)}
            className={`px-2.5 py-1 rounded-full border text-[11px] font-medium whitespace-nowrap transition-colors ${channelFilter === ch ? 'bg-foreground text-background border-foreground' : 'bg-card text-muted-foreground border-input hover:text-foreground'}`}>
            {ch === 'all' ? 'Any' : chLabel(ch)}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1.5">
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="h-6 rounded border border-input bg-background pl-1.5 pr-5 text-[10px]">
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="all">All</option>
          </select>
          <button type="button" onClick={() => { setSelectMode(!selectMode); setSelectedIds(new Set()) }}
            className={`p-1 rounded transition-colors ${selectMode ? 'text-accent bg-accent/10' : 'text-muted-foreground/50 hover:text-muted-foreground'}`}
            title={selectMode ? 'Cancel selection' : 'Select multiple'}>
            <SquareCheck className="size-3.5" />
          </button>
        </div>
      </div>

      {/* Bulk actions bar */}
      {selectMode && (
        <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 bg-accent/5 border-b">
          <button type="button" onClick={toggleSelectAll} disabled={visibleConvs.length === 0}
            className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-40"
            title={allSelected ? 'Clear selection' : 'Select all conversations'}>
            {allSelected ? <CheckCircle className="size-3 text-accent" /> : <Square className="size-3 text-muted-foreground/50" />}
            {allSelected ? 'Clear' : 'Select all'}
          </button>
          <span className="text-[10px] font-medium text-muted-foreground">{selectedIds.size} selected</span>
          {selectedIds.size > 0 && (
            <>
              <Button type="button" variant="outline" size="sm" className="h-6 text-[10px] px-2" onClick={() => handleBulkAction('markRead')}>
                <CheckCheck className="size-2.5 mr-1" /> Mark read
              </Button>
              <Button type="button" variant="outline" size="sm" className="h-6 text-[10px] px-2" onClick={() => handleBulkAction('close')}>
                <Archive className="size-2.5 mr-1" /> Archive
              </Button>
              <Button type="button" variant="outline" size="sm" className="h-6 text-[10px] px-2" onClick={() => handleBulkAction('reopen')}>
                <RotateCcw className="size-2.5 mr-1" /> Reopen
              </Button>
              <Button type="button" variant="outline" size="sm" className="h-6 text-[10px] px-2 text-[#b91c1c] hover:text-[#b91c1c] hover:bg-[rgba(239,68,68,.06)] dark:text-[#f87171] dark:hover:text-[#f87171] dark:hover:bg-[rgba(239,68,68,.08)]" onClick={() => handleBulkAction('delete')}>
                <Trash2 className="size-2.5 mr-1" /> Delete
              </Button>
            </>
          )}
          <button type="button" onClick={() => { setSelectMode(false); setSelectedIds(new Set()) }} className="ml-auto text-[10px] text-muted-foreground hover:text-foreground">Cancel</button>
        </div>
      )}

      {/* Conversation rows */}
      <div className="flex-1 overflow-y-auto">
        {listLoading ? (
          <div className="flex items-center justify-center py-16"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
        ) : visibleConvs.length === 0 ? (
          <div className="text-center py-12 px-6 mx-auto max-w-md">
            <div className="inline-flex items-center justify-center size-14 rounded-2xl bg-accent/10 text-accent mb-4">
              <Inbox className="size-7" />
            </div>
            <h3 className="text-sm font-semibold mb-1">{listFilter !== 'all' ? 'Nothing here' : 'Your inbox is empty'}</h3>
            <p className="text-xs text-muted-foreground mb-8">{listFilter !== 'all' ? 'No conversations match this filter.' : "When you send emails or receive SMS messages, they'll appear here in one place."}</p>
            {listFilter === 'all' && (
              <div className="space-y-2 mt-2">
                <button type="button" onClick={startCompose} className="flex items-center gap-3 rounded-lg border p-3 text-left hover:bg-muted/50 transition-colors w-full">
                  <Mail className="size-5 text-[#1d4ed8] dark:text-[#93c5fd] shrink-0" />
                  <div><p className="text-xs font-medium">Send an email</p><p className="text-[10px] text-muted-foreground">Reach out to a contact</p></div>
                  <ChevronRight className="size-4 text-muted-foreground ml-auto shrink-0" />
                </button>
                <button type="button" onClick={() => onGoToSettings?.()} className="flex items-center gap-3 rounded-lg border p-3 text-left hover:bg-muted/50 transition-colors w-full">
                  <Smartphone className="size-5 text-[#047857] dark:text-[#34d399] shrink-0" />
                  <div><p className="text-xs font-medium">Connect SMS</p><p className="text-[10px] text-muted-foreground">Set up Twilio to send and receive texts</p></div>
                  <ChevronRight className="size-4 text-muted-foreground ml-auto shrink-0" />
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className={listMode === 'full' ? 'mx-auto max-w-3xl' : ''}>
            {visibleConvs.map(conv => (
              <div key={conv.id} className={`flex items-start gap-2 px-3 md:px-4 py-3 border-b transition-colors cursor-pointer relative ${selectedId === conv.id ? 'bg-accent/[.06] before:absolute before:left-0 before:top-0 before:bottom-0 before:w-[3px] before:bg-accent' : 'hover:bg-muted/40'}`}>
                {selectMode && (
                  <button type="button" onClick={e => { e.stopPropagation(); toggleSelect(conv.id) }} className="mt-1 shrink-0">
                    {selectedIds.has(conv.id) ? <CheckCircle className="size-4 text-accent" /> : <Square className="size-4 text-muted-foreground/40" />}
                  </button>
                )}
                <button type="button" onClick={() => { if (!selectMode) loadDetail(conv.id) }} className="flex items-start gap-3 flex-1 text-left min-w-0">
                  <div className="size-9 rounded-[11px] flex items-center justify-center text-xs font-bold text-white shrink-0" style={{ backgroundColor: avColor(conv.displayName) }}>
                    {ini(conv.displayName)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2 mb-0.5">
                      <span className={`text-sm truncate ${conv.unreadCount > 0 ? 'font-semibold' : 'font-medium'}`}>{conv.displayName || 'Unknown'}</span>
                      <span className="text-[10px] text-muted-foreground shrink-0">{relTime(conv.lastMessageAt)}</span>
                    </div>
                    <p className={`text-xs truncate ${conv.unreadCount > 0 ? 'text-foreground' : 'text-muted-foreground'}`}>
                      {conv.lastMessageDirection === 'outbound' && <span className="text-muted-foreground/60">You: </span>}
                      {conv.lastMessagePreview || 'No messages'}
                    </p>
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <ChannelBadge ch={conv.lastMessageChannel} />
                      <StateBadge state={conv.aiState ?? null} />
                    </div>
                  </div>
                </button>
                {conv.unreadCount > 0 && <span className="mt-3 size-2 rounded-full bg-[#6D4AFF] shrink-0 self-center" />}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )

  // ── Render ──
  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Inbox top bar: Menu (toggles app sidebar) */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b bg-card shrink-0">
        <button type="button" onClick={toggleAppNav}
          className="flex items-center gap-2 rounded-[9px] border border-input bg-card px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:border-accent/40 hover:text-foreground transition-colors">
          <Menu className="size-4" /> Menu
        </button>
        {(selectedId || composing) && (
          <button type="button" onClick={() => composing ? setComposing(false) : closeDetail()}
            className="md:hidden flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-4" /> Back
          </button>
        )}
      </div>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* LEFT: list — full width until a message is opened, then a 340px column */}
        {renderList()}

        {/* CENTER: reading pane / compose (only when a conversation is open or composing) */}
        {(selectedId || composing) && (
          <div className="flex-1 flex flex-col min-w-0 bg-muted/20">
            {composing ? (
              <ComposeView
                composeChannel={composeChannel} setComposeChannel={setComposeChannel}
                composeTo={composeTo} setComposeTo={setComposeTo}
                composeContactId={composeContactId} composeContacts={composeContacts}
                composeSubject={composeSubject} setComposeSubject={setComposeSubject}
                composeCc={composeCc} setComposeCc={setComposeCc}
                composeBcc={composeBcc} setComposeBcc={setComposeBcc}
                showCcBcc={showCcBcc} setShowCcBcc={setShowCcBcc}
                composeBody={composeBody} setComposeBody={setComposeBody}
                composeSearch={composeSearch} searchContacts={searchContacts}
                composeDropdown={composeDropdown} selectComposeContact={selectComposeContact}
                setComposeNeedsManualAddress={setComposeNeedsManualAddress} composeNeedsManualAddress={composeNeedsManualAddress}
                composeSending={composeSending} handleComposeSend={handleComposeSend}
                onClose={() => setComposing(false)}
              />
            ) : detailLoading ? (
              <div className="flex-1 flex items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
            ) : detail ? (
              <ReadingPane
                detail={detail}
                selectedConv={selectedConv}
                notes={notes}
                aiState={openAiState()}
                aiDraft={aiDraft}
                aiSkipReason={aiSkipReason}
                replyOpen={replyOpen} setReplyOpen={setReplyOpen}
                replySubject={replySubject} setReplySubject={setReplySubject}
                replyBody={replyBody} setReplyBody={setReplyBody}
                activeChannel={activeChannel} setActiveChannel={setActiveChannel}
                sending={sending}
                contactOpen={contactOpen} setContactOpen={setContactOpen}
                showNoteInput={showNoteInput} setShowNoteInput={setShowNoteInput}
                noteText={noteText} setNoteText={setNoteText} addingNote={addingNote} addNote={addNote}
                readBodyRef={readBodyRef}
                onClose={closeDetail}
                toggleStatus={toggleStatus}
                handleSend={handleSend}
                approveDraft={approveDraft}
                dismissDraft={dismissDraft}
              />
            ) : null}
          </div>
        )}

        {/* RIGHT: contact pane, expandable on demand */}
        {contactOpen && selectedId && detail && (
          <ContactPane
            detail={detail}
            selectedConv={selectedConv}
            sidebarData={sidebarData}
            stageValue={stageValue}
            editingStage={editingStage} setEditingStage={setEditingStage}
            updateStage={updateStage}
            newTag={newTag} setNewTag={setNewTag} addTag={addTag}
            onClose={() => setContactOpen(false)}
          />
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-4 right-4 z-50 px-4 py-2.5 rounded-lg shadow-lg text-sm font-medium animate-in fade-in slide-in-from-bottom-2 ${toast.type === 'error' ? 'bg-red-600 text-white' : 'bg-foreground text-background'}`}>
          {toast.msg}
        </div>
      )}
    </div>
  )
}

// ══════════════════════════════ Reading pane ══════════════════════════════
function ReadingPane(props: {
  detail: ConvDetail
  selectedConv: InboxConv | undefined
  notes: Note[]
  aiState: AiState
  aiDraft: { id: string; body: string; flagged?: boolean; flagReasons?: string[] } | null
  aiSkipReason: string | null
  replyOpen: boolean; setReplyOpen: (v: boolean) => void
  replySubject: string; setReplySubject: (v: string) => void
  replyBody: string; setReplyBody: (v: string) => void
  activeChannel: 'email' | 'sms' | 'chat'; setActiveChannel: (v: 'email' | 'sms' | 'chat') => void
  sending: boolean
  contactOpen: boolean; setContactOpen: (v: boolean) => void
  showNoteInput: boolean; setShowNoteInput: (v: boolean) => void
  noteText: string; setNoteText: (v: string) => void; addingNote: boolean; addNote: () => void
  readBodyRef: React.RefObject<HTMLDivElement | null>
  onClose: () => void
  toggleStatus: () => void
  handleSend: () => void
  approveDraft: () => void
  dismissDraft: () => void
}) {
  const {
    detail, selectedConv, notes, aiState, aiDraft, aiSkipReason,
    replyOpen, setReplyOpen, replySubject, setReplySubject, replyBody, setReplyBody,
    activeChannel, setActiveChannel, sending, contactOpen, setContactOpen,
    showNoteInput, setShowNoteInput, noteText, setNoteText, addingNote, addNote,
    readBodyRef, onClose, toggleStatus, handleSend, approveDraft, dismissDraft,
  } = props

  const name = detail.contact?.displayName || selectedConv?.displayName || 'Visitor'
  const ch = selectedConv?.lastMessageChannel || (detail.availableChannels.sms && !detail.availableChannels.email ? 'sms' : 'email')
  // Subject = the latest email subject in the thread, else the contact name.
  const lastEmail = [...detail.messages].reverse().find(m => m.channel === 'email' && m.subject)
  const subject = lastEmail?.subject || `Conversation with ${name}`
  const senderEmail = detail.contact?.email || selectedConv?.avatarEmail || detail.contact?.phone || ''
  const lastInbound = [...detail.messages].reverse().find(m => m.direction === 'inbound') || detail.messages[detail.messages.length - 1]

  return (
    <>
      {/* Header */}
      <div className="border-b px-4 md:px-6 py-3.5 flex items-start justify-between gap-3 shrink-0 bg-card">
        <div className="flex items-start gap-3 min-w-0">
          <div className="size-10 rounded-[11px] flex items-center justify-center text-sm font-bold text-white shrink-0" style={{ backgroundColor: avColor(name) }}>
            {ini(name)}
          </div>
          <div className="min-w-0">
            <h2 className="text-base md:text-lg font-bold tracking-tight truncate">{subject}</h2>
            <div className="text-[12px] text-muted-foreground truncate">
              {name}{senderEmail ? ` · ${senderEmail}` : ''}{lastInbound ? ` · ${fmtTime(lastInbound.createdAt)}` : ''}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <StateBadge state={aiState} />
          <ChannelBadge ch={ch} />
          <Badge variant={detail.status === 'open' ? 'default' : 'secondary'} className={`hidden sm:inline-flex h-[21px] px-2 rounded-full border font-mono text-[10px] font-semibold uppercase tracking-[.07em] cursor-pointer ${detail.status === 'open' ? 'bg-[rgba(16,185,129,.10)] text-[#047857] border-[rgba(16,185,129,.26)] dark:bg-[rgba(16,185,129,.14)] dark:text-[#34d399] dark:border-[rgba(16,185,129,.30)]' : 'bg-[rgba(16,16,18,.07)] text-[rgba(16,16,18,.62)] border-[rgba(16,16,18,.16)] dark:bg-[rgba(255,255,255,.10)] dark:text-[rgba(255,255,255,.6)] dark:border-[rgba(255,255,255,.14)]'}`} onClick={toggleStatus}>
            {detail.status}
          </Badge>
          <IconButton variant="ghost" size="sm" type="button" aria-label="Close conversation" title={detail.status === 'open' ? 'Close conversation' : 'Reopen conversation'} onClick={toggleStatus}>
            {detail.status === 'open' ? <Archive className="size-4" /> : <RotateCcw className="size-4" />}
          </IconButton>
          <IconButton variant={contactOpen ? 'outline' : 'ghost'} size="sm" type="button" aria-label="Contact details" title="Contact details" onClick={() => setContactOpen(!contactOpen)}>
            <Contact className="size-4" />
          </IconButton>
          <IconButton variant="ghost" size="sm" type="button" aria-label="Close" title="Close conversation" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </div>
      </div>

      {/* Body — full-width email card(s), scrolled to TOP on open */}
      <div ref={readBodyRef} className="flex-1 overflow-y-auto p-4 md:p-6">
        {detail.messages.length === 0 && notes.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground py-12">No messages yet.</p>
        ) : (() => {
          type TimelineItem = { type: 'message'; data: UnifiedMsg; ts: number } | { type: 'note'; data: Note; ts: number }
          const timeline: TimelineItem[] = [
            ...detail.messages.map(m => ({ type: 'message' as const, data: m, ts: new Date(m.createdAt).getTime() })),
            ...notes.map(n => ({ type: 'note' as const, data: n, ts: new Date(n.created_at).getTime() })),
          ].sort((a, b) => a.ts - b.ts)

          return (
            <div className="max-w-3xl mx-auto space-y-4">
              {timeline.map((item) => {
                if (item.type === 'note') {
                  return (
                    <div key={`note-${item.data.id}`} className="flex justify-center">
                      <div className="bg-[rgba(217,119,6,.06)] dark:bg-[rgba(245,158,11,.08)] border border-[rgba(217,119,6,.22)] dark:border-[rgba(245,158,11,.25)] rounded-lg px-4 py-2 max-w-[90%]">
                        <div className="flex items-center gap-1.5 mb-1">
                          <StickyNote className="size-3 text-[#b45309] dark:text-[#fbbf24]" />
                          <span className="text-[10px] font-medium text-[#b45309] dark:text-[#fbbf24]">Internal Note · {item.data.user_name}</span>
                          <span className="text-[10px] text-[#b45309]/60 dark:text-[#fbbf24]/60">{fmtTime(item.data.created_at)}</span>
                        </div>
                        <p className="text-xs text-[#b45309] dark:text-[#fbbf24] whitespace-pre-wrap">{item.data.content}</p>
                      </div>
                    </div>
                  )
                }
                const msg = item.data
                const out = msg.direction === 'outbound'
                return (
                  <div key={`msg-${msg.id}`} className={`rounded-2xl border ${out ? 'bg-accent text-accent-foreground border-transparent' : 'bg-card border-border'} px-5 py-4`}>
                    <div className={`flex items-center gap-1.5 mb-2 text-[10px] font-medium uppercase tracking-wide ${out ? 'opacity-80' : 'text-muted-foreground'}`}>
                      <span className={out ? '' : chColor(msg.channel)}>{chIcon(msg.channel, 'size-3')}</span>
                      <span>{chLabel(msg.channel)}</span>
                      {out && <span>· You</span>}
                      {msg.isBot && <><Sparkles className="size-3" /><span>Sent automatically by your Chief of Staff</span></>}
                      <span className={`ml-auto normal-case font-normal ${out ? 'opacity-80' : ''}`}>{fmtTime(msg.createdAt)}</span>
                      {out && msg.channel === 'email' && (
                        msg.clickedAt ? <CheckCheck className="size-3" /> :
                        msg.openedAt ? <Eye className="size-3" /> :
                        msg.status === 'sent' ? <Check className="size-3 opacity-70" /> : null
                      )}
                    </div>
                    {msg.channel === 'email' && msg.subject && <p className={`text-sm font-semibold mb-2 ${out ? '' : 'text-foreground'}`}>{msg.subject}</p>}
                    {msg.channel === 'email' ? (
                      <div className={`text-[14.5px] leading-relaxed prose prose-sm max-w-none [&>*]:m-0 [&>*+*]:mt-3 ${out ? 'prose-invert' : ''}`} dangerouslySetInnerHTML={{ __html: sanitizeHtml(msg.body) }} />
                    ) : (
                      <p className="text-[14.5px] leading-relaxed whitespace-pre-wrap">{msg.bodyText || msg.body}</p>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })()}
      </div>

      {/* State-aware reply area */}
      <div className="border-t bg-card shrink-0">
        {/* Internal note input */}
        {showNoteInput && (
          <div className="px-3 md:px-6 pt-3">
            <div className="bg-[rgba(217,119,6,.06)] dark:bg-[rgba(245,158,11,.08)] border border-[rgba(217,119,6,.22)] dark:border-[rgba(245,158,11,.25)] rounded-lg p-3 max-w-3xl mx-auto">
              <div className="flex items-center gap-1.5 mb-2">
                <StickyNote className="size-3 text-[#b45309] dark:text-[#fbbf24]" />
                <span className="text-[10px] font-medium text-[#b45309] dark:text-[#fbbf24]">Add Internal Note (only your team sees this)</span>
              </div>
              <Textarea value={noteText} onChange={e => setNoteText(e.target.value)} placeholder="Type a note..." className="text-sm mb-2 bg-white dark:bg-background" rows={2}
                onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); addNote() } }} />
              <div className="flex gap-2">
                <Button type="button" size="sm" className="h-7 text-xs" onClick={addNote} disabled={!noteText.trim() || addingNote}>
                  {addingNote ? <Loader2 className="size-3 animate-spin mr-1" /> : <Save className="size-3 mr-1" />} Save Note
                </Button>
                <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setShowNoteInput(false); setNoteText('') }}>Cancel</Button>
              </div>
            </div>
          </div>
        )}

        <div className="p-3 md:p-4 max-w-3xl mx-auto w-full">
          <ReplyArea
            detail={detail}
            aiState={aiState}
            aiDraft={aiDraft}
            aiSkipReason={aiSkipReason}
            replyOpen={replyOpen} setReplyOpen={setReplyOpen}
            replySubject={replySubject} setReplySubject={setReplySubject}
            replyBody={replyBody} setReplyBody={setReplyBody}
            activeChannel={activeChannel} setActiveChannel={setActiveChannel}
            sending={sending}
            handleSend={handleSend}
            approveDraft={approveDraft}
            dismissDraft={dismissDraft}
            toggleStatus={toggleStatus}
            showNoteInput={showNoteInput} setShowNoteInput={setShowNoteInput}
          />
        </div>
      </div>
    </>
  )
}

// ══════════════════════════════ Reply area ══════════════════════════════
function ReplyArea(props: {
  detail: ConvDetail
  aiState: AiState
  aiDraft: { id: string; body: string; flagged?: boolean; flagReasons?: string[] } | null
  aiSkipReason: string | null
  replyOpen: boolean; setReplyOpen: (v: boolean) => void
  replySubject: string; setReplySubject: (v: string) => void
  replyBody: string; setReplyBody: (v: string) => void
  activeChannel: 'email' | 'sms' | 'chat'; setActiveChannel: (v: 'email' | 'sms' | 'chat') => void
  sending: boolean
  handleSend: () => void
  approveDraft: () => void
  dismissDraft: () => void
  toggleStatus: () => void
  showNoteInput: boolean; setShowNoteInput: (v: boolean) => void
}) {
  const {
    detail, aiState, aiDraft, aiSkipReason, replyOpen, setReplyOpen,
    replySubject, setReplySubject, replyBody, setReplyBody, activeChannel, setActiveChannel,
    sending, handleSend, approveDraft, dismissDraft, toggleStatus, showNoteInput, setShowNoteInput,
  } = props

  const closed = detail.status === 'closed'

  // The full composer (channel toggle + subject + textarea + send), used by all
  // manual/follow-up/edit flows.
  const composer = (onSend: () => void, sendLabel = 'Send', sendIcon = <Send className="size-4" />) => (
    <div className="mt-1">
      <div className="flex items-center gap-1 mb-2">
        {(['email', 'sms'] as const).map(c => (
          <button key={c} type="button" disabled={!detail.availableChannels[c]} onClick={() => setActiveChannel(c)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${activeChannel === c ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted'} ${!detail.availableChannels[c] ? 'opacity-30 cursor-not-allowed' : ''}`}>
            {chIcon(c, 'size-3')} {chLabel(c)}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1">
          <IconButton variant="ghost" size="xs" type="button" title="Add internal note" aria-label="Add note" onClick={() => setShowNoteInput(!showNoteInput)}>
            <StickyNote className="size-3.5 text-[#b45309] dark:text-[#fbbf24]" />
          </IconButton>
        </div>
      </div>
      {activeChannel === 'email' && (
        <Input value={replySubject} onChange={e => setReplySubject(e.target.value)} placeholder="Subject" className="h-8 text-sm mb-2" />
      )}
      <div className="flex items-end gap-2">
        <Textarea value={replyBody} onChange={e => setReplyBody(e.target.value)}
          onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); onSend() } }}
          placeholder={`Reply via ${chLabel(activeChannel)}...`}
          disabled={sending || closed}
          className="min-h-[120px] max-h-[360px] resize-y text-sm flex-1" />
        <Button type="button" onClick={onSend} title={sendLabel}
          disabled={!replyBody.trim() || sending || (activeChannel === 'email' && !replySubject.trim()) || closed}
          className="h-10 px-4">
          {sending ? <Loader2 className="size-4 animate-spin" /> : sendIcon}
        </Button>
      </div>
      {activeChannel === 'sms' && replyBody.length > 0 && (
        <p className={`text-[10px] mt-1 ${replyBody.length > 160 ? 'text-[#b45309] dark:text-[#fbbf24]' : 'text-muted-foreground/50'}`}>
          {replyBody.length}/160 {replyBody.length > 160 ? `(${Math.ceil(replyBody.length / 160)} segments)` : ''}
        </p>
      )}
    </div>
  )

  if (closed) {
    return <p className="text-[12px] text-muted-foreground text-center py-2">Closed. <button type="button" className="text-accent underline" onClick={toggleStatus}>Reopen</button> to reply.</p>
  }

  // ── Draft pending (not flagged) ──
  if (aiState === 'draft' && aiDraft) {
    return (
      <div>
        <div className="rounded-xl border border-[rgba(109,74,255,.30)] bg-[rgba(109,74,255,.06)] px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-[13px] font-semibold text-[#5b3fd6] dark:text-[#c4b5fd]">
              <Sparkles className="size-4" /> {replyOpen ? 'Edit suggested reply' : 'Suggested reply ready'}
            </span>
            <button type="button" onClick={dismissDraft} className="text-[12px] text-muted-foreground hover:text-foreground">Dismiss</button>
          </div>
          {!replyOpen && <pre className="mt-2 font-sans whitespace-pre-wrap text-[13px] text-muted-foreground leading-relaxed">{aiDraft.body}</pre>}
        </div>
        {replyOpen && (
          <Textarea value={replyBody} onChange={e => setReplyBody(e.target.value)}
            onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); approveDraft() } }}
            className="mt-2 min-h-[140px] max-h-[360px] resize-y text-sm" />
        )}
        <div className="flex justify-end gap-2 mt-3">
          {replyOpen
            ? <Button type="button" variant="outline" size="sm" onClick={() => setReplyOpen(false)}>Cancel</Button>
            : <Button type="button" variant="outline" size="sm" onClick={() => setReplyOpen(true)}><Pencil className="size-3.5 mr-1.5" /> Edit</Button>}
          <Button type="button" size="sm" onClick={approveDraft} disabled={!replyBody.trim() || sending}>
            {sending ? <Loader2 className="size-3.5 mr-1.5 animate-spin" /> : <Send className="size-3.5 mr-1.5" />} Approve &amp; send
          </Button>
        </div>
      </div>
    )
  }

  // ── Flagged (held for review) ──
  if (aiState === 'flagged' && aiDraft) {
    return (
      <div>
        <div className="rounded-xl border border-[#e6cf9a] bg-[rgba(183,121,31,.10)] dark:bg-[rgba(245,158,11,.08)] px-4 py-3">
          <span className="flex items-center gap-1.5 text-[13px] font-semibold text-[#8a5a10] dark:text-[#fbbf24]">
            <span className="text-base leading-none">⚑</span> Flagged — held for your review
          </span>
          <p className="mt-1.5 text-[12px] text-[#8a5a10]/90 dark:text-[#fbbf24]/90">
            {aiDraft.flagReasons && aiDraft.flagReasons.length > 0 ? `Reason: ${aiDraft.flagReasons.join(', ')}. ` : ''}
            Drafted but not sent, even in auto mode.
          </p>
          {!replyOpen && <pre className="mt-2 font-sans whitespace-pre-wrap text-[13px] text-muted-foreground leading-relaxed">{aiDraft.body}</pre>}
        </div>
        {replyOpen && (
          <Textarea value={replyBody} onChange={e => setReplyBody(e.target.value)}
            onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); approveDraft() } }}
            className="mt-2 min-h-[140px] max-h-[360px] resize-y text-sm" />
        )}
        <div className="flex justify-end gap-2 mt-3">
          <button type="button" onClick={dismissDraft} className="text-[12px] text-muted-foreground hover:text-foreground self-center mr-auto">Dismiss</button>
          {replyOpen
            ? <Button type="button" variant="outline" size="sm" onClick={() => setReplyOpen(false)}>Cancel</Button>
            : <Button type="button" variant="outline" size="sm" onClick={() => setReplyOpen(true)}><Pencil className="size-3.5 mr-1.5" /> Edit</Button>}
          <Button type="button" size="sm" onClick={approveDraft} disabled={!replyBody.trim() || sending}>
            {sending ? <Loader2 className="size-3.5 mr-1.5 animate-spin" /> : <Send className="size-3.5 mr-1.5" />} Approve &amp; send
          </Button>
        </div>
      </div>
    )
  }

  // ── Auto-sent: assistant already replied → follow-up option ──
  if (aiState === 'autosent') {
    return (
      <div>
        {!replyOpen ? (
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <Sparkles className="size-3.5 text-[#5b3fd6] dark:text-[#c4b5fd]" /> Your Chief of Staff already replied automatically. You can follow up.
            </span>
            <Button type="button" size="sm" className="ml-auto" onClick={() => { setReplyBody(''); setReplyOpen(true) }}>Follow up</Button>
          </div>
        ) : composer(handleSend, 'Send follow-up')}
      </div>
    )
  }

  // ── Skipped (newsletter / automated) ──
  if (aiState === 'skipped' || (!aiDraft && aiSkipReason === 'automated')) {
    return (
      <div>
        {!replyOpen ? (
          <>
            <div className="rounded-xl border border-border bg-muted/40 px-4 py-3 text-[12px] text-muted-foreground">
              No reply suggested — looks like a newsletter, so your Chief of Staff skipped it. You can still reply yourself.
            </div>
            <div className="flex justify-end mt-3">
              <Button type="button" variant="outline" size="sm" onClick={() => { setReplyBody(''); setReplyOpen(true) }}>Reply anyway</Button>
            </div>
          </>
        ) : composer(handleSend)}
      </div>
    )
  }

  // ── Manual (no draft, no skip) ──
  return (
    <div>
      {!replyOpen ? (
        <div className="flex items-center gap-3">
          <span className="text-[12px] text-muted-foreground">No draft needed. Reply when you like.</span>
          <Button type="button" size="sm" className="ml-auto" onClick={() => { setReplyBody(''); setReplyOpen(true) }}>Reply</Button>
        </div>
      ) : composer(handleSend)}
    </div>
  )
}

// ══════════════════════════════ Contact pane ══════════════════════════════
function ContactPane(props: {
  detail: ConvDetail
  selectedConv: InboxConv | undefined
  sidebarData: any
  stageValue: string
  editingStage: boolean; setEditingStage: (v: boolean) => void
  updateStage: (s: string) => void
  newTag: string; setNewTag: (v: string) => void; addTag: (t: string) => void
  onClose: () => void
}) {
  const { detail, selectedConv, sidebarData, stageValue, editingStage, setEditingStage, updateStage, newTag, setNewTag, addTag, onClose } = props
  const name = detail.contact?.displayName || selectedConv?.displayName || 'Visitor'
  return (
    <div className="w-full md:w-[300px] md:shrink-0 border-l bg-card overflow-y-auto absolute md:static inset-0 z-20 md:z-auto">
      <div className="p-5 relative">
        <button type="button" onClick={onClose} aria-label="Hide contact panel" title="Hide contact panel" className="absolute right-3 top-3 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted">
          <X className="size-4" />
        </button>
        <div className="text-center mb-5 pb-5 border-b">
          <div className="size-14 rounded-[14px] flex items-center justify-center text-lg font-bold text-white mx-auto mb-3" style={{ backgroundColor: avColor(name) }}>
            {ini(name)}
          </div>
          <h3 className="font-semibold">{name}</h3>
          {detail.contact?.email && <p className="text-xs text-muted-foreground mt-0.5">{detail.contact.email}</p>}
          {detail.contact?.phone && <p className="text-xs text-muted-foreground">{detail.contact.phone}</p>}
          {!detail.contact && <p className="text-xs text-muted-foreground mt-1">No contact linked</p>}
        </div>
        <div className="space-y-4">
          {detail.contact && (
            <>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Stage</span>
                  <button type="button" onClick={() => setEditingStage(!editingStage)} className="text-[10px] text-muted-foreground hover:text-foreground"><Pencil className="size-2.5" /></button>
                </div>
                {editingStage ? (
                  <div className="flex flex-wrap gap-1">
                    {STAGES.map(s => (
                      <button key={s} type="button" onClick={() => updateStage(s)}
                        className={`px-2 py-0.5 rounded text-[10px] font-medium border transition-colors capitalize ${stageValue === s ? 'bg-accent text-accent-foreground border-accent' : 'border-border text-muted-foreground hover:border-accent/40'}`}>
                        {s}
                      </button>
                    ))}
                  </div>
                ) : (
                  <Badge variant="secondary" className="text-[10px] capitalize">{stageValue || detail.contact.lifecycleStage || 'Unknown'}</Badge>
                )}
              </div>
              {detail.contact.source && (
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Source</span>
                  <span className="capitalize">{detail.contact.source}</span>
                </div>
              )}
            </>
          )}

          {sidebarData?.engagementScore != null && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Engagement</span>
              <span className="font-medium">{sidebarData.engagementScore}/100</span>
            </div>
          )}

          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">Tags</p>
            <div className="flex flex-wrap gap-1 mb-2">
              {(sidebarData?.tags || []).map((t: any) => <Badge key={t.id} variant="secondary" className="text-[10px]">{t.name}</Badge>)}
            </div>
            <div className="flex items-center gap-1">
              <Input value={newTag} onChange={e => setNewTag(e.target.value)} placeholder="Add tag..."
                className="h-6 text-[10px] flex-1" onKeyDown={e => { if (e.key === 'Enter') addTag(newTag) }} />
              <IconButton variant="ghost" size="xs" type="button" aria-label="Add tag" onClick={() => addTag(newTag)} disabled={!newTag.trim()}>
                <Plus className="size-3" />
              </IconButton>
            </div>
          </div>

          {sidebarData?.notes?.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">Contact Notes</p>
              <div className="space-y-2">
                {sidebarData.notes.slice(0, 3).map((n: any) => (
                  <div key={n.id} className="text-xs bg-muted/50 rounded p-2">
                    <p className="line-clamp-2">{n.content}</p>
                    <p className="text-[10px] text-muted-foreground mt-1">{relTime(n.created_at)}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">Channels</p>
            <div className="flex items-center gap-2">
              {detail.availableChannels.email && <Badge variant="outline" className="text-[10px] gap-1"><Mail className="size-2.5" /> Email</Badge>}
              {detail.availableChannels.sms && <Badge variant="outline" className="text-[10px] gap-1"><Smartphone className="size-2.5" /> SMS</Badge>}
            </div>
          </div>

          <a href="/backend/contacts" className="flex items-center gap-2 text-xs text-accent hover:underline mt-4">
            <ExternalLink className="size-3" /> View full profile
          </a>
        </div>
      </div>
    </div>
  )
}

// ══════════════════════════════ Compose ══════════════════════════════
function ComposeView(props: {
  composeChannel: 'email' | 'sms'; setComposeChannel: (v: 'email' | 'sms') => void
  composeTo: string; setComposeTo: (v: string) => void
  composeContactId: string; composeContacts: Array<{ id: string; display_name: string; primary_email: string | null; primary_phone: string | null }>
  composeSubject: string; setComposeSubject: (v: string) => void
  composeCc: string; setComposeCc: (v: string) => void
  composeBcc: string; setComposeBcc: (v: string) => void
  showCcBcc: boolean; setShowCcBcc: (v: boolean) => void
  composeBody: string; setComposeBody: (v: string) => void
  composeSearch: string; searchContacts: (q: string) => void
  composeDropdown: boolean; selectComposeContact: (c: any) => void
  setComposeNeedsManualAddress: (v: boolean) => void; composeNeedsManualAddress: boolean
  composeSending: boolean; handleComposeSend: () => void
  onClose: () => void
}) {
  const {
    composeChannel, setComposeChannel, composeTo, setComposeTo, composeContactId, composeContacts,
    composeSubject, setComposeSubject, composeCc, setComposeCc, composeBcc, setComposeBcc,
    showCcBcc, setShowCcBcc, composeBody, setComposeBody, composeSearch, searchContacts,
    composeDropdown, selectComposeContact, setComposeNeedsManualAddress, composeNeedsManualAddress,
    composeSending, handleComposeSend, onClose,
  } = props
  return (
    <div className="flex-1 flex flex-col">
      <div className="border-b px-4 md:px-6 py-3.5 flex items-center justify-between shrink-0 bg-card">
        <h2 className="text-base font-semibold">New Message</h2>
        <IconButton variant="ghost" size="sm" type="button" aria-label="Close" onClick={onClose}><X className="size-4" /></IconButton>
      </div>
      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        <div className="max-w-xl mx-auto space-y-4">
          <div className="flex items-center gap-2">
            {(['email', 'sms'] as const).map(ch => (
              <button key={ch} type="button" onClick={() => { setComposeChannel(ch); if (composeContactId) { const c = composeContacts.find(x => x.id === composeContactId); if (c) { const addr = ch === 'sms' ? (c.primary_phone || '') : (c.primary_email || ''); setComposeTo(addr); setComposeNeedsManualAddress(!addr) } } }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${composeChannel === ch ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}>
                {chIcon(ch, 'size-3')} {chLabel(ch)}
              </button>
            ))}
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">To</label>
            <div className="relative">
              <Input value={composeSearch} onChange={e => searchContacts(e.target.value)}
                placeholder={composeChannel === 'sms' ? 'Search contact or enter phone...' : 'Search contact or enter email...'}
                className="text-sm" />
              {composeDropdown && composeContacts.length > 0 && (
                <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-background border rounded-lg shadow-lg max-h-48 overflow-y-auto">
                  {composeContacts.map(c => (
                    <button key={c.id} type="button" onClick={() => selectComposeContact(c)}
                      className="w-full text-left px-3 py-2 hover:bg-muted transition-colors border-b last:border-0">
                      <p className="text-sm font-medium">{c.display_name}</p>
                      <p className="text-xs text-muted-foreground">{c.primary_email}{c.primary_phone ? ` · ${c.primary_phone}` : ''}</p>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {composeTo && (
              <p className="text-[10px] text-muted-foreground mt-1">Sending to: <span className="font-medium text-foreground">{composeTo}</span></p>
            )}
            {((!composeContactId && composeSearch.length >= 3) || composeNeedsManualAddress) && (
              <div className="mt-2">
                <label className="text-xs font-medium text-muted-foreground mb-1 block">
                  {composeChannel === 'sms' ? 'Phone Number' : 'Email Address'}
                  {composeNeedsManualAddress && <span className="text-[#b45309] dark:text-[#fbbf24] ml-1">(not on file, enter manually)</span>}
                </label>
                <Input value={composeTo} onChange={e => setComposeTo(e.target.value)}
                  placeholder={composeChannel === 'sms' ? '+15551234567' : 'recipient@example.com'}
                  className="text-sm" />
              </div>
            )}
          </div>

          {composeChannel === 'email' && (
            <>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-medium text-muted-foreground">Subject</label>
                  {!showCcBcc && (
                    <button type="button" onClick={() => setShowCcBcc(true)} className="text-[10px] text-muted-foreground hover:text-foreground">CC / BCC</button>
                  )}
                </div>
                <Input value={composeSubject} onChange={e => setComposeSubject(e.target.value)} placeholder="Subject" className="text-sm" />
              </div>
              {showCcBcc && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">CC</label>
                    <Input value={composeCc} onChange={e => setComposeCc(e.target.value)} placeholder="cc@example.com" className="text-sm" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">BCC</label>
                    <Input value={composeBcc} onChange={e => setComposeBcc(e.target.value)} placeholder="bcc@example.com" className="text-sm" />
                  </div>
                </div>
              )}
            </>
          )}

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Message</label>
            <Textarea value={composeBody} onChange={e => setComposeBody(e.target.value)}
              placeholder={composeChannel === 'sms' ? 'Type your message...' : 'Write your email...'}
              className="text-sm min-h-[200px]" rows={8}
              onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); handleComposeSend() } }} />
            {composeChannel === 'sms' && composeBody.length > 0 && (
              <p className={`text-[10px] mt-1 ${composeBody.length > 160 ? 'text-[#b45309] dark:text-[#fbbf24]' : 'text-muted-foreground/50'}`}>
                {composeBody.length}/160 {composeBody.length > 160 ? `(${Math.ceil(composeBody.length / 160)} segments)` : ''}
              </p>
            )}
          </div>

          <div className="flex justify-end">
            <Button type="button" onClick={handleComposeSend}
              disabled={!composeTo.trim() || !composeBody.trim() || (composeChannel === 'email' && !composeSubject.trim()) || composeSending}>
              {composeSending ? <Loader2 className="size-4 mr-2 animate-spin" /> : <Send className="size-4 mr-2" />}
              {composeSending ? 'Sending...' : `Send ${chLabel(composeChannel)}`}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
