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

import { useEffect, useRef, useState } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Badge } from '@open-mercato/ui/primitives/badge'
import {
  Mail, Server, X as XIcon, Check, Phone, Send, Sparkles, Globe, Upload,
  FileText, BookOpen, Loader2,
} from 'lucide-react'
import AppPasswordGuides from '@/modules/customers/backend/components/AppPasswordGuides'

type EmailConnection = { id: string; provider: string; email_address: string; is_primary: boolean; is_active?: boolean }
type TwilioConnection = { id: string; accountSid: string; phoneNumber: string; isActive: boolean }
type RoutingAddress = { id: string; type: string; provider: string; email_address: string; display_label: string; can_receive: boolean }
type RoutingConfig = { purpose: string; provider_type: string; provider_id: string; from_name: string | null; from_address: string | null }
type KbDoc = { id: string; title: string }

const TONES = [
  { id: 'professional', label: 'Professional', desc: 'Business-appropriate, clear and direct' },
  { id: 'friendly', label: 'Friendly', desc: 'Warm, approachable, uses natural language' },
  { id: 'casual', label: 'Casual', desc: 'Relaxed, conversational' },
  { id: 'formal', label: 'Formal', desc: 'Polished, structured' },
  { id: 'custom', label: 'Custom', desc: 'Define your own tone and style' },
]

export default function InboxSettings({ onAiSettingsSaved }: { onAiSettingsSaved?: () => void }) {
  // ── Connected mailbox (IMAP/SMTP) ──
  const [emailConnections, setEmailConnections] = useState<EmailConnection[]>([])
  const [disconnecting, setDisconnecting] = useState<string | null>(null)
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

  // ── AI reply assistant ──
  const [aiEnabled, setAiEnabled] = useState(false)
  const [businessName, setBusinessName] = useState('')
  const [businessDescription, setBusinessDescription] = useState('')
  const [knowledgeBase, setKnowledgeBase] = useState('')
  const [tone, setTone] = useState('professional')
  const [customTone, setCustomTone] = useState('')
  const [instructions, setInstructions] = useState('')
  const [savingAi, setSavingAi] = useState(false)
  const [aiSaved, setAiSaved] = useState(false)
  const [aiError, setAiError] = useState('')
  const [importing, setImporting] = useState(false)
  const [websiteUrl, setWebsiteUrl] = useState('')
  const [uploadedFile, setUploadedFile] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── KB document picker (mirrors the Customer Service settings picker) ──
  const [kbPickerOpen, setKbPickerOpen] = useState(false)
  const [kbDocs, setKbDocs] = useState<KbDoc[]>([])
  const [kbConnected, setKbConnected] = useState(true)
  const [kbDocsLoading, setKbDocsLoading] = useState(false)
  const [kbSelectedIds, setKbSelectedIds] = useState<Set<string>>(new Set())
  const [kbImporting, setKbImporting] = useState(false)
  const [kbSummary, setKbSummary] = useState('')

  // ── Email intelligence ──
  const [eiEnabled, setEiEnabled] = useState(false)
  const [eiAutoCreate, setEiAutoCreate] = useState(true)
  const [eiAutoTimeline, setEiAutoTimeline] = useState(true)
  const [eiAutoEngagement, setEiAutoEngagement] = useState(true)
  const [eiAutoStage, setEiAutoStage] = useState(false)
  const [eiSaving, setEiSaving] = useState(false)

  // ── Signature ──
  const [signature, setSignature] = useState('')
  const [savingSignature, setSavingSignature] = useState(false)
  const [signatureSaved, setSignatureSaved] = useState(false)

  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch('/api/email/connections', { credentials: 'include' }).then(r => r.json()).catch(() => null),
      fetch('/api/twilio/connections', { credentials: 'include' }).then(r => r.json()).catch(() => null),
      fetch('/api/email/routing', { credentials: 'include' }).then(r => r.json()).catch(() => null),
      fetch('/api/inbox/ai-settings', { credentials: 'include' }).then(r => r.json()).catch(() => null),
      fetch('/api/email/intelligence-settings', { credentials: 'include' }).then(r => r.json()).catch(() => null),
    ]).then(([conn, twilio, routing, ai, ei]) => {
      if (cancelled) return
      if (conn?.ok) setEmailConnections(conn.data || [])
      if (twilio?.ok && twilio.data) setTwilioConnection(twilio.data)
      if (routing?.ok && routing.data) {
        setRoutingAddresses(routing.data.addresses || [])
        setRoutingConfig(routing.data.routing || [])
      }
      if (ai?.ok && ai.data) {
        setAiEnabled(ai.data.enabled ?? false)
        setBusinessName(ai.data.business_name || '')
        setBusinessDescription(ai.data.business_description || '')
        setKnowledgeBase(ai.data.knowledge_base || '')
        const t = ai.data.tone || 'professional'
        if (TONES.find(x => x.id === t && x.id !== 'custom')) { setTone(t) }
        else { setTone('custom'); setCustomTone(t) }
        setInstructions(ai.data.instructions || '')
        if (ai.data.signature) setSignature(ai.data.signature)
      }
      if (ei?.ok && ei.data) {
        setEiEnabled(ei.data.is_enabled ?? false)
        setEiAutoCreate(ei.data.auto_create_contacts ?? true)
        setEiAutoTimeline(ei.data.auto_update_timeline ?? true)
        setEiAutoEngagement(ei.data.auto_update_engagement ?? true)
        setEiAutoStage(ei.data.auto_advance_stage ?? false)
      }
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  const hasSmtpConnection = emailConnections.some(c => c.provider === 'smtp')

  // ── Mailbox actions ──
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
        const connRes = await fetch('/api/email/connections', { credentials: 'include' })
        const connData = await connRes.json()
        if (connData.ok) setEmailConnections(connData.data || [])
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

  // ── AI assistant actions ──
  async function handleImportWebsite() {
    if (!websiteUrl.trim()) return
    setImporting(true)
    try {
      const res = await fetch('/api/chat/scrape-website', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: websiteUrl }) })
      const data = await res.json()
      if (data.ok && data.data?.content) {
        if (!businessDescription.trim()) {
          const lines = data.data.content.split('\n')
          setBusinessDescription(lines.slice(0, 5).join('\n').substring(0, 500))
        }
        setKnowledgeBase(prev => prev ? `${prev}\n\n--- Imported from ${data.data.url} ---\n${data.data.content}` : data.data.content)
        setWebsiteUrl('')
      } else { setAiError(data.error || 'Failed to import') }
    } catch { setAiError('Failed to fetch website') }
    setImporting(false)
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (event) => {
      const text = event.target?.result as string
      if (text) {
        setKnowledgeBase(prev => prev ? `${prev}\n\n--- From ${file.name} ---\n${text}` : text)
        setUploadedFile(file.name)
      }
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  async function saveAi() {
    setSavingAi(true); setAiError(''); setAiSaved(false)
    try {
      const res = await fetch('/api/inbox/ai-settings', { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: aiEnabled,
          businessName,
          businessDescription,
          knowledgeBase,
          tone: tone === 'custom' ? customTone : tone,
          instructions,
          signature,
        }) })
      const data = await res.json()
      if (data.ok) {
        setAiSaved(true)
        onAiSettingsSaved?.()
        setTimeout(() => setAiSaved(false), 3000)
      } else { setAiError(data.error || 'Failed to save') }
    } catch { setAiError('Failed to save AI assistant settings') }
    setSavingAi(false)
  }

  // ── KB picker actions ──
  async function openKbPicker() {
    setAiError(''); setKbSummary('')
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
    setAiError('')
    const ids = Array.from(kbSelectedIds)
    if (ids.length === 0) { setAiError('Select at least one document.'); return }
    setKbImporting(true)
    try {
      const res = await fetch('/api/inbox/kb-documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ ids }) })
      const data = await res.json()
      if (data.ok) {
        const docs: { title: string; content: string }[] = data.data || []
        if (docs.length > 0) {
          const appended = docs.map(d => `--- From Knowledge Base: ${d.title} ---\n${d.content}`).join('\n\n')
          setKnowledgeBase(prev => prev ? `${prev}\n\n${appended}` : appended)
        }
        setKbSummary(`${data.added ?? docs.length} added${data.skipped ? `, ${data.skipped} skipped` : ''} from Knowledge Base. Save below to keep them.`)
        setKbPickerOpen(false)
        setKbSelectedIds(new Set())
      } else { setAiError(data.error || 'Failed to import documents.') }
    } catch { setAiError('Failed to import documents.') }
    setKbImporting(false)
  }

  // ── Email intelligence ──
  async function saveEiSettings(patch: Record<string, unknown>) {
    setEiSaving(true)
    try {
      await fetch('/api/email/intelligence-settings', { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
    } catch {}
    setEiSaving(false)
  }

  // ── Signature ──
  async function saveSignature() {
    setSavingSignature(true); setSignatureSaved(false)
    try {
      const res = await fetch('/api/inbox/ai-settings', { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signature }) })
      const data = await res.json()
      if (data.ok) { setSignatureSaved(true); setTimeout(() => setSignatureSaved(false), 3000) }
    } catch {}
    setSavingSignature(false)
  }

  if (loading) {
    return <div className="rounded-lg border px-4 py-10 text-center text-sm text-muted-foreground">Loading...</div>
  }

  return (
    <div className="max-w-2xl mx-auto p-6">
      {/* Connected mailbox */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Mail className="size-4 text-muted-foreground" /> Connected mailbox
        </h2>
        <p className="text-xs text-muted-foreground mb-3">
          Connect the mailbox your Inbox sends from and syncs replies into. Works with Gmail, Outlook, Yahoo, iCloud, or any provider that supports IMAP and SMTP. Use an App Password, not your normal password.
        </p>
        <div className="rounded-lg border divide-y">
          {emailConnections.map(conn => (
            <div key={conn.id} className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="text-sm font-medium flex items-center gap-2">
                  {conn.email_address}
                  {conn.is_primary && <Badge variant="violet">Primary</Badge>}
                </p>
                <p className="text-xs text-muted-foreground">
                  Connected via {conn.provider === 'gmail' ? 'Gmail (OAuth)' : conn.provider === 'microsoft' ? 'Outlook (OAuth)' : conn.provider === 'smtp' ? 'Email (IMAP/SMTP)' : conn.provider}
                </p>
              </div>
              <Button type="button" variant="outline" size="sm" disabled={disconnecting === conn.id}
                onClick={() => disconnectMailbox(conn.id, conn.email_address)}>
                {disconnecting === conn.id ? 'Disconnecting...' : <><XIcon className="size-3 mr-1" /> Disconnect</>}
              </Button>
            </div>
          ))}
          {!hasSmtpConnection && (
            <div className="px-4 py-3">
              <div className="flex items-center gap-2 mb-1">
                <Server className="size-3.5 text-muted-foreground" />
                <p className="text-sm font-medium">Connect a mailbox</p>
              </div>
              <p className="text-xs text-muted-foreground mb-3">Enables sending and inbox sync, so replies appear here in your Inbox.</p>
              {smtpError && <p className="text-xs text-[#b91c1c] dark:text-[#f87171] mb-2">{smtpError}</p>}
              {smtpSuccess && <p className="text-xs text-[#047857] dark:text-[#34d399] mb-2 flex items-center gap-1"><Check className="size-3" /> Mailbox connected.</p>}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
                <Input value={emailAddr} onChange={e => setEmailAddr(e.target.value)} placeholder="your@email.com" className="h-8 text-xs" type="email" />
                <Input value={emailPassword} onChange={e => setEmailPassword(e.target.value)} type="password" placeholder="App Password" className="h-8 text-xs" />
              </div>
              <div className="mb-3"><AppPasswordGuides /></div>
              <button type="button" className="text-xs text-muted-foreground underline mb-2 block" onClick={() => setShowAdvanced(v => !v)}>
                {showAdvanced ? 'Hide advanced settings' : 'Advanced: custom server settings'}
              </button>
              {showAdvanced && (
                <div className="grid grid-cols-2 gap-2 mb-2 p-3 rounded-md bg-muted/40 border">
                  <Input value={imapHost} onChange={e => setImapHost(e.target.value)} placeholder="IMAP host (auto-detected)" className="h-8 text-xs" />
                  <Input value={imapPort} onChange={e => setImapPort(e.target.value)} placeholder="IMAP port (993)" className="h-8 text-xs" />
                  <Input value={smtpHost} onChange={e => setSmtpHost(e.target.value)} placeholder="SMTP host (auto-detected)" className="h-8 text-xs" />
                  <Input value={smtpPort} onChange={e => setSmtpPort(e.target.value)} placeholder="SMTP port (587)" className="h-8 text-xs" />
                </div>
              )}
              <Button type="button" variant="outline" size="sm" onClick={saveSmtp} disabled={savingSmtp || !emailAddr || !emailPassword}>
                {savingSmtp ? 'Testing connection...' : 'Connect mailbox'}
              </Button>
            </div>
          )}
        </div>
      </section>

      {/* Text messages (SMS) */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Phone className="size-4 text-muted-foreground" /> Text messages (SMS)
        </h2>
        <p className="text-xs text-muted-foreground mb-3">
          Send and receive texts in your Inbox using your own Twilio account.
        </p>
        <div className="rounded-lg border divide-y">
          {twilioConnection ? (
            <div className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="text-sm font-medium flex items-center gap-2">{twilioConnection.phoneNumber}<Badge variant="green">Connected</Badge></p>
                <p className="text-xs text-muted-foreground">Account: {twilioConnection.accountSid}</p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={disconnectTwilio} disabled={disconnectingTwilio}>
                {disconnectingTwilio ? 'Disconnecting...' : <><XIcon className="size-3 mr-1" /> Disconnect</>}
              </Button>
            </div>
          ) : (
            <div className="px-4 py-3">
              <p className="text-sm font-medium mb-1">Connect Twilio account</p>
              <p className="text-xs text-muted-foreground mb-3">Bring your own Twilio SID, auth token, and number.</p>
              {twilioError && <p className="text-xs text-[#b91c1c] dark:text-[#f87171] mb-2">{twilioError}</p>}
              {twilioSuccess && <p className="text-xs text-[#047857] dark:text-[#34d399] mb-2 flex items-center gap-1"><Check className="size-3" /> Twilio connected.</p>}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
                <Input value={twilioSid} onChange={e => setTwilioSid(e.target.value)} placeholder="Account SID" className="h-8 text-xs" />
                <Input value={twilioToken} onChange={e => setTwilioToken(e.target.value)} type="password" placeholder="Auth Token" className="h-8 text-xs" />
              </div>
              <div className="flex gap-2">
                <Input value={twilioPhone} onChange={e => setTwilioPhone(e.target.value)} placeholder="Phone Number (+1234567890)" className="h-8 text-xs flex-1" />
                <Button type="button" variant="outline" size="sm" onClick={saveTwilio} disabled={savingTwilio || !twilioSid || !twilioToken || !twilioPhone}>
                  {savingTwilio ? 'Testing...' : 'Save & Test'}
                </Button>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Routing addresses */}
      {routingAddresses.length > 1 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <Send className="size-4 text-muted-foreground" /> Routing addresses
          </h2>
          <p className="text-xs text-muted-foreground mb-3">Choose which email address sends each type of email. Leave blank to use defaults.</p>
          <div className="rounded-lg border divide-y">
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
                <div key={purpose} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{label}</p>
                      <p className="text-[11px] text-muted-foreground">{desc}</p>
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
                        className="h-8 text-xs rounded-md border border-input bg-background px-3 w-[320px]"
                      >
                        <option value="">Default (auto)</option>
                        {filteredAddresses.map(a => (
                          <option key={a.id} value={`${a.type}:${a.id}`}>{a.display_label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {routingFeedback?.purpose === purpose && (
                    <p className={`text-[11px] mt-1 ${routingFeedback.type === 'success' ? 'text-[#047857] dark:text-[#34d399]' : 'text-[#b91c1c] dark:text-[#f87171]'}`}>
                      {routingFeedback.text}
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* AI reply assistant */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Sparkles className="size-4 text-muted-foreground" /> AI reply assistant
          </h2>
          <label className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Enabled</span>
            <button type="button" onClick={() => setAiEnabled(v => !v)}
              className={`relative w-10 h-5 rounded-full transition-colors ${aiEnabled ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600'}`}>
              <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform shadow-sm ${aiEnabled ? 'translate-x-5' : ''}`} />
            </button>
          </label>
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          Teach the assistant about your business so it can suggest draft replies when you ask for one. You stay in control: nothing sends on its own.
        </p>

        {aiError && (
          <div className="mb-3 rounded-lg border border-[rgba(239,68,68,.26)] bg-[rgba(239,68,68,.10)] px-4 py-2 text-sm text-[#b91c1c] dark:text-[#f87171]">{aiError}</div>
        )}

        {/* Business context */}
        <div className="rounded-lg border divide-y mb-4">
          <div className="px-4 py-3">
            <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Business name</label>
            <Input value={businessName} onChange={e => setBusinessName(e.target.value)} placeholder="Your Business Name" className="h-9 text-sm" />
          </div>
          <div className="px-4 py-3">
            <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">About your business</label>
            <textarea value={businessDescription} onChange={e => setBusinessDescription(e.target.value)}
              placeholder="What does your business do? Who are your customers?"
              className="w-full rounded-md border bg-card px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring h-24" />
          </div>
        </div>

        {/* Tone */}
        <div className="rounded-lg border mb-4">
          <div className="px-4 py-3 border-b">
            <p className="text-sm font-medium">Reply tone</p>
            <p className="text-xs text-muted-foreground mt-0.5">How should suggested drafts sound?</p>
          </div>
          <div className="px-4 py-3 space-y-2">
            {TONES.map(t => (
              <button key={t.id} type="button" onClick={() => setTone(t.id)}
                className={`w-full flex items-center gap-3 rounded-lg border p-3 text-left transition-colors ${tone === t.id ? 'selected-card' : 'hover:bg-muted/50'}`}>
                <div className={`size-4 rounded-full border-2 flex items-center justify-center shrink-0 ${tone === t.id ? 'border-accent' : 'border-muted-foreground/30'}`}>
                  {tone === t.id && <div className="size-2 rounded-full bg-accent" />}
                </div>
                <div>
                  <p className="text-sm font-medium">{t.label}</p>
                  <p className="text-[11px] text-muted-foreground">{t.desc}</p>
                </div>
              </button>
            ))}
            {tone === 'custom' && (
              <textarea value={customTone} onChange={e => setCustomTone(e.target.value)}
                placeholder="Describe your preferred tone..."
                className="w-full rounded-md border bg-card px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring h-20 mt-2" />
            )}
          </div>
        </div>

        {/* Instructions / rules */}
        <div className="rounded-lg border mb-4">
          <div className="px-4 py-3 border-b">
            <p className="text-sm font-medium">Instructions and rules</p>
            <p className="text-xs text-muted-foreground mt-0.5">Specific rules for the assistant to follow when drafting replies.</p>
          </div>
          <div className="px-4 py-3">
            <textarea value={instructions} onChange={e => setInstructions(e.target.value)}
              placeholder={'e.g. "Always mention our guarantee" or "Never discuss competitor pricing"'}
              className="w-full rounded-md border bg-card px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring h-20" />
          </div>
        </div>

        {/* Knowledge base */}
        <div className="rounded-lg border mb-4">
          <div className="px-4 py-3 border-b">
            <p className="text-sm font-medium flex items-center gap-2"><BookOpen className="size-4 text-muted-foreground" /> Knowledge base</p>
            <p className="text-xs text-muted-foreground mt-0.5">Information the assistant should reference: pricing, policies, FAQs, product details.</p>
          </div>
          <div className="px-4 py-3 space-y-3">
            {/* Import controls */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <button type="button" onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-2 rounded-lg border p-3 hover:bg-muted/50 transition-colors text-left">
                <Upload className="size-4 text-muted-foreground shrink-0" />
                <div>
                  <p className="text-xs font-medium">Upload a document</p>
                  <p className="text-[10px] text-muted-foreground">TXT, MD, CSV</p>
                </div>
              </button>
              <button type="button" onClick={openKbPicker}
                className="flex items-center gap-2 rounded-lg border p-3 hover:bg-muted/50 transition-colors text-left">
                <BookOpen className="size-4 text-muted-foreground shrink-0" />
                <div>
                  <p className="text-xs font-medium">From Knowledge Base</p>
                  <p className="text-[10px] text-muted-foreground">Pick a stored document</p>
                </div>
              </button>
              <div className="flex items-center gap-2 rounded-lg border p-3">
                <Globe className="size-4 text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium">Scan a website</p>
                  <p className="text-[10px] text-muted-foreground">Pull your site text</p>
                </div>
              </div>
              <input ref={fileInputRef} type="file" accept=".txt,.md,.csv" className="hidden" onChange={handleFileUpload} />
            </div>

            {/* Website scan input */}
            <div className="flex items-center gap-2">
              <Input value={websiteUrl} onChange={e => setWebsiteUrl(e.target.value)} placeholder="https://yourbusiness.com"
                className="flex-1 h-8 text-sm" onKeyDown={e => { if (e.key === 'Enter') handleImportWebsite() }} />
              <Button type="button" variant="outline" size="sm" onClick={handleImportWebsite} disabled={importing || !websiteUrl.trim()}>
                {importing ? <Loader2 className="size-3.5 mr-1.5 animate-spin" /> : <Globe className="size-3.5 mr-1.5" />}
                {importing ? 'Scanning...' : 'Scan'}
              </Button>
            </div>

            {uploadedFile && (
              <div className="flex items-center gap-2">
                <FileText className="size-4 text-muted-foreground" />
                <span className="text-xs">{uploadedFile}</span>
                <button type="button" onClick={() => setUploadedFile(null)} className="text-muted-foreground hover:text-foreground"><XIcon className="size-3" /></button>
              </div>
            )}

            {/* KB picker */}
            {kbPickerOpen && (
              <div className="rounded-md border px-3 py-3 space-y-3 bg-muted/20">
                <p className="text-xs font-medium flex items-center gap-2"><BookOpen className="size-3.5 text-muted-foreground" /> Select a reference document from your Knowledge Base</p>
                {kbDocsLoading ? (
                  <p className="text-xs text-muted-foreground py-4 text-center">Loading your Knowledge Base...</p>
                ) : !kbConnected ? (
                  <div className="rounded-md border px-4 py-6 text-center text-xs text-muted-foreground">
                    Could not connect to your Knowledge Base right now. Make sure you have one set up, then try again.
                  </div>
                ) : kbDocs.length === 0 ? (
                  <div className="rounded-md border px-4 py-6 text-center text-xs text-muted-foreground">No documents found in your Knowledge Base yet.</div>
                ) : (
                  <div className="max-h-64 overflow-y-auto rounded-md border divide-y bg-card">
                    {kbDocs.map(doc => (
                      <label key={doc.id} className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-muted/40">
                        <input type="checkbox" checked={kbSelectedIds.has(doc.id)} onChange={() => toggleKbDoc(doc.id)} className="size-4 shrink-0" />
                        <span className="truncate flex-1">{doc.title}</span>
                      </label>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <Button type="button" size="sm" onClick={importSelectedKbDocs} disabled={kbImporting || kbSelectedIds.size === 0}>
                    {kbImporting ? 'Adding...' : kbSelectedIds.size > 0 ? `Add selected (${kbSelectedIds.size})` : 'Add selected'}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => { setKbPickerOpen(false); setKbSelectedIds(new Set()) }} disabled={kbImporting}>Cancel</Button>
                </div>
              </div>
            )}
            {kbSummary && <p className="text-[11px] text-[#047857] dark:text-[#34d399]">{kbSummary}</p>}

            <textarea value={knowledgeBase} onChange={e => setKnowledgeBase(e.target.value)}
              placeholder="Paste or type your business information here..."
              className="w-full rounded-md border bg-card px-3 py-2.5 text-sm font-mono resize-none focus:outline-none focus:ring-1 focus:ring-ring h-48" />
          </div>
        </div>

        {/* Save AI assistant */}
        <div className="flex items-center gap-3">
          <Button type="button" onClick={saveAi} disabled={savingAi}>
            {savingAi ? <Loader2 className="size-4 mr-2 animate-spin" /> : aiSaved ? <Check className="size-4 mr-2" /> : null}
            {savingAi ? 'Saving...' : aiSaved ? 'Saved' : 'Save AI assistant'}
          </Button>
          {aiSaved && <span className="text-xs text-[#047857] dark:text-[#34d399]">Settings saved.</span>}
        </div>
      </section>

      {/* Email intelligence */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Mail className="size-4 text-muted-foreground" /> Email intelligence
        </h2>
        <p className="text-xs text-muted-foreground mb-3">
          Automatically scan your connected mailbox to create contacts, log emails, and track engagement.
        </p>
        <div className="rounded-lg border divide-y">
          <div className="flex items-center justify-between px-4 py-3">
            <div>
              <p className="text-sm font-medium">Enable inbox scanning</p>
              <p className="text-xs text-muted-foreground">Scan your inbox on a schedule to keep your CRM up to date</p>
            </div>
            <button type="button" onClick={() => { const next = !eiEnabled; setEiEnabled(next); saveEiSettings({ is_enabled: next }) }}
              disabled={eiSaving}
              className={`relative w-10 h-5 rounded-full transition-colors ${eiEnabled ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600'}`}>
              <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform shadow-sm ${eiEnabled ? 'translate-x-5' : ''}`} />
            </button>
          </div>
          {eiEnabled && [
            { label: 'Auto-create contacts', desc: 'Create new contacts from unknown senders', value: eiAutoCreate, key: 'auto_create_contacts', set: setEiAutoCreate },
            { label: 'Update timeline', desc: 'Log inbound emails to contact timeline', value: eiAutoTimeline, key: 'auto_update_timeline', set: setEiAutoTimeline },
            { label: 'Update engagement', desc: 'Track email engagement scores', value: eiAutoEngagement, key: 'auto_update_engagement', set: setEiAutoEngagement },
            { label: 'Auto-advance stage', desc: 'Move prospects to leads when engagement is high', value: eiAutoStage, key: 'auto_advance_stage', set: setEiAutoStage },
          ].map(item => (
            <div key={item.key} className="flex items-center justify-between px-4 py-2.5">
              <div>
                <p className="text-sm">{item.label}</p>
                <p className="text-xs text-muted-foreground">{item.desc}</p>
              </div>
              <button type="button" onClick={() => { const next = !item.value; item.set(next); saveEiSettings({ [item.key]: next }) }}
                disabled={eiSaving}
                className={`relative w-9 h-[18px] rounded-full transition-colors ${item.value ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600'}`}>
                <span className={`absolute top-[1px] left-[1px] w-4 h-4 bg-white rounded-full transition-transform shadow-sm ${item.value ? 'translate-x-[18px]' : ''}`} />
              </button>
            </div>
          ))}
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
            <p className="text-[11px] text-muted-foreground mt-1.5">Added to the end of suggested drafts. You can still edit each draft before sending.</p>
            <div className="mt-2 flex items-center gap-3">
              <Button type="button" variant="outline" size="sm" onClick={saveSignature} disabled={savingSignature}>
                {savingSignature ? 'Saving...' : 'Save signature'}
              </Button>
              {signatureSaved && <span className="text-xs text-[#047857] dark:text-[#34d399] flex items-center gap-1"><Check className="size-3" /> Saved</span>}
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
