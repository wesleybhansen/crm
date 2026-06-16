'use client'

// Inbox Settings tab. One place to set up everything the personal Inbox needs:
// the connected mailbox (IMAP/SMTP), text messages (Twilio), routing addresses,
// the AI reply assistant (tone, rules, knowledge, website scan, file upload, and
// a Knowledge Base document picker), email intelligence, and a signature.
//
// Every section REUSES an endpoint that already exists (the same ones the general
// settings page and the old ai-setup wizard used). Nothing here invents a new
// data model; it only relocates the inbox-specific setup into the Inbox page so
// it lives next to the conversations it configures.
//
// EVERYTHING AUTOSAVES. There are no per-section Save buttons. Text fields save
// on blur (and debounced as you type); toggles, selects, and tone chips save
// immediately. A single shared status line at the bottom reflects Saving / Saved,
// mirroring the Customer Service Settings tab. The hydratedRef guard keeps the
// initial GET-driven state writes from triggering a save on mount.
//
// IMPORTANT: the personal Inbox NEVER lists the dedicated Customer Service support
// inbox. Mailbox connections are always fetched with ?excludePurpose=customer_service,
// and a mailbox connected here is posted with NO purpose (personal = purpose null),
// so it stays distinct from the CS support inbox (which posts purpose='customer_service').

import { useEffect, useRef, useState } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Badge } from '@open-mercato/ui/primitives/badge'
import {
  Mail, Server, X as XIcon, Check, Phone, Send, Sparkles, Globe,
  FileText, BookOpen, Plus, FileEdit, Flag, Trash2, MessageSquareQuote,
} from 'lucide-react'
import AppPasswordGuides from '@/modules/customers/backend/components/AppPasswordGuides'

type EmailConnection = { id: string; provider: string; email_address: string; is_primary: boolean; is_active?: boolean; purpose?: string | null }
type TwilioConnection = { id: string; accountSid: string; phoneNumber: string; isActive: boolean }
type RoutingAddress = { id: string; type: string; provider: string; email_address: string; display_label: string; can_receive: boolean }
type RoutingConfig = { purpose: string; provider_type: string; provider_id: string; from_name: string | null; from_address: string | null }
type KbDoc = { id: string; title: string }

// Reply-mode model mirrors the Customer Service settings, tailored to a personal
// inbox. SETTINGS phase only: nothing here drafts or sends; that is a later phase.
type ReplyMode = 'draft' | 'auto' | 'hybrid'
type FlagAction = 'pause' | 'auto_send'
type FlagScenario = { key: string; label: string; enabled: boolean; action: FlagAction; instructions: string }
// Grounding-library entry stored in inbox_knowledge.
type KnowledgeEntry = {
  id: string
  kind: 'model_answer' | 'document' | 'web_page'
  title: string
  sourceUrl?: string | null
  sourceLabel?: string | null
  isWebSource?: boolean
  contentPreview: string
  createdAt: string
}

const TONES = [
  { id: 'professional', label: 'Professional' },
  { id: 'friendly', label: 'Friendly' },
  { id: 'casual', label: 'Casual' },
  { id: 'formal', label: 'Formal' },
  { id: 'custom', label: 'Custom' },
]

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

export default function InboxSettings({ onAiSettingsSaved }: { onAiSettingsSaved?: () => void }) {
  // ── Connected mailboxes (IMAP/SMTP). Personal inbox supports MULTIPLE. ──
  const [emailConnections, setEmailConnections] = useState<EmailConnection[]>([])
  const [disconnecting, setDisconnecting] = useState<string | null>(null)
  // The connect form is always available, even when one mailbox is already
  // connected, so the user can add another personal mailbox.
  const [showConnectForm, setShowConnectForm] = useState(false)
  const [emailAddr, setEmailAddr] = useState('')
  const [emailPassword, setEmailPassword] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [smtpHost, setSmtpHost] = useState('')
  const [smtpPort, setSmtpPort] = useState('587')
  const [imapHost, setImapHost] = useState('')
  const [imapPort, setImapPort] = useState('993')
  const [savingSmtp, setSavingSmtp] = useState(false)
  const [smtpError, setSmtpError] = useState('')
  const [smtpSuccess, setSmtpSuccess] = useState(false)

  // ── Text messages (Twilio) ──
  const [twilioConnection, setTwilioConnection] = useState<TwilioConnection | null>(null)
  const [twilioSid, setTwilioSid] = useState('')
  const [twilioToken, setTwilioToken] = useState('')
  const [twilioPhone, setTwilioPhone] = useState('')
  const [savingTwilio, setSavingTwilio] = useState(false)
  const [twilioError, setTwilioError] = useState('')
  const [twilioSuccess, setTwilioSuccess] = useState(false)
  const [disconnectingTwilio, setDisconnectingTwilio] = useState(false)

  // ── Routing addresses ──
  const [routingAddresses, setRoutingAddresses] = useState<RoutingAddress[]>([])
  const [routingConfig, setRoutingConfig] = useState<RoutingConfig[]>([])
  const [routingSaving, setRoutingSaving] = useState<string | null>(null)
  const [routingFeedback, setRoutingFeedback] = useState<{ purpose: string; type: 'success' | 'error'; text: string } | null>(null)

  // ── AI reply assistant (autosaved) ──
  const [aiEnabled, setAiEnabled] = useState(false)
  const [businessName, setBusinessName] = useState('')
  const [businessDescription, setBusinessDescription] = useState('')
  const [tone, setTone] = useState('professional')
  const [customTone, setCustomTone] = useState('')
  const [instructions, setInstructions] = useState('')
  const [aiError, setAiError] = useState('')

  // ── Reply mode + flag scenarios (mirror Customer Service settings) ──
  const [replyMode, setReplyMode] = useState<ReplyMode>('draft')
  const [hybridThreshold, setHybridThreshold] = useState(0.85)
  // Always the full canonical list (server seeds defaults when none saved).
  const [flagScenarios, setFlagScenarios] = useState<FlagScenario[]>([])
  const [newScenarioLabel, setNewScenarioLabel] = useState('')
  const [newScenarioInstructions, setNewScenarioInstructions] = useState('')
  const [newScenarioAction, setNewScenarioAction] = useState<FlagAction>('pause')

  // ── Knowledge & model answers (grounding library, stored in inbox_knowledge) ──
  const [knowledge, setKnowledge] = useState<KnowledgeEntry[]>([])
  const [kbError, setKbError] = useState('')
  const [kbSaving, setKbSaving] = useState(false)
  const [maTitle, setMaTitle] = useState('')
  const [maContent, setMaContent] = useState('')
  const [docTitle, setDocTitle] = useState('')
  const [docContent, setDocContent] = useState('')
  const [docFiles, setDocFiles] = useState<File[]>([])
  const [docProgress, setDocProgress] = useState<{ name: string; status: 'pending' | 'done' | 'failed'; error?: string }[]>([])
  const [docSummary, setDocSummary] = useState('')
  const [urlValue, setUrlValue] = useState('')
  const [urlLabel, setUrlLabel] = useState('')
  const [urlSaving, setUrlSaving] = useState(false)
  const [urlError, setUrlError] = useState('')
  const [urlSuccess, setUrlSuccess] = useState('')

  // ── KB document picker (mirrors the Customer Service settings picker) ──
  const [kbPickerOpen, setKbPickerOpen] = useState(false)
  const [kbDocs, setKbDocs] = useState<(KbDoc & { alreadyImported?: boolean })[]>([])
  const [kbConnected, setKbConnected] = useState(true)
  const [kbDocsLoading, setKbDocsLoading] = useState(false)
  const [kbSelectedIds, setKbSelectedIds] = useState<Set<string>>(new Set())
  const [kbImporting, setKbImporting] = useState(false)

  // ── Email intelligence (autosaved immediately on toggle) ──
  const [eiEnabled, setEiEnabled] = useState(false)
  const [eiAutoCreate, setEiAutoCreate] = useState(true)
  const [eiAutoTimeline, setEiAutoTimeline] = useState(true)
  const [eiAutoEngagement, setEiAutoEngagement] = useState(true)
  const [eiAutoStage, setEiAutoStage] = useState(false)

  // ── Signature (autosaved, part of the AI settings record) ──
  const [signature, setSignature] = useState('')

  const [loading, setLoading] = useState(true)

  // ── Autosave plumbing. hydratedRef stays false until the initial GET has
  // populated the fields, so neither the first mount nor the hydration writes
  // trigger a save. A single shared status line reflects the latest save. ──
  const hydratedRef = useRef(false)
  const aiTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [status, setStatus] = useState<SaveStatus>('idle')

  // Personal mailboxes only: NEVER show the dedicated Customer Service support
  // inbox in the personal Inbox.
  const CONNECTIONS_URL = '/api/email/connections?excludePurpose=customer_service'

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch(CONNECTIONS_URL, { credentials: 'include' }).then(r => r.json()).catch(() => null),
      fetch('/api/twilio/connections', { credentials: 'include' }).then(r => r.json()).catch(() => null),
      fetch('/api/email/routing', { credentials: 'include' }).then(r => r.json()).catch(() => null),
      fetch('/api/inbox/ai-settings', { credentials: 'include' }).then(r => r.json()).catch(() => null),
      fetch('/api/email/intelligence-settings', { credentials: 'include' }).then(r => r.json()).catch(() => null),
      fetch('/api/inbox/knowledge', { credentials: 'include' }).then(r => r.json()).catch(() => null),
    ]).then(([conn, twilio, routing, ai, ei, kb]) => {
      if (cancelled) return
      if (conn?.ok) setEmailConnections(conn.data || [])
      if (twilio?.ok && twilio.data) setTwilioConnection(twilio.data)
      if (routing?.ok && routing.data) {
        setRoutingAddresses(routing.data.addresses || [])
        setRoutingConfig(routing.data.routing || [])
      }
      if (ai?.ok) {
        const d = ai.data
        if (d) {
          setAiEnabled(d.enabled ?? false)
          setBusinessName(d.business_name || '')
          setBusinessDescription(d.business_description || '')
          const t = d.tone || 'professional'
          if (TONES.find(x => x.id === t && x.id !== 'custom')) { setTone(t) }
          else { setTone('custom'); setCustomTone(t) }
          setInstructions(d.instructions || '')
          if (d.signature) setSignature(d.signature)
          setReplyMode(d.reply_mode === 'auto' || d.reply_mode === 'hybrid' ? d.reply_mode : 'draft')
          if (typeof d.hybrid_confidence_threshold === 'number' && Number.isFinite(d.hybrid_confidence_threshold)) {
            setHybridThreshold(Math.min(1, Math.max(0, d.hybrid_confidence_threshold)))
          }
        }
        // Flag scenarios: the server returns the full list on the row, or the
        // default seed separately when no row exists yet.
        const scenarios = Array.isArray(d?.flag_scenarios) ? d.flag_scenarios
          : Array.isArray(ai.defaultFlagScenarios) ? ai.defaultFlagScenarios : []
        setFlagScenarios(scenarios)
      }
      if (kb?.ok) setKnowledge(kb.data || [])
      if (ei?.ok && ei.data) {
        setEiEnabled(ei.data.is_enabled ?? false)
        setEiAutoCreate(ei.data.auto_create_contacts ?? true)
        setEiAutoTimeline(ei.data.auto_update_timeline ?? true)
        setEiAutoEngagement(ei.data.auto_update_engagement ?? true)
        setEiAutoStage(ei.data.auto_advance_stage ?? false)
      }
      setLoading(false)
      // Open the connect form by default only when there is no mailbox yet.
      if (!(conn?.ok && (conn.data || []).length > 0)) setShowConnectForm(true)
      // Mark hydration complete on the next tick so the state writes above do not
      // trip the autosave effect. From here on, only genuine user edits save.
      setTimeout(() => { hydratedRef.current = true }, 0)
    })
    return () => { cancelled = true }
  }, [])

  // ── AI assistant + reply-mode + signature autosave. The ai-settings PUT merges
  // with the existing record (server uses `?? existing`), so sending only these
  // fields is safe and does not clobber anything else. Debounced for text typing;
  // toggles, tone chips, reply mode, and flag scenarios flow through the same
  // debounced save. The grounding library (knowledge) saves on its own endpoint. ──
  async function persistAi(): Promise<boolean> {
    const res = await fetch('/api/inbox/ai-settings', {
      method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: aiEnabled,
        businessName,
        businessDescription,
        tone: tone === 'custom' ? customTone : tone,
        instructions,
        signature,
        replyMode,
        hybridConfidenceThreshold: hybridThreshold,
        flagScenarios,
      }),
    })
    const data = await res.json().catch(() => ({ ok: false }))
    if (data.ok) onAiSettingsSaved?.()
    return !!data.ok
  }

  async function runSave(fn: () => Promise<boolean>) {
    setStatus('saving')
    try {
      const ok = await fn()
      setStatus(ok ? 'saved' : 'error')
      if (ok) setTimeout(() => setStatus(s => (s === 'saved' ? 'idle' : s)), 2000)
    } catch {
      setStatus('error')
    }
  }

  // Debounced AI autosave: fires when any AI / signature field changes. The
  // hydration guard keeps load-time writes from saving.
  useEffect(() => {
    if (!hydratedRef.current) return
    if (aiTimerRef.current) clearTimeout(aiTimerRef.current)
    aiTimerRef.current = setTimeout(() => { void runSave(persistAi) }, 600)
    return () => { if (aiTimerRef.current) clearTimeout(aiTimerRef.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiEnabled, businessName, businessDescription, tone, customTone, instructions, signature, replyMode, hybridThreshold, flagScenarios])

  const hasSmtpConnection = emailConnections.some(c => c.provider === 'smtp')

  async function reloadConnections() {
    const connRes = await fetch(CONNECTIONS_URL, { credentials: 'include' })
    const connData = await connRes.json().catch(() => null)
    if (connData?.ok) setEmailConnections(connData.data || [])
  }

  // ── Mailbox actions. Personal mailbox is posted with NO purpose, so it stays
  // distinct from the Customer Service support inbox. ──
  async function saveSmtp() {
    setSavingSmtp(true); setSmtpError(''); setSmtpSuccess(false)
    try {
      const body: Record<string, any> = { emailAddress: emailAddr, password: emailPassword }
      if (showAdvanced) {
        if (smtpHost) { body.smtpHost = smtpHost; body.smtpPort = Number(smtpPort) }
        if (imapHost) { body.imapHost = imapHost; body.imapPort = Number(imapPort) }
      }
      const res = await fetch('/api/email/smtp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) })
      const data = await res.json()
      if (data.ok) {
        setSmtpSuccess(true)
        setEmailAddr(''); setEmailPassword(''); setSmtpHost(''); setSmtpPort('587'); setImapHost(''); setImapPort('993'); setShowAdvanced(false)
        await reloadConnections()
        setShowConnectForm(false)
        setTimeout(() => setSmtpSuccess(false), 3000)
      } else { setSmtpError(data.error || 'Failed to save') }
    } catch { setSmtpError('Failed to save email configuration') }
    setSavingSmtp(false)
  }

  async function disconnectMailbox(id: string, address: string) {
    if (!confirm(`Disconnect ${address}? You will not be able to send or receive from this account.`)) return
    setDisconnecting(id)
    try {
      await fetch(`/api/email/connections?id=${id}`, { method: 'DELETE', credentials: 'include' })
      setEmailConnections(prev => prev.filter(c => c.id !== id))
    } catch {}
    setDisconnecting(null)
  }

  // ── Twilio actions ──
  async function saveTwilio() {
    setSavingTwilio(true); setTwilioError(''); setTwilioSuccess(false)
    try {
      const res = await fetch('/api/twilio/connections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ accountSid: twilioSid, authToken: twilioToken, phoneNumber: twilioPhone }) })
      const data = await res.json()
      if (data.ok) {
        setTwilioSuccess(true); setTwilioSid(''); setTwilioToken(''); setTwilioPhone('')
        const connRes = await fetch('/api/twilio/connections', { credentials: 'include' })
        const connData = await connRes.json()
        if (connData.ok && connData.data) setTwilioConnection(connData.data)
        setTimeout(() => setTwilioSuccess(false), 3000)
      } else { setTwilioError(data.error || 'Failed to save') }
    } catch { setTwilioError('Failed to save Twilio configuration') }
    setSavingTwilio(false)
  }

  async function disconnectTwilio() {
    if (!confirm('Disconnect Twilio? SMS sending will stop working.')) return
    setDisconnectingTwilio(true)
    try {
      await fetch('/api/twilio/connections', { method: 'DELETE', credentials: 'include' })
      setTwilioConnection(null)
    } catch {}
    setDisconnectingTwilio(false)
  }

  // ── Flag-scenario helpers (mirror Customer Service settings) ──
  function updateFlagScenario(key: string, patch: Partial<FlagScenario>) {
    setFlagScenarios(prev => prev.map(s => s.key === key ? { ...s, ...patch } : s))
  }
  function isCustomScenario(key: string) { return key.startsWith('custom_') }
  function generateCustomKey(label: string): string {
    const slug = label.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32)
    const rand = Math.random().toString(36).slice(2, 8)
    const base = slug ? `custom_${slug}_${rand}` : `custom_${rand}`
    return flagScenarios.some(s => s.key === base) ? `${base}_${Math.random().toString(36).slice(2, 6)}` : base
  }
  function addCustomScenario() {
    const label = newScenarioLabel.trim()
    if (!label) return
    setFlagScenarios(prev => [...prev, {
      key: generateCustomKey(label), label, enabled: true,
      action: newScenarioAction, instructions: newScenarioInstructions.trim(),
    }])
    setNewScenarioLabel(''); setNewScenarioInstructions(''); setNewScenarioAction('pause')
  }
  function removeCustomScenario(key: string) {
    if (!isCustomScenario(key)) return
    setFlagScenarios(prev => prev.filter(s => s.key !== key))
  }

  // ── Knowledge library actions (stored in inbox_knowledge) ──
  async function loadKnowledge() {
    const res = await fetch('/api/inbox/knowledge', { credentials: 'include' }).then(r => r.json()).catch(() => null)
    if (res?.ok) setKnowledge(res.data || [])
  }

  async function addModelAnswer() {
    setKbError('')
    if (!maContent.trim()) { setKbError('Enter the answer text first.'); return }
    setKbSaving(true)
    try {
      const res = await fetch('/api/inbox/knowledge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ kind: 'model_answer', title: maTitle.trim() || undefined, content: maContent.trim() }),
      })
      const data = await res.json()
      if (data.ok) { setMaTitle(''); setMaContent(''); await loadKnowledge() }
      else setKbError(data.error || 'Failed to add model answer.')
    } catch { setKbError('Failed to add model answer.') }
    setKbSaving(false)
  }

  async function addDocument() {
    setKbError(''); setDocSummary('')
    if (docFiles.length === 0 && !docContent.trim()) { setKbError('Upload one or more files or paste the document text.'); return }
    setKbSaving(true)
    try {
      if (docFiles.length > 0) {
        const single = docFiles.length === 1
        setDocProgress(docFiles.map(f => ({ name: f.name, status: 'pending' as const })))
        let added = 0, skipped = 0
        for (let i = 0; i < docFiles.length; i++) {
          const file = docFiles[i]
          try {
            const form = new FormData()
            if (single && docTitle.trim()) form.append('title', docTitle.trim())
            form.append('file', file)
            const res = await fetch('/api/inbox/knowledge', { method: 'POST', credentials: 'include', body: form })
            const data = await res.json().catch(() => ({}))
            if (data.ok) { added++; setDocProgress(prev => prev.map((p, idx) => idx === i ? { ...p, status: 'done' } : p)) }
            else { skipped++; setDocProgress(prev => prev.map((p, idx) => idx === i ? { ...p, status: 'failed', error: data.error } : p)) }
          } catch { skipped++; setDocProgress(prev => prev.map((p, idx) => idx === i ? { ...p, status: 'failed', error: 'Upload failed' } : p)) }
        }
        setDocSummary(`${added} added${skipped ? `, ${skipped} skipped` : ''}.`)
        setDocFiles([]); setDocTitle('')
        await loadKnowledge()
      } else {
        const res = await fetch('/api/inbox/knowledge', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ kind: 'document', title: docTitle.trim() || undefined, content: docContent.trim() }),
        })
        const data = await res.json()
        if (data.ok) { setDocTitle(''); setDocContent(''); await loadKnowledge() }
        else setKbError(data.error || 'Failed to add document.')
      }
    } catch { setKbError('Failed to add document.') }
    setKbSaving(false)
  }

  async function addWebPage() {
    setUrlError(''); setUrlSuccess('')
    const url = urlValue.trim()
    if (!url) { setUrlError('Enter a web page URL.'); return }
    setUrlSaving(true)
    try {
      const res = await fetch('/api/inbox/knowledge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ kind: 'web_page', url, title: urlLabel.trim() || undefined }),
      })
      const data = await res.json().catch(() => ({}))
      if (data.ok) {
        setUrlValue(''); setUrlLabel('')
        setUrlSuccess('Page added. We pulled the text to help draft replies.')
        await loadKnowledge()
        setTimeout(() => setUrlSuccess(''), 4000)
      } else setUrlError(data.error || 'Could not add that page.')
    } catch { setUrlError('Could not add that page.') }
    setUrlSaving(false)
  }

  async function deleteKnowledge(id: string) {
    setKbError('')
    const prev = knowledge
    setKnowledge(prev.filter(k => k.id !== id))
    try {
      const res = await fetch(`/api/inbox/knowledge?id=${id}`, { method: 'DELETE', credentials: 'include' })
      const data = await res.json()
      if (!data.ok) { setKnowledge(prev); setKbError(data.error || 'Failed to delete.') }
    } catch { setKnowledge(prev); setKbError('Failed to delete.') }
  }

  // ── KB picker actions: read text from the user's Knowledge Base, then save the
  // selected docs into the inbox grounding library as document entries. ──
  async function openKbPicker() {
    setKbError('')
    setKbPickerOpen(true); setKbDocsLoading(true); setKbSelectedIds(new Set())
    try {
      const res = await fetch('/api/inbox/kb-documents', { credentials: 'include' }).then(r => r.json()).catch(() => null)
      if (res?.ok) { setKbConnected(res.connected !== false); setKbDocs(Array.isArray(res.data) ? res.data : []) }
      else { setKbConnected(false); setKbDocs([]) }
    } catch { setKbConnected(false); setKbDocs([]) }
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
      const res = await fetch('/api/inbox/kb-documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ ids }) })
      const data = await res.json()
      if (data.ok) {
        const docs: { title: string; content: string }[] = data.data || []
        let added = 0, skipped = 0
        for (const doc of docs) {
          try {
            const r = await fetch('/api/inbox/knowledge', {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
              body: JSON.stringify({ kind: 'document', title: doc.title || undefined, content: doc.content }),
            })
            const d = await r.json().catch(() => ({}))
            if (d.ok) added++; else skipped++
          } catch { skipped++ }
        }
        setDocSummary(`${added} added${skipped ? `, ${skipped} skipped` : ''} from Knowledge Base.`)
        setKbPickerOpen(false)
        setKbSelectedIds(new Set())
        await loadKnowledge()
      } else { setKbError(data.error || 'Failed to import documents.') }
    } catch { setKbError('Failed to import documents.') }
    setKbImporting(false)
  }

  // ── Email intelligence: each toggle saves immediately. ──
  async function persistEi(patch: Record<string, unknown>): Promise<boolean> {
    const res = await fetch('/api/email/intelligence-settings', { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
    const data = await res.json().catch(() => ({ ok: false }))
    return !!data.ok
  }

  if (loading) {
    return <div className="max-w-2xl mx-auto p-6"><div className="rounded-[14px] border bg-card px-4 py-10 text-center text-[13px] text-muted-foreground">Loading...</div></div>
  }

  // Small toggle component matching the mockup treatment.
  const Toggle = ({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) => (
    <button type="button" onClick={onClick} disabled={disabled}
      className={`relative w-10 h-[23px] rounded-full transition-colors shrink-0 ${on ? 'bg-accent' : 'bg-zinc-300 dark:bg-zinc-600'} ${disabled ? 'opacity-50' : ''}`}>
      <span className={`absolute top-[2.5px] left-[2.5px] size-[18px] bg-white rounded-full transition-transform shadow-sm ${on ? 'translate-x-[17px]' : ''}`} />
    </button>
  )

  // ── Consistent type scale (mirrored onto Customer Service settings next). ──
  // fieldLabel: form field labels (was the faint 10-11px muted token).
  // subhead: sub-block headings inside a section card.
  const fieldLabel = 'text-[12.5px] font-medium text-foreground/80 mb-1.5'
  const sectionLabel = fieldLabel
  const subhead = 'text-[13px] font-semibold text-foreground'
  const helpText = 'text-[13px] text-muted-foreground'
  const cardTitle = 'text-[15px] font-semibold tracking-[-.01em] text-foreground flex items-center gap-2'

  return (
    <div className="max-w-[760px] mx-auto p-4 sm:p-6">
      {/* ── Connected mailboxes (multiple personal mailboxes supported) ── */}
      <section className="mb-5 rounded-[14px] border bg-card p-5">
        <h3 className={`${cardTitle} mb-1.5`}>
          <Mail className="size-[18px] text-muted-foreground" /> Connected mailboxes
          {emailConnections.length > 0 && <Badge variant="green">Connected</Badge>}
        </h3>
        <p className={`${helpText} mb-4`}>
          The email accounts this Inbox sends and receives from. Works with Gmail, Outlook, or any IMAP/SMTP provider. Use an App Password, not your normal password. The dedicated Customer Service support inbox is kept separate and never appears here.
        </p>

        {emailConnections.length > 0 && (
          <div className="space-y-2.5 mb-4">
            {emailConnections.map(conn => (
              <div key={conn.id} className="flex items-center justify-between gap-3 rounded-xl border bg-muted/30 px-3.5 py-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="size-9 rounded-[11px] bg-accent flex items-center justify-center text-xs font-bold text-accent-foreground shrink-0">
                    {(conn.email_address[0] || '?').toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="text-[13.5px] font-semibold truncate flex items-center gap-2">
                      {conn.email_address}
                      {conn.is_primary && <Badge variant="violet">Primary</Badge>}
                    </p>
                    <p className="text-[12.5px] text-muted-foreground">
                      {conn.provider === 'gmail' ? 'Gmail (OAuth)' : conn.provider === 'microsoft' ? 'Outlook (OAuth)' : conn.provider === 'smtp' ? 'IMAP/SMTP' : conn.provider}
                    </p>
                  </div>
                </div>
                <Button type="button" variant="outline" size="sm" className="shrink-0" disabled={disconnecting === conn.id}
                  onClick={() => disconnectMailbox(conn.id, conn.email_address)}>
                  {disconnecting === conn.id ? 'Disconnecting...' : <><XIcon className="size-3 mr-1" /> Disconnect</>}
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Connect-another form is always available. */}
        {emailConnections.length > 0 && !showConnectForm && (
          <Button type="button" variant="outline" size="sm" onClick={() => setShowConnectForm(true)}>
            <Plus className="size-3.5 mr-1" /> Add another mailbox
          </Button>
        )}

        {showConnectForm && (
          <div className="rounded-xl border bg-muted/20 p-4">
            <div className="flex items-center gap-2 mb-1">
              <Server className="size-4 text-muted-foreground" />
              <p className={subhead}>Connect a mailbox</p>
            </div>
            <p className={`${helpText} mb-3.5`}>Enables sending and inbox sync, so replies appear here in your Inbox.</p>
            {smtpError && <p className="text-[12.5px] text-[#b91c1c] dark:text-[#f87171] mb-2">{smtpError}</p>}
            {smtpSuccess && <p className="text-[12.5px] text-[#047857] dark:text-[#34d399] mb-2 flex items-center gap-1"><Check className="size-3.5" /> Mailbox connected.</p>}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
              <div><p className={fieldLabel}>Email address</p><Input value={emailAddr} onChange={e => setEmailAddr(e.target.value)} placeholder="you@yourbusiness.com" className="h-10 text-[13.5px]" type="email" /></div>
              <div><p className={fieldLabel}>App Password</p><Input value={emailPassword} onChange={e => setEmailPassword(e.target.value)} type="password" placeholder="••••••••••••" className="h-10 text-[13.5px]" /></div>
            </div>
            <div className="mb-3"><AppPasswordGuides /></div>
            <button type="button" className="text-[12.5px] text-muted-foreground underline mb-2.5 block" onClick={() => setShowAdvanced(v => !v)}>
              {showAdvanced ? 'Hide advanced settings' : 'Advanced: custom server settings'}
            </button>
            {showAdvanced && (
              <div className="grid grid-cols-2 gap-2.5 mb-3 p-3.5 rounded-md bg-muted/40 border">
                <Input value={imapHost} onChange={e => setImapHost(e.target.value)} placeholder="IMAP host (auto-detected)" className="h-10 text-[13.5px]" />
                <Input value={imapPort} onChange={e => setImapPort(e.target.value)} placeholder="IMAP port (993)" className="h-10 text-[13.5px]" />
                <Input value={smtpHost} onChange={e => setSmtpHost(e.target.value)} placeholder="SMTP host (auto-detected)" className="h-10 text-[13.5px]" />
                <Input value={smtpPort} onChange={e => setSmtpPort(e.target.value)} placeholder="SMTP port (587)" className="h-10 text-[13.5px]" />
              </div>
            )}
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" onClick={saveSmtp} disabled={savingSmtp || !emailAddr || !emailPassword}>
                {savingSmtp ? 'Testing connection...' : 'Connect mailbox'}
              </Button>
              {emailConnections.length > 0 && (
                <Button type="button" variant="ghost" size="sm" onClick={() => { setShowConnectForm(false); setSmtpError('') }}>Cancel</Button>
              )}
            </div>
          </div>
        )}
        {!hasSmtpConnection && emailConnections.length === 0 && !showConnectForm && (
          <Button type="button" size="sm" onClick={() => setShowConnectForm(true)}>Connect mailbox</Button>
        )}
      </section>

      {/* ── Text messages (SMS) ── */}
      <section className="mb-5 rounded-[14px] border bg-card p-5">
        <h3 className={`${cardTitle} mb-1.5`}>
          <Phone className="size-[18px] text-muted-foreground" /> Text messages (SMS)
          {twilioConnection ? <Badge variant="green">Connected</Badge> : <Badge variant="secondary">Not connected</Badge>}
        </h3>
        <p className={`${helpText} mb-4`}>
          Bring your own Twilio number so texts land in this Inbox. This is the Inbox's main number; Customer Service uses its own separate support number.
        </p>
        {twilioConnection ? (
          <div className="flex items-center justify-between gap-3 rounded-xl border bg-muted/30 px-3.5 py-3">
            <div>
              <p className="text-[13.5px] font-semibold">{twilioConnection.phoneNumber}</p>
              <p className="text-[12.5px] text-muted-foreground">Account: {twilioConnection.accountSid}</p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={disconnectTwilio} disabled={disconnectingTwilio}>
              {disconnectingTwilio ? 'Disconnecting...' : <><XIcon className="size-3 mr-1" /> Disconnect</>}
            </Button>
          </div>
        ) : (
          <div>
            {twilioError && <p className="text-[12.5px] text-[#b91c1c] dark:text-[#f87171] mb-2">{twilioError}</p>}
            {twilioSuccess && <p className="text-[12.5px] text-[#047857] dark:text-[#34d399] mb-2 flex items-center gap-1"><Check className="size-3.5" /> Twilio connected.</p>}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
              <div><p className={fieldLabel}>Twilio Account SID</p><Input value={twilioSid} onChange={e => setTwilioSid(e.target.value)} placeholder="AC…" className="h-10 text-[13.5px]" /></div>
              <div><p className={fieldLabel}>Auth Token</p><Input value={twilioToken} onChange={e => setTwilioToken(e.target.value)} type="password" placeholder="••••••••" className="h-10 text-[13.5px]" /></div>
            </div>
            <div className="mb-3.5"><p className={fieldLabel}>Phone number</p><Input value={twilioPhone} onChange={e => setTwilioPhone(e.target.value)} placeholder="+1 415 555 0123" className="h-10 text-[13.5px]" /></div>
            <Button type="button" size="sm" onClick={saveTwilio} disabled={savingTwilio || !twilioSid || !twilioToken || !twilioPhone}>
              {savingTwilio ? 'Testing...' : 'Connect Twilio'}
            </Button>
          </div>
        )}
      </section>

      {/* ── Routing addresses (each select autosaves on change already) ── */}
      {routingAddresses.length > 1 && (
        <section className="mb-5 rounded-[14px] border bg-card p-5">
          <h3 className={`${cardTitle} mb-1.5`}>
            <Send className="size-[18px] text-muted-foreground" /> Routing addresses
          </h3>
          <p className={`${helpText} mb-4`}>Choose which email address sends each type of email. Leave blank to use defaults.</p>
          <div className="rounded-xl border divide-y">
            {([
              { purpose: 'inbox' as const, label: 'Inbox / Personal', desc: 'Inbox replies, manual compose' },
              { purpose: 'invoices' as const, label: 'Invoices & Payments', desc: 'Invoice sends, payment receipts' },
              { purpose: 'marketing' as const, label: 'Marketing', desc: 'Campaigns, sequences, event broadcasts' },
              { purpose: 'automations' as const, label: 'Automations', desc: 'Automation rule emails' },
              { purpose: 'transactional' as const, label: 'Transactional', desc: 'Confirmations, enrollments, bookings, notifications' },
            ]).map(({ purpose, label, desc }) => {
              const current = routingConfig.find(r => r.purpose === purpose)
              const filteredAddresses = purpose === 'inbox' ? routingAddresses.filter(a => a.can_receive) : routingAddresses
              return (
                <div key={purpose} className="px-4 py-3.5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-[13.5px] font-medium">{label}</p>
                      <p className="text-[12.5px] text-muted-foreground">{desc}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <select
                        value={current ? `${current.provider_type}:${current.provider_id}` : ''}
                        onChange={async (e) => {
                          const val = e.target.value
                          if (!val) {
                            try {
                              await fetch(`/api/email/routing?purpose=${purpose}`, { method: 'DELETE', credentials: 'include' })
                              setRoutingConfig(prev => prev.filter(r => r.purpose !== purpose))
                              setRoutingFeedback({ purpose, type: 'success', text: 'Reset to default' })
                              setTimeout(() => setRoutingFeedback(null), 2000)
                            } catch {}
                            return
                          }
                          const [pType, pId] = val.split(':')
                          setRoutingSaving(purpose)
                          try {
                            const res = await fetch('/api/email/routing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
                              body: JSON.stringify({ purpose, provider_type: pType, provider_id: pId }) })
                            const data = await res.json()
                            if (data.ok) {
                              setRoutingConfig(prev => {
                                const filtered = prev.filter(r => r.purpose !== purpose)
                                return [...filtered, { purpose, provider_type: pType, provider_id: pId, from_name: null, from_address: null }]
                              })
                              setRoutingFeedback({ purpose, type: 'success', text: 'Saved' })
                              setTimeout(() => setRoutingFeedback(null), 2000)
                            } else { setRoutingFeedback({ purpose, type: 'error', text: data.error || 'Failed' }) }
                          } catch { setRoutingFeedback({ purpose, type: 'error', text: 'Failed to save' }) }
                          setRoutingSaving(null)
                        }}
                        disabled={routingSaving === purpose}
                        className="h-10 text-[13.5px] rounded-md border border-input bg-background px-3 w-full sm:w-[320px]"
                      >
                        <option value="">Default (auto)</option>
                        {filteredAddresses.map(a => (
                          <option key={a.id} value={`${a.type}:${a.id}`}>{a.display_label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {routingFeedback?.purpose === purpose && (
                    <p className={`text-[12.5px] mt-1.5 ${routingFeedback.type === 'success' ? 'text-[#047857] dark:text-[#34d399]' : 'text-[#b91c1c] dark:text-[#f87171]'}`}>
                      {routingFeedback.text}
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* ── AI reply assistant (autosaved). MERGED card: the enable toggle + intro,
          then two sub-blocks — (a) Voice and rules, (b) Knowledge it draws on. Both
          configure the same assistant, so they live together in one card. ── */}
      <section className="mb-5 rounded-[14px] border bg-card p-5">
        <div className="flex items-center justify-between mb-1.5">
          <h3 className={cardTitle}>
            <Sparkles className="size-[18px] text-muted-foreground" /> AI reply assistant
            {aiEnabled && <Badge variant="green">On</Badge>}
          </h3>
          <Toggle on={aiEnabled} onClick={() => setAiEnabled(v => !v)} />
        </div>
        <p className={helpText}>
          Teach the assistant about your work so it can suggest draft replies to the people who email you. You stay in control: nothing sends on its own.
        </p>

        {aiError && (
          <div className="mt-4 rounded-lg border border-[rgba(239,68,68,.26)] bg-[rgba(239,68,68,.10)] px-4 py-2 text-[13px] text-[#b91c1c] dark:text-[#f87171]">{aiError}</div>
        )}

        {/* ── Sub-block (a): Voice and rules ── */}
        <div className="mt-5 pt-5 border-t">
          <p className={subhead}>Voice and rules</p>
          <p className={`${helpText} mt-0.5 mb-4`}>Who the assistant is writing as, and how it should sound.</p>

          {/* Business context */}
          <div className="space-y-4 mb-5">
            <div>
              <p className={fieldLabel}>Your name or business name</p>
              <Input value={businessName} onChange={e => setBusinessName(e.target.value)} placeholder="Your name or business" className="h-10 text-[13.5px]" />
            </div>
            <div>
              <p className={fieldLabel}>About you</p>
              <textarea value={businessDescription} onChange={e => setBusinessDescription(e.target.value)}
                placeholder="What do you do? Who tends to email you?"
                className="w-full rounded-md border bg-card px-3 py-2.5 text-[13.5px] resize-none focus:outline-none focus:ring-1 focus:ring-ring h-24" />
            </div>
          </div>

          {/* Tone — chips that save on click */}
          <p className={fieldLabel}>Tone</p>
          <div className="flex flex-wrap gap-1.5 mb-5">
            {TONES.map(t => (
              <button key={t.id} type="button" onClick={() => setTone(t.id)}
                className={`text-[12.5px] rounded-full border px-3 py-1.5 transition-colors ${tone === t.id ? 'bg-accent text-accent-foreground border-accent' : 'bg-card text-muted-foreground border-input hover:text-foreground'}`}>
                {t.label}
              </button>
            ))}
          </div>
          {tone === 'custom' && (
            <textarea value={customTone} onChange={e => setCustomTone(e.target.value)}
              placeholder="Describe your preferred tone..."
              className="w-full rounded-md border bg-card px-3 py-2.5 text-[13.5px] resize-none focus:outline-none focus:ring-1 focus:ring-ring h-20 mb-5" />
          )}

          {/* Rules / instructions */}
          <p className={fieldLabel}>Rules and instructions</p>
          <textarea value={instructions} onChange={e => setInstructions(e.target.value)}
            placeholder={'e.g. "Always offer a call" or "Never commit to a deadline"'}
            className="w-full rounded-md border bg-card px-3 py-2.5 text-[13.5px] resize-none focus:outline-none focus:ring-1 focus:ring-ring h-20" />
        </div>

        {/* ── Sub-block (b): Knowledge it draws on ── */}
        <div className="mt-6 pt-5 border-t">
          <p className={subhead}>Knowledge it draws on</p>
          <p className={`${helpText} mt-0.5 mb-4`}>
            Give the assistant example answers and reference documents to draw from. Drafted replies will reuse and adapt them when relevant.
          </p>

          {kbError && (
            <div className="mb-4 rounded-lg border border-[rgba(239,68,68,.26)] bg-[rgba(239,68,68,.10)] px-4 py-2 text-[13px] text-[#b91c1c] dark:text-[#f87171]">{kbError}</div>
          )}

          {/* Existing entries */}
          <div className="rounded-xl border divide-y mb-4">
            {knowledge.length === 0 ? (
              <div className="px-4 py-6 text-center text-[12.5px] text-muted-foreground">No entries yet. Add a model answer or a reference document below.</div>
            ) : (
              knowledge.map(entry => (
                <div key={entry.id} className="flex items-start justify-between px-4 py-3 gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-0.5">
                      <Badge variant="secondary" className="shrink-0">
                        {entry.kind === 'model_answer' ? (
                          <span className="flex items-center gap-1"><MessageSquareQuote className="size-3" /> Model answer</span>
                        ) : entry.kind === 'web_page' ? (
                          <span className="flex items-center gap-1"><Globe className="size-3" /> Web page</span>
                        ) : (
                          <span className="flex items-center gap-1"><FileText className="size-3" /> Document</span>
                        )}
                      </Badge>
                      <p className="text-[13.5px] font-medium truncate">{entry.title}</p>
                    </div>
                    <p className="text-[12.5px] text-muted-foreground line-clamp-2">{entry.contentPreview}</p>
                    {entry.isWebSource && entry.sourceUrl && (
                      <p className="text-[12.5px] text-muted-foreground mt-0.5 flex items-center gap-1 min-w-0">
                        <Globe className="size-3 shrink-0" />
                        <a href={entry.sourceUrl} target="_blank" rel="noopener noreferrer"
                          className="truncate underline hover:text-foreground">{entry.sourceLabel || entry.sourceUrl}</a>
                      </p>
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
          <div className="rounded-xl border mb-4">
            <div className="px-4 py-3 border-b flex items-center justify-between gap-3">
              <div>
                <p className="text-[13.5px] font-medium flex items-center gap-2"><BookOpen className="size-4 text-muted-foreground" /> Add from Knowledge Base</p>
                <p className="text-[12.5px] text-muted-foreground mt-0.5">Pull documents you have stored in your Knowledge Base straight into this library.</p>
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
                  <p className="text-[12.5px] text-muted-foreground py-4 text-center">Loading your Knowledge Base...</p>
                ) : !kbConnected ? (
                  <div className="rounded-md border px-4 py-6 text-center text-[12.5px] text-muted-foreground">Could not connect to your Knowledge Base right now. Make sure you have one set up, then try again.</div>
                ) : kbDocs.length === 0 ? (
                  <div className="rounded-md border px-4 py-6 text-center text-[12.5px] text-muted-foreground">No documents found in your Knowledge Base yet.</div>
                ) : (
                  <div className="max-h-64 overflow-y-auto rounded-md border divide-y">
                    {kbDocs.map(doc => (
                      <label key={doc.id} className="flex items-center gap-2 px-3 py-2 text-[13.5px] cursor-pointer hover:bg-muted/40">
                        <input type="checkbox" checked={kbSelectedIds.has(doc.id)} onChange={() => toggleKbDoc(doc.id)} className="size-4 shrink-0" />
                        <span className="truncate flex-1">{doc.title}</span>
                      </label>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <Button type="button" size="sm" onClick={importSelectedKbDocs} disabled={kbImporting || kbSelectedIds.size === 0}>
                    <Plus className="size-3.5 mr-1" /> {kbSelectedIds.size > 0 ? `Add selected (${kbSelectedIds.size})` : 'Add selected'}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => { setKbPickerOpen(false); setKbSelectedIds(new Set()) }} disabled={kbImporting}>Cancel</Button>
                </div>
              </div>
            )}
          </div>

          {/* Add a web page */}
          <div className="rounded-xl border mb-4">
            <div className="px-4 py-3 border-b">
              <p className="text-[13.5px] font-medium flex items-center gap-2"><Globe className="size-4 text-muted-foreground" /> Add a web page</p>
              <p className="text-[12.5px] text-muted-foreground mt-0.5">Add your FAQ page or website URL. We pull the text to help draft accurate replies.</p>
            </div>
            <div className="px-4 py-3 space-y-3">
              {urlError && <p className="text-[12.5px] text-[#b91c1c] dark:text-[#f87171]">{urlError}</p>}
              {urlSuccess && <p className="text-[12.5px] text-[#047857] dark:text-[#34d399] flex items-center gap-1"><Check className="size-3.5" /> {urlSuccess}</p>}
              <input value={urlValue} onChange={e => setUrlValue(e.target.value)} placeholder="https://yourbusiness.com/faq" type="url"
                className="w-full rounded-md border bg-card px-3 py-2.5 text-[13.5px] focus:outline-none focus:ring-1 focus:ring-ring" />
              <input value={urlLabel} onChange={e => setUrlLabel(e.target.value)} placeholder="Label (optional), e.g. FAQ page"
                className="w-full rounded-md border bg-card px-3 py-2.5 text-[13.5px] focus:outline-none focus:ring-1 focus:ring-ring" />
              <Button type="button" size="sm" onClick={addWebPage} disabled={urlSaving || !urlValue.trim()}>
                {urlSaving ? 'Adding page...' : <><Plus className="size-3.5 mr-1" /> Add web page</>}
              </Button>
            </div>
          </div>

          {/* Add a model answer */}
          <div className="rounded-xl border mb-4">
            <div className="px-4 py-3 border-b">
              <p className="text-[13.5px] font-medium flex items-center gap-2"><MessageSquareQuote className="size-4 text-muted-foreground" /> Add a model answer</p>
              <p className="text-[12.5px] text-muted-foreground mt-0.5">An example reply the assistant can reuse or adapt for similar questions.</p>
            </div>
            <div className="px-4 py-3 space-y-3">
              <input value={maTitle} onChange={e => setMaTitle(e.target.value)} placeholder="Title (optional), e.g. Scheduling a call"
                className="w-full rounded-md border bg-card px-3 py-2.5 text-[13.5px] focus:outline-none focus:ring-1 focus:ring-ring" />
              <textarea value={maContent} onChange={e => setMaContent(e.target.value)} placeholder="Write the model answer here..."
                className="w-full rounded-md border bg-card px-3 py-2.5 text-[13.5px] resize-none focus:outline-none focus:ring-1 focus:ring-ring h-28" />
              <Button type="button" size="sm" onClick={addModelAnswer} disabled={kbSaving}>
                <Plus className="size-3.5 mr-1" /> Add model answer
              </Button>
            </div>
          </div>

          {/* Upload a reference document */}
          <div className="rounded-xl border">
            <div className="px-4 py-3 border-b">
              <p className="text-[13.5px] font-medium flex items-center gap-2"><FileText className="size-4 text-muted-foreground" /> Upload a reference document</p>
              <p className="text-[12.5px] text-muted-foreground mt-0.5">Upload one or more PDF, Word (.docx), or text (.txt, .md, .csv) files, or paste text. The text is pulled out automatically. Each file becomes its own entry.</p>
            </div>
            <div className="px-4 py-3 space-y-3">
              <input value={docTitle} onChange={e => setDocTitle(e.target.value)}
                placeholder="Title (optional, used only with a single file), e.g. Service overview"
                className="w-full rounded-md border bg-card px-3 py-2.5 text-[13.5px] focus:outline-none focus:ring-1 focus:ring-ring" />
              <input type="file" multiple accept=".pdf,.docx,.txt,.md,.markdown,.csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown,text/csv"
                onChange={e => { setDocFiles(e.target.files ? Array.from(e.target.files) : []); setDocProgress([]); setDocSummary('') }}
                className="block w-full text-[13.5px] text-muted-foreground file:mr-3 file:rounded-md file:border file:bg-card file:px-3 file:py-1.5 file:text-[13px] file:font-medium hover:file:bg-muted/50" />
              {docFiles.length > 1 && (
                <p className="text-[12.5px] text-muted-foreground">{docFiles.length} files selected. Each is added as a separate entry.</p>
              )}
              {docProgress.length > 0 && (
                <ul className="space-y-1">
                  {docProgress.map((p, i) => (
                    <li key={i} className="flex items-center gap-2 text-[12.5px]">
                      {p.status === 'done' ? <Check className="size-3 text-[#047857] dark:text-[#34d399]" />
                        : p.status === 'failed' ? <XIcon className="size-3 text-[#b91c1c] dark:text-[#f87171]" />
                        : <span className="inline-block size-3 rounded-full border border-muted-foreground/40 border-t-transparent animate-spin" />}
                      <span className="truncate text-muted-foreground">{p.name}</span>
                      {p.status === 'failed' && p.error && <span className="text-[#b91c1c] dark:text-[#f87171] truncate">{p.error}</span>}
                    </li>
                  ))}
                </ul>
              )}
              {docSummary && <p className="text-[12.5px] text-[#047857] dark:text-[#34d399]">{docSummary}</p>}
              <p className="text-[12.5px] text-muted-foreground">Or paste the document text:</p>
              <textarea value={docContent} onChange={e => setDocContent(e.target.value)} placeholder="Paste reference text here..."
                className="w-full rounded-md border bg-card px-3 py-2.5 text-[13.5px] resize-none focus:outline-none focus:ring-1 focus:ring-ring h-28" />
              <Button type="button" size="sm" onClick={addDocument} disabled={kbSaving}>
                <Plus className="size-3.5 mr-1" /> {docFiles.length > 1 ? `Add ${docFiles.length} documents` : 'Add document'}
              </Button>
            </div>
          </div>
        </div>

        {/* ── Sub-block (c): Automatic CRM updates (formerly the separate Email intelligence section) ── */}
        <div className="mt-6 pt-5 border-t">
          <p className={subhead}>Automatic CRM updates</p>
          <p className={`${helpText} mt-0.5 mb-4`}>Reads incoming mail to keep your CRM current. Read-only, and it runs on its own even when drafting is off.</p>
          <div className="rounded-xl border divide-y">
            <div className="flex items-center justify-between px-4 py-3.5">
              <div>
                <p className="text-[13.5px] font-medium">Enable inbox scanning</p>
                <p className="text-[12.5px] text-muted-foreground">Scan your inbox on a schedule to keep your CRM up to date</p>
              </div>
              <Toggle on={eiEnabled} onClick={() => { const next = !eiEnabled; setEiEnabled(next); void runSave(() => persistEi({ is_enabled: next })) }} />
            </div>
            {eiEnabled && [
              { label: 'Create contacts from new senders', desc: 'Create new contacts from unknown senders', value: eiAutoCreate, key: 'auto_create_contacts', set: setEiAutoCreate },
              { label: 'Log messages to the contact timeline', desc: 'Log inbound emails to contact timeline', value: eiAutoTimeline, key: 'auto_update_timeline', set: setEiAutoTimeline },
              { label: 'Update engagement scores', desc: 'Track email engagement scores', value: eiAutoEngagement, key: 'auto_update_engagement', set: setEiAutoEngagement },
              { label: 'Advance pipeline stage automatically', desc: 'Move prospects to leads when engagement is high (off by default)', value: eiAutoStage, key: 'auto_advance_stage', set: setEiAutoStage },
            ].map(item => (
              <div key={item.key} className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="text-[13.5px]">{item.label}</p>
                  <p className="text-[12.5px] text-muted-foreground">{item.desc}</p>
                </div>
                <Toggle on={item.value} onClick={() => { const next = !item.value; item.set(next); void runSave(() => persistEi({ [item.key]: next })) }} />
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Reply mode ── */}
      <section className="mb-5 rounded-[14px] border bg-card p-5">
        <h3 className={`${cardTitle} mb-1.5`}>
          <FileEdit className="size-[18px] text-muted-foreground" /> Reply mode
        </h3>
        <p className={`${helpText} mb-4`}>
          Choose whether replies to the people who email you wait for your approval, send automatically, or send only when they are confident and safe.
        </p>
        <div className="rounded-xl border divide-y">
          {([
            { mode: 'draft' as ReplyMode, icon: FileEdit, title: 'Draft for approval',
              desc: 'Every reply is drafted and waits in your Inbox until you approve it. Nothing sends on its own.', rounded: 'rounded-t-xl' },
            { mode: 'auto' as ReplyMode, icon: Send, title: 'Auto-send',
              desc: 'Every drafted reply is sent automatically as soon as it is written. Use this only when you trust replies to go out without review.', rounded: '' },
            { mode: 'hybrid' as ReplyMode, icon: Sparkles, title: 'Hybrid',
              desc: 'Auto-send only confident, safe replies. Anything sensitive or uncertain waits in your Inbox for review.', rounded: 'rounded-b-xl' },
          ]).map(({ mode, icon: Icon, title, desc, rounded }) => {
            const selected = replyMode === mode
            return (
              <button key={mode} type="button" onClick={() => setReplyMode(mode)}
                className={`w-full text-left flex items-center justify-between px-4 py-3.5 transition ${rounded} ${selected ? 'selected-card' : 'hover:bg-muted/30'}`}>
                <div className="flex items-center gap-3 min-w-0">
                  <Icon className={`size-4 shrink-0 ${selected ? 'text-accent' : 'text-muted-foreground'}`} />
                  <div className="min-w-0">
                    <p className="text-[13.5px] font-medium">{title}</p>
                    <p className="text-[12.5px] text-muted-foreground">{desc}</p>
                  </div>
                </div>
                {selected && <Check className="size-4 text-accent shrink-0" />}
              </button>
            )
          })}
        </div>
        {replyMode === 'hybrid' && (
          <div className="mt-3.5 rounded-xl border px-4 py-3.5">
            <label className={`${fieldLabel} block`}>Confidence threshold</label>
            <div className="flex items-center gap-3">
              <input type="number" min={0} max={1} step={0.05} value={hybridThreshold}
                onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) setHybridThreshold(Math.min(1, Math.max(0, v))) }}
                className="w-24 rounded-md border bg-card px-3 py-2 text-[13.5px] focus:outline-none focus:ring-1 focus:ring-ring" />
              <span className="text-[12.5px] text-muted-foreground">0 to 1. Default 0.85.</span>
            </div>
            <p className="text-[12.5px] text-muted-foreground mt-2">
              A reply auto-sends only when the assistant is at least this confident in its answer and judges it safe to send. Everything else waits for your approval. Higher values send fewer replies on their own.
            </p>
          </div>
        )}
      </section>

      {/* ── Flag scenarios ── */}
      <section className="mb-5 rounded-[14px] border bg-card p-5">
        <h3 className={`${cardTitle} mb-1.5`}>
          <Flag className="size-[18px] text-muted-foreground" /> Flag scenarios
        </h3>
        <p className={`${helpText} mb-4`}>
          Tell the assistant which situations to watch for. When an incoming message matches an enabled scenario, it flags the message and drafts a reply using your instructions. Pause for review holds the reply in your Inbox, even in auto-send mode. Auto-send lets the reply go out on its own.
        </p>
        <div className="rounded-xl border divide-y">
          {flagScenarios.length === 0 ? (
            <div className="px-4 py-6 text-center text-[12.5px] text-muted-foreground">No flag scenarios available.</div>
          ) : (
            flagScenarios.map(s => {
              const custom = isCustomScenario(s.key)
              return (
                <div key={s.key} className="px-4 py-3.5 space-y-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <label className="flex items-center gap-2.5 min-w-0 cursor-pointer">
                      <input type="checkbox" checked={s.enabled}
                        onChange={e => updateFlagScenario(s.key, { enabled: e.target.checked })}
                        className="size-4 rounded border-input accent-[#2563eb] shrink-0" />
                      <span className="text-[13.5px] font-medium truncate">{s.label}</span>
                      {custom && <Badge variant="secondary" className="shrink-0">Custom</Badge>}
                    </label>
                    <div className="flex items-center gap-2 shrink-0">
                      <select value={s.action} onChange={e => updateFlagScenario(s.key, { action: e.target.value as FlagAction })}
                        disabled={!s.enabled}
                        className="shrink-0 rounded-md border bg-card px-2.5 py-2 text-[13px] focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50">
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
                    <textarea value={s.instructions}
                      onChange={e => updateFlagScenario(s.key, { instructions: e.target.value })}
                      placeholder="How should the assistant respond in this scenario? (optional)"
                      className="w-full rounded-md border bg-card px-3 py-2.5 text-[13.5px] resize-none focus:outline-none focus:ring-1 focus:ring-ring h-20" />
                  )}
                </div>
              )
            })
          )}
        </div>

        {/* Add a custom scenario */}
        <div className="rounded-xl border mt-3.5">
          <div className="px-4 py-3 border-b">
            <p className="text-[13.5px] font-medium flex items-center gap-2"><Plus className="size-4 text-muted-foreground" /> Add a custom scenario</p>
            <p className="text-[12.5px] text-muted-foreground mt-0.5">Define your own situation to watch for, such as a meeting request or an introduction. The assistant flags matching messages and follows your instructions.</p>
          </div>
          <div className="px-4 py-3 space-y-3">
            <input value={newScenarioLabel} onChange={e => setNewScenarioLabel(e.target.value)}
              placeholder="Scenario name, e.g. Meeting request"
              className="w-full rounded-md border bg-card px-3 py-2.5 text-[13.5px] focus:outline-none focus:ring-1 focus:ring-ring" />
            <textarea value={newScenarioInstructions} onChange={e => setNewScenarioInstructions(e.target.value)}
              placeholder="How should the assistant respond in this scenario? (optional)"
              className="w-full rounded-md border bg-card px-3 py-2.5 text-[13.5px] resize-none focus:outline-none focus:ring-1 focus:ring-ring h-20" />
            <div className="flex items-center justify-between gap-3">
              <select value={newScenarioAction} onChange={e => setNewScenarioAction(e.target.value as FlagAction)}
                className="rounded-md border bg-card px-2.5 py-2 text-[13px] focus:outline-none focus:ring-1 focus:ring-ring">
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


      {/* ── Signature (autosaved as part of AI settings) ── */}
      <section className="mb-5 rounded-[14px] border bg-card p-5">
        <h3 className={`${cardTitle} mb-1.5`}>
          <Mail className="size-[18px] text-muted-foreground" /> Signature
        </h3>
        <p className={`${helpText} mb-4`}>Appended to the end of your suggested drafts. You can still edit each draft before sending.</p>
        <textarea value={signature} onChange={e => setSignature(e.target.value)}
          placeholder={'e.g.\nThanks,\nThe Acme Team'}
          className="w-full rounded-md border bg-card px-3 py-2.5 text-[13.5px] resize-none focus:outline-none focus:ring-1 focus:ring-ring h-24" />
      </section>

      {/* ── Shared autosave status line (mirrors Customer Service Settings) ── */}
      <div className="flex items-center gap-2 h-5 text-[12.5px] mb-6">
        {status === 'saving' ? (
          <span className="text-muted-foreground flex items-center gap-1.5">
            <span className="inline-block size-3 rounded-full border border-muted-foreground/40 border-t-transparent animate-spin" />
            Saving...
          </span>
        ) : status === 'error' ? (
          <span className="text-[#b91c1c] dark:text-[#f87171]">Could not save. We will retry when you make another change.</span>
        ) : status === 'saved' ? (
          <span className="text-[#047857] dark:text-[#34d399] flex items-center gap-1"><Check className="size-3" /> Saved</span>
        ) : (
          <span className="text-muted-foreground">Changes save automatically.</span>
        )}
      </div>

      <p className="text-[12.5px] text-muted-foreground">
        Marketing sender, payments, team members, and the Knowledge Base connection stay on the general Settings page; they are not inbox-specific.
      </p>
    </div>
  )
}
