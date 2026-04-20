'use client'

import { useState, useEffect } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Settings, Monitor, Key, User, Moon, Sun, Check, Mail, X as XIcon, Server, Send, CreditCard, Phone, Sparkles, Briefcase, Smile, Minus, Kanban, Users as UsersIcon, GripVertical, Pencil, Trash2, Plus, ChevronUp, ChevronDown, BookOpen, LayoutDashboard, EyeOff, Eye } from 'lucide-react'

export default function SimpleSettingsPage() {
  const [mode, setMode] = useState('simple')
  const [theme, setTheme] = useState('light')
  const [saved, setSaved] = useState(false)
  const [aiUsage, setAiUsage] = useState<{ callsUsed: number; callsCap: number; hasUserKey: boolean } | null>(null)
  const [byokKey, setByokKey] = useState('')
  const [savingKey, setSavingKey] = useState(false)
  const [emailConnections, setEmailConnections] = useState<Array<{ id: string; provider: string; email_address: string; is_primary: boolean }>>([])
  const [disconnecting, setDisconnecting] = useState<string | null>(null)

  // Email connection state (IMAP/SMTP)
  const [emailAddr, setEmailAddr] = useState('')
  const [emailPassword, setEmailPassword] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [openGuide, setOpenGuide] = useState<'gmail' | 'outlook' | 'other' | null>(null)
  const [smtpHost, setSmtpHost] = useState('')
  const [smtpPort, setSmtpPort] = useState('587')
  const [imapHost, setImapHost] = useState('')
  const [imapPort, setImapPort] = useState('993')
  const [savingSmtp, setSavingSmtp] = useState(false)
  const [smtpError, setSmtpError] = useState('')
  const [smtpSuccess, setSmtpSuccess] = useState(false)

  // ESP state
  const [espProvider, setEspProvider] = useState('resend')
  const [espApiKey, setEspApiKey] = useState('')
  const [espDomain, setEspDomain] = useState('')
  const [espSenderEmail, setEspSenderEmail] = useState('')
  const [espSenderName, setEspSenderName] = useState('')
  const [savingEsp, setSavingEsp] = useState(false)
  const [espError, setEspError] = useState('')
  const [espSuccess, setEspSuccess] = useState(false)
  const [espConnection, setEspConnection] = useState<{ id: string; provider: string; sending_domain: string; default_sender_email?: string; default_sender_name?: string; is_active: boolean } | null>(null)

  // Stripe Connect state
  const [stripeConnection, setStripeConnection] = useState<{ id: string; stripeAccountId: string; businessName: string | null; livemode: boolean; isActive: boolean } | null>(null)
  const [disconnectingStripe, setDisconnectingStripe] = useState(false)
  const [termsUrl, setTermsUrl] = useState('')
  const [savingTerms, setSavingTerms] = useState(false)
  const [termsSaved, setTermsSaved] = useState(false)

  // Twilio state
  const [twilioConnection, setTwilioConnection] = useState<{ id: string; accountSid: string; phoneNumber: string; isActive: boolean } | null>(null)
  const [twilioSid, setTwilioSid] = useState('')
  const [twilioToken, setTwilioToken] = useState('')
  const [twilioPhone, setTwilioPhone] = useState('')
  const [savingTwilio, setSavingTwilio] = useState(false)
  const [twilioError, setTwilioError] = useState('')
  const [twilioSuccess, setTwilioSuccess] = useState(false)
  const [disconnectingTwilio, setDisconnectingTwilio] = useState(false)

  // AI Persona state
  const [aiPersonaName, setAiPersonaName] = useState('Scout')
  const [aiPersonaStyle, setAiPersonaStyle] = useState('professional')
  const [aiCustomInstructions, setAiCustomInstructions] = useState('')
  const [savingPersona, setSavingPersona] = useState(false)
  const [personaSaved, setPersonaSaved] = useState(false)

  // PKB state
  const [pkbApiKey, setPkbApiKey] = useState('')
  const [pkbConnected, setPkbConnected] = useState(false)
  const [pkbTesting, setPkbTesting] = useState(false)
  const [pkbDocCount, setPkbDocCount] = useState(0)
  const [pkbMessage, setPkbMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // AMS API key state
  const [amsKeyExists, setAmsKeyExists] = useState(false)
  const [amsKeySecret, setAmsKeySecret] = useState<string | null>(null)
  const [amsKeyGenerating, setAmsKeyGenerating] = useState(false)
  const [amsKeyCopied, setAmsKeyCopied] = useState(false)
  const [amsUrlCopied, setAmsUrlCopied] = useState(false)


  // Sender addresses state
  const [senderAddresses, setSenderAddresses] = useState<Array<{ id: string; sender_email: string; sender_name: string | null; is_default: boolean }>>([])
  const [newSenderEmail, setNewSenderEmail] = useState('')
  const [newSenderName, setNewSenderName] = useState('')
  const [addingSender, setAddingSender] = useState(false)
  const [senderFeedback, setSenderFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // Email routing state
  const [routingAddresses, setRoutingAddresses] = useState<Array<{ id: string; type: string; provider: string; email_address: string; display_label: string; can_receive: boolean }>>([])
  const [routingConfig, setRoutingConfig] = useState<Array<{ purpose: string; provider_type: string; provider_id: string; from_name: string | null; from_address: string | null }>>([])
  const [routingSaving, setRoutingSaving] = useState<string | null>(null)
  const [routingFeedback, setRoutingFeedback] = useState<{ purpose: string; type: 'success' | 'error'; text: string } | null>(null)

  // Pipeline mode state
  const [pipelineMode, setPipelineMode] = useState<'deals' | 'journey'>('deals')
  const [savingPipelineMode, setSavingPipelineMode] = useState(false)
  const [pipelineModeSaved, setPipelineModeSaved] = useState(false)
  const [calendarFeedId, setCalendarFeedId] = useState('')
  const [calendarCopied, setCalendarCopied] = useState(false)

  // Sidebar visibility
  const [hiddenSidebar, setHiddenSidebar] = useState<string[]>([])

  // Pipeline stages state
  const [pipelineStages, setPipelineStages] = useState<Array<{ name: string }>>([])
  const [editingStageIndex, setEditingStageIndex] = useState<number | null>(null)
  const [editingStageName, setEditingStageName] = useState('')
  const [newStageName, setNewStageName] = useState('')
  const [savingStages, setSavingStages] = useState(false)
  const [stagesSaved, setStagesSaved] = useState(false)

  // Team state
  const [teamMembers, setTeamMembers] = useState<Array<{id:string,name:string,email:string,role_name:string,is_owner:boolean,created_at:string,last_login_at:string|null}>>([])
  const [teamInvites, setTeamInvites] = useState<Array<{id:string,email:string,role:string,created_at:string,expires_at:string,invited_by_name:string}>>([])
  const [teamSeats, setTeamSeats] = useState({ used: 0, max: 5 })
  const [currentUserRole, setCurrentUserRole] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState('member')
  const [inviting, setInviting] = useState(false)
  const [inviteError, setInviteError] = useState('')
  const [inviteSuccess, setInviteSuccess] = useState('')

  // Inbox Intelligence state
  const [eiEnabled, setEiEnabled] = useState(false)
  const [eiAutoCreate, setEiAutoCreate] = useState(true)
  const [eiAutoTimeline, setEiAutoTimeline] = useState(true)
  const [eiAutoEngagement, setEiAutoEngagement] = useState(true)
  const [eiAutoStage, setEiAutoStage] = useState(true)
  const [eiSyncing, setEiSyncing] = useState(false)
  const [eiSaving, setEiSaving] = useState(false)
  const [eiSyncStatus, setEiSyncStatus] = useState<string | null>(null)
  const [eiSyncError, setEiSyncError] = useState<string | null>(null)
  const [eiLastSync, setEiLastSync] = useState<string | null>(null)
  const [eiEmailsProcessed, setEiEmailsProcessed] = useState(0)
  const [eiContactsCreated, setEiContactsCreated] = useState(0)
  const [eiSyncResult, setEiSyncResult] = useState<{ emailsProcessed: number; contactsCreated: number } | null>(null)

  // Load hidden sidebar items from cookie
  useEffect(() => {
    try {
      const raw = document.cookie.split('; ').find(c => c.startsWith('crm_hidden_sidebar='))?.split('=')[1]
      if (raw) setHiddenSidebar(JSON.parse(decodeURIComponent(raw)))
    } catch {}
  }, [])

  function toggleSidebarItem(href: string) {
    setHiddenSidebar(prev => {
      const next = prev.includes(href) ? prev.filter(h => h !== href) : [...prev, href]
      document.cookie = `crm_hidden_sidebar=${encodeURIComponent(JSON.stringify(next))};path=/;max-age=${365 * 24 * 60 * 60}`
      // Force sidebar to re-render by navigating to the same page
      setTimeout(() => window.location.reload(), 100)
      return next
    })
  }

  // Clean up success/error query params from URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.has('email_connected') || params.has('stripe_connected') || params.has('stripe_error')) {
      setTimeout(() => {
        window.history.replaceState({}, '', window.location.pathname)
      }, 5000)
    }
  }, [])

  useEffect(() => {
    // Read theme
    setTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light')
    // Load AI usage
    fetch('/api/ai/usage', { credentials: 'include' })
      .then(r => r.json()).then(d => { if (d.ok) setAiUsage(d.data) }).catch(() => {})
    // Load email connections
    fetch('/api/email/connections', { credentials: 'include' })
      .then(r => r.json()).then(d => { if (d.ok) setEmailConnections(d.data || []) }).catch(() => {})
    // Load ESP connection
    fetch('/api/email/esp', { credentials: 'include' })
      .then(r => r.json()).then(d => { if (d.ok && d.data) setEspConnection(d.data) }).catch(() => {})
    // Load Stripe connection
    fetch('/api/payments/stripe/connections', { credentials: 'include' })
      .then(r => r.json()).then(d => { if (d.ok && d.data) setStripeConnection(d.data) }).catch(() => {})
    // Load Twilio connection
    fetch('/api/twilio/connections', { credentials: 'include' })
      .then(r => r.json()).then(d => { if (d.ok && d.data) setTwilioConnection(d.data) }).catch(() => {})
    // Load PKB config
    fetch('/api/courses/pkb/config', { credentials: 'include' })
      .then(r => r.json()).then(d => { if (d.ok && d.data?.configured) setPkbConnected(true) }).catch(() => {})
    // Check if AMS API key already exists
    fetch('/api/api_keys/keys?search=AMS+Integration', { credentials: 'include' })
      .then(r => r.json()).then(d => { if (d.items?.length) setAmsKeyExists(true) }).catch(() => {})
    // Load sender addresses
    fetch('/api/email/sender-addresses', { credentials: 'include' })
      .then(r => r.json()).then(d => { if (d.ok) setSenderAddresses(d.data || []) }).catch(() => {})
    // Load email routing config
    fetch('/api/email/routing', { credentials: 'include' })
      .then(r => r.json()).then(d => {
        if (d.ok && d.data) {
          setRoutingAddresses(d.data.addresses || [])
          setRoutingConfig(d.data.routing || [])
        }
      }).catch(() => {})
    // Load AI persona
    fetch('/api/customers/business-profile', { credentials: 'include' })
      .then(r => r.json()).then(d => {
        if (d.ok && d.data) {
          if (d.data.ai_persona_name) setAiPersonaName(d.data.ai_persona_name)
          if (d.data.ai_persona_style) setAiPersonaStyle(d.data.ai_persona_style)
          if (d.data.ai_custom_instructions) setAiCustomInstructions(d.data.ai_custom_instructions)
          if (d.data.pipeline_mode) setPipelineMode(d.data.pipeline_mode)
          if (d.data.pipeline_stages) {
            try {
              const stages = typeof d.data.pipeline_stages === 'string' ? JSON.parse(d.data.pipeline_stages) : d.data.pipeline_stages
              if (Array.isArray(stages)) setPipelineStages(stages)
            } catch {}
          }
          if (d.data.interface_mode) setMode(d.data.interface_mode)
          if (d.data.terms_url) setTermsUrl(d.data.terms_url)
        }
      }).catch(() => {})
    fetch('/api/auth/me', { credentials: 'include' })
      .then(r => r.json()).then(d => { if (d?.id) setCalendarFeedId(d.id) }).catch(() => {})
    // Load Inbox Intelligence settings
    fetch('/api/email/intelligence-settings', { credentials: 'include' })
      .then(r => r.json()).then(d => {
        if (d.ok && d.data) {
          setEiEnabled(d.data.is_enabled || false)
          setEiAutoCreate(d.data.auto_create_contacts ?? true)
          setEiAutoTimeline(d.data.auto_update_timeline ?? true)
          setEiAutoEngagement(d.data.auto_update_engagement ?? true)
          setEiAutoStage(d.data.auto_advance_stage ?? true)
          setEiLastSync(d.data.last_sync_at || null)
          setEiSyncStatus(d.data.last_sync_status || null)
          setEiSyncError(d.data.last_sync_error || null)
          setEiEmailsProcessed(d.data.emails_processed_total || 0)
          setEiContactsCreated(d.data.contacts_created_total || 0)
        }
      }).catch(() => {})
    // Load team data
    fetch('/api/team', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (d.ok && d.data) {
          setTeamMembers(d.data.members || [])
          setTeamInvites(d.data.invites || [])
          setTeamSeats(d.data.seats || { used: 0, max: 5 })
          setCurrentUserRole(d.data.currentUserRole || '')
        }
      })
      .catch(() => {})
  }, [])

  async function sendInvite() {
    if (!inviteEmail.trim()) return
    setInviting(true); setInviteError(''); setInviteSuccess('')
    try {
      const res = await fetch('/api/team', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole })
      })
      const d = await res.json()
      if (d.ok) {
        const msg = d.warning
          ? d.warning + (d.data?.inviteUrl ? ` Invite link: ${d.data.inviteUrl}` : '')
          : `Invite sent to ${inviteEmail}`
        setInviteSuccess(msg)
        if (d.warning) setInviteError(d.warning)
        setInviteEmail('')
        // Reload team data
        fetch('/api/team', { credentials: 'include' }).then(r => r.json()).then(d => {
          if (d.ok && d.data) { setTeamMembers(d.data.members||[]); setTeamInvites(d.data.invites||[]); setTeamSeats(d.data.seats||{used:0,max:5}) }
        })
      } else { setInviteError(d.error || 'Failed to send invite') }
    } catch { setInviteError('Failed to send invite') }
    setInviting(false)
  }

  async function removeMember(userId: string, name: string) {
    if (!confirm(`Remove ${name} from the team?`)) return
    const res = await fetch('/api/team/member', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ userId })
    })
    const d = await res.json()
    if (d.ok) { setTeamMembers(prev => prev.filter(m => m.id !== userId)) }
    else { alert(d.error || 'Failed to remove member') }
  }

  async function revokeInvite(inviteId: string) {
    const res = await fetch('/api/team/invite', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ inviteId })
    })
    const d = await res.json()
    if (d.ok) { setTeamInvites(prev => prev.filter(i => i.id !== inviteId)) }
  }

  async function changeMode(newMode: string) {
    setMode(newMode)
    // Save to database (primary) and cookie (fallback)
    await fetch('/api/customers/business-profile', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ interfaceMode: newMode }),
    })
    // Also set cookie as fallback for server-side rendering
    document.cookie = `crm_interface_mode=${newMode}; path=/; max-age=${60 * 60 * 24 * 365}`
    setSaved(true)
    setTimeout(() => { setSaved(false); window.location.reload() }, 1000)
  }

  function toggleTheme() {
    const newTheme = theme === 'dark' ? 'light' : 'dark'
    setTheme(newTheme)
    if (newTheme === 'dark') {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
    localStorage.setItem('om-theme', newTheme)
  }

  async function saveSmtp() {
    setSavingSmtp(true)
    setSmtpError('')
    setSmtpSuccess(false)
    try {
      const body: Record<string, any> = { emailAddress: emailAddr, password: emailPassword }
      if (showAdvanced) {
        if (smtpHost) { body.smtpHost = smtpHost; body.smtpPort = Number(smtpPort) }
        if (imapHost) { body.imapHost = imapHost; body.imapPort = Number(imapPort) }
      }
      const res = await fetch('/api/email/smtp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (data.ok) {
        setSmtpSuccess(true)
        setEmailAddr('')
        setEmailPassword('')
        setSmtpHost('')
        setSmtpPort('587')
        setImapHost('')
        setImapPort('993')
        setShowAdvanced(false)
        // Reload connections
        const connRes = await fetch('/api/email/connections', { credentials: 'include' })
        const connData = await connRes.json()
        if (connData.ok) setEmailConnections(connData.data || [])
        setTimeout(() => setSmtpSuccess(false), 3000)
      } else {
        setSmtpError(data.error || 'Failed to save')
      }
    } catch {
      setSmtpError('Failed to save SMTP configuration')
    }
    setSavingSmtp(false)
  }

  async function saveEsp() {
    setSavingEsp(true)
    setEspError('')
    setEspSuccess(false)
    try {
      const res = await fetch('/api/email/esp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          provider: espProvider,
          apiKey: espApiKey,
          sendingDomain: espDomain || undefined,
          defaultSenderEmail: espSenderEmail || undefined,
          defaultSenderName: espSenderName || undefined,
        }),
      })
      const data = await res.json()
      if (data.ok) {
        setEspSuccess(true)
        setEspApiKey('')
        setEspDomain('')
        setEspSenderEmail('')
        setEspSenderName('')
        // Reload ESP connection
        const espRes = await fetch('/api/email/esp', { credentials: 'include' })
        const espData = await espRes.json()
        if (espData.ok && espData.data) setEspConnection(espData.data)
        setTimeout(() => setEspSuccess(false), 3000)
      } else {
        setEspError(data.error || 'Failed to save')
      }
    } catch {
      setEspError('Failed to save ESP configuration')
    }
    setSavingEsp(false)
  }

  async function disconnectEsp() {
    if (!espConnection) return
    if (!confirm('Disconnect your email provider? Bulk email sending will stop working.')) return
    try {
      await fetch(`/api/email/esp?id=${espConnection.id}`, { method: 'DELETE', credentials: 'include' })
      setEspConnection(null)
    } catch {}
  }

  async function disconnectStripe() {
    if (!confirm('Disconnect Stripe? You will not be able to accept payments until you reconnect.')) return
    setDisconnectingStripe(true)
    try {
      await fetch('/api/payments/stripe/connections', { method: 'DELETE', credentials: 'include' })
      setStripeConnection(null)
    } catch {}
    setDisconnectingStripe(false)
  }

  async function saveTwilio() {
    setSavingTwilio(true)
    setTwilioError('')
    setTwilioSuccess(false)
    try {
      const res = await fetch('/api/twilio/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          accountSid: twilioSid,
          authToken: twilioToken,
          phoneNumber: twilioPhone,
        }),
      })
      const data = await res.json()
      if (data.ok) {
        setTwilioSuccess(true)
        setTwilioSid('')
        setTwilioToken('')
        setTwilioPhone('')
        // Reload connection
        const connRes = await fetch('/api/twilio/connections', { credentials: 'include' })
        const connData = await connRes.json()
        if (connData.ok && connData.data) setTwilioConnection(connData.data)
        setTimeout(() => setTwilioSuccess(false), 3000)
      } else {
        setTwilioError(data.error || 'Failed to save')
      }
    } catch {
      setTwilioError('Failed to save Twilio configuration')
    }
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

  async function savePersona() {
    setSavingPersona(true)
    setPersonaSaved(false)
    try {
      await fetch('/api/customers/business-profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          aiPersonaName: aiPersonaName.trim() || 'Scout',
          aiPersonaStyle,
          aiCustomInstructions: aiCustomInstructions.trim() || undefined,
        }),
      })
      setPersonaSaved(true)
      setTimeout(() => setPersonaSaved(false), 3000)
    } catch {}
    setSavingPersona(false)
  }

  async function savePipelineStages(stages: Array<{ name: string }>) {
    setSavingStages(true)
    setStagesSaved(false)
    try {
      await fetch('/api/customers/business-profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ pipelineStages: stages }),
      })
      setPipelineStages(stages)
      setStagesSaved(true)
      setTimeout(() => setStagesSaved(false), 3000)
    } catch {}
    setSavingStages(false)
  }

  function addStage() {
    const name = newStageName.trim()
    if (!name) return
    const updated = [...pipelineStages, { name }]
    setNewStageName('')
    savePipelineStages(updated)
  }

  function removeStage(index: number) {
    const updated = pipelineStages.filter((_, i) => i !== index)
    savePipelineStages(updated)
  }

  function moveStage(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= pipelineStages.length) return
    const updated = [...pipelineStages]
    const temp = updated[index]
    updated[index] = updated[target]
    updated[target] = temp
    savePipelineStages(updated)
  }

  function startEditStage(index: number) {
    setEditingStageIndex(index)
    setEditingStageName(pipelineStages[index].name)
  }

  function saveEditStage() {
    if (editingStageIndex === null) return
    const name = editingStageName.trim()
    if (!name) return
    const updated = [...pipelineStages]
    updated[editingStageIndex] = { name }
    setEditingStageIndex(null)
    setEditingStageName('')
    savePipelineStages(updated)
  }

  function cancelEditStage() {
    setEditingStageIndex(null)
    setEditingStageName('')
  }

  async function savePipelineMode(newMode: 'deals' | 'journey') {
    setSavingPipelineMode(true)
    setPipelineModeSaved(false)
    const previousMode = pipelineMode
    setPipelineMode(newMode)
    try {
      await fetch('/api/customers/business-profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ pipelineMode: newMode }),
      })
      setPipelineModeSaved(true)
      setTimeout(() => setPipelineModeSaved(false), 3000)
    } catch {
      setPipelineMode(previousMode)
    }
    setSavingPipelineMode(false)
  }

  const hasSmtpConnection = emailConnections.some(c => c.provider === 'smtp')

  async function saveEiSettings(updates: Record<string, any>) {
    setEiSaving(true)
    try {
      const res = await fetch('/api/email/intelligence-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(updates),
      })
      const data = await res.json()
      if (data.ok && data.data) {
        setEiEnabled(data.data.is_enabled || false)
        setEiAutoCreate(data.data.auto_create_contacts ?? true)
        setEiAutoTimeline(data.data.auto_update_timeline ?? true)
        setEiAutoEngagement(data.data.auto_update_engagement ?? true)
        setEiAutoStage(data.data.auto_advance_stage ?? true)
      }
    } catch {}
    setEiSaving(false)
  }

  async function triggerEiSync() {
    setEiSyncing(true)
    setEiSyncResult(null)
    try {
      const res = await fetch('/api/email/intelligence-sync', {
        method: 'POST',
        credentials: 'include',
      })
      const data = await res.json()
      if (data.ok && data.data) {
        setEiSyncResult({ emailsProcessed: data.data.emailsProcessed, contactsCreated: data.data.contactsCreated })
        setEiEmailsProcessed(prev => prev + data.data.emailsProcessed)
        setEiContactsCreated(prev => prev + data.data.contactsCreated)
        setEiLastSync(new Date().toISOString())
        setEiSyncStatus(data.data.errors?.length > 0 ? 'error' : 'success')
        if (data.data.errors?.length > 0) {
          setEiSyncError(data.data.errors.join('; '))
        } else {
          setEiSyncError(null)
        }
      } else {
        setEiSyncStatus('error')
        setEiSyncError(data.error || 'Sync failed')
      }
    } catch {
      setEiSyncStatus('error')
      setEiSyncError('Network error during sync')
    }
    setEiSyncing(false)
  }

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h1 className="text-lg font-semibold mb-6">Settings</h1>

      {saved && (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 dark:bg-emerald-900/20 dark:border-emerald-800 px-4 py-2 text-sm text-emerald-700 dark:text-emerald-400 flex items-center gap-2">
          <Check className="size-4" /> Settings saved. Reloading...
        </div>
      )}

      {/* Appearance */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Monitor className="size-4 text-muted-foreground" /> Appearance
        </h2>
        <div className="rounded-lg border divide-y">
          <div className="flex items-center justify-between px-4 py-3">
            <div>
              <p className="text-sm font-medium">Theme</p>
              <p className="text-xs text-muted-foreground">Switch between light and dark mode</p>
            </div>
            <button type="button" onClick={toggleTheme}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium hover:bg-muted/50 transition">
              {theme === 'dark' ? <Moon className="size-3.5" /> : <Sun className="size-3.5" />}
              {theme === 'dark' ? 'Dark' : 'Light'}
            </button>
          </div>
          <div className="flex items-center justify-between px-4 py-3">
            <div>
              <p className="text-sm font-medium">Interface Mode</p>
              <p className="text-xs text-muted-foreground">Simple mode shows essential features only. Advanced shows everything.</p>
            </div>
            <div className="flex gap-1.5">
              <button type="button" onClick={() => changeMode('simple')}
                className="px-3 py-1.5 rounded-lg border text-xs font-medium transition"
                style={mode === 'simple' ? { borderColor: '#3B82F6', backgroundColor: '#EFF6FF', color: '#2563EB', boxShadow: '0 0 0 1px rgba(59,130,246,0.3)' } : undefined}>
                Simple</button>
              <button type="button" onClick={() => changeMode('advanced')}
                className="px-3 py-1.5 rounded-lg border text-xs font-medium transition"
                style={mode === 'advanced' ? { borderColor: '#3B82F6', backgroundColor: '#EFF6FF', color: '#2563EB', boxShadow: '0 0 0 1px rgba(59,130,246,0.3)' } : undefined}>
                Advanced</button>
            </div>
          </div>
        </div>
      </section>

      {/* Team Management */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <UsersIcon className="size-4 text-muted-foreground" /> Team
          <span className="text-xs font-normal text-muted-foreground ml-auto">
            {teamSeats.used} of {teamSeats.max} seats used
          </span>
        </h2>
        <div className="rounded-lg border divide-y">
          {/* Invite form - only for owner/admin */}
          {(currentUserRole === 'owner' || currentUserRole === 'admin') && (
            <div className="px-4 py-3">
              <div className="flex gap-2">
                <Input value={inviteEmail} onChange={e => { setInviteEmail(e.target.value); setInviteError(''); setInviteSuccess('') }}
                  placeholder="Email address" type="email" className="flex-1 h-9 text-sm" />
                <select value={inviteRole} onChange={e => setInviteRole(e.target.value)}
                  className="rounded-md border bg-background px-3 py-1.5 text-sm h-9">
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
                <Button type="button" size="sm" className="h-9 shrink-0" onClick={sendInvite} disabled={inviting || !inviteEmail.trim()}>
                  {inviting ? 'Sending...' : 'Send Invite'}
                </Button>
              </div>
              {inviteError && <p className="text-xs text-red-500 mt-2">{inviteError}</p>}
              {inviteSuccess && <p className="text-xs text-emerald-600 mt-2">{inviteSuccess}</p>}
            </div>
          )}

          {/* Active members */}
          {teamMembers.map(member => (
            <div key={member.id} className="flex items-center justify-between px-4 py-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="size-8 rounded-full bg-primary/10 flex items-center justify-center text-xs font-semibold text-primary shrink-0">
                  {(member.name || member.email || '?')[0].toUpperCase()}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{member.name || member.email}</p>
                  <p className="text-xs text-muted-foreground truncate">{member.email}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium ${
                  member.is_owner ? 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400'
                  : member.role_name === 'admin' ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400'
                  : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                }`}>
                  {member.is_owner ? 'Owner' : member.role_name === 'admin' ? 'Admin' : 'Member'}
                </span>
                {(currentUserRole === 'owner' || currentUserRole === 'admin') && !member.is_owner && member.id !== teamMembers.find(m => m.is_owner)?.id && (
                  <button type="button" onClick={() => removeMember(member.id, member.name || member.email)}
                    className="text-xs text-muted-foreground hover:text-red-500 transition">Remove</button>
                )}
              </div>
            </div>
          ))}

          {/* Pending invites */}
          {teamInvites.map(invite => (
            <div key={invite.id} className="flex items-center justify-between px-4 py-3 bg-muted/30">
              <div className="min-w-0">
                <p className="text-sm text-muted-foreground truncate">{invite.email}</p>
                <p className="text-[10px] text-muted-foreground">
                  Invited as {invite.role} · expires {new Date(invite.expires_at).toLocaleDateString()}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                  Pending
                </span>
                {(currentUserRole === 'owner' || currentUserRole === 'admin') && (
                  <button type="button" onClick={() => revokeInvite(invite.id)}
                    className="text-xs text-muted-foreground hover:text-red-500 transition">Revoke</button>
                )}
              </div>
            </div>
          ))}

          {teamMembers.length === 0 && teamInvites.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground">
              No team members yet. Send an invite to get started.
            </div>
          )}
        </div>
      </section>

      {/* AI Assistant */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Sparkles className="size-4 text-muted-foreground" /> AI Assistant
        </h2>
        <div className="rounded-lg border divide-y">
          <div className="px-4 py-3">
            <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Assistant Name</label>
            <Input value={aiPersonaName} onChange={e => setAiPersonaName(e.target.value)}
              placeholder="e.g. Scout, Atlas, Sage" className="h-9 text-sm" />
          </div>
          <div className="px-4 py-3">
            <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-2">Communication Style</label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {[
                { id: 'professional', label: 'Professional & Direct', icon: Briefcase, desc: 'Sharp, efficient, data-driven' },
                { id: 'casual', label: 'Friendly & Casual', icon: Smile, desc: 'Warm, encouraging, conversational' },
                { id: 'minimal', label: 'Minimal & Efficient', icon: Minus, desc: 'Concise, no filler, just substance' },
              ].map(ps => (
                <button key={ps.id} type="button" onClick={() => setAiPersonaStyle(ps.id)}
                  className={`flex flex-col items-center gap-1.5 px-3 py-3 rounded-lg border text-center transition ${
                    aiPersonaStyle === ps.id ? 'selected-card' : 'hover:bg-muted/50 text-foreground/70 hover:text-foreground'
                  }`}>
                  <ps.icon className={`size-4 ${aiPersonaStyle === ps.id ? 'text-accent' : 'text-muted-foreground/60'}`} />
                  <span className={`text-[11px] font-medium leading-tight ${aiPersonaStyle === ps.id ? 'text-foreground' : ''}`}>{ps.label}</span>
                  <span className="text-[10px] text-muted-foreground leading-tight">{ps.desc}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="px-4 py-3">
            <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Custom Instructions <span className="normal-case font-normal">(optional)</span></label>
            <textarea value={aiCustomInstructions} onChange={e => setAiCustomInstructions(e.target.value)}
              placeholder='e.g. "Never use exclamation marks", "Always mention our money-back guarantee"'
              className="w-full rounded-md border bg-card px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring h-20 mb-2" />
          </div>
          {/* Preview */}
          <div className="px-4 py-3 bg-muted/30">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium mb-2">Preview</p>
            <div className="flex items-start gap-2">
              <div className="w-6 h-6 rounded-md bg-accent/10 flex items-center justify-center shrink-0 mt-0.5">
                <Sparkles className="size-3 text-accent" />
              </div>
              <div className="text-xs text-foreground/80 leading-relaxed">
                {aiPersonaStyle === 'professional' && (
                  <p><strong>{aiPersonaName || 'Scout'}</strong>: I've analyzed your pipeline. You have 3 deals that haven't been updated in over a week. I'd recommend following up on the Smith proposal first — it has the highest value.</p>
                )}
                {aiPersonaStyle === 'casual' && (
                  <p><strong>{aiPersonaName || 'Scout'}</strong>: Hey! Looks like you've got a few deals that could use some love. The Smith proposal is the big one — maybe shoot them a quick check-in today?</p>
                )}
                {aiPersonaStyle === 'minimal' && (
                  <p><strong>{aiPersonaName || 'Scout'}</strong>: 3 stale deals. Prioritize Smith proposal ($12k). Follow up today.</p>
                )}
              </div>
            </div>
          </div>
          <div className="px-4 py-3">
            {personaSaved && (
              <p className="text-xs text-emerald-600 dark:text-emerald-400 mb-2 flex items-center gap-1"><Check className="size-3" /> Persona saved!</p>
            )}
            <Button type="button" variant="outline" size="sm" onClick={savePersona} disabled={savingPersona}>
              {savingPersona ? 'Saving...' : 'Save AI Settings'}
            </Button>
          </div>
        </div>
      </section>

      {/* Pipeline Mode */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Kanban className="size-4 text-muted-foreground" /> Pipeline Mode
        </h2>
        <div className="rounded-lg border divide-y">
          <div className="px-4 py-3">
            <p className="text-sm font-medium mb-1">Pipeline Display</p>
            <p className="text-xs text-muted-foreground mb-3">Choose how your pipeline page works</p>
            {pipelineModeSaved && (
              <p className="text-xs text-emerald-600 dark:text-emerald-400 mb-2 flex items-center gap-1"><Check className="size-3" /> Pipeline mode saved!</p>
            )}
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => savePipelineMode('deals')}
                disabled={savingPipelineMode}
                className={`flex items-center gap-2.5 px-3 py-3 rounded-lg border text-left transition ${
                  pipelineMode === 'deals' ? 'selected-card' : 'hover:bg-muted/50 text-foreground/70 hover:text-foreground'
                }`}>
                <Kanban className={`size-4 shrink-0 ${pipelineMode === 'deals' ? 'text-accent' : 'text-muted-foreground/60'}`} />
                <div>
                  <span className={`text-xs font-medium ${pipelineMode === 'deals' ? 'text-foreground' : ''}`}>Deals (B2B)</span>
                  <p className="text-[10px] text-muted-foreground leading-tight mt-0.5">Track deals through stages</p>
                </div>
              </button>
              <button type="button" onClick={() => savePipelineMode('journey')}
                disabled={savingPipelineMode}
                className={`flex items-center gap-2.5 px-3 py-3 rounded-lg border text-left transition ${
                  pipelineMode === 'journey' ? 'selected-card' : 'hover:bg-muted/50 text-foreground/70 hover:text-foreground'
                }`}>
                <UsersIcon className={`size-4 shrink-0 ${pipelineMode === 'journey' ? 'text-accent' : 'text-muted-foreground/60'}`} />
                <div>
                  <span className={`text-xs font-medium ${pipelineMode === 'journey' ? 'text-foreground' : ''}`}>Journey (B2C)</span>
                  <p className="text-[10px] text-muted-foreground leading-tight mt-0.5">Track contacts by lifecycle</p>
                </div>
              </button>
            </div>
            <p className="text-[10px] text-muted-foreground mt-2">Switching modes does not delete any data. Your existing deals will be hidden in journey mode and vice versa.</p>
          </div>
          {/* Pipeline Stages Editor */}
          <div className="px-4 py-3">
            <p className="text-sm font-medium mb-1">Pipeline Stages</p>
            <p className="text-xs text-muted-foreground mb-3">
              {pipelineMode === 'journey' ? 'Define the lifecycle stages contacts move through' : 'Define the stages deals move through in your pipeline'}
            </p>
            {stagesSaved && (
              <p className="text-xs text-emerald-600 dark:text-emerald-400 mb-2 flex items-center gap-1"><Check className="size-3" /> Stages saved!</p>
            )}
            <div className="space-y-1.5 mb-3">
              {pipelineStages.map((stage, index) => (
                <div key={index} className="flex items-center gap-1.5 group">
                  <span className="text-[10px] text-muted-foreground w-4 text-right shrink-0">{index + 1}</span>
                  {editingStageIndex === index ? (
                    <div className="flex items-center gap-1.5 flex-1 min-w-0">
                      <Input
                        value={editingStageName}
                        onChange={e => setEditingStageName(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') saveEditStage()
                          if (e.key === 'Escape') cancelEditStage()
                        }}
                        className="h-8 text-sm flex-1"
                        autoFocus
                      />
                      <Button type="button" variant="outline" size="sm" onClick={saveEditStage} className="h-8 px-2 text-xs">Save</Button>
                      <Button type="button" variant="ghost" size="sm" onClick={cancelEditStage} className="h-8 px-2 text-xs">Cancel</Button>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2 flex-1 min-w-0 px-2.5 py-1.5 rounded-md border bg-card text-sm">
                        <span className="truncate">{stage.name}</span>
                      </div>
                      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button type="button" onClick={() => moveStage(index, -1)} disabled={index === 0 || savingStages}
                          className="p-1 rounded hover:bg-muted disabled:opacity-30" title="Move up">
                          <ChevronUp className="size-3.5 text-muted-foreground" />
                        </button>
                        <button type="button" onClick={() => moveStage(index, 1)} disabled={index === pipelineStages.length - 1 || savingStages}
                          className="p-1 rounded hover:bg-muted disabled:opacity-30" title="Move down">
                          <ChevronDown className="size-3.5 text-muted-foreground" />
                        </button>
                        <button type="button" onClick={() => startEditStage(index)} disabled={savingStages}
                          className="p-1 rounded hover:bg-muted disabled:opacity-30" title="Edit">
                          <Pencil className="size-3.5 text-muted-foreground" />
                        </button>
                        <button type="button" onClick={() => removeStage(index)} disabled={savingStages || pipelineStages.length <= 1}
                          className="p-1 rounded hover:bg-muted disabled:opacity-30" title="Delete">
                          <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
            {/* Add new stage */}
            <div className="flex items-center gap-1.5">
              <span className="w-4 shrink-0" />
              <Input
                value={newStageName}
                onChange={e => setNewStageName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addStage() }}
                placeholder="Add a new stage..."
                className="h-8 text-sm flex-1"
                disabled={savingStages}
              />
              <Button type="button" variant="outline" size="sm" onClick={addStage} disabled={savingStages || !newStageName.trim()} className="h-8 px-2.5">
                <Plus className="size-3.5" />
              </Button>
            </div>
          </div>
        </div>
      </section>


      {/* Calendar Feed */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Settings className="size-4 text-muted-foreground" /> Calendar
        </h2>
        <div className="rounded-lg border divide-y">
          {/* Google Calendar */}
          <div className="flex items-center justify-between px-4 py-3">
            <div>
              <p className="text-sm font-medium">Google Calendar</p>
              <p className="text-xs text-muted-foreground">Two-way sync with your Google Calendar</p>
              {emailConnections.some(c => c.provider === 'gmail') && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-1 flex items-center gap-1"><Check className="size-3" /> Connected via Gmail</p>
              )}
            </div>
            {!emailConnections.some(c => c.provider === 'gmail') && (
              <Button type="button" variant="outline" size="sm" onClick={() => window.location.href = '/api/calendar/google/auth?type=both'}>
                Connect
              </Button>
            )}
          </div>
          {/* Apple Calendar */}
          <div className="px-4 py-3">
            <div className="flex items-center justify-between mb-1">
              <div>
                <p className="text-sm font-medium">Apple Calendar</p>
                <p className="text-xs text-muted-foreground">Subscribe to your bookings in Apple Calendar</p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-2 mb-1">1. Copy this URL → 2. Open Apple Calendar → 3. File → New Calendar Subscription → 4. Paste & Subscribe</p>
            <div className="flex gap-2">
              <Input value={calendarFeedId ? `${window.location.origin}/api/calendar/feed/${calendarFeedId}.ics` : 'Loading...'} readOnly
                className="h-8 text-xs flex-1 font-mono" onClick={e => (e.target as HTMLInputElement).select()} />
              <Button type="button" variant="outline" size="sm" onClick={() => {
                navigator.clipboard.writeText(`${window.location.origin}/api/calendar/feed/${calendarFeedId}.ics`)
                setCalendarCopied(true); setTimeout(() => setCalendarCopied(false), 2000)
              }}>{calendarCopied ? <><Check className="size-3 mr-1" /> Copied!</> : 'Copy'}</Button>
            </div>
          </div>
          {/* Other Calendar Apps */}
          <div className="px-4 py-3">
            <div>
              <p className="text-sm font-medium">Other Calendar Apps</p>
              <p className="text-xs text-muted-foreground">Outlook desktop, Thunderbird, Fastmail, or any app that supports .ics feeds</p>
            </div>
            <p className="text-xs text-muted-foreground mt-2 mb-1">Copy the URL above and paste it into your calendar app's "Subscribe to calendar" or "Add by URL" option.</p>
          </div>
        </div>
      </section>

      {/* Business Profile */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Settings className="size-4 text-muted-foreground" /> Business Profile
        </h2>
        <div className="rounded-lg border divide-y">
          <div className="flex items-center justify-between px-4 py-3">
            <div>
              <p className="text-sm font-medium">Business Information</p>
              <p className="text-xs text-muted-foreground">Update your business name, description, offer, and other details</p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => window.location.href = '/backend/welcome'}>
              Edit
            </Button>
          </div>
        </div>
      </section>

      {/* Account */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <User className="size-4 text-muted-foreground" /> Account
        </h2>
        <div className="rounded-lg border divide-y">
          <div className="flex items-center justify-between px-4 py-3">
            <div>
              <p className="text-sm font-medium">Profile</p>
              <p className="text-xs text-muted-foreground">Update your name, email, and password</p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => window.location.href = '/backend/profile'}>
              Edit Profile
            </Button>
          </div>
        </div>
      </section>

      {/* Email */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Mail className="size-4 text-muted-foreground" /> Email
        </h2>
        <div className="rounded-lg border divide-y">
          {/* Connected email accounts */}
          {emailConnections.length > 0 && (
            emailConnections.map(conn => (
              <div key={conn.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="text-sm font-medium flex items-center gap-2">
                    {conn.email_address}
                    {conn.is_primary && <span className="text-[10px] bg-accent/10 text-accent px-1.5 py-0.5 rounded font-medium">Primary</span>}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Connected via {conn.provider === 'gmail' ? 'Gmail (OAuth)' : conn.provider === 'microsoft' ? 'Outlook (OAuth)' : conn.provider === 'smtp' ? 'Email (IMAP/SMTP)' : conn.provider}
                  </p>
                </div>
                <Button type="button" variant="outline" size="sm"
                  disabled={disconnecting === conn.id}
                  onClick={async () => {
                    if (!confirm(`Disconnect ${conn.email_address}? You will not be able to send or receive emails from this account.`)) return
                    setDisconnecting(conn.id)
                    await fetch(`/api/email/connections?id=${conn.id}`, { method: 'DELETE', credentials: 'include' })
                    setEmailConnections(prev => prev.filter(c => c.id !== conn.id))
                    setDisconnecting(null)
                  }}>
                  {disconnecting === conn.id ? 'Disconnecting...' : <><XIcon className="size-3 mr-1" /> Disconnect</>}
                </Button>
              </div>
            ))
          )}

          {/* Connect Email Account (IMAP/SMTP) */}
          {!hasSmtpConnection && (
            <div className="px-4 py-3">
              <div className="flex items-center gap-2 mb-1">
                <Server className="size-3.5 text-muted-foreground" />
                <p className="text-sm font-medium">Connect Email Account</p>
              </div>
              <p className="text-xs text-muted-foreground mb-3">
                Works with Gmail, Outlook, Yahoo, iCloud, or any email provider. Enables sending <em>and</em> inbox sync so replies appear in your CRM.
              </p>

              {smtpError && (
                <p className="text-xs text-red-600 dark:text-red-400 mb-2">{smtpError}</p>
              )}
              {smtpSuccess && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400 mb-2 flex items-center gap-1"><Check className="size-3" /> Email connected!</p>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
                <Input value={emailAddr} onChange={e => setEmailAddr(e.target.value)}
                  placeholder="your@email.com" className="h-8 text-xs" type="email" />
                <Input value={emailPassword} onChange={e => setEmailPassword(e.target.value)}
                  type="password" placeholder="App Password" className="h-8 text-xs" />
              </div>

              {/* Provider guides */}
              <div className="mb-3 space-y-1">
                <p className="text-xs font-medium text-foreground mb-2">How to get your App Password — select your provider:</p>

                {/* Gmail */}
                <div className="rounded-md border overflow-hidden">
                  <button
                    type="button"
                    className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium hover:bg-muted/50 transition-colors"
                    onClick={() => setOpenGuide(g => g === 'gmail' ? null : 'gmail')}
                  >
                    <span className="flex items-center gap-2">
                      <span className="text-base">📧</span> Gmail
                    </span>
                    <span className="text-muted-foreground">{openGuide === 'gmail' ? '▲' : '▼'}</span>
                  </button>
                  {openGuide === 'gmail' && (
                    <div className="px-3 pb-3 pt-1 text-xs text-muted-foreground space-y-1.5 bg-muted/20 border-t">
                      <p className="font-medium text-foreground">You need 2-Step Verification enabled first:</p>
                      <ol className="space-y-1 list-none">
                        <li><span className="font-medium text-foreground">1.</span> Go to <span className="font-mono bg-muted px-1 rounded">myaccount.google.com</span></li>
                        <li><span className="font-medium text-foreground">2.</span> Click <strong>Security</strong> in the left sidebar</li>
                        <li><span className="font-medium text-foreground">3.</span> Under <strong>"How you sign in to Google"</strong>, confirm <strong>2-Step Verification</strong> shows as On. If it's off, click it and follow the steps to turn it on (you'll need your phone).</li>
                        <li><span className="font-medium text-foreground">4.</span> Once 2-Step Verification is on, use the <strong>search bar at the top</strong> of myaccount.google.com and search <strong>"App Passwords"</strong> — it won't appear in the menu, search is the easiest way to find it</li>
                        <li><span className="font-medium text-foreground">5.</span> You may be asked to re-enter your Google password</li>
                        <li><span className="font-medium text-foreground">6.</span> In the <strong>App name</strong> box, type <strong>LaunchOS CRM</strong></li>
                        <li><span className="font-medium text-foreground">7.</span> Click <strong>Create</strong></li>
                        <li><span className="font-medium text-foreground">8.</span> Google shows a <strong>16-character password</strong> in a yellow box (looks like: <span className="font-mono bg-muted px-1 rounded">xxxx xxxx xxxx xxxx</span>)</li>
                        <li><span className="font-medium text-foreground">9.</span> Copy that password — <strong>you only see it once</strong></li>
                        <li><span className="font-medium text-foreground">10.</span> Paste it into the App Password field above. Spaces are fine.</li>
                      </ol>
                      <p className="text-amber-600 dark:text-amber-400 pt-1">⚠️ If you don't see App Passwords after enabling 2-Step Verification, your Google Workspace admin may have disabled it — contact them or use a personal Gmail account.</p>
                    </div>
                  )}
                </div>

                {/* Outlook */}
                <div className="rounded-md border overflow-hidden">
                  <button
                    type="button"
                    className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium hover:bg-muted/50 transition-colors"
                    onClick={() => setOpenGuide(g => g === 'outlook' ? null : 'outlook')}
                  >
                    <span className="flex items-center gap-2">
                      <span className="text-base">📨</span> Outlook / Hotmail / Microsoft 365
                    </span>
                    <span className="text-muted-foreground">{openGuide === 'outlook' ? '▲' : '▼'}</span>
                  </button>
                  {openGuide === 'outlook' && (
                    <div className="px-3 pb-3 pt-1 text-xs text-muted-foreground space-y-1.5 bg-muted/20 border-t">
                      <p className="font-medium text-foreground">You need two-step verification enabled first:</p>
                      <ol className="space-y-1 list-none">
                        <li><span className="font-medium text-foreground">1.</span> Go to <span className="font-mono bg-muted px-1 rounded">account.microsoft.com</span></li>
                        <li><span className="font-medium text-foreground">2.</span> Click <strong>Security</strong> in the top navigation</li>
                        <li><span className="font-medium text-foreground">3.</span> Click <strong>Advanced security options</strong></li>
                        <li><span className="font-medium text-foreground">4.</span> Under <strong>"Two-step verification"</strong>, make sure it's turned on. If not, click <strong>Turn on</strong> and follow the steps.</li>
                        <li><span className="font-medium text-foreground">5.</span> Scroll down to <strong>"App passwords"</strong> and click <strong>Create a new app password</strong></li>
                        <li><span className="font-medium text-foreground">6.</span> Microsoft generates a password automatically — copy it</li>
                        <li><span className="font-medium text-foreground">7.</span> Paste it into the App Password field above</li>
                      </ol>
                      <p className="text-amber-600 dark:text-amber-400 pt-1">⚠️ Microsoft 365 business accounts may have app passwords disabled by your IT admin. If you don't see the option, ask your admin or try a personal Outlook/Hotmail account.</p>
                    </div>
                  )}
                </div>

                {/* Other */}
                <div className="rounded-md border overflow-hidden">
                  <button
                    type="button"
                    className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium hover:bg-muted/50 transition-colors"
                    onClick={() => setOpenGuide(g => g === 'other' ? null : 'other')}
                  >
                    <span className="flex items-center gap-2">
                      <span className="text-base">📬</span> Yahoo, iCloud, or other providers
                    </span>
                    <span className="text-muted-foreground">{openGuide === 'other' ? '▲' : '▼'}</span>
                  </button>
                  {openGuide === 'other' && (
                    <div className="px-3 pb-3 pt-1 text-xs text-muted-foreground space-y-2 bg-muted/20 border-t">
                      <div>
                        <p className="font-medium text-foreground mb-1">Yahoo Mail:</p>
                        <ol className="space-y-1 list-none">
                          <li><span className="font-medium text-foreground">1.</span> Go to <span className="font-mono bg-muted px-1 rounded">login.yahoo.com</span> → click your name → <strong>Account Security</strong></li>
                          <li><span className="font-medium text-foreground">2.</span> Enable <strong>Two-step verification</strong> if not already on</li>
                          <li><span className="font-medium text-foreground">3.</span> Scroll to <strong>"Generate app password"</strong>, select <strong>Other App</strong>, type <strong>LaunchOS CRM</strong>, click <strong>Generate</strong></li>
                          <li><span className="font-medium text-foreground">4.</span> Copy the password shown and paste it above</li>
                        </ol>
                      </div>
                      <div>
                        <p className="font-medium text-foreground mb-1">iCloud Mail:</p>
                        <ol className="space-y-1 list-none">
                          <li><span className="font-medium text-foreground">1.</span> Go to <span className="font-mono bg-muted px-1 rounded">appleid.apple.com</span></li>
                          <li><span className="font-medium text-foreground">2.</span> Sign in → click <strong>Sign-In and Security</strong></li>
                          <li><span className="font-medium text-foreground">3.</span> Click <strong>App-Specific Passwords</strong> → <strong>Generate an app-specific password</strong></li>
                          <li><span className="font-medium text-foreground">4.</span> Enter a label like <strong>LaunchOS CRM</strong> → click <strong>Create</strong></li>
                          <li><span className="font-medium text-foreground">5.</span> Copy the password and paste it above. Use your full iCloud email (e.g. you@icloud.com).</li>
                        </ol>
                      </div>
                      <div>
                        <p className="font-medium text-foreground mb-1">Custom / business email (GoDaddy, Namecheap, Zoho, etc.):</p>
                        <p>Use your regular email password — most hosting providers support standard IMAP/SMTP without requiring an App Password. If the connection fails, check that IMAP is enabled in your email provider's settings.</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <button
                type="button"
                className="text-xs text-muted-foreground underline mb-2 block"
                onClick={() => setShowAdvanced(v => !v)}
              >
                {showAdvanced ? '▲ Hide advanced settings' : '▼ Advanced: custom server settings'}
              </button>

              {showAdvanced && (
                <div className="grid grid-cols-2 gap-2 mb-2 p-3 rounded-md bg-muted/40 border">
                  <Input value={imapHost} onChange={e => setImapHost(e.target.value)}
                    placeholder="IMAP host (auto-detected)" className="h-8 text-xs" />
                  <Input value={imapPort} onChange={e => setImapPort(e.target.value)}
                    placeholder="IMAP port (993)" className="h-8 text-xs" />
                  <Input value={smtpHost} onChange={e => setSmtpHost(e.target.value)}
                    placeholder="SMTP host (auto-detected)" className="h-8 text-xs" />
                  <Input value={smtpPort} onChange={e => setSmtpPort(e.target.value)}
                    placeholder="SMTP port (587)" className="h-8 text-xs" />
                </div>
              )}

              <Button type="button" variant="outline" size="sm" onClick={saveSmtp}
                disabled={savingSmtp || !emailAddr || !emailPassword}>
                {savingSmtp ? 'Testing connection...' : 'Connect Email'}
              </Button>
            </div>
          )}
        </div>
      </section>

      {/* Bulk Email (ESP) */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Send className="size-4 text-muted-foreground" /> Bulk Email (ESP)
        </h2>
        <div className="rounded-lg border divide-y">
          {espConnection ? (
            <div className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="text-sm font-medium flex items-center gap-2">
                  {espConnection.provider.charAt(0).toUpperCase() + espConnection.provider.slice(1)}
                  <span className="text-[10px] bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 px-1.5 py-0.5 rounded font-medium">Active</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {espConnection.default_sender_email
                    ? `Sends from: ${espConnection.default_sender_name ? `${espConnection.default_sender_name} <${espConnection.default_sender_email}>` : espConnection.default_sender_email}`
                    : espConnection.sending_domain ? `Domain: ${espConnection.sending_domain}` : 'Connected for bulk sending'}
                </p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={disconnectEsp}>
                <XIcon className="size-3 mr-1" /> Disconnect
              </Button>
            </div>
          ) : (
            <div className="px-4 py-3">
              <p className="text-sm font-medium mb-1">Connect Email Service Provider</p>
              <p className="text-xs text-muted-foreground mb-3">For bulk email campaigns. Bring your own API key.</p>

              {espError && (
                <p className="text-xs text-red-600 dark:text-red-400 mb-2">{espError}</p>
              )}
              {espSuccess && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400 mb-2 flex items-center gap-1"><Check className="size-3" /> ESP connected!</p>
              )}

              <div className="space-y-3">
                <div className="flex gap-2">
                  <select value={espProvider} onChange={e => setEspProvider(e.target.value)}
                    className="h-8 text-xs rounded-md border border-input bg-background px-2 flex-shrink-0">
                    <option value="resend">Resend</option>
                    <option value="sendgrid">SendGrid</option>
                    <option value="mailgun">Mailgun</option>
                    <option value="ses">Amazon SES</option>
                  </select>
                  <Input value={espApiKey} onChange={e => setEspApiKey(e.target.value)}
                    type="password"
                    placeholder={espProvider === 'ses' ? 'SMTP_USER:SMTP_PASS:REGION' : 'API Key'}
                    className="h-8 text-xs flex-1" />
                </div>
                {espProvider === 'mailgun' && (
                  <div>
                    <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Sending Domain</label>
                    <Input value={espDomain} onChange={e => setEspDomain(e.target.value)}
                      placeholder="e.g. mail.example.com" className="h-8 text-xs max-w-md" />
                  </div>
                )}
                <Button type="button" variant="outline" size="sm" onClick={saveEsp}
                  disabled={savingEsp || !espApiKey}>
                  {savingEsp ? 'Testing connection...' : 'Connect ESP'}
                </Button>
              </div>

              {espProvider === 'resend' && (
                <details className="text-xs text-muted-foreground mt-4">
                  <summary className="cursor-pointer font-medium hover:text-foreground transition-colors">Step-by-step: How to set up Resend</summary>
                  <div className="mt-2 ml-1 space-y-3">
                    <ol className="list-decimal list-inside space-y-1.5">
                      <li>Go to <a href="https://resend.com" target="_blank" rel="noopener noreferrer" className="text-accent underline">resend.com</a> and create a free account</li>
                      <li>Click <strong>Domains</strong> → <strong>Add Domain</strong> → enter your domain (e.g. <code className="bg-muted px-1 rounded">yourbusiness.com</code>)</li>
                      <li>Resend shows you <strong>3 DNS records</strong> to add — go to your domain registrar (GoDaddy, Namecheap, Cloudflare, etc.) and add them</li>
                      <li>Back in Resend, click <strong>Verify</strong> (usually takes 5-30 minutes)</li>
                      <li>Click <strong>API Keys</strong> → <strong>Create API Key</strong> → name it, select <strong>Full access</strong>, click <strong>Add</strong></li>
                      <li>Copy the key (starts with <code className="bg-muted px-1 rounded">re_</code>) and paste it above</li>
                      <li>Click <strong>Connect ESP</strong> — then add your sender addresses in the section below</li>
                    </ol>
                  </div>
                </details>
              )}
              {espProvider === 'sendgrid' && (
                <details className="text-xs text-muted-foreground mt-4">
                  <summary className="cursor-pointer font-medium hover:text-foreground transition-colors">Step-by-step: How to set up SendGrid</summary>
                  <ol className="list-decimal list-inside space-y-1.5 mt-2 ml-1">
                    <li>Go to <a href="https://sendgrid.com" target="_blank" rel="noopener noreferrer" className="text-accent underline">sendgrid.com</a> and log in</li>
                    <li>Go to <strong>Settings → Sender Authentication</strong> and verify your domain</li>
                    <li>Go to <strong>Settings → API Keys</strong> → <strong>Create API Key</strong></li>
                    <li>Name it, select <strong>Full Access</strong>, click <strong>Create & View</strong></li>
                    <li>Copy the key (starts with <code className="bg-muted px-1 rounded">SG.</code>) and paste it above</li>
                    <li>Click <strong>Connect ESP</strong> — then add your sender addresses below</li>
                  </ol>
                </details>
              )}
            </div>
          )}
          {/* Sender Addresses — inside the ESP card when connected */}
          {espConnection && (
            <div className="px-4 py-3 border-t">
              <p className="text-sm font-medium mb-0.5">Sender Addresses</p>
              <p className="text-xs text-muted-foreground mb-3">
                Add the email addresses you want to send from. You can use any address on your verified domain — no real mailboxes needed.
              </p>
              {senderAddresses.map(sa => (
                <div key={sa.id} className="flex items-center justify-between py-1.5">
                  <div className="flex items-center gap-2">
                    <p className="text-sm">
                      {sa.sender_name ? `${sa.sender_name} <${sa.sender_email}>` : sa.sender_email}
                    </p>
                    {sa.is_default && (
                      <span className="text-[10px] bg-accent/10 text-accent px-1.5 py-0.5 rounded font-medium">Default</span>
                    )}
                  </div>
                  <button type="button" onClick={async () => {
                    if (!confirm(`Remove ${sa.sender_email}?`)) return
                    try {
                      await fetch(`/api/email/sender-addresses?id=${sa.id}`, { method: 'DELETE', credentials: 'include' })
                      setSenderAddresses(prev => prev.filter(a => a.id !== sa.id))
                      fetch('/api/email/routing', { credentials: 'include' })
                        .then(r => r.json()).then(d => { if (d.ok && d.data) setRoutingAddresses(d.data.addresses || []) }).catch(() => {})
                    } catch {}
                  }} className="text-xs text-muted-foreground hover:text-red-600 transition">Remove</button>
                </div>
              ))}
              <div className="flex gap-2 items-end mt-2">
                <div className="flex-1">
                  <label className="text-[10px] font-medium text-muted-foreground block mb-0.5">Display Name</label>
                  <Input value={newSenderName} onChange={e => setNewSenderName(e.target.value)}
                    placeholder="e.g. The Launch Pad" className="h-8 text-xs" />
                </div>
                <div className="flex-1">
                  <label className="text-[10px] font-medium text-muted-foreground block mb-0.5">Email Address</label>
                  <Input value={newSenderEmail} onChange={e => setNewSenderEmail(e.target.value)}
                    type="email" placeholder={`e.g. hello@${espConnection.sending_domain || 'yourdomain.com'}`}
                    className="h-8 text-xs" />
                </div>
                <Button type="button" variant="outline" size="sm" disabled={addingSender || !newSenderEmail.trim()}
                  className="shrink-0"
                  onClick={async () => {
                    setAddingSender(true)
                    setSenderFeedback(null)
                    try {
                      const res = await fetch('/api/email/sender-addresses', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
                        body: JSON.stringify({ senderEmail: newSenderEmail.trim(), senderName: newSenderName.trim() || undefined, isDefault: senderAddresses.length === 0 }),
                      })
                      const data = await res.json()
                      if (data.ok) {
                        setSenderAddresses(prev => [...prev, data.data])
                        setNewSenderEmail('')
                        setNewSenderName('')
                        setSenderFeedback({ type: 'success', text: 'Sender address added!' })
                        setTimeout(() => setSenderFeedback(null), 3000)
                        fetch('/api/email/routing', { credentials: 'include' })
                          .then(r => r.json()).then(d => { if (d.ok && d.data) setRoutingAddresses(d.data.addresses || []) }).catch(() => {})
                      } else {
                        setSenderFeedback({ type: 'error', text: data.error || 'Failed to add' })
                      }
                    } catch { setSenderFeedback({ type: 'error', text: 'Failed to add sender address' }) }
                    setAddingSender(false)
                  }}>
                  {addingSender ? 'Adding...' : 'Add'}
                </Button>
              </div>
              {senderFeedback && (
                <p className={`text-[11px] mt-1.5 ${senderFeedback.type === 'success' ? 'text-emerald-600' : 'text-red-600'}`}>
                  {senderFeedback.text}
                </p>
              )}
              <details className="text-xs text-muted-foreground mt-3">
                <summary className="cursor-pointer font-medium hover:text-foreground transition-colors">What address should I use?</summary>
                <div className="mt-2 space-y-1.5">
                  <p>You can use any address on your verified domain. Common choices:</p>
                  <ul className="list-disc list-inside space-y-0.5 ml-1">
                    <li><code className="bg-muted px-1 rounded">hello@</code> — general business emails, marketing</li>
                    <li><code className="bg-muted px-1 rounded">support@</code> — transactional, confirmations</li>
                    <li><code className="bg-muted px-1 rounded">noreply@</code> — automated notifications</li>
                    <li><code className="bg-muted px-1 rounded">yourname@</code> — personal outreach</li>
                  </ul>
                  <p className="mt-1">These don&apos;t need to be real mailboxes. Your ESP handles the sending. If someone replies, it will bounce unless you&apos;ve set up email hosting for that address.</p>
                </div>
              </details>
            </div>
          )}
        </div>
      </section>

      {/* Inbox Intelligence */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Mail className="size-4 text-muted-foreground" /> Inbox Intelligence
        </h2>
        <div className="rounded-lg border divide-y">
          {/* Main toggle */}
          <div className="flex items-center justify-between px-4 py-3">
            <div>
              <p className="text-sm font-medium">Inbox Scanning</p>
              <p className="text-xs text-muted-foreground">Automatically scan connected inboxes 1-2x daily to create contacts, log emails, and update engagement</p>
            </div>
            <button
              type="button"
              onClick={() => { const next = !eiEnabled; setEiEnabled(next); saveEiSettings({ is_enabled: next }) }}
              disabled={eiSaving}
              className={`relative w-10 h-5 rounded-full transition-colors ${eiEnabled ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600'}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform shadow-sm ${eiEnabled ? 'translate-x-5' : ''}`} />
            </button>
          </div>

          {eiEnabled && (
            <>
              {/* Sub-toggles */}
              {[
                { label: 'Auto-create contacts', desc: 'Create new contacts from unknown senders', value: eiAutoCreate, key: 'auto_create_contacts', set: setEiAutoCreate },
                { label: 'Update timeline', desc: 'Log inbound emails to contact timeline', value: eiAutoTimeline, key: 'auto_update_timeline', set: setEiAutoTimeline },
                { label: 'Update engagement', desc: 'Track email engagement scores (+2 received, +4 replied)', value: eiAutoEngagement, key: 'auto_update_engagement', set: setEiAutoEngagement },
                { label: 'Auto-advance stage', desc: 'Move prospects to leads when engagement is high', value: eiAutoStage, key: 'auto_advance_stage', set: setEiAutoStage },
              ].map(item => (
                <div key={item.key} className="flex items-center justify-between px-4 py-2.5">
                  <div>
                    <p className="text-sm">{item.label}</p>
                    <p className="text-xs text-muted-foreground">{item.desc}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => { const next = !item.value; item.set(next); saveEiSettings({ [item.key]: next }) }}
                    disabled={eiSaving}
                    className={`relative w-9 h-[18px] rounded-full transition-colors ${item.value ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600'}`}
                  >
                    <span className={`absolute top-[1px] left-[1px] w-4 h-4 bg-white rounded-full transition-transform shadow-sm ${item.value ? 'translate-x-[18px]' : ''}`} />
                  </button>
                </div>
              ))}

              {/* Stats and sync */}
              <div className="px-4 py-3">
                <div className="flex items-center gap-4 mb-3">
                  <div className="text-center">
                    <p className="text-lg font-semibold">{eiEmailsProcessed}</p>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Emails Processed</p>
                  </div>
                  <div className="text-center">
                    <p className="text-lg font-semibold">{eiContactsCreated}</p>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Contacts Created</p>
                  </div>
                  <div className="flex-1" />
                  <Button type="button" variant="outline" size="sm" onClick={triggerEiSync} disabled={eiSyncing}>
                    {eiSyncing ? 'Scanning...' : 'Sync Now'}
                  </Button>
                </div>
                {eiLastSync && (
                  <p className="text-xs text-muted-foreground">
                    Last sync: {new Date(eiLastSync).toLocaleString()}
                    {eiSyncStatus === 'success' && <span className="text-emerald-600 ml-1.5"><Check className="size-3 inline" /> Success</span>}
                    {eiSyncStatus === 'error' && <span className="text-red-500 ml-1.5">Failed</span>}
                    {eiSyncStatus === 'running' && <span className="text-blue-500 ml-1.5">Running...</span>}
                  </p>
                )}
                {eiSyncResult && (
                  <p className="text-xs text-emerald-600 mt-1 flex items-center gap-1">
                    <Check className="size-3" />
                    Processed {eiSyncResult.emailsProcessed} emails, created {eiSyncResult.contactsCreated} contacts
                  </p>
                )}
                {eiSyncError && eiSyncStatus === 'error' && (
                  <p className="text-xs text-red-500 mt-1">{eiSyncError}</p>
                )}
                {!emailConnections.some(c => c.is_active) && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-2">
                    Connect an email account above to use Inbox Intelligence
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      </section>

      {/* Email Routing — only show when multiple email addresses are available */}
      {routingAddresses.length > 1 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <Send className="size-4 text-muted-foreground" /> Email Routing
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
              const filteredAddresses = purpose === 'inbox'
                ? routingAddresses.filter(a => a.can_receive)
                : routingAddresses
              const selectedAddr = current ? routingAddresses.find(a => a.id === current.provider_id) : null
              const isEsp = current?.provider_type === 'esp' || (selectedAddr && !selectedAddr.can_receive)

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
                            // Clear routing — revert to default
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
                            const res = await fetch('/api/email/routing', {
                              method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
                              body: JSON.stringify({ purpose, provider_type: pType, provider_id: pId }),
                            })
                            const data = await res.json()
                            if (data.ok) {
                              setRoutingConfig(prev => {
                                const filtered = prev.filter(r => r.purpose !== purpose)
                                return [...filtered, { purpose, provider_type: pType, provider_id: pId, from_name: null, from_address: null }]
                              })
                              setRoutingFeedback({ purpose, type: 'success', text: 'Saved' })
                              setTimeout(() => setRoutingFeedback(null), 2000)
                            } else {
                              setRoutingFeedback({ purpose, type: 'error', text: data.error || 'Failed' })
                            }
                          } catch { setRoutingFeedback({ purpose, type: 'error', text: 'Failed to save' }) }
                          setRoutingSaving(null)
                        }}
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
                    <p className={`text-[11px] mt-1 ${routingFeedback.type === 'success' ? 'text-emerald-600' : 'text-red-600'}`}>
                      {routingFeedback.text}
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* Stripe Connect */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <CreditCard className="size-4 text-muted-foreground" /> Payments (Stripe)
        </h2>
        <div className="rounded-lg border divide-y">
          {stripeConnection ? (
            <div className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="text-sm font-medium flex items-center gap-2">
                  {stripeConnection.businessName || stripeConnection.stripeAccountId}
                  <span className="text-[10px] bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 px-1.5 py-0.5 rounded font-medium">Connected</span>
                  {stripeConnection.livemode && (
                    <span className="text-[10px] bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 px-1.5 py-0.5 rounded font-medium">Live</span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  Account: {stripeConnection.stripeAccountId}
                </p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={disconnectStripe}
                disabled={disconnectingStripe}>
                {disconnectingStripe ? 'Disconnecting...' : <><XIcon className="size-3 mr-1" /> Disconnect</>}
              </Button>
            </div>
          ) : (
            <div className="px-4 py-3">
              <p className="text-sm font-medium mb-1">Connect Stripe Account</p>
              <p className="text-xs text-muted-foreground mb-3">Accept payments through your own Stripe account via Stripe Connect</p>
              {new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '').get('stripe_connected') === 'true' && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400 mb-2 flex items-center gap-1"><Check className="size-3" /> Stripe connected successfully!</p>
              )}
              {new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '').get('stripe_error') && (
                <p className="text-xs text-red-600 dark:text-red-400 mb-2">
                  Failed to connect Stripe: {new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '').get('stripe_error')}
                </p>
              )}
              <Button type="button" variant="outline" size="sm"
                onClick={() => window.location.href = '/api/payments/stripe/connect-oauth'}>
                Connect Stripe
              </Button>
            </div>
          )}
          {/* Terms & Conditions URL */}
          <div className="px-4 py-3">
            <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Terms & Conditions URL</label>
            <p className="text-xs text-muted-foreground mb-2">If set, customers must agree to your terms before completing payment</p>
            <div className="flex gap-2">
              <Input value={termsUrl} onChange={e => setTermsUrl(e.target.value)}
                placeholder="https://yoursite.com/terms" className="h-9 text-sm flex-1" />
              <Button type="button" variant="outline" size="sm" disabled={savingTerms} onClick={async () => {
                setSavingTerms(true)
                setTermsSaved(false)
                try {
                  await fetch('/api/customers/business-profile', {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
                    body: JSON.stringify({ termsUrl: termsUrl.trim() || '' }),
                  })
                  setTermsSaved(true)
                  setTimeout(() => setTermsSaved(false), 3000)
                } catch {}
                setSavingTerms(false)
              }}>
                {savingTerms ? 'Saving...' : 'Save'}
              </Button>
            </div>
            {termsSaved && (
              <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-1.5 flex items-center gap-1"><Check className="size-3" /> Saved!</p>
            )}
          </div>
        </div>
      </section>

      {/* Twilio SMS */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Phone className="size-4 text-muted-foreground" /> SMS (Twilio)
        </h2>
        <div className="rounded-lg border divide-y">
          {twilioConnection ? (
            <div className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="text-sm font-medium flex items-center gap-2">
                  {twilioConnection.phoneNumber}
                  <span className="text-[10px] bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 px-1.5 py-0.5 rounded font-medium">Connected</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  Account: {twilioConnection.accountSid}
                </p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={disconnectTwilio}
                disabled={disconnectingTwilio}>
                {disconnectingTwilio ? 'Disconnecting...' : <><XIcon className="size-3 mr-1" /> Disconnect</>}
              </Button>
            </div>
          ) : (
            <div className="px-4 py-3">
              <p className="text-sm font-medium mb-1">Connect Twilio Account</p>
              <p className="text-xs text-muted-foreground mb-3">Send and receive SMS using your own Twilio account</p>

              {twilioError && (
                <p className="text-xs text-red-600 dark:text-red-400 mb-2">{twilioError}</p>
              )}
              {twilioSuccess && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400 mb-2 flex items-center gap-1"><Check className="size-3" /> Twilio connected!</p>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
                <Input value={twilioSid} onChange={e => setTwilioSid(e.target.value)}
                  placeholder="Account SID" className="h-8 text-xs" />
                <Input value={twilioToken} onChange={e => setTwilioToken(e.target.value)}
                  type="password" placeholder="Auth Token" className="h-8 text-xs" />
              </div>
              <div className="flex gap-2">
                <Input value={twilioPhone} onChange={e => setTwilioPhone(e.target.value)}
                  placeholder="Phone Number (+1234567890)" className="h-8 text-xs flex-1" />
                <Button type="button" variant="outline" size="sm" onClick={saveTwilio}
                  disabled={savingTwilio || !twilioSid || !twilioToken || !twilioPhone}>
                  {savingTwilio ? 'Testing...' : 'Save & Test'}
                </Button>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Old Calendar section removed — consolidated into Calendar section above */}

      {/* API Keys */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Key className="size-4 text-muted-foreground" /> Integrations
        </h2>
        <div className="rounded-lg border divide-y">
          <div className="flex items-center justify-between px-4 py-3">
            <div>
              <p className="text-sm font-medium">API Keys</p>
              <p className="text-xs text-muted-foreground">Connect external tools like LaunchBot or Blog-Ops</p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => window.location.href = '/backend/api-keys'}>
              Manage Keys
            </Button>
          </div>
          <div className="px-4 py-3 space-y-3">
            <div>
              <p className="text-sm font-medium">AI Provider Keys</p>
              <p className="text-xs text-muted-foreground">Add your own API keys. These are used as fallback when the platform AI cap is reached, and for voice assistant TTS.</p>
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Google Gemini API Key</label>
              <div className="flex gap-2">
                <Input value={byokKey} onChange={e => setByokKey(e.target.value)}
                  type="password" placeholder={aiUsage?.hasUserKey ? '••••••••••••••••' : 'AIza...'}
                  className="h-8 text-sm flex-1" />
                <Button type="button" variant="outline" size="sm"
                  onClick={async () => {
                    setSavingKey(true)
                    await fetch('/api/ai/usage', {
                      method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
                      body: JSON.stringify({ userKey: byokKey }),
                    })
                    setByokKey('')
                    setSavingKey(false)
                    fetch('/api/ai/usage', { credentials: 'include' })
                      .then(r => r.json()).then(d => { if (d.ok) setAiUsage(d.data) })
                  }}
                  disabled={savingKey || !byokKey.trim()}>
                  {savingKey ? 'Saving...' : 'Save'}
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">Used for AI assistant, email drafts, landing page generation. Get a key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener" className="underline">aistudio.google.com</a></p>
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">OpenAI API Key</label>
              <div className="flex gap-2">
                <Input id="openai-key-input" type="password" placeholder="sk-..."
                  className="h-8 text-sm flex-1" />
                <Button type="button" variant="outline" size="sm"
                  onClick={async () => {
                    const input = document.getElementById('openai-key-input') as HTMLInputElement
                    if (!input?.value.trim()) return
                    setSavingKey(true)
                    await fetch('/api/ai/usage', {
                      method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
                      body: JSON.stringify({ openaiKey: input.value.trim() }),
                    })
                    input.value = ''
                    setSavingKey(false)
                  }}
                  disabled={savingKey}>
                  {savingKey ? 'Saving...' : 'Save'}
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">Used for voice assistant TTS. Get a key at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener" className="underline">platform.openai.com</a></p>
            </div>
          </div>
        </div>
      </section>

      {/* Knowledge Base Connection */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold mb-4 flex items-center gap-2">
          <BookOpen className="size-4 text-muted-foreground" /> Knowledge Base Connection
          {pkbConnected && <span className="text-[10px] font-medium text-emerald-600 ml-2">Connected</span>}
        </h2>
        <div className="bg-card rounded-lg border p-5">
          <p className="text-xs text-muted-foreground mb-4">Connect your Personal Knowledge Base to pull documents into AI course generation and other AI features.</p>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">PKB API Key</label>
              <Input value={pkbApiKey} onChange={(ev: any) => setPkbApiKey(ev.target.value)} placeholder="pkb_..." type="password" className="text-sm max-w-md" />
            </div>
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer font-medium hover:text-foreground transition-colors">How to get your API key</summary>
              <ol className="list-decimal list-inside space-y-1.5 mt-2 ml-1">
                <li>Go to <a href="https://kb.thelaunchpadincubator.com" target="_blank" className="text-accent underline">kb.thelaunchpadincubator.com</a> and log in</li>
                <li>Click the <strong>gear icon</strong> (Settings) in the bottom-left corner of the sidebar</li>
                <li>Navigate to the <strong>"API Keys"</strong> section</li>
                <li>Click <strong>"Create New API Key"</strong></li>
                <li>Copy the generated key (starts with <code className="bg-muted px-1 rounded">pkb_</code>)</li>
                <li>Paste it in the field above and click "Connect & Test"</li>
              </ol>
            </details>
            <Button type="button" variant="outline" size="sm" disabled={pkbTesting || !pkbApiKey.trim()} onClick={async () => {
              setPkbTesting(true)
              await fetch('/api/courses/pkb/config', { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: pkbApiKey }) })
              const res = await fetch('/api/courses/pkb/config', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' })
              const d = await res.json()
              if (d.ok) { setPkbConnected(true); setPkbDocCount(d.data.documentCount); setPkbMessage({ type: 'success', text: `Connected! Found ${d.data.documentCount} documents.` }); setTimeout(() => setPkbMessage(null), 5000) }
              else { setPkbConnected(false); setPkbMessage({ type: 'error', text: d.error || 'Connection failed. Check your API key.' }) }
              setPkbTesting(false)
            }}>
              {pkbTesting ? 'Testing...' : pkbConnected ? 'Reconnect' : 'Connect & Test'}
            </Button>
          </div>
          {pkbMessage && (
            <p className={`text-xs mt-2 px-1 ${pkbMessage.type === 'success' ? 'text-emerald-600' : 'text-red-600'}`}>
              {pkbMessage.type === 'success' && <Check className="size-3 inline mr-1" />}
              {pkbMessage.text}
            </p>
          )}
        </div>
      </section>

      {/* AMS Integration */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold mb-4 flex items-center gap-2">
          <Key className="size-4 text-muted-foreground" /> AMS Integration
          {amsKeyExists && !amsKeySecret && <span className="text-[10px] font-medium text-emerald-600 ml-2">Key Generated</span>}
        </h2>
        <div className="bg-card rounded-lg border p-5 space-y-4">
          <p className="text-xs text-muted-foreground">Generate an API key that allows the Automatic Marketing System (AMS) to connect to your CRM and sync contacts, send emails, and publish landing pages.</p>

          {/* Generated key display */}
          {amsKeySecret && (
            <div className="rounded-md border bg-muted/40 p-4 space-y-3">
              <p className="text-xs font-medium text-foreground">Your AMS API Key — copy this now</p>
              <p className="text-[11px] text-amber-600 dark:text-amber-400">This key will only be shown once. Copy it before leaving this page.</p>
              <div className="flex items-center gap-2">
                <code className="text-xs font-mono break-all flex-1 bg-background border rounded px-2 py-1.5">{amsKeySecret}</code>
                <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => {
                  navigator.clipboard.writeText(amsKeySecret)
                  setAmsKeyCopied(true)
                  setTimeout(() => setAmsKeyCopied(false), 2000)
                }}>
                  {amsKeyCopied ? <><Check className="size-3 mr-1" />Copied</> : 'Copy'}
                </Button>
              </div>
            </div>
          )}

          {/* CRM URL (always useful to show) */}
          {(amsKeySecret || amsKeyExists) && (
            <div className="rounded-md border bg-muted/40 p-4 space-y-2">
              <p className="text-xs font-medium text-foreground">Your CRM URL</p>
              <div className="flex items-center gap-2">
                <code className="text-xs font-mono flex-1 bg-background border rounded px-2 py-1.5">https://crm.thelaunchpadincubator.com</code>
                <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => {
                  navigator.clipboard.writeText('https://crm.thelaunchpadincubator.com')
                  setAmsUrlCopied(true)
                  setTimeout(() => setAmsUrlCopied(false), 2000)
                }}>
                  {amsUrlCopied ? <><Check className="size-3 mr-1" />Copied</> : 'Copy'}
                </Button>
              </div>
            </div>
          )}

          {/* Generate button */}
          <Button type="button" variant="outline" size="sm" disabled={amsKeyGenerating} onClick={async () => {
            setAmsKeyGenerating(true)
            try {
              const res = await fetch('/api/api_keys/keys', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'AMS Integration', roles: ['admin'] }),
              })
              const d = await res.json()
              if (d.secret) {
                setAmsKeySecret(d.secret)
                setAmsKeyExists(true)
              }
            } finally {
              setAmsKeyGenerating(false)
            }
          }}>
            {amsKeyGenerating ? 'Generating...' : amsKeyExists ? 'Regenerate Key' : 'Generate API Key'}
          </Button>
          {amsKeyExists && !amsKeySecret && (
            <p className="text-[11px] text-muted-foreground">A key has already been generated. Regenerating will invalidate the previous key — you will need to update it in AMS.</p>
          )}

          {/* Step-by-step instructions */}
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer font-medium text-foreground hover:opacity-80 transition-opacity">What to do with this API key</summary>
            <div className="mt-3 space-y-2 ml-1 border-l-2 border-border pl-3">
              <p className="font-medium text-foreground">After generating your key, follow these steps in AMS:</p>
              <ol className="list-decimal list-inside space-y-2">
                <li>Log in to your AMS dashboard at <strong>marketing.thelaunchpadincubator.com</strong></li>
                <li>Go to <strong>Settings</strong> (gear icon in the sidebar)</li>
                <li>Click <strong>API Keys</strong></li>
                <li>Scroll to the <strong>Launch OS (CRM)</strong> section</li>
                <li>Paste your <strong>API Key</strong> into the API Key field</li>
                <li>Paste your <strong>CRM URL</strong> (<code className="bg-muted px-1 rounded">https://crm.thelaunchpadincubator.com</code>) into the CRM URL field</li>
                <li>Click <strong>Connect</strong></li>
              </ol>
              <p className="mt-2">Once connected, AMS will be able to sync contacts, send emails through your CRM, and publish landing pages directly to your CRM.</p>
            </div>
          </details>
        </div>
      </section>

      {/* Sidebar Menu */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <LayoutDashboard className="size-4 text-muted-foreground" /> Sidebar Menu
        </h2>
        <div className="rounded-lg border divide-y">
          <div className="px-4 py-3">
            <p className="text-sm font-medium mb-0.5">Show / Hide Menu Items</p>
            <p className="text-xs text-muted-foreground">Toggle which sections appear in your sidebar. Hidden items are still accessible via direct URL. Refresh the page after making changes.</p>
          </div>
          {[
            { href: '/backend/contacts', label: 'Contacts' },
            { href: '/backend/customers/deals/pipeline', label: 'Pipeline' },
            { href: '/backend/payments', label: 'Payments' },
            { href: '/backend/calendar', label: 'Calendar' },
            { href: '/backend/automations-v2', label: 'Automations' },
            { href: '/backend/chat', label: 'Chat' },
            { href: '/backend/affiliates', label: 'Affiliates' },
            { href: '/backend/forms', label: 'Forms' },
            { href: '/backend/landing-pages', label: 'Landing Pages' },
            { href: '/backend/funnels', label: 'Funnels' },
            { href: '/backend/inbox', label: 'Inbox' },
            { href: '/backend/courses', label: 'Courses' },
            { href: '/backend/sequences', label: 'Sequences' },
            { href: '/backend/surveys', label: 'Surveys' },
            { href: '/backend/my-events', label: 'Events' },
          ].map(item => (
            <div key={item.href} className="flex items-center justify-between px-4 py-2.5">
              <span className="text-sm">{item.label}</span>
              <button type="button" onClick={() => toggleSidebarItem(item.href)}
                className={`p-1 rounded transition-colors ${hiddenSidebar.includes(item.href) ? 'text-muted-foreground/40 hover:text-foreground' : 'text-emerald-500 hover:text-emerald-600'}`}
                title={hiddenSidebar.includes(item.href) ? 'Show in sidebar' : 'Hide from sidebar'}>
                {hiddenSidebar.includes(item.href) ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* AI Usage — hidden until monitoring/caps are implemented */}
    </div>
  )
}
