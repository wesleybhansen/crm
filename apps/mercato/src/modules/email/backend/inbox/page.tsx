'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { Badge } from '@open-mercato/ui/primitives/badge'
import { Switch } from '@open-mercato/ui/primitives/switch'
import { Label } from '@open-mercato/ui/primitives/label'
import {
  Search, Mail, MessageCircle, Smartphone, Send, X,
  PanelRightClose, PanelRightOpen, Check, CheckCheck,
  Eye, Loader2, Inbox, Archive, Bot, ExternalLink,
  StickyNote, Sparkles, Settings, Plus, SquareCheck,
  Square, CheckCircle, RotateCcw, Pencil, Tag, Save,
  Zap, BookOpen, MessageSquare, ChevronRight, Trash2,
} from 'lucide-react'

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
const chColor = (ch: string | null) => ch === 'email' ? 'text-blue-600' : ch === 'sms' ? 'text-emerald-600' : ch === 'chat' ? 'text-violet-600' : 'text-muted-foreground'

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

function sanitizeHtml(html: string): string {
  return html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '').replace(/\bon\w+\s*=\s*["'][^"']*["']/gi, '').replace(/javascript\s*:/gi, '')
}

const STAGES = ['lead', 'prospect', 'opportunity', 'customer', 'partner', 'churned']
const TONES = [
  { id: 'professional', label: 'Professional' },
  { id: 'friendly', label: 'Friendly' },
  { id: 'casual', label: 'Casual' },
  { id: 'formal', label: 'Formal' },
]

// ── Main ──
export default function UnifiedInboxPage() {
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

  // Sidebar
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarData, setSidebarData] = useState<any>(null)
  const [editingStage, setEditingStage] = useState(false)
  const [stageValue, setStageValue] = useState('')
  const [newTag, setNewTag] = useState('')

  // Composer
  const [activeChannel, setActiveChannel] = useState<'email' | 'sms' | 'chat'>('email')
  const [replySubject, setReplySubject] = useState('')
  const [replyBody, setReplyBody] = useState('')
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

  // AI Draft
  const [aiDraft, setAiDraft] = useState<string | null>(null)
  const [aiDrafting, setAiDrafting] = useState(false)
  const [showAiSetup, setShowAiSetup] = useState(false)
  const [aiSettings, setAiSettings] = useState<any>(null)
  const [aiSetupStep, setAiSetupStep] = useState(0)
  const [aiForm, setAiForm] = useState({ enabled: false, businessName: '', businessDescription: '', knowledgeBase: '', tone: 'professional', instructions: '' })
  const [savingAi, setSavingAi] = useState(false)

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

  // Load AI settings on mount and when window regains focus
  const loadAiSettings = useCallback(() => {
    fetch('/api/inbox/ai-settings', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.ok && d.data) { setAiSettings(d.data); setAiForm({ enabled: d.data.enabled, businessName: d.data.business_name || '', businessDescription: d.data.business_description || '', knowledgeBase: d.data.knowledge_base || '', tone: d.data.tone || 'professional', instructions: d.data.instructions || '' }) } })
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
    setSelectedId(id); setDetailLoading(true); setDetail(null); setSidebarData(null); setNotes([]); setAiDraft(null); setShowNoteInput(false)
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
      if (ok) { setReplyBody(''); setAiDraft(null); showToast('Message sent'); if (selectedId) loadDetail(selectedId); loadConversations() }
      else { showToast('Failed to send message', 'error') }
    } catch { showToast('Failed to send message', 'error') }
    setSending(false)
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

  const generateAiDraft = async () => {
    if (!detail || !selectedId) return
    setAiDrafting(true); setAiDraft(null)
    try {
      const res = await fetch('/api/inbox/ai-draft', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: selectedId, channel: activeChannel, recentMessages: detail.messages.slice(-10) }) })
      const d = await res.json()
      if (d.ok) setAiDraft(d.data.draft)
    } catch { /* silent */ }
    setAiDrafting(false)
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

  const saveAiSettings = async () => {
    setSavingAi(true)
    await fetch('/api/inbox/ai-settings', { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(aiForm) })
    setAiSettings({ ...aiSettings, ...aiForm })
    setSavingAi(false); setShowAiSetup(false)
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

  const selectedConv = conversations.find(c => c.id === selectedId)

  // ── Render ──
  return (
    <div className="flex h-[calc(100vh-56px)] overflow-hidden">
      {/* ═══ LEFT: Conversation List ═══ */}
      <div className="w-[340px] border-r flex flex-col shrink-0 bg-background">
        {/* Search + New Message */}
        <div className="p-3 pb-0">
          <div className="flex items-center gap-2">
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
          {(['all', 'email', 'sms', 'chat'] as const).map(ch => (
            <button key={ch} type="button" onClick={() => setChannelFilter(ch)}
              className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium transition-colors ${channelFilter === ch ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}>
              {ch === 'all' ? <Inbox className="size-3" /> : chIcon(ch, 'size-3')} {ch === 'all' ? 'All' : chLabel(ch)}
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
          <div className="flex items-center gap-2 px-3 py-1.5 bg-accent/5 border-b">
            <span className="text-[10px] font-medium text-muted-foreground">{selectedIds.size} selected</span>
            {selectedIds.size > 0 && (
              <>
                <Button type="button" variant="outline" size="sm" className="h-6 text-[10px] px-2" onClick={() => handleBulkAction('markRead')}>
                  <CheckCheck className="size-2.5 mr-1" /> Mark read
                </Button>
                <Button type="button" variant="outline" size="sm" className="h-6 text-[10px] px-2" onClick={() => handleBulkAction('close')}>
                  <Archive className="size-2.5 mr-1" /> Close
                </Button>
                <Button type="button" variant="outline" size="sm" className="h-6 text-[10px] px-2" onClick={() => handleBulkAction('reopen')}>
                  <RotateCcw className="size-2.5 mr-1" /> Reopen
                </Button>
                <Button type="button" variant="outline" size="sm" className="h-6 text-[10px] px-2 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/20" onClick={() => handleBulkAction('delete')}>
                  <Trash2 className="size-2.5 mr-1" /> Delete
                </Button>
              </>
            )}
            <button type="button" onClick={() => { setSelectMode(false); setSelectedIds(new Set()) }} className="ml-auto text-[10px] text-muted-foreground hover:text-foreground">Cancel</button>
          </div>
        )}

        {/* AI Assistant banner */}
        {!selectMode && (
          <a href="/backend/inbox/ai-setup" className="flex items-center gap-2.5 mx-3 mt-2 mb-1 px-3 py-2 rounded-lg bg-gradient-to-r from-violet-50 to-purple-50 dark:from-violet-950/20 dark:to-purple-950/20 border border-violet-200 dark:border-violet-800 hover:border-violet-300 transition-colors">
            <Sparkles className="size-4 text-violet-500 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-semibold text-violet-700 dark:text-violet-300">{aiSettings?.enabled ? 'AI Reply Assistant' : 'Set up AI Reply Assistant'}</p>
              <p className="text-[10px] text-violet-500/70">{aiSettings?.enabled ? 'Drafts replies using your knowledge base' : 'Auto-draft replies based on your business context'}</p>
            </div>
            <ChevronRight className="size-3.5 text-violet-400 shrink-0" />
          </a>
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
              <p className="text-xs text-muted-foreground mb-6">When you send emails, receive SMS messages, or get chat conversations, they'll all appear here in one place.</p>
              <div className="space-y-2">
                <a href="/backend/payments" className="flex items-center gap-3 rounded-lg border p-3 text-left hover:bg-muted/50 transition-colors">
                  <Mail className="size-5 text-blue-500 shrink-0" />
                  <div><p className="text-xs font-medium">Send an email</p><p className="text-[10px] text-muted-foreground">Invoice a client or reach out to a contact</p></div>
                  <ChevronRight className="size-4 text-muted-foreground ml-auto shrink-0" />
                </a>
                <a href="/backend/chat" className="flex items-center gap-3 rounded-lg border p-3 text-left hover:bg-muted/50 transition-colors">
                  <MessageCircle className="size-5 text-violet-500 shrink-0" />
                  <div><p className="text-xs font-medium">Set up live chat</p><p className="text-[10px] text-muted-foreground">Add a chat widget to your website</p></div>
                  <ChevronRight className="size-4 text-muted-foreground ml-auto shrink-0" />
                </a>
                <a href="/backend/settings-simple" className="flex items-center gap-3 rounded-lg border p-3 text-left hover:bg-muted/50 transition-colors">
                  <Smartphone className="size-5 text-emerald-500 shrink-0" />
                  <div><p className="text-xs font-medium">Connect SMS</p><p className="text-[10px] text-muted-foreground">Set up Twilio to send and receive texts</p></div>
                  <ChevronRight className="size-4 text-muted-foreground ml-auto shrink-0" />
                </a>
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
                <div className="size-9 rounded-full bg-muted flex items-center justify-center text-xs font-bold text-muted-foreground shrink-0 relative">
                  {ini(conv.displayName)}
                  {conv.unreadCount > 0 && <span className="absolute -top-0.5 -right-0.5 size-2.5 bg-blue-500 rounded-full border-2 border-background" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-0.5">
                    <span className={`text-sm truncate ${conv.unreadCount > 0 ? 'font-semibold' : 'font-medium'}`}>{conv.displayName || 'Unknown'}</span>
                    <span className="text-[10px] text-muted-foreground shrink-0 ml-2">{relTime(conv.lastMessageAt)}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className={chColor(conv.lastMessageChannel)}>{chIcon(conv.lastMessageChannel, 'size-3')}</span>
                    <p className={`text-xs truncate ${conv.unreadCount > 0 ? 'text-foreground' : 'text-muted-foreground'}`}>
                      {conv.lastMessageDirection === 'outbound' && <span className="text-muted-foreground/60">You: </span>}
                      {conv.lastMessagePreview || 'No messages'}
                    </p>
                  </div>
                </div>
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* ═══ CENTER: Message Thread ═══ */}
      <div className="flex-1 flex flex-col min-w-0">
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
                        {composeNeedsManualAddress && <span className="text-amber-600 ml-1">(not on file — enter manually)</span>}
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
                    <p className={`text-[10px] mt-1 ${composeBody.length > 160 ? 'text-amber-600' : 'text-muted-foreground/50'}`}>
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
                <Badge variant={detail.status === 'open' ? 'default' : 'secondary'} className={`text-[10px] cursor-pointer ${detail.status === 'open' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' : ''}`} onClick={toggleStatus}>
                  {detail.status}
                </Badge>
                <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={toggleStatus}>
                  {detail.status === 'open' ? <Archive className="size-3 mr-1" /> : <RotateCcw className="size-3 mr-1" />}
                  {detail.status === 'open' ? 'Close' : 'Reopen'}
                </Button>
                <IconButton variant="ghost" size="sm" type="button" aria-label="Toggle sidebar" onClick={() => setSidebarOpen(!sidebarOpen)}>
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
                        <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-lg px-4 py-2 max-w-[80%]">
                          <div className="flex items-center gap-1.5 mb-1">
                            <StickyNote className="size-3 text-amber-600" />
                            <span className="text-[10px] font-medium text-amber-700 dark:text-amber-400">Internal Note · {item.data.user_name}</span>
                            <span className="text-[10px] text-amber-600/60">{fmtTime(item.data.created_at)}</span>
                          </div>
                          <p className="text-xs text-amber-900 dark:text-amber-200 whitespace-pre-wrap">{item.data.content}</p>
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
                            {msg.isBot && <Bot className="size-2.5 text-violet-500" />}
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
                              msg.clickedAt ? <CheckCheck className="size-3 text-blue-500" /> :
                              msg.openedAt ? <Eye className="size-3 text-emerald-500" /> :
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
              {/* AI Draft suggestion */}
              {aiDraft && (
                <div className="px-3 pt-3">
                  <div className="bg-violet-50 dark:bg-violet-950/20 border border-violet-200 dark:border-violet-800 rounded-lg p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="flex items-center gap-1.5 text-[10px] font-medium text-violet-700 dark:text-violet-300"><Sparkles className="size-3" /> AI Draft Suggestion</span>
                      <div className="flex items-center gap-1">
                        <Button type="button" variant="ghost" size="sm" className="h-6 text-[10px] px-2" onClick={() => { setReplyBody(aiDraft); setAiDraft(null) }}>
                          <Check className="size-2.5 mr-1" /> Use
                        </Button>
                        <Button type="button" variant="ghost" size="sm" className="h-6 text-[10px] px-2" onClick={() => setAiDraft(null)}>
                          <X className="size-2.5" />
                        </Button>
                      </div>
                    </div>
                    <p className="text-xs text-violet-900 dark:text-violet-200 whitespace-pre-wrap">{aiDraft}</p>
                  </div>
                </div>
              )}

              {/* Note input */}
              {showNoteInput && (
                <div className="px-3 pt-3">
                  <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3">
                    <div className="flex items-center gap-1.5 mb-2">
                      <StickyNote className="size-3 text-amber-600" />
                      <span className="text-[10px] font-medium text-amber-700">Add Internal Note (only your team sees this)</span>
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
                  {(['email', 'sms', 'chat'] as const).map(ch => (
                    <button key={ch} type="button" disabled={!detail.availableChannels[ch]} onClick={() => setActiveChannel(ch)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${activeChannel === ch ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted'} ${!detail.availableChannels[ch] ? 'opacity-30 cursor-not-allowed' : ''}`}>
                      {chIcon(ch, 'size-3')} {chLabel(ch)}
                    </button>
                  ))}
                  <div className="ml-auto flex items-center gap-1">
                    <IconButton variant="ghost" size="xs" type="button" title="Add internal note" aria-label="Add note" onClick={() => setShowNoteInput(!showNoteInput)}>
                      <StickyNote className="size-3.5 text-amber-500" />
                    </IconButton>
                    {aiSettings?.enabled && (
                      <IconButton variant="ghost" size="xs" type="button" title="AI draft reply" aria-label="AI draft" onClick={generateAiDraft} disabled={aiDrafting}>
                        {aiDrafting ? <Loader2 className="size-3.5 animate-spin text-violet-500" /> : <Sparkles className="size-3.5 text-violet-500" />}
                      </IconButton>
                    )}
                  </div>
                </div>

                {activeChannel === 'email' && (
                  <Input value={replySubject} onChange={e => setReplySubject(e.target.value)} placeholder="Subject" className="h-8 text-sm mb-2" />
                )}
                <div className="flex items-end gap-2">
                  <Textarea value={replyBody} onChange={e => setReplyBody(e.target.value)}
                    onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); handleSend() } }}
                    placeholder={`Reply via ${chLabel(activeChannel)}...`}
                    disabled={sending || detail.status === 'closed'}
                    className="min-h-[44px] max-h-[300px] resize-none text-sm flex-1 transition-all" rows={1}
                    onFocus={e => { e.target.style.minHeight = '160px' }}
                    onBlur={e => { if (!e.target.value.trim()) e.target.style.minHeight = '44px' }} />
                  <Button type="button" onClick={handleSend}
                    disabled={!replyBody.trim() || sending || (activeChannel === 'email' && !replySubject.trim()) || detail.status === 'closed'}
                    className="h-10 px-4">
                    {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                  </Button>
                </div>
                {activeChannel === 'sms' && replyBody.length > 0 && (
                  <p className={`text-[10px] mt-1 ${replyBody.length > 160 ? 'text-amber-600' : 'text-muted-foreground/50'}`}>
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
        <div className="w-[300px] border-l bg-card overflow-y-auto shrink-0">
          <div className="p-5">
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

      {/* Toast notification */}
      {toast && (
        <div className={`fixed bottom-4 right-4 z-50 px-4 py-2.5 rounded-lg shadow-lg text-sm font-medium animate-in fade-in slide-in-from-bottom-2 ${toast.type === 'error' ? 'bg-red-600 text-white' : 'bg-foreground text-background'}`}>
          {toast.msg}
        </div>
      )}
    </div>
  )
}
