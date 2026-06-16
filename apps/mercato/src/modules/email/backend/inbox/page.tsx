'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { Badge } from '@open-mercato/ui/primitives/badge'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@open-mercato/ui/primitives/tabs'
import {
  Search, Mail, MessageCircle, Smartphone, Send, X,
  PanelRightClose, PanelRightOpen, PanelLeftClose, PanelLeftOpen,
  Check, CheckCheck,
  Eye, Loader2, Inbox, Archive, Bot, ExternalLink,
  StickyNote, Sparkles, Plus, SquareCheck,
  Square, CheckCircle, RotateCcw, Pencil, Save,
  BookOpen, ChevronRight, Trash2,
} from 'lucide-react'
import InboxSettings from './InboxSettings'

// ── Types ──
type InboxConv = {
  id: string; contactId: string | null; chatConversationId: string | null
  status: string; lastMessageAt: string | null; lastMessageChannel: string | null
  lastMessagePreview: string | null; lastMessageDirection: string | null
  unreadCount: number; displayName: string | null; avatarEmail: string | null; avatarPhone: string | null
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

// Deterministic colored avatar (matches the mockup's colored initials), drawn
// from the app palette (house violet, green, cyan, amber, plum).
const AV_COLORS = ['#6D4AFF', '#1E9E6A', '#0E7C93', '#B7791F', '#8E5BD0', '#C2557A', '#3E7BD0']
function avColor(name: string | null): string {
  const s = name || '?'
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return AV_COLORS[h % AV_COLORS.length]
}

// Channel badge: a soft-tinted mono micro-label (Email / SMS / Chat).
function ChannelBadge({ ch }: { ch: string | null }) {
  const styles: Record<string, string> = {
    email: 'bg-[rgba(109,74,255,.10)] text-[#5b3fd6] dark:text-[#c4b5fd]',
    sms: 'bg-[rgba(30,158,106,.12)] text-[#1e7a52] dark:text-[#34d399]',
    chat: 'bg-[rgba(14,124,147,.12)] text-[#0e7c93] dark:text-[#67e8f9]',
  }
  const key = ch === 'sms' ? 'sms' : ch === 'chat' ? 'chat' : 'email'
  return <span className={`font-mono text-[9px] font-bold uppercase tracking-[.05em] rounded px-1.5 py-0.5 ${styles[key]}`}>{chLabel(ch)}</span>
}

function sanitizeHtml(html: string): string {
  return html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '').replace(/\bon\w+\s*=\s*["'][^"']*["']/gi, '').replace(/javascript\s*:/gi, '')
}

const STAGES = ['lead', 'prospect', 'opportunity', 'customer', 'partner', 'churned']

// ── Main ──
export default function UnifiedInboxPage() {
  // Tabs: Conversations (default) + Settings, mirroring the Customer Service page.
  const [tab, setTab] = useState<'conversations' | 'settings'>('conversations')

  // List
  const [conversations, setConversations] = useState<InboxConv[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [deepSearch, setDeepSearch] = useState(false)
  const [channelFilter, setChannelFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('open')

  // Bulk select
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Detail
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ConvDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [notes, setNotes] = useState<Note[]>([])

  // Collapsible panes. The right contact pane reuses the existing sidebarOpen
  // flag; the left conversation-list pane gets its own. Each pane's collapsed
  // state persists in localStorage so it survives reloads.
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [sidebarData, setSidebarData] = useState<any>(null)
  const [editingStage, setEditingStage] = useState(false)
  const [stageValue, setStageValue] = useState('')
  const [newTag, setNewTag] = useState('')

  // Composer
  const [activeChannel, setActiveChannel] = useState<'email' | 'sms' | 'chat'>('email')
  const [replySubject, setReplySubject] = useState('')
  const [replyBody, setReplyBody] = useState('')
  // AI desk: a pending AI-drafted reply for the open conversation (held in draft
  // / hybrid mode, or a flagged one paused for review). Pre-fills the composer.
  const [aiDraft, setAiDraft] = useState<{ id: string; body: string; flagged?: boolean; flagReasons?: string[] } | null>(null)
  // Why no draft (e.g. 'automated' = the engine skipped a newsletter/no-reply),
  // so we can show a short explanation instead of a silent empty composer.
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

  // AI reply assistant status. The inbox no longer drafts replies inline (it is a
  // human personal inbox); this only powers the setup banner copy and is managed
  // in the Settings tab via InboxSettings.
  const [aiSettings, setAiSettings] = useState<any>(null)

  // Toast
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)
  const showToast = (msg: string, type: 'success' | 'error' = 'success') => { setToast({ msg, type }); setTimeout(() => setToast(null), 4000) }

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  // Hydrate collapsed-pane state from localStorage on mount. The right contact
  // pane reuses sidebarOpen (persisted under noli-inbox-right-collapsed: '1'
  // means collapsed/closed). The left list pane uses leftCollapsed.
  useEffect(() => {
    try {
      if (localStorage.getItem('noli-inbox-left-collapsed') === '1') setLeftCollapsed(true)
      if (localStorage.getItem('noli-inbox-right-collapsed') === '0') setSidebarOpen(true)
    } catch {}
  }, [])
  // Email-client focus: opening a conversation collapses the list to a slim rail
  // so the message + reply get the full width. Reopen the list from the rail to
  // browse. Transient (not persisted) so it never overrides the saved preference.
  useEffect(() => {
    if (selectedId) setLeftCollapsed(true)
  }, [selectedId])
  const toggleLeftCollapsed = useCallback(() => {
    setLeftCollapsed(prev => {
      const next = !prev
      try { localStorage.setItem('noli-inbox-left-collapsed', next ? '1' : '0') } catch {}
      return next
    })
  }, [])
  const toggleSidebar = useCallback(() => {
    setSidebarOpen(prev => {
      const next = !prev
      // Persist as a collapsed flag: '1' = collapsed (closed), '0' = open.
      try { localStorage.setItem('noli-inbox-right-collapsed', next ? '0' : '1') } catch {}
      return next
    })
  }, [])

  // Load AI settings on mount and when window regains focus (for the setup banner)
  const loadAiSettings = useCallback(() => {
    fetch('/api/inbox/ai-settings', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.ok && d.data) { setAiSettings(d.data) } })
      .catch(() => {})
  }, [])
  useEffect(() => { loadAiSettings() }, [loadAiSettings])
  useEffect(() => {
    const onFocus = () => loadAiSettings()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [loadAiSettings])

  // ── Load detail ──
  const loadDetail = useCallback(async (id: string) => {
    setComposing(false)
    setSelectedId(id); setDetailLoading(true); setDetail(null); setSidebarData(null); setNotes([]); setShowNoteInput(false); setAiDraft(null); setAiSkipReason(null)
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
        const lastIn = [...msgs].reverse().find(m => m.direction === 'inbound')
        if (lastIn) setActiveChannel(lastIn.channel)
        else if (d.data.availableChannels.email) setActiveChannel('email')
        else if (d.data.availableChannels.sms) setActiveChannel('sms')
        else if (d.data.availableChannels.chat) setActiveChannel('chat')
        const lastEmail = [...msgs].reverse().find(m => m.channel === 'email')
        setReplySubject(lastEmail?.subject ? (lastEmail.subject.startsWith('Re:') ? lastEmail.subject : `Re: ${lastEmail.subject}`) : '')
        setReplyBody('')
        // AI desk: surface a pending drafted reply for this conversation, if any.
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
        // Sidebar
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
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
  }, [])

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
      if (ok) { setReplyBody(''); showToast('Message sent'); if (selectedId) loadDetail(selectedId); loadConversations() }
      else { showToast('Failed to send message', 'error') }
    } catch { showToast('Failed to send message', 'error') }
    setSending(false)
  }

  // Approve & send a pending AI draft (sends the edited body + marks the draft sent).
  const approveDraft = async () => {
    if (!aiDraft || !replyBody.trim() || sending) return
    setSending(true)
    try {
      const r = await fetch('/api/inbox/draft', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: aiDraft.id, action: 'approve', body: replyBody }) })
      const j = await r.json()
      if (j.ok) { setAiDraft(null); setReplyBody(''); showToast('Sent'); if (selectedId) loadDetail(selectedId); loadConversations() }
      else showToast(j.error || 'Failed to send', 'error')
    } catch { showToast('Failed to send', 'error') }
    setSending(false)
  }
  const dismissDraft = async () => {
    if (!aiDraft) return
    const id = aiDraft.id
    setAiDraft(null); setReplyBody('')
    try { await fetch('/api/inbox/draft', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action: 'dismiss' }) }) } catch { /* ignore */ }
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
      setSelectedId(null); setDetail(null)
    }
    setSelectedIds(new Set()); setSelectMode(false); loadConversations()
  }

  const updateStage = async (stage: string) => {
    if (!detail?.contact?.id) return
    await fetch(`/api/pipeline/contact-detail?id=${detail.contact.id}`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lifecycleStage: stage }) }).catch(() => {})
    setStageValue(stage); setEditingStage(false)
    // Also update via the entity directly
    const container = null // client-side, use API
    fetch(`/api/contacts/${detail.contact.id}`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lifecycle_stage: stage }) }).catch(() => {})
  }

  const addTag = async (tagName: string) => {
    if (!detail?.contact?.id || !tagName.trim()) return
    await fetch('/api/crm-contact-tags', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contactId: detail.contact.id, name: tagName.trim() }) }).catch(() => {})
    setNewTag('')
    // Reload sidebar
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
    setComposing(true); setSelectedId(null); setDetail(null)
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

  // Select-all toggles between selecting every conversation currently in the
  // list and clearing the selection.
  const allSelected = conversations.length > 0 && selectedIds.size === conversations.length
  const toggleSelectAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(conversations.map(c => c.id)))
  }

  const selectedConv = conversations.find(c => c.id === selectedId)

  // ── Render ──
  return (
    <div className="flex flex-col h-[calc(100vh-56px)] overflow-hidden">
      {/* Tab switcher: Conversations (default) + Settings */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as 'conversations' | 'settings')} className="flex flex-col flex-1 min-h-0">
        <div className="px-4 pt-3 border-b shrink-0">
          <TabsList>
            <TabsTrigger value="conversations">Conversations</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="conversations" className="flex-1 min-h-0">
    <div className="flex h-full overflow-hidden gap-3 p-3 bg-muted/30">
      {/* ═══ LEFT: Conversation List ═══ */}
      {leftCollapsed ? (
        <div className="w-10 rounded-xl border flex flex-col items-center shrink-0 bg-card py-2 gap-2">
          <IconButton variant="ghost" size="sm" type="button" aria-label="Expand conversation list" title="Expand conversation list" onClick={toggleLeftCollapsed}>
            <PanelLeftOpen className="size-4" />
          </IconButton>
          <IconButton variant="ghost" size="sm" type="button" aria-label="New message" title="Compose new message" onClick={startCompose}>
            <Pencil className="size-4" />
          </IconButton>
        </div>
      ) : (
      <div className="w-[340px] rounded-xl border flex flex-col shrink-0 bg-card overflow-hidden">
        {/* Search + New Message */}
        <div className="p-3 pb-0">
          <div className="flex items-center gap-2">
            <IconButton variant="ghost" size="sm" type="button" aria-label="Collapse conversation list" title="Collapse conversation list" onClick={toggleLeftCollapsed}>
              <PanelLeftClose className="size-4" />
            </IconButton>
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <Input value={search} onChange={e => setSearch(e.target.value)} placeholder={deepSearch ? 'Search message content...' : 'Search contacts...'} className="pl-9 pr-9 h-9 text-sm" />
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

        {/* Filters row */}
        <div className="flex items-center gap-1 px-3 py-2 border-b">
          {(['all', 'email', 'sms'] as const).map(ch => (
            <button key={ch} type="button" onClick={() => setChannelFilter(ch)}
              className={`px-2.5 py-1 rounded-full border text-[11px] font-medium whitespace-nowrap transition-colors ${channelFilter === ch ? 'bg-foreground text-background border-foreground' : 'bg-card text-muted-foreground border-input hover:text-foreground'}`}>
              {ch === 'all' ? 'All' : chLabel(ch)}
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

        {/* Bulk actions bar — only when selecting */}
        {selectMode && (
          <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 bg-accent/5 border-b">
            <button type="button" onClick={toggleSelectAll} disabled={conversations.length === 0}
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

        {/* Conversation list */}
        <div className="flex-1 overflow-y-auto">
          {listLoading ? (
            <div className="flex items-center justify-center py-16"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
          ) : conversations.length === 0 ? (
            /* ═══ EMPTY STATE ═══ */
            <div className="text-center py-12 px-6">
              <div className="inline-flex items-center justify-center size-14 rounded-2xl bg-accent/10 text-accent mb-4">
                <Inbox className="size-7" />
              </div>
              <h3 className="text-sm font-semibold mb-1">Your inbox is empty</h3>
              <p className="text-xs text-muted-foreground mb-8">When you send emails or receive SMS messages, they'll appear here in one place.</p>
              <div className="space-y-2 mt-2">
                <a href="/backend/payments" className="flex items-center gap-3 rounded-lg border p-3 text-left hover:bg-muted/50 transition-colors">
                  <Mail className="size-5 text-[#1d4ed8] dark:text-[#93c5fd] shrink-0" />
                  <div><p className="text-xs font-medium">Send an email</p><p className="text-[10px] text-muted-foreground">Invoice a client or reach out to a contact</p></div>
                  <ChevronRight className="size-4 text-muted-foreground ml-auto shrink-0" />
                </a>
                <button type="button" onClick={() => setTab('settings')} className="flex items-center gap-3 rounded-lg border p-3 text-left hover:bg-muted/50 transition-colors w-full">
                  <Smartphone className="size-5 text-[#047857] dark:text-[#34d399] shrink-0" />
                  <div><p className="text-xs font-medium">Connect SMS</p><p className="text-[10px] text-muted-foreground">Set up Twilio to send and receive texts</p></div>
                  <ChevronRight className="size-4 text-muted-foreground ml-auto shrink-0" />
                </button>
              </div>
            </div>
          ) : conversations.map(conv => (
            <div key={conv.id} className={`flex items-start gap-2 px-3 py-3 border-b transition-colors cursor-pointer ${selectedId === conv.id ? 'bg-muted/70' : 'hover:bg-muted/40'}`}>
              {selectMode && (
                <button type="button" onClick={e => { e.stopPropagation(); toggleSelect(conv.id) }} className="mt-1 shrink-0">
                  {selectedIds.has(conv.id) ? <CheckCircle className="size-4 text-accent" /> : <Square className="size-4 text-muted-foreground/40" />}
                </button>
              )}
              <button type="button" onClick={() => { if (!selectMode) loadDetail(conv.id) }} className="flex items-start gap-3 flex-1 text-left min-w-0">
                <div className="size-9 rounded-[11px] flex items-center justify-center text-xs font-bold text-white shrink-0 relative" style={{ backgroundColor: avColor(conv.displayName) }}>
                  {ini(conv.displayName)}
                  {conv.unreadCount > 0 && <span className="absolute -top-0.5 -right-0.5 size-2.5 bg-[#6D4AFF] rounded-full border-2 border-card" />}
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
                  <div className="mt-1.5"><ChannelBadge ch={conv.lastMessageChannel} /></div>
                </div>
              </button>
            </div>
          ))}
        </div>
      </div>
      )}

      {/* ═══ CENTER: Message Thread ═══ */}
      <div className="flex-1 flex flex-col min-w-0 rounded-xl border bg-card overflow-hidden">
        {composing ? (
          /* ═══ COMPOSE NEW MESSAGE ═══ */
          <div className="flex-1 flex flex-col">
            <div className="border-b px-4 py-3 flex items-center justify-between shrink-0 bg-card">
              <h2 className="text-sm font-semibold">New Message</h2>
              <IconButton variant="ghost" size="sm" type="button" aria-label="Close" onClick={() => setComposing(false)}><X className="size-4" /></IconButton>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <div className="max-w-xl mx-auto space-y-4">
                {/* Channel toggle */}
                <div className="flex items-center gap-2">
                  {(['email', 'sms'] as const).map(ch => (
                    <button key={ch} type="button" onClick={() => { setComposeChannel(ch); if (composeContactId) { const c = composeContacts.find(x => x.id === composeContactId); if (c) { const addr = ch === 'sms' ? (c.primary_phone || '') : (c.primary_email || ''); setComposeTo(addr); setComposeNeedsManualAddress(!addr) } } }}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${composeChannel === ch ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}>
                      {chIcon(ch, 'size-3')} {chLabel(ch)}
                    </button>
                  ))}
                </div>

                {/* To field with contact search */}
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
                  {/* Show manual address input when: no contact selected and typed 3+ chars, OR contact selected but missing the needed field */}
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

                {/* Subject + CC/BCC (email only) */}
                {composeChannel === 'email' && (
                  <>
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-xs font-medium text-muted-foreground">Subject</label>
                        {!showCcBcc && (
                          <button type="button" onClick={() => setShowCcBcc(true)} className="text-[10px] text-muted-foreground hover:text-foreground">
                            CC / BCC
                          </button>
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

                {/* Body */}
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
        ) : !selectedId ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <Inbox className="size-12 mx-auto text-muted-foreground/20 mb-4" />
              <p className="text-sm text-muted-foreground">Select a conversation</p>
              <p className="text-xs text-muted-foreground/60 mt-1">or</p>
              <Button type="button" variant="outline" size="sm" className="mt-3" onClick={startCompose}>
                <Pencil className="size-3.5 mr-1.5" /> New Message
              </Button>
            </div>
          </div>
        ) : detailLoading ? (
          <div className="flex-1 flex items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
        ) : detail ? (
          <>
            {/* Header */}
            <div className="border-b px-4 py-3 flex items-center justify-between shrink-0 bg-card">
              <div className="flex items-center gap-3 min-w-0">
                <div className="size-8 rounded-full bg-muted flex items-center justify-center text-xs font-bold text-muted-foreground shrink-0">
                  {ini(detail.contact?.displayName || selectedConv?.displayName || null)}
                </div>
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold truncate">{detail.contact?.displayName || selectedConv?.displayName || 'Visitor'}</h2>
                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    {detail.contact?.email && <span>{detail.contact.email}</span>}
                    {detail.contact?.phone && <span>{detail.contact.phone}</span>}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <Badge variant={detail.status === 'open' ? 'default' : 'secondary'} className={`h-[21px] px-2 rounded-full border font-mono text-[10px] font-semibold uppercase tracking-[.07em] cursor-pointer ${detail.status === 'open' ? 'bg-[rgba(16,185,129,.10)] text-[#047857] border-[rgba(16,185,129,.26)] dark:bg-[rgba(16,185,129,.14)] dark:text-[#34d399] dark:border-[rgba(16,185,129,.30)]' : 'bg-[rgba(16,16,18,.07)] text-[rgba(16,16,18,.62)] border-[rgba(16,16,18,.16)] dark:bg-[rgba(255,255,255,.10)] dark:text-[rgba(255,255,255,.6)] dark:border-[rgba(255,255,255,.14)]'}`} onClick={toggleStatus}>
                  {detail.status}
                </Badge>
                <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={toggleStatus}>
                  {detail.status === 'open' ? <Archive className="size-3 mr-1" /> : <RotateCcw className="size-3 mr-1" />}
                  {detail.status === 'open' ? 'Close' : 'Reopen'}
                </Button>
                <IconButton variant="ghost" size="sm" type="button" aria-label={sidebarOpen ? 'Collapse contact panel' : 'Expand contact panel'} title={sidebarOpen ? 'Collapse contact panel' : 'Expand contact panel'} onClick={toggleSidebar}>
                  {sidebarOpen ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
                </IconButton>
              </div>
            </div>

            {/* Messages + Notes interleaved */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {detail.messages.length === 0 && notes.length === 0 ? (
                <p className="text-center text-sm text-muted-foreground py-12">No messages yet.</p>
              ) : (() => {
                // Merge messages and notes chronologically
                type TimelineItem = { type: 'message'; data: UnifiedMsg } | { type: 'note'; data: Note }
                const timeline: TimelineItem[] = [
                  ...detail.messages.map(m => ({ type: 'message' as const, data: m, ts: new Date(m.createdAt).getTime() })),
                  ...notes.map(n => ({ type: 'note' as const, data: n, ts: new Date(n.created_at).getTime() })),
                ].sort((a, b) => a.ts - b.ts)

                return timeline.map((item, i) => {
                  if (item.type === 'note') {
                    return (
                      <div key={`note-${item.data.id}`} className="flex justify-center">
                        <div className="bg-[rgba(217,119,6,.06)] dark:bg-[rgba(245,158,11,.08)] border border-[rgba(217,119,6,.22)] dark:border-[rgba(245,158,11,.25)] rounded-lg px-4 py-2 max-w-[80%]">
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
                  const prevItem = i > 0 ? timeline[i - 1] : null
                  const prevTs = prevItem ? (prevItem.type === 'message' ? prevItem.data.createdAt : prevItem.data.created_at) : null
                  const showDate = !prevTs || new Date(msg.createdAt).toDateString() !== new Date(prevTs).toDateString()

                  return (
                    <div key={`msg-${msg.id}`}>
                      {showDate && (
                        <div className="flex items-center gap-3 my-3">
                          <div className="flex-1 h-px bg-border" />
                          <span className="text-[10px] text-muted-foreground font-medium">{new Date(msg.createdAt).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</span>
                          <div className="flex-1 h-px bg-border" />
                        </div>
                      )}
                      <div className={`flex ${out ? 'justify-end' : 'justify-start'}`}>
                        <div className="max-w-[75%]">
                          <div className={`flex items-center gap-1 mb-1 ${out ? 'justify-end' : ''}`}>
                            <span className={chColor(msg.channel)}>{chIcon(msg.channel, 'size-2.5')}</span>
                            <span className="text-[9px] text-muted-foreground font-medium uppercase">{chLabel(msg.channel)}</span>
                            {msg.isBot && <Bot className="size-2.5 text-[#6d28d9] dark:text-[#c4b5fd]" />}
                          </div>
                          <div className={`rounded-2xl px-4 py-2.5 ${out ? 'bg-accent text-accent-foreground rounded-tr-md' : 'bg-muted rounded-tl-md'}`}>
                            {msg.channel === 'email' && msg.subject && <p className="text-xs font-semibold mb-1 opacity-70">{msg.subject}</p>}
                            {msg.channel === 'email' ? (
                              <div className="text-sm prose prose-sm max-w-none [&>*]:m-0" dangerouslySetInnerHTML={{ __html: sanitizeHtml(msg.body) }} />
                            ) : (
                              <p className="text-sm whitespace-pre-wrap">{msg.bodyText || msg.body}</p>
                            )}
                          </div>
                          <div className={`flex items-center gap-1.5 mt-1 ${out ? 'justify-end' : ''}`}>
                            <span className="text-[10px] text-muted-foreground">{fmtTime(msg.createdAt)}</span>
                            {out && msg.channel === 'email' && (
                              msg.clickedAt ? <CheckCheck className="size-3 text-[#1d4ed8] dark:text-[#93c5fd]" /> :
                              msg.openedAt ? <Eye className="size-3 text-[#047857] dark:text-[#34d399]" /> :
                              msg.status === 'sent' ? <Check className="size-3 text-muted-foreground/50" /> : null
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })
              })()}
              <div ref={messagesEndRef} />
            </div>

            {/* Composer area */}
            <div className="border-t bg-card shrink-0">
              {/* Note input */}
              {showNoteInput && (
                <div className="px-3 pt-3">
                  <div className="bg-[rgba(217,119,6,.06)] dark:bg-[rgba(245,158,11,.08)] border border-[rgba(217,119,6,.22)] dark:border-[rgba(245,158,11,.25)] rounded-lg p-3">
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

              <div className="p-3">
                {/* Toolbar */}
                <div className="flex items-center gap-1 mb-2">
                  {(['email', 'sms'] as const).map(ch => (
                    <button key={ch} type="button" disabled={!detail.availableChannels[ch]} onClick={() => setActiveChannel(ch)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${activeChannel === ch ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted'} ${!detail.availableChannels[ch] ? 'opacity-30 cursor-not-allowed' : ''}`}>
                      {chIcon(ch, 'size-3')} {chLabel(ch)}
                    </button>
                  ))}
                  <div className="ml-auto flex items-center gap-1">
                    <IconButton variant="ghost" size="xs" type="button" title="Add internal note" aria-label="Add note" onClick={() => setShowNoteInput(!showNoteInput)}>
                      <StickyNote className="size-3.5 text-[#b45309] dark:text-[#fbbf24]" />
                    </IconButton>
                  </div>
                </div>

                {aiDraft && (
                  <div className="mb-2 rounded-lg border border-[rgba(109,74,255,.30)] bg-[rgba(109,74,255,.06)] px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 text-[12px] font-semibold text-[#5b3fd6] dark:text-[#c4b5fd]">
                        <Sparkles className="size-3.5" /> Suggested reply{aiDraft.flagged ? ' — flagged for your review' : ''}
                      </span>
                      <button type="button" onClick={dismissDraft} className="text-[11px] text-muted-foreground hover:text-foreground">Dismiss</button>
                    </div>
                    {aiDraft.flagged && aiDraft.flagReasons && aiDraft.flagReasons.length > 0 && (
                      <p className="mt-1 text-[11px] text-muted-foreground">Flagged: {aiDraft.flagReasons.join(', ')}</p>
                    )}
                    <p className="mt-1 text-[11px] text-muted-foreground">Edit below, then Approve &amp; send.</p>
                  </div>
                )}
                {!aiDraft && aiSkipReason === 'automated' && (
                  <div className="mb-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
                    <p className="text-[12px] text-muted-foreground">No reply suggested. This looks like an automated or newsletter message, so the assistant skipped it. You can still reply yourself below.</p>
                  </div>
                )}
                {activeChannel === 'email' && (
                  <Input value={replySubject} onChange={e => setReplySubject(e.target.value)} placeholder="Subject" className="h-8 text-sm mb-2" />
                )}
                <div className="flex items-end gap-2">
                  <Textarea value={replyBody} onChange={e => setReplyBody(e.target.value)}
                    onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); aiDraft ? approveDraft() : handleSend() } }}
                    placeholder={`Reply via ${chLabel(activeChannel)}...`}
                    disabled={sending || detail.status === 'closed'}
                    className={`${aiDraft ? 'min-h-[180px]' : 'min-h-[120px]'} max-h-[360px] resize-y text-sm flex-1`} />
                  <Button type="button" onClick={() => aiDraft ? approveDraft() : handleSend()}
                    title={aiDraft ? 'Approve and send' : 'Send'}
                    disabled={!replyBody.trim() || sending || (activeChannel === 'email' && !replySubject.trim()) || detail.status === 'closed'}
                    className="h-10 px-4">
                    {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                  </Button>
                </div>
                {activeChannel === 'sms' && replyBody.length > 0 && (
                  <p className={`text-[10px] mt-1 ${replyBody.length > 160 ? 'text-[#b45309] dark:text-[#fbbf24]' : 'text-muted-foreground/50'}`}>
                    {replyBody.length}/160 {replyBody.length > 160 ? `(${Math.ceil(replyBody.length / 160)} segments)` : ''}
                  </p>
                )}
                {detail.status === 'closed' && (
                  <p className="text-[11px] text-muted-foreground text-center mt-2">Closed. <button type="button" className="text-accent underline" onClick={toggleStatus}>Reopen</button></p>
                )}
              </div>
            </div>
          </>
        ) : null}
      </div>

      {/* ═══ RIGHT: Contact Sidebar ═══ */}
      {sidebarOpen && selectedId && detail && (
        <div className="w-[300px] rounded-xl border bg-card overflow-y-auto shrink-0">
          <div className="p-5 relative">
            <button type="button" onClick={toggleSidebar} aria-label="Hide contact panel" title="Hide contact panel" className="absolute right-3 top-3 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted">
              <X className="size-4" />
            </button>
            <div className="text-center mb-5 pb-5 border-b">
              <div className="size-14 rounded-full bg-muted flex items-center justify-center text-lg font-bold text-muted-foreground mx-auto mb-3">
                {ini(detail.contact?.displayName || selectedConv?.displayName || null)}
              </div>
              <h3 className="font-semibold">{detail.contact?.displayName || selectedConv?.displayName || 'Visitor'}</h3>
              {detail.contact?.email && <p className="text-xs text-muted-foreground mt-0.5">{detail.contact.email}</p>}
              {detail.contact?.phone && <p className="text-xs text-muted-foreground">{detail.contact.phone}</p>}
              {!detail.contact && <p className="text-xs text-muted-foreground mt-1">No contact linked</p>}
            </div>
            <div className="space-y-4">
              {/* Lifecycle Stage — editable (only for linked contacts) */}
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

              {/* Tags — editable */}
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

              {/* Notes */}
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

              {/* Channels */}
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">Channels</p>
                <div className="flex items-center gap-2">
                  {detail.availableChannels.email && <Badge variant="outline" className="text-[10px] gap-1"><Mail className="size-2.5" /> Email</Badge>}
                  {detail.availableChannels.sms && <Badge variant="outline" className="text-[10px] gap-1"><Smartphone className="size-2.5" /> SMS</Badge>}
                  {detail.availableChannels.chat && <Badge variant="outline" className="text-[10px] gap-1"><MessageCircle className="size-2.5" /> Chat</Badge>}
                </div>
              </div>

              <a href="/backend/contacts" className="flex items-center gap-2 text-xs text-accent hover:underline mt-4">
                <ExternalLink className="size-3" /> View Full Profile
              </a>
            </div>
          </div>
        </div>
      )}

      {/* ═══ RIGHT: thin rail to reopen the contact panel when collapsed ═══ */}
      {!sidebarOpen && selectedId && detail && (
        <div className="w-10 border-l bg-card flex flex-col items-center shrink-0 py-2">
          <IconButton variant="ghost" size="sm" type="button" aria-label="Expand contact panel" title="Expand contact panel" onClick={toggleSidebar}>
            <PanelRightOpen className="size-4" />
          </IconButton>
        </div>
      )}
    </div>
        </TabsContent>

        <TabsContent value="settings" className="flex-1 min-h-0 overflow-y-auto">
          <InboxSettings onAiSettingsSaved={loadAiSettings} />
        </TabsContent>
      </Tabs>

      {/* Toast notification */}
      {toast && (
        <div className={`fixed bottom-4 right-4 z-50 px-4 py-2.5 rounded-lg shadow-lg text-sm font-medium animate-in fade-in slide-in-from-bottom-2 ${toast.type === 'error' ? 'bg-red-600 text-white' : 'bg-foreground text-background'}`}>
          {toast.msg}
        </div>
      )}
    </div>
  )
}
