'use client'

import { useState, useEffect, useRef } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Badge } from '@open-mercato/ui/primitives/badge'
import { Input } from '@open-mercato/ui/primitives/input'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@open-mercato/ui/primitives/tabs'
import { Headphones, Mail, Check, FileEdit, Send, Sparkles, BookOpen, MessageSquareQuote, FileText, Trash2, Plus, Server, Globe, X as XIcon, MessageSquare, Flag, Code, Link as LinkIcon, ExternalLink } from 'lucide-react'
import AppPasswordGuides from '@/modules/customers/backend/components/AppPasswordGuides'
import TwilioSmsGuide from '@/modules/customers/backend/components/TwilioSmsGuide'
import CustomerServiceQueue from './CustomerServiceQueue'

type ReplyMode = 'draft' | 'auto' | 'hybrid'
type FlagAction = 'pause' | 'auto_send'
type FlagScenario = { key: string; label: string; enabled: boolean; action: FlagAction; instructions: string }
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
  csSmsNumber: string | null
  csChatEnabled?: boolean
  flagScenarios?: FlagScenario[] | null
  defaultSignature?: string | null
}
// A website chat widget. Customer Service owns website chat: this panel manages
// the widget's APPEARANCE and deployment only. Answers, knowledge, and escalation
// are configured in the rest of these Customer Service settings.
type ChatWidget = {
  id: string
  name: string
  slug: string | null
  business_name: string | null
  brand_color: string | null
  welcome_message: string | null
  greeting_message: string | null
  is_active: boolean
  public_page_enabled: boolean
  embedCode: string
  conversation_count?: number
}
type KnowledgeEntry = {
  id: string
  kind: 'model_answer' | 'document'
  title: string
  sourceFilename: string | null
  sourceUrl?: string | null
  isWebSource?: boolean
  contentPreview: string
  createdAt: string
}

export default function CustomerServiceSettingsPage() {
  // Queue is the default view; Settings holds the configuration UI.
  const [tab, setTab] = useState<'queue' | 'settings'>('queue')

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  // null = watch all connected mailboxes. An array = only those ids.
  const [watchedIds, setWatchedIds] = useState<string[] | null>(null)
  const [replyMode, setReplyMode] = useState<ReplyMode>('draft')
  const [hybridThreshold, setHybridThreshold] = useState(0.8)
  const [signature, setSignature] = useState('')
  // Dedicated customer-service SMS number (E.164). Empty = SMS support off.
  const [csSmsNumber, setCsSmsNumber] = useState('')
  // When true, the public website chat widget routes inbound visitor messages
  // through the Customer Service drafter (flag scenarios + grounding) instead of
  // the standalone widget bot. Off = existing widget-bot behavior, unchanged.
  const [csChatEnabled, setCsChatEnabled] = useState(false)

  // Website chat widgets owned by Customer Service. This panel creates/edits the
  // APPEARANCE only (name, business name, brand color, welcome message), toggles
  // active + the hosted public page, and surfaces the embed code and hosted page
  // link. Answers/knowledge/escalation are handled by the CS settings on this page.
  const [widgets, setWidgets] = useState<ChatWidget[]>([])
  const [widgetsLoaded, setWidgetsLoaded] = useState(false)
  const [widgetBusy, setWidgetBusy] = useState<string | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  // New-widget form.
  const [showWidgetForm, setShowWidgetForm] = useState(false)
  const [nwName, setNwName] = useState('')
  const [nwBusinessName, setNwBusinessName] = useState('')
  const [nwBrandColor, setNwBrandColor] = useState('#6d28d9')
  const [nwWelcome, setNwWelcome] = useState('Hi there! How can we help you today?')
  const [nwSaving, setNwSaving] = useState(false)
  const [widgetError, setWidgetError] = useState('')
  // Inline edit of an existing widget's appearance.
  const [editWidgetId, setEditWidgetId] = useState<string | null>(null)
  const [ewName, setEwName] = useState('')
  const [ewBusinessName, setEwBusinessName] = useState('')
  const [ewBrandColor, setEwBrandColor] = useState('#6d28d9')
  const [ewWelcome, setEwWelcome] = useState('')

  // The org's connected Twilio number, if any, used as a "use this number" hint.
  const [twilioNumber, setTwilioNumber] = useState<string | null>(null)
  // Flag scenarios. The settings GET always returns the full default list (the 6
  // canonical scenarios plus any saved custom ones), so this is populated on
  // hydration; user edits autosave like the other fields.
  const [flagScenarios, setFlagScenarios] = useState<FlagScenario[]>([])
  // Draft inputs for the "Add a custom scenario" control.
  const [newScenarioLabel, setNewScenarioLabel] = useState('')
  const [newScenarioInstructions, setNewScenarioInstructions] = useState('')
  const [newScenarioAction, setNewScenarioAction] = useState<FlagAction>('pause')

  // Autosave plumbing. `hydratedRef` stays false until the initial GET has
  // populated the settings fields, so neither the first mount nor the
  // hydration write (which would otherwise clobber server state with defaults)
  // triggers a save. Only genuine user edits do.
  const hydratedRef = useRef(false)
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
    const all: EmailConnection[] = allRes?.ok ? (allRes.data || []) : []
    const cs: EmailConnection[] = csRes?.ok ? (csRes.data || []) : []
    if (allRes?.ok) setConnections(all)
    if (csRes?.ok) setCsInboxes(cs)
    return { all, cs }
  }

  // ---- Website chat widgets (appearance + deployment only) ----
  const origin = typeof window !== 'undefined' ? window.location.origin : ''

  async function loadWidgets() {
    const res = await fetch('/api/chat/widgets', { credentials: 'include' }).then(r => r.json()).catch(() => null)
    if (res?.ok) setWidgets(res.data || [])
    setWidgetsLoaded(true)
  }

  function copyText(key: string, text: string) {
    navigator.clipboard.writeText(text)
    setCopiedKey(key)
    setTimeout(() => setCopiedKey(k => (k === key ? null : k)), 2000)
  }

  async function createWidget() {
    setWidgetError('')
    if (!nwName.trim()) { setWidgetError('Give your chat widget a name.'); return }
    setNwSaving(true)
    try {
      const res = await fetch('/api/chat/widgets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: nwName.trim(),
          businessName: nwBusinessName.trim() || nwName.trim(),
          brandColor: nwBrandColor,
          welcomeMessage: nwWelcome.trim(),
          greetingMessage: nwWelcome.trim(),
          publicPageEnabled: true,
          config: { primaryColor: nwBrandColor, position: 'bottom-right' },
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (data.ok) {
        // Creating a widget here means Customer Service should own this chat, so
        // reflect cs_chat_enabled = true (the API also enforces this server-side).
        setCsChatEnabled(true)
        setShowWidgetForm(false)
        setNwName(''); setNwBusinessName(''); setNwBrandColor('#6d28d9')
        setNwWelcome('Hi there! How can we help you today?')
        await loadWidgets()
      } else {
        setWidgetError(data.error || 'Could not create the chat widget.')
      }
    } catch {
      setWidgetError('Could not create the chat widget.')
    }
    setNwSaving(false)
  }

  function beginEditWidget(w: ChatWidget) {
    setEditWidgetId(w.id)
    setEwName(w.name || '')
    setEwBusinessName(w.business_name || '')
    setEwBrandColor(w.brand_color || '#6d28d9')
    setEwWelcome(w.welcome_message || w.greeting_message || '')
    setWidgetError('')
  }

  async function saveEditWidget() {
    if (!editWidgetId) return
    setWidgetError('')
    if (!ewName.trim()) { setWidgetError('Give your chat widget a name.'); return }
    setWidgetBusy(editWidgetId)
    try {
      const res = await fetch(`/api/chat/widgets?id=${editWidgetId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: ewName.trim(),
          businessName: ewBusinessName.trim() || ewName.trim(),
          brandColor: ewBrandColor,
          welcomeMessage: ewWelcome.trim(),
          greetingMessage: ewWelcome.trim(),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (data.ok) { setEditWidgetId(null); await loadWidgets() }
      else setWidgetError(data.error || 'Could not save changes.')
    } catch {
      setWidgetError('Could not save changes.')
    }
    setWidgetBusy(null)
  }

  async function patchWidget(id: string, body: Record<string, unknown>) {
    setWidgetBusy(id)
    try {
      const res = await fetch(`/api/chat/widgets?id=${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (data.ok) await loadWidgets()
    } catch {}
    setWidgetBusy(null)
  }

  async function deleteWidget(id: string) {
    if (!confirm('Delete this chat widget? Any embed using it will stop working. This cannot be undone.')) return
    setWidgetBusy(id)
    try {
      await fetch(`/api/chat/widgets?id=${id}`, { method: 'DELETE', credentials: 'include' })
      if (editWidgetId === id) setEditWidgetId(null)
      await loadWidgets()
    } catch {}
    setWidgetBusy(null)
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
        const connectedEmail = supportEmail
        setSupportEmail(''); setSupportPassword('')
        setSupportImapHost(''); setSupportImapPort('993')
        setSupportSmtpHost(''); setSupportSmtpPort('587')
        setSupportShowAdvanced(false)
        const fresh = await reloadConnections()
        // Auto-watch the newly connected support inbox by default and persist it.
        const newConn = (fresh?.cs || []).find((c: EmailConnection) => c.email_address === connectedEmail)
          || (fresh?.cs || []).find((c: EmailConnection) => !csInboxes.some(x => x.id === c.id))
        if (newConn) {
          setWatchedIds(prev => {
            const next = prev === null ? [newConn.id] : (prev.includes(newConn.id) ? prev : [...prev, newConn.id])
            // Persist immediately so the inbox starts watching without a manual save.
            void persistSettings({ watchedConnectionIds: next })
            return next
          })
        }
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
  const [docFiles, setDocFiles] = useState<File[]>([])
  // Per-file upload progress + a summary line shown after a multi-file upload.
  const [docProgress, setDocProgress] = useState<{ name: string; status: 'pending' | 'done' | 'failed'; error?: string }[]>([])
  const [docSummary, setDocSummary] = useState('')

  // Add-a-web-page (FAQ / website URL) ingestion.
  const [urlValue, setUrlValue] = useState('')
  const [urlLabel, setUrlLabel] = useState('')
  const [urlSaving, setUrlSaving] = useState(false)
  const [urlError, setUrlError] = useState('')
  const [urlSuccess, setUrlSuccess] = useState('')

  // Add-from-Knowledge-Base picker.
  type KbDoc = { id: string; title: string; alreadyImported: boolean }
  const [kbPickerOpen, setKbPickerOpen] = useState(false)
  const [kbDocs, setKbDocs] = useState<KbDoc[]>([])
  const [kbConnected, setKbConnected] = useState(true)
  const [kbDocsLoading, setKbDocsLoading] = useState(false)
  const [kbSelectedIds, setKbSelectedIds] = useState<Set<string>>(new Set())
  const [kbImporting, setKbImporting] = useState(false)

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
      fetch('/api/twilio/connections', { credentials: 'include' }).then(r => r.json()).catch(() => null),
    ]).then(([settingsRes, connRes, kbRes, csConnRes, twilioRes]) => {
      if (cancelled) return
      if (settingsRes?.ok && settingsRes.data) {
        const s: Settings = settingsRes.data
        setWatchedIds(Array.isArray(s.watchedConnectionIds) ? s.watchedConnectionIds : null)
        setReplyMode(s.replyMode === 'auto' || s.replyMode === 'hybrid' ? s.replyMode : 'draft')
        if (typeof s.hybridConfidenceThreshold === 'number' && Number.isFinite(s.hybridConfidenceThreshold)) {
          setHybridThreshold(Math.min(1, Math.max(0, s.hybridConfidenceThreshold)))
        }
        setCsSmsNumber(s.csSmsNumber || '')
        setCsChatEnabled(s.csChatEnabled === true)
        if (Array.isArray(s.flagScenarios)) setFlagScenarios(s.flagScenarios)
        // Prepopulate with the server-computed default sign-off (built from the
        // business name) when no signature has been saved yet. This runs before
        // hydratedRef flips true on the next tick, so it does NOT trigger an
        // autosave; only genuine user edits after hydration save. The user can
        // still edit or clear the field.
        setSignature(s.signature || s.defaultSignature || '')
      }
      if (connRes?.ok) setConnections(connRes.data || [])
      if (csConnRes?.ok) setCsInboxes(csConnRes.data || [])
      if (twilioRes?.ok && twilioRes.data?.phoneNumber) setTwilioNumber(twilioRes.data.phoneNumber)
      if (kbRes?.ok) setKnowledge(kbRes.data || [])
      // Load website chat widgets for the CS-owned Website Chat panel.
      void loadWidgets()
      setLoading(false)
      // Mark hydration complete on the next tick so the state updates above do
      // not trip the autosave effect. From here on, only user edits autosave.
      setTimeout(() => { hydratedRef.current = true }, 0)
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
    setDocSummary('')
    if (docFiles.length === 0 && !docContent.trim()) { setKbError('Upload one or more files or paste the document text.'); return }
    setKbSaving(true)
    try {
      if (docFiles.length > 0) {
        // Upload each selected file as its own entry, tracking per-file progress.
        // The optional title applies only when a single file is uploaded; with
        // many files each falls back to its own filename server-side.
        const single = docFiles.length === 1
        setDocProgress(docFiles.map(f => ({ name: f.name, status: 'pending' as const })))
        let added = 0
        let skipped = 0
        for (let i = 0; i < docFiles.length; i++) {
          const file = docFiles[i]
          try {
            const form = new FormData()
            form.append('kind', 'document')
            if (single && docTitle.trim()) form.append('title', docTitle.trim())
            form.append('file', file)
            const res = await fetch('/api/customer-service/knowledge', { method: 'POST', credentials: 'include', body: form })
            const data = await res.json().catch(() => ({}))
            if (data.ok) {
              added++
              setDocProgress(prev => prev.map((p, idx) => idx === i ? { ...p, status: 'done' } : p))
            } else {
              skipped++
              setDocProgress(prev => prev.map((p, idx) => idx === i ? { ...p, status: 'failed', error: data.error } : p))
            }
          } catch {
            skipped++
            setDocProgress(prev => prev.map((p, idx) => idx === i ? { ...p, status: 'failed', error: 'Upload failed' } : p))
          }
        }
        setDocSummary(`${added} added${skipped ? `, ${skipped} skipped` : ''}.`)
        setDocFiles([]); setDocTitle('')
        await loadKnowledge()
      } else {
        // Paste-single path (unchanged behavior).
        const res = await fetch('/api/customer-service/knowledge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ kind: 'document', title: docTitle.trim() || undefined, content: docContent.trim() }),
        })
        const data = await res.json()
        if (data.ok) {
          setDocTitle(''); setDocContent('')
          await loadKnowledge()
        } else {
          setKbError(data.error || 'Failed to add document.')
        }
      }
    } catch {
      setKbError('Failed to add document.')
    }
    setKbSaving(false)
  }

  async function addWebPage() {
    setUrlError('')
    setUrlSuccess('')
    const url = urlValue.trim()
    if (!url) { setUrlError('Enter a web page URL.'); return }
    setUrlSaving(true)
    try {
      const res = await fetch('/api/customer-service/ingest-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ url, label: urlLabel.trim() || undefined }),
      })
      const data = await res.json().catch(() => ({}))
      if (data.ok) {
        setUrlValue(''); setUrlLabel('')
        setUrlSuccess('Page added. We pulled the text to help draft replies.')
        await loadKnowledge()
        setTimeout(() => setUrlSuccess(''), 4000)
      } else {
        setUrlError(data.error || 'Could not add that page.')
      }
    } catch {
      setUrlError('Could not add that page.')
    }
    setUrlSaving(false)
  }

  async function openKbPicker() {
    setKbError('')
    setKbPickerOpen(true)
    setKbDocsLoading(true)
    setKbSelectedIds(new Set())
    try {
      const res = await fetch('/api/customer-service/kb-documents', { credentials: 'include' }).then(r => r.json()).catch(() => null)
      if (res?.ok) {
        setKbConnected(res.connected !== false)
        setKbDocs(Array.isArray(res.data) ? res.data : [])
      } else {
        setKbConnected(false)
        setKbDocs([])
      }
    } catch {
      setKbConnected(false)
      setKbDocs([])
    }
    setKbDocsLoading(false)
  }

  function toggleKbDoc(id: string) {
    setKbSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  async function importSelectedKbDocs() {
    setKbError('')
    const ids = Array.from(kbSelectedIds)
    if (ids.length === 0) { setKbError('Select at least one document.'); return }
    setKbImporting(true)
    try {
      const res = await fetch('/api/customer-service/kb-documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ ids }),
      })
      const data = await res.json().catch(() => ({}))
      if (data.ok) {
        setDocSummary(`${data.added ?? 0} added${data.skipped ? `, ${data.skipped} skipped` : ''} from Knowledge Base.`)
        setKbPickerOpen(false)
        setKbSelectedIds(new Set())
        await loadKnowledge()
      } else {
        setKbError(data.error || 'Failed to import documents.')
      }
    } catch {
      setKbError('Failed to import documents.')
    }
    setKbImporting(false)
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

  // Update a single flag scenario by key (enabled / action / instructions).
  // Changing any field triggers the debounced autosave like the other settings.
  function updateFlagScenario(key: string, patch: Partial<FlagScenario>) {
    setFlagScenarios(prev => prev.map(s => s.key === key ? { ...s, ...patch } : s))
  }

  // A scenario is custom (user-defined, removable) when its key carries the
  // custom_ prefix. The 6 canonical scenarios are fixed and not removable.
  function isCustomScenario(key: string) {
    return key.startsWith('custom_')
  }

  // Generate a stable, unique key for a new custom scenario. We slugify the
  // label so the key is human-readable, then append a short random suffix to
  // keep it unique even if two customs share a label. The server validates the
  // custom_ prefix; the suffix guarantees we never collide with an existing key.
  function generateCustomKey(label: string): string {
    const slug = label.toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32)
    const rand = Math.random().toString(36).slice(2, 8)
    const base = slug ? `custom_${slug}_${rand}` : `custom_${rand}`
    // Extremely unlikely, but guard against a collision with an existing key.
    return flagScenarios.some(s => s.key === base) ? `${base}_${Math.random().toString(36).slice(2, 6)}` : base
  }

  // Append a new custom scenario from the draft inputs, then clear the inputs.
  // The new scenario starts enabled so it takes effect immediately; autosave
  // persists it via the existing flagScenarios effect.
  function addCustomScenario() {
    const label = newScenarioLabel.trim()
    if (!label) return
    const scenario: FlagScenario = {
      key: generateCustomKey(label),
      label,
      enabled: true,
      action: newScenarioAction,
      instructions: newScenarioInstructions.trim(),
    }
    setFlagScenarios(prev => [...prev, scenario])
    setNewScenarioLabel('')
    setNewScenarioInstructions('')
    setNewScenarioAction('pause')
  }

  // Remove a custom scenario (canonical scenarios cannot be removed).
  function removeCustomScenario(key: string) {
    if (!isCustomScenario(key)) return
    setFlagScenarios(prev => prev.filter(s => s.key !== key))
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

  // Central PUT helper. The server derives `enabled` from the watched mailboxes,
  // so the client never sends `enabled` and can never clobber it to false. We do
  // NOT send sourceModes anymore (one global reply mode applies to all mailboxes).
  // `overrides` lets callers persist a specific value (e.g. a just-added mailbox)
  // without waiting for a React state flush.
  async function persistSettings(overrides?: { watchedConnectionIds?: string[] | null }) {
    const res = await fetch('/api/customer-service/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        watchedConnectionIds: overrides && 'watchedConnectionIds' in overrides ? overrides.watchedConnectionIds : watchedIds,
        replyMode,
        hybridConfidenceThreshold: hybridThreshold,
        signature: signature.trim() || undefined,
        // Empty string clears the dedicated CS number server-side.
        csSmsNumber: csSmsNumber.trim(),
        csChatEnabled,
        flagScenarios,
      }),
    })
    return res.json()
  }

  async function autosave() {
    setSaving(true)
    setSaved(false)
    setError('')
    try {
      const data = await persistSettings()
      if (data.ok) {
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      } else {
        setError(data.error || 'Failed to save')
      }
    } catch {
      setError('Failed to save settings')
    }
    setSaving(false)
  }

  // Debounced autosave. Whenever a settings field the user controls changes, we
  // wait ~700ms after the last change and then PUT once. The hydration guard
  // keeps the initial load and the GET-driven state writes from saving. A
  // failed save leaves the error visible and retries on the next edit.
  useEffect(() => {
    if (!hydratedRef.current) return
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
    autosaveTimerRef.current = setTimeout(() => { void autosave() }, 700)
    return () => { if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedIds, replyMode, hybridThreshold, signature, csSmsNumber, csChatEnabled, flagScenarios])

  const watchingAll = watchedIds === null
  // Personal Inbox mailboxes are everything that is not a dedicated support inbox.
  const personalMailboxes = connections.filter(c => c.purpose !== 'customer_service')
  // The watch list shows the dedicated support inboxes by default. The user can
  // opt in to also watch their personal Inbox mailboxes.
  const visibleMailboxes = showSharedMailboxes ? connections : csInboxes

  // The feature is considered set up once at least one dedicated support inbox is
  // connected OR a dedicated customer-service SMS number is configured. Until
  // then, the Queue shows a guided empty-state.
  const needsSetup = csInboxes.length === 0 && csSmsNumber.trim() === ''

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="mb-1">
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <Headphones className="size-5 text-muted-foreground" /> Customer Service
        </h1>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        Let Noli reply to incoming customer emails. Choose whether replies wait for your approval, send automatically, or send only when they are confident and safe.
      </p>

      <Tabs value={tab} onValueChange={(v) => setTab(v as 'queue' | 'settings')}>
        <TabsList className="mb-4">
          <TabsTrigger value="queue">Queue</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="queue">
          {loading ? (
            <div className="rounded-lg border px-4 py-10 text-center text-sm text-muted-foreground">Loading...</div>
          ) : (
            <CustomerServiceQueue needsSetup={needsSetup} onGoToSettings={() => setTab('settings')} />
          )}
        </TabsContent>

        <TabsContent value="settings">
      {loading ? (
        <div className="rounded-lg border px-4 py-10 text-center text-sm text-muted-foreground">Loading...</div>
      ) : (
        <>
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
                <div className="pt-1">
                  <AppPasswordGuides />
                </div>
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
                      {conn.purpose === 'customer_service'
                        ? <Badge variant="violet">Support</Badge>
                        : conn.is_primary && <Badge variant="secondary">Primary</Badge>}
                    </label>
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

          {/* Flag scenarios */}
          <section className="mb-8">
            <h2 className="text-sm font-semibold mb-1 flex items-center gap-2">
              <Flag className="size-4 text-muted-foreground" /> Flag scenarios
            </h2>
            <p className="text-xs text-muted-foreground mb-3">
              Tell Noli which situations to watch for. When an incoming message matches an enabled scenario, Noli flags it, drafts a reply using your instructions, and emails you an alert. Pause for review holds the reply in your queue, even in auto-send mode. Auto-send lets the reply go out on its own.
            </p>
            <div className="rounded-lg border divide-y">
              {flagScenarios.length === 0 ? (
                <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                  No flag scenarios available.
                </div>
              ) : (
                flagScenarios.map(s => {
                  const custom = isCustomScenario(s.key)
                  return (
                  <div key={s.key} className="px-4 py-3 space-y-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <label className="flex items-center gap-2.5 min-w-0 cursor-pointer">
                        <input type="checkbox" checked={s.enabled}
                          onChange={e => updateFlagScenario(s.key, { enabled: e.target.checked })}
                          className="size-4 rounded border-input accent-[#2563eb] shrink-0" />
                        <span className="text-sm font-medium truncate">{s.label}</span>
                        {custom && <Badge variant="secondary" className="shrink-0">Custom</Badge>}
                      </label>
                      <div className="flex items-center gap-2 shrink-0">
                        <select
                          value={s.action}
                          onChange={e => updateFlagScenario(s.key, { action: e.target.value as FlagAction })}
                          disabled={!s.enabled}
                          className="shrink-0 rounded-md border bg-card px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
                        >
                          <option value="pause">Pause for my review</option>
                          <option value="auto_send">Auto-send the reply</option>
                        </select>
                        {custom && (
                          <button type="button" onClick={() => removeCustomScenario(s.key)}
                            className="shrink-0 text-muted-foreground hover:text-[#b91c1c] transition p-1" title="Remove scenario">
                            <Trash2 className="size-4" />
                          </button>
                        )}
                      </div>
                    </div>
                    {s.enabled && (
                      <textarea
                        value={s.instructions}
                        onChange={e => updateFlagScenario(s.key, { instructions: e.target.value })}
                        placeholder="How should the AI respond in this scenario? (optional)"
                        className="w-full rounded-md border bg-card px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring h-20"
                      />
                    )}
                  </div>
                  )
                })
              )}
            </div>

            {/* Add a custom scenario */}
            <div className="rounded-lg border mt-3">
              <div className="px-4 py-3 border-b">
                <p className="text-sm font-medium flex items-center gap-2">
                  <Plus className="size-4 text-muted-foreground" /> Add a custom scenario
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Define your own situation to watch for, such as a wholesale inquiry or a press request. Noli flags matching messages and follows your instructions.
                </p>
              </div>
              <div className="px-4 py-3 space-y-3">
                <input value={newScenarioLabel} onChange={e => setNewScenarioLabel(e.target.value)}
                  placeholder="Scenario name, e.g. Wholesale inquiry"
                  className="w-full rounded-md border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring" />
                <textarea value={newScenarioInstructions} onChange={e => setNewScenarioInstructions(e.target.value)}
                  placeholder="How should Noli respond in this scenario? (optional)"
                  className="w-full rounded-md border bg-card px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring h-20" />
                <div className="flex items-center justify-between gap-3">
                  <select
                    value={newScenarioAction}
                    onChange={e => setNewScenarioAction(e.target.value as FlagAction)}
                    className="rounded-md border bg-card px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                  >
                    <option value="pause">Pause for my review</option>
                    <option value="auto_send">Auto-send the reply</option>
                  </select>
                  <Button type="button" size="sm" onClick={addCustomScenario} disabled={!newScenarioLabel.trim()}>
                    <Plus className="size-3.5 mr-1" /> Add scenario
                  </Button>
                </div>
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
                <p className="text-[11px] text-muted-foreground mt-1.5">Added to the end of drafted replies. We prefilled a default from your business name. Edit or clear it anytime. You can still edit each draft before sending.</p>
              </div>
            </div>
          </section>

          {/* Customer service SMS number */}
          <section className="mb-8">
            <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
              <MessageSquare className="size-4 text-muted-foreground" /> Customer service SMS number
            </h2>
            <p className="text-xs text-muted-foreground mb-3">
              Use a dedicated Twilio number for support texts. Texts to this number are drafted by Noli and follow the reply mode above. Connect your Twilio account in Settings first. Use a number that is different from the one your Inbox uses, so support texts and inbox texts stay separate.
            </p>
            <div className="rounded-lg border">
              <div className="px-4 py-3 space-y-2">
                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block">
                  Support SMS number <span className="normal-case font-normal">(optional)</span>
                </label>
                <Input
                  value={csSmsNumber}
                  onChange={e => setCsSmsNumber(e.target.value)}
                  placeholder="+1 415 555 0123"
                  className="h-9 text-sm"
                  inputMode="tel"
                />
                {twilioNumber ? (
                  csSmsNumber.trim() === '' ? (
                    <p className="text-[11px] text-muted-foreground">
                      Your connected Twilio number is {twilioNumber}. Enter a different number to dedicate to support, then set its inbound webhook below.
                    </p>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">
                      Enter the Twilio number you want to use only for support. It must be different from your Inbox number ({twilioNumber}).
                    </p>
                  )
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    No Twilio account connected yet. Connect Twilio in Settings, then enter a dedicated support number here.
                  </p>
                )}
                <div className="rounded-md bg-muted/40 border px-3 py-2 mt-1">
                  <p className="text-[11px] font-medium text-muted-foreground mb-1">In Twilio, set this number&apos;s inbound message webhook to:</p>
                  <code className="text-xs break-all">https://crm.noliai.com/api/sms/webhook</code>
                  <p className="text-[11px] text-muted-foreground mt-1.5">
                    Method POST. This is the same webhook your Inbox uses, so the number you choose here must be a separate number from your Inbox number.
                  </p>
                </div>
                <div className="pt-1">
                  <TwilioSmsGuide />
                </div>
              </div>
            </div>
          </section>

          {/* Website chat — Customer Service owns website chat. Set up the widget
              here (appearance + deployment); answers and escalation come from the
              rest of these Customer Service settings. */}
          <section className="mb-8">
            <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
              <Globe className="size-4 text-muted-foreground" /> Website chat
            </h2>
            <p className="text-xs text-muted-foreground mb-3">
              Add live chat to your website. Customer Service powers it: visitors get an instant answer grounded in your knowledge and model answers, each message is checked against your flag scenarios, and a flagged message that pauses for review is held for you while the visitor sees a brief note that someone will follow up. Set the look of your widget below, then copy the embed code or share the hosted page link.
            </p>

            {/* Master toggle */}
            <div className="rounded-lg border mb-3">
              <label className="flex items-start justify-between gap-3 px-4 py-3 cursor-pointer">
                <div className="min-w-0">
                  <p className="text-sm font-medium">Handle website chat</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Route incoming chat messages through Customer Service. Uses your reply mode, flag scenarios, and knowledge. Turning this off pauses automatic answers on your chat widgets.
                  </p>
                </div>
                <input type="checkbox" checked={csChatEnabled}
                  onChange={e => setCsChatEnabled(e.target.checked)}
                  className="size-4 mt-0.5 rounded border-input accent-[#2563eb] shrink-0" />
              </label>
            </div>

            {widgetError && (
              <p className="text-xs text-[#b91c1c] dark:text-[#f87171] mb-2">{widgetError}</p>
            )}

            {/* Existing widgets */}
            <div className="rounded-lg border divide-y mb-3">
              {!widgetsLoaded ? (
                <div className="px-4 py-6 text-center text-xs text-muted-foreground">Loading your chat widgets...</div>
              ) : widgets.length === 0 ? (
                <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                  No chat widget yet. Create one below to add chat to your website.
                </div>
              ) : (
                widgets.map(w => {
                  const hostedUrl = w.slug ? `${origin}/api/chat/page/${w.slug}` : ''
                  const embed = w.embedCode || `<script src="${origin}/api/chat/widget/${w.id}" async></script>`
                  const isEditing = editWidgetId === w.id
                  return (
                    <div key={w.id} className="px-4 py-3 space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="size-3 rounded-full shrink-0" style={{ backgroundColor: w.brand_color || '#6d28d9' }} />
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate flex items-center gap-2">
                              {w.name}
                              <Badge variant={w.is_active ? 'violet' : 'secondary'}>{w.is_active ? 'Active' : 'Inactive'}</Badge>
                            </p>
                            <p className="text-xs text-muted-foreground truncate">
                              {w.business_name || w.name}
                              {typeof w.conversation_count === 'number' ? ` · ${w.conversation_count} conversations` : ''}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Button type="button" variant="outline" size="sm"
                            disabled={widgetBusy === w.id}
                            onClick={() => patchWidget(w.id, { isActive: !w.is_active })}>
                            {w.is_active ? 'Disable' : 'Enable'}
                          </Button>
                          <Button type="button" variant="outline" size="sm"
                            onClick={() => (isEditing ? setEditWidgetId(null) : beginEditWidget(w))}>
                            {isEditing ? 'Close' : 'Edit'}
                          </Button>
                          <button type="button" onClick={() => deleteWidget(w.id)}
                            disabled={widgetBusy === w.id}
                            className="shrink-0 text-muted-foreground hover:text-[#b91c1c] transition p-1" title="Delete widget">
                            <Trash2 className="size-4" />
                          </button>
                        </div>
                      </div>

                      {isEditing && (
                        <div className="rounded-md border bg-muted/30 px-3 py-3 space-y-2.5">
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <Input value={ewName} onChange={e => setEwName(e.target.value)} placeholder="Widget name" className="h-8 text-xs" />
                            <Input value={ewBusinessName} onChange={e => setEwBusinessName(e.target.value)} placeholder="Business name (shown to visitors)" className="h-8 text-xs" />
                          </div>
                          <textarea value={ewWelcome} onChange={e => setEwWelcome(e.target.value)}
                            placeholder="Welcome message"
                            className="w-full rounded-md border bg-card px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring h-16" />
                          <div className="flex items-center gap-2">
                            <input type="color" value={ewBrandColor} onChange={e => setEwBrandColor(e.target.value)}
                              className="size-8 rounded-md border cursor-pointer p-0" />
                            <Input value={ewBrandColor} onChange={e => setEwBrandColor(e.target.value)} placeholder="#6d28d9" className="h-8 text-xs font-mono w-28" />
                          </div>
                          <div className="flex items-center gap-2">
                            <Button type="button" size="sm" onClick={saveEditWidget} disabled={widgetBusy === w.id || !ewName.trim()}>
                              {widgetBusy === w.id ? 'Saving...' : 'Save changes'}
                            </Button>
                            <Button type="button" size="sm" variant="ghost" onClick={() => setEditWidgetId(null)}>Cancel</Button>
                          </div>
                        </div>
                      )}

                      {/* Hosted public page */}
                      <label className="flex items-center justify-between gap-3 cursor-pointer">
                        <span className="text-xs text-muted-foreground">Hosted chat page (a shareable link to a full-page chat)</span>
                        <input type="checkbox" checked={w.public_page_enabled}
                          onChange={() => patchWidget(w.id, { publicPageEnabled: !w.public_page_enabled })}
                          disabled={widgetBusy === w.id}
                          className="size-4 rounded border-input accent-[#2563eb] shrink-0" />
                      </label>

                      {/* Embed code */}
                      <div className="rounded-md bg-muted/40 border px-3 py-2">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[11px] font-medium text-muted-foreground flex items-center gap-1.5"><Code className="size-3" /> Embed code</span>
                          <button type="button" onClick={() => copyText(`embed-${w.id}`, embed)}
                            className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1">
                            {copiedKey === `embed-${w.id}` ? <><Check className="size-3 text-[#047857] dark:text-[#34d399]" /> Copied</> : <>Copy</>}
                          </button>
                        </div>
                        <code className="text-[11px] break-all block leading-relaxed text-muted-foreground">{embed}</code>
                        <p className="text-[11px] text-muted-foreground mt-1.5">Paste this just before the closing &lt;/body&gt; tag on your site.</p>
                      </div>

                      {/* Hosted page link */}
                      {w.public_page_enabled && w.slug && (
                        <div className="rounded-md bg-muted/40 border px-3 py-2">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-[11px] font-medium text-muted-foreground flex items-center gap-1.5"><LinkIcon className="size-3" /> Hosted page link</span>
                            <div className="flex items-center gap-2">
                              <button type="button" onClick={() => copyText(`link-${w.id}`, hostedUrl)}
                                className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1">
                                {copiedKey === `link-${w.id}` ? <><Check className="size-3 text-[#047857] dark:text-[#34d399]" /> Copied</> : <>Copy</>}
                              </button>
                              <button type="button" onClick={() => window.open(hostedUrl, '_blank')}
                                className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1">
                                <ExternalLink className="size-3" /> Open
                              </button>
                            </div>
                          </div>
                          <code className="text-[11px] break-all block leading-relaxed text-muted-foreground">{hostedUrl}</code>
                        </div>
                      )}
                    </div>
                  )
                })
              )}
            </div>

            {/* Create a new widget */}
            {showWidgetForm ? (
              <div className="rounded-lg border">
                <div className="px-4 py-3 border-b">
                  <p className="text-sm font-medium flex items-center gap-2"><Plus className="size-4 text-muted-foreground" /> New chat widget</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Set how the widget looks. Answers come from your Customer Service knowledge and flag scenarios above.</p>
                </div>
                <div className="px-4 py-3 space-y-2.5">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <Input value={nwName} onChange={e => setNwName(e.target.value)} placeholder="Widget name, e.g. Main Site Chat" className="h-8 text-xs" />
                    <Input value={nwBusinessName} onChange={e => setNwBusinessName(e.target.value)} placeholder="Business name (shown to visitors)" className="h-8 text-xs" />
                  </div>
                  <textarea value={nwWelcome} onChange={e => setNwWelcome(e.target.value)}
                    placeholder="Welcome message"
                    className="w-full rounded-md border bg-card px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring h-16" />
                  <div className="flex items-center gap-2">
                    <input type="color" value={nwBrandColor} onChange={e => setNwBrandColor(e.target.value)}
                      className="size-8 rounded-md border cursor-pointer p-0" />
                    <Input value={nwBrandColor} onChange={e => setNwBrandColor(e.target.value)} placeholder="#6d28d9" className="h-8 text-xs font-mono w-28" />
                  </div>
                  <div className="flex items-center gap-2">
                    <Button type="button" size="sm" onClick={createWidget} disabled={nwSaving || !nwName.trim()}>
                      {nwSaving ? 'Creating...' : <><Plus className="size-3.5 mr-1" /> Create widget</>}
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => { setShowWidgetForm(false); setWidgetError('') }}>Cancel</Button>
                  </div>
                </div>
              </div>
            ) : (
              <Button type="button" variant="outline" size="sm" onClick={() => { setShowWidgetForm(true); setWidgetError('') }}>
                <Plus className="size-3.5 mr-1" /> Create a chat widget
              </Button>
            )}
          </section>

          {/* Settings autosave as you change them. This row just reflects status. */}
          <div className="flex items-center gap-2 mb-10 h-5 text-xs">
            {saving ? (
              <span className="text-muted-foreground flex items-center gap-1.5">
                <span className="inline-block size-3 rounded-full border border-muted-foreground/40 border-t-transparent animate-spin" />
                Saving...
              </span>
            ) : error ? (
              <span className="text-[#b91c1c] dark:text-[#f87171]">{error} We will retry when you make another change.</span>
            ) : saved ? (
              <span className="text-[#047857] dark:text-[#34d399] flex items-center gap-1"><Check className="size-3" /> Saved</span>
            ) : (
              <span className="text-muted-foreground">Changes save automatically.</span>
            )}
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
                          ) : entry.isWebSource ? (
                            <span className="flex items-center gap-1"><Globe className="size-3" /> Web page</span>
                          ) : (
                            <span className="flex items-center gap-1"><FileText className="size-3" /> Document</span>
                          )}
                        </Badge>
                        <p className="text-sm font-medium truncate">{entry.title}</p>
                      </div>
                      <p className="text-xs text-muted-foreground line-clamp-2">{entry.contentPreview}</p>
                      {entry.sourceFilename && (
                        entry.isWebSource && entry.sourceUrl ? (
                          <p className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-1 min-w-0">
                            <Globe className="size-3 shrink-0" />
                            <a href={entry.sourceUrl} target="_blank" rel="noopener noreferrer"
                              className="truncate underline hover:text-foreground">{entry.sourceFilename}</a>
                          </p>
                        ) : (
                          <p className="text-[11px] text-muted-foreground mt-0.5">From {entry.sourceFilename}</p>
                        )
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

            {/* Add from Knowledge Base */}
            <div className="rounded-lg border mb-4">
              <div className="px-4 py-3 border-b flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium flex items-center gap-2">
                    <BookOpen className="size-4 text-muted-foreground" /> Add from Knowledge Base
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Pull documents you have stored in your Knowledge Base straight into this library.
                  </p>
                </div>
                {!kbPickerOpen && (
                  <Button type="button" size="sm" variant="outline" onClick={openKbPicker} className="shrink-0">
                    <BookOpen className="size-3.5 mr-1" /> Browse Knowledge Base
                  </Button>
                )}
              </div>
              {kbPickerOpen && (
                <div className="px-4 py-3 space-y-3">
                  {kbDocsLoading ? (
                    <p className="text-xs text-muted-foreground py-4 text-center">Loading your Knowledge Base...</p>
                  ) : !kbConnected ? (
                    <div className="rounded-md border px-4 py-6 text-center text-xs text-muted-foreground">
                      Could not connect to your Knowledge Base right now. Make sure you have one set up, then try again.
                    </div>
                  ) : kbDocs.length === 0 ? (
                    <div className="rounded-md border px-4 py-6 text-center text-xs text-muted-foreground">
                      No documents found in your Knowledge Base yet.
                    </div>
                  ) : (
                    <div className="max-h-64 overflow-y-auto rounded-md border divide-y">
                      {kbDocs.map(doc => (
                        <label key={doc.id} className={`flex items-center gap-2 px-3 py-2 text-sm ${doc.alreadyImported ? 'opacity-60' : 'cursor-pointer hover:bg-muted/40'}`}>
                          <input type="checkbox" disabled={doc.alreadyImported}
                            checked={kbSelectedIds.has(doc.id)} onChange={() => toggleKbDoc(doc.id)}
                            className="size-4 shrink-0" />
                          <span className="truncate flex-1">{doc.title}</span>
                          {doc.alreadyImported && <span className="text-[11px] text-muted-foreground shrink-0">Already added</span>}
                        </label>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <Button type="button" size="sm" onClick={importSelectedKbDocs} disabled={kbImporting || kbSelectedIds.size === 0}>
                      <Plus className="size-3.5 mr-1" /> {kbSelectedIds.size > 0 ? `Add selected (${kbSelectedIds.size})` : 'Add selected'}
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => { setKbPickerOpen(false); setKbSelectedIds(new Set()) }} disabled={kbImporting}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {/* Add a web page (FAQ / website URL) */}
            <div className="rounded-lg border mb-4">
              <div className="px-4 py-3 border-b">
                <p className="text-sm font-medium flex items-center gap-2">
                  <Globe className="size-4 text-muted-foreground" /> Add a web page
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Add your FAQ page or website URL. We pull the text to help draft accurate replies.
                </p>
              </div>
              <div className="px-4 py-3 space-y-3">
                {urlError && (
                  <p className="text-xs text-[#b91c1c] dark:text-[#f87171]">{urlError}</p>
                )}
                {urlSuccess && (
                  <p className="text-xs text-[#047857] dark:text-[#34d399] flex items-center gap-1"><Check className="size-3" /> {urlSuccess}</p>
                )}
                <input value={urlValue} onChange={e => setUrlValue(e.target.value)}
                  placeholder="https://yourbusiness.com/faq" type="url"
                  className="w-full rounded-md border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring" />
                <input value={urlLabel} onChange={e => setUrlLabel(e.target.value)}
                  placeholder="Label (optional), e.g. FAQ page"
                  className="w-full rounded-md border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring" />
                <Button type="button" size="sm" onClick={addWebPage} disabled={urlSaving || !urlValue.trim()}>
                  {urlSaving ? 'Adding page...' : <><Plus className="size-3.5 mr-1" /> Add web page</>}
                </Button>
              </div>
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
            <div className="rounded-lg border mb-4">
              <div className="px-4 py-3 border-b">
                <p className="text-sm font-medium flex items-center gap-2">
                  <FileText className="size-4 text-muted-foreground" /> Upload a reference document
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Upload one or more PDF, Word (.docx), or text (.txt, .md, .csv) files, or paste text. The text is pulled out automatically. Each file becomes its own entry.
                </p>
              </div>
              <div className="px-4 py-3 space-y-3">
                <input value={docTitle} onChange={e => setDocTitle(e.target.value)}
                  placeholder="Title (optional, used only with a single file), e.g. Shipping policy"
                  className="w-full rounded-md border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring" />
                <input type="file" multiple accept=".pdf,.docx,.txt,.md,.markdown,.csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown,text/csv"
                  onChange={e => { setDocFiles(e.target.files ? Array.from(e.target.files) : []); setDocProgress([]); setDocSummary('') }}
                  className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border file:bg-card file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-muted/50" />
                {docFiles.length > 1 && (
                  <p className="text-[11px] text-muted-foreground">{docFiles.length} files selected. Each is added as a separate entry.</p>
                )}
                {docProgress.length > 0 && (
                  <ul className="space-y-1">
                    {docProgress.map((p, i) => (
                      <li key={i} className="flex items-center gap-2 text-[11px]">
                        {p.status === 'done' ? (
                          <Check className="size-3 text-[#047857] dark:text-[#34d399]" />
                        ) : p.status === 'failed' ? (
                          <XIcon className="size-3 text-[#b91c1c] dark:text-[#f87171]" />
                        ) : (
                          <span className="inline-block size-3 rounded-full border border-muted-foreground/40 border-t-transparent animate-spin" />
                        )}
                        <span className="truncate text-muted-foreground">{p.name}</span>
                        {p.status === 'failed' && p.error && (
                          <span className="text-[#b91c1c] dark:text-[#f87171] truncate">{p.error}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {docSummary && (
                  <p className="text-[11px] text-[#047857] dark:text-[#34d399]">{docSummary}</p>
                )}
                <p className="text-[11px] text-muted-foreground">Or paste the document text:</p>
                <textarea value={docContent} onChange={e => setDocContent(e.target.value)}
                  placeholder="Paste reference text here..."
                  className="w-full rounded-md border bg-card px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring h-28" />
                <Button type="button" size="sm" onClick={addDocument} disabled={kbSaving}>
                  <Plus className="size-3.5 mr-1" /> {docFiles.length > 1 ? `Add ${docFiles.length} documents` : 'Add document'}
                </Button>
              </div>
            </div>

          </section>
        </>
      )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
