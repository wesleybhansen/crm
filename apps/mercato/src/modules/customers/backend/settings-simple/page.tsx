'use client'

import { useState, useEffect } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Settings, Monitor, Smartphone, Key, User, Moon, Sun, Check, Mail, X as XIcon, Server, Send, CreditCard, Phone, Sparkles, Briefcase, Smile, Minus, Kanban, Users as UsersIcon } from 'lucide-react'

export default function SimpleSettingsPage() {
  const [mode, setMode] = useState('simple')
  const [theme, setTheme] = useState('light')
  const [saved, setSaved] = useState(false)
  const [aiUsage, setAiUsage] = useState<{ callsUsed: number; callsCap: number; hasUserKey: boolean } | null>(null)
  const [byokKey, setByokKey] = useState('')
  const [savingKey, setSavingKey] = useState(false)
  const [emailConnections, setEmailConnections] = useState<Array<{ id: string; provider: string; email_address: string; is_primary: boolean }>>([])
  const [disconnecting, setDisconnecting] = useState<string | null>(null)

  // SMTP state
  const [smtpHost, setSmtpHost] = useState('')
  const [smtpPort, setSmtpPort] = useState('587')
  const [smtpUsername, setSmtpUsername] = useState('')
  const [smtpPassword, setSmtpPassword] = useState('')
  const [smtpFrom, setSmtpFrom] = useState('')
  const [savingSmtp, setSavingSmtp] = useState(false)
  const [smtpError, setSmtpError] = useState('')
  const [smtpSuccess, setSmtpSuccess] = useState(false)

  // ESP state
  const [espProvider, setEspProvider] = useState('resend')
  const [espApiKey, setEspApiKey] = useState('')
  const [espDomain, setEspDomain] = useState('')
  const [savingEsp, setSavingEsp] = useState(false)
  const [espError, setEspError] = useState('')
  const [espSuccess, setEspSuccess] = useState(false)
  const [espConnection, setEspConnection] = useState<{ id: string; provider: string; sending_domain: string; is_active: boolean } | null>(null)

  // Stripe Connect state
  const [stripeConnection, setStripeConnection] = useState<{ id: string; stripeAccountId: string; businessName: string | null; livemode: boolean; isActive: boolean } | null>(null)
  const [disconnectingStripe, setDisconnectingStripe] = useState(false)

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

  // Pipeline mode state
  const [pipelineMode, setPipelineMode] = useState<'deals' | 'journey'>('deals')
  const [savingPipelineMode, setSavingPipelineMode] = useState(false)
  const [pipelineModeSaved, setPipelineModeSaved] = useState(false)
  const [calendarFeedId, setCalendarFeedId] = useState('')

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
    fetch('/api/stripe/connections', { credentials: 'include' })
      .then(r => r.json()).then(d => { if (d.ok && d.data) setStripeConnection(d.data) }).catch(() => {})
    // Load Twilio connection
    fetch('/api/twilio/connections', { credentials: 'include' })
      .then(r => r.json()).then(d => { if (d.ok && d.data) setTwilioConnection(d.data) }).catch(() => {})
    // Load AI persona
    fetch('/api/business-profile', { credentials: 'include' })
      .then(r => r.json()).then(d => {
        if (d.ok && d.data) {
          if (d.data.ai_persona_name) setAiPersonaName(d.data.ai_persona_name)
          if (d.data.ai_persona_style) setAiPersonaStyle(d.data.ai_persona_style)
          if (d.data.ai_custom_instructions) setAiCustomInstructions(d.data.ai_custom_instructions)
          if (d.data.pipeline_mode) setPipelineMode(d.data.pipeline_mode)
          if (d.data.interface_mode) setMode(d.data.interface_mode)
        }
      }).catch(() => {})
    fetch('/api/auth/me', { credentials: 'include' })
      .then(r => r.json()).then(d => { if (d?.id) setCalendarFeedId(d.id) }).catch(() => {})
  }, [])

  async function changeMode(newMode: string) {
    setMode(newMode)
    // Save to database (primary) and cookie (fallback)
    await fetch('/api/business-profile', {
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
      const res = await fetch('/api/email/smtp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          host: smtpHost,
          port: Number(smtpPort),
          username: smtpUsername,
          password: smtpPassword,
          fromAddress: smtpFrom,
        }),
      })
      const data = await res.json()
      if (data.ok) {
        setSmtpSuccess(true)
        setSmtpHost('')
        setSmtpPort('587')
        setSmtpUsername('')
        setSmtpPassword('')
        setSmtpFrom('')
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
        }),
      })
      const data = await res.json()
      if (data.ok) {
        setEspSuccess(true)
        setEspApiKey('')
        setEspDomain('')
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
    try {
      await fetch(`/api/email/esp?id=${espConnection.id}`, { method: 'DELETE', credentials: 'include' })
      setEspConnection(null)
    } catch {}
  }

  async function disconnectStripe() {
    setDisconnectingStripe(true)
    try {
      await fetch('/api/stripe/connections', { method: 'DELETE', credentials: 'include' })
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
      await fetch('/api/business-profile', {
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

  async function savePipelineMode(newMode: 'deals' | 'journey') {
    setSavingPipelineMode(true)
    setPipelineModeSaved(false)
    const previousMode = pipelineMode
    setPipelineMode(newMode)
    try {
      await fetch('/api/business-profile', {
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
            <div className="grid grid-cols-3 gap-2">
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
        </div>
      </section>

      {/* Automations */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Settings className="size-4 text-muted-foreground" /> Automations
        </h2>
        <div className="rounded-lg border divide-y">
          <div className="flex items-center justify-between px-4 py-3">
            <div>
              <p className="text-sm font-medium">Pipeline Automations</p>
              <p className="text-xs text-muted-foreground">Trigger actions when deals move between stages</p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => window.location.href = '/backend/automations'}>
              Manage
            </Button>
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
              <Button type="button" variant="outline" size="sm" onClick={() => window.location.href = '/api/google/auth?type=both'}>
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
              }}>Copy</Button>
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
                    Connected via {conn.provider === 'gmail' ? 'Gmail' : conn.provider === 'microsoft' ? 'Outlook' : conn.provider === 'smtp' ? 'SMTP' : conn.provider}
                  </p>
                </div>
                <Button type="button" variant="outline" size="sm"
                  disabled={disconnecting === conn.id}
                  onClick={async () => {
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

          {/* Connect buttons */}
          <div className="px-4 py-3">
            <p className="text-sm font-medium mb-1">Connect Email Account</p>
            <p className="text-xs text-muted-foreground mb-3">Send emails from your own email account</p>
            {new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '').get('email_connected') === 'true' && (
              <p className="text-xs text-emerald-600 dark:text-emerald-400 mb-2 flex items-center gap-1"><Check className="size-3" /> Connected!</p>
            )}
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => window.location.href = '/api/google/auth?type=email'}>
                Connect Gmail
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => window.location.href = '/api/microsoft/auth'}>
                Connect Outlook
              </Button>
            </div>
          </div>

          {/* SMTP Configuration */}
          {!hasSmtpConnection && (
            <div className="px-4 py-3">
              <div className="flex items-center gap-2 mb-2">
                <Server className="size-3.5 text-muted-foreground" />
                <p className="text-sm font-medium">SMTP Connection</p>
              </div>
              <p className="text-xs text-muted-foreground mb-3">Connect any email server via SMTP</p>

              {smtpError && (
                <p className="text-xs text-red-600 dark:text-red-400 mb-2">{smtpError}</p>
              )}
              {smtpSuccess && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400 mb-2 flex items-center gap-1"><Check className="size-3" /> SMTP connected!</p>
              )}

              <div className="grid grid-cols-2 gap-2 mb-2">
                <Input value={smtpHost} onChange={e => setSmtpHost(e.target.value)}
                  placeholder="SMTP Host (e.g. smtp.example.com)" className="h-8 text-xs" />
                <Input value={smtpPort} onChange={e => setSmtpPort(e.target.value)}
                  placeholder="Port (587)" className="h-8 text-xs" />
              </div>
              <div className="grid grid-cols-2 gap-2 mb-2">
                <Input value={smtpUsername} onChange={e => setSmtpUsername(e.target.value)}
                  placeholder="Username" className="h-8 text-xs" />
                <Input value={smtpPassword} onChange={e => setSmtpPassword(e.target.value)}
                  type="password" placeholder="Password" className="h-8 text-xs" />
              </div>
              <div className="flex gap-2">
                <Input value={smtpFrom} onChange={e => setSmtpFrom(e.target.value)}
                  placeholder="From address (you@example.com)" className="h-8 text-xs flex-1" />
                <Button type="button" variant="outline" size="sm" onClick={saveSmtp}
                  disabled={savingSmtp || !smtpHost || !smtpUsername || !smtpPassword || !smtpFrom}>
                  {savingSmtp ? 'Testing...' : 'Connect SMTP'}
                </Button>
              </div>
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
                  {espConnection.sending_domain ? `Domain: ${espConnection.sending_domain}` : 'Connected for bulk sending'}
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

              <div className="flex gap-2 mb-2">
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
              {(espProvider === 'mailgun' || espProvider === 'resend') && (
                <div className="mb-2">
                  <Input value={espDomain} onChange={e => setEspDomain(e.target.value)}
                    placeholder="Sending domain (e.g. mail.example.com)"
                    className="h-8 text-xs" />
                </div>
              )}
              <Button type="button" variant="outline" size="sm" onClick={saveEsp}
                disabled={savingEsp || !espApiKey}>
                {savingEsp ? 'Testing...' : 'Connect ESP'}
              </Button>
            </div>
          )}
        </div>
      </section>

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
                onClick={() => window.location.href = '/api/stripe/connect-oauth'}>
                Connect Stripe
              </Button>
            </div>
          )}
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

              <div className="grid grid-cols-2 gap-2 mb-2">
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
          <div className="px-4 py-3">
            <div className="flex items-center justify-between mb-2">
              <div>
                <p className="text-sm font-medium">AI Provider Key (BYOK)</p>
                <p className="text-xs text-muted-foreground">Add your own API key for unlimited AI features</p>
              </div>
            </div>
            <div className="flex gap-2">
              <Input value={byokKey} onChange={e => setByokKey(e.target.value)}
                type="password" placeholder={aiUsage?.hasUserKey ? '••••••••••••••••' : 'Paste your Gemini or OpenAI API key'}
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
          </div>
        </div>
      </section>

      {/* AI Usage */}
      {aiUsage && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <Monitor className="size-4 text-muted-foreground" /> AI Usage
          </h2>
          <div className="rounded-lg border p-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-medium">This month</p>
              <p className="text-sm tabular-nums">
                <span className="font-semibold">{aiUsage.callsUsed}</span>
                <span className="text-muted-foreground"> / {aiUsage.callsCap} calls</span>
              </p>
            </div>
            <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
              <div className="h-full rounded-full bg-accent transition-all"
                style={{ width: `${Math.min(100, (aiUsage.callsUsed / aiUsage.callsCap) * 100)}%` }} />
            </div>
            {aiUsage.callsUsed >= aiUsage.callsCap && !aiUsage.hasUserKey && (
              <p className="text-xs text-amber-600 dark:text-amber-400 mt-2">
                Limit reached. Add your own API key above to continue using AI features.
              </p>
            )}
            {aiUsage.hasUserKey && (
              <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-2 flex items-center gap-1">
                <Check className="size-3" /> Your own API key is active. Unlimited AI usage.
              </p>
            )}
          </div>
        </section>
      )}
    </div>
  )
}
