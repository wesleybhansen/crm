'use client'

import { useState, useEffect, useCallback } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { ArrowRight, ArrowLeft, Sparkles, Check, Loader2, FileText, Users, Kanban, Plus, Trash2, GripVertical, Target, Briefcase, ShoppingBag, Monitor, Wrench, GraduationCap, Heart, Home, Lightbulb, Globe, Megaphone, UserPlus, Search, CalendarDays, Presentation, PenTool, Smile, Minus, Mail, CreditCard, MessageSquare, Link, CheckCircle2, Mic } from 'lucide-react'

type Step = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

const businessTypes = [
  { id: 'coaching', label: 'Coaching / Consulting', icon: Target },
  { id: 'agency', label: 'Agency / Freelance', icon: Briefcase },
  { id: 'ecommerce', label: 'E-commerce / Products', icon: ShoppingBag },
  { id: 'saas', label: 'Software / SaaS', icon: Monitor },
  { id: 'services', label: 'Professional Services', icon: Wrench },
  { id: 'education', label: 'Education / Courses', icon: GraduationCap },
  { id: 'health', label: 'Health / Fitness', icon: Heart },
  { id: 'realestate', label: 'Real Estate', icon: Home },
  { id: 'other', label: 'Other', icon: Lightbulb },
]

const clientSources = [
  { id: 'landing-pages', label: 'Landing pages', icon: FileText },
  { id: 'social-media', label: 'Social media', icon: Globe },
  { id: 'referrals', label: 'Referrals', icon: Users },
  { id: 'cold-outreach', label: 'Cold outreach', icon: Megaphone },
  { id: 'ads', label: 'Paid ads', icon: Target },
  { id: 'events', label: 'Events / networking', icon: CalendarDays },
  { id: 'content', label: 'Content / SEO', icon: PenTool },
  { id: 'inbound', label: 'Inbound leads', icon: UserPlus },
]

const personaStyles = [
  { id: 'professional', label: 'Professional & Direct', icon: Briefcase, description: 'Sharp, efficient, data-driven' },
  { id: 'casual', label: 'Friendly & Casual', icon: Smile, description: 'Warm, encouraging, conversational' },
  { id: 'minimal', label: 'Minimal & Efficient', icon: Minus, description: 'Concise, no filler, just substance' },
]

const SEL = {
  card: { borderColor: '#3B82F6', backgroundColor: '#EFF6FF', boxShadow: '0 0 0 1px rgba(59,130,246,0.3)' } as React.CSSProperties,
  text: { color: '#2563EB', fontWeight: 600 } as React.CSSProperties,
  icon: { color: '#2563EB' } as React.CSSProperties,
}

function SelectableCard({ selected, onClick, children, className = '' }: {
  selected: boolean; onClick: () => void; children: React.ReactNode; className?: string
}) {
  return (
    <button type="button" onClick={onClick}
      className={`rounded-lg border transition ${selected ? '' : 'hover:bg-muted/50 text-foreground/70 hover:text-foreground'} ${className}`}
      style={selected ? SEL.card : undefined}>
      {children}
    </button>
  )
}

export default function WelcomePage() {
  const [step, setStep] = useState<Step>(0)
  const [businessName, setBusinessName] = useState('')
  const [businessType, setBusinessType] = useState('')
  const [businessDescription, setBusinessDescription] = useState('')
  const [idealClients, setIdealClients] = useState('')
  const [mainOffer, setMainOffer] = useState('')
  const [selectedSources, setSelectedSources] = useState<string[]>([])
  const [teamSize, setTeamSize] = useState('solo')
  const [pipelineStages, setPipelineStages] = useState<Array<{ name: string }>>([])
  const [pipelineMode, setPipelineMode] = useState<'deals' | 'journey' | ''>('')
  const [loadingPipeline, setLoadingPipeline] = useState(false)
  const [finishing, setFinishing] = useState(false)

  // AI Persona state
  const [aiPersonaName, setAiPersonaName] = useState('Scout')
  const [aiPersonaStyle, setAiPersonaStyle] = useState('professional')
  const [aiCustomInstructions, setAiCustomInstructions] = useState('')

  // Website scan state
  const [websiteUrl, setWebsiteUrl] = useState('')
  const [scanning, setScanning] = useState(false)
  const [scanComplete, setScanComplete] = useState(false)

  // Connections state
  const [emailConnected, setEmailConnected] = useState(false)
  const [stripeConnected, setStripeConnected] = useState(false)
  const [twilioConnected, setTwilioConnected] = useState(false)
  const [emailIntakeMode, setEmailIntakeMode] = useState<'auto' | 'suggest' | 'off'>('suggest')
  const [voiceAnalyzing, setVoiceAnalyzing] = useState(false)
  const [voiceDone, setVoiceDone] = useState(false)

  const [showIcsGuide, setShowIcsGuide] = useState<'apple' | 'other' | null>(null)
  const [calendarFeedId, setCalendarFeedId] = useState('')

  // Team invite state
  const [maxSeats, setMaxSeats] = useState(1)
  const [teamInviteEmails, setTeamInviteEmails] = useState<string[]>([''])
  const [teamInviteRole, setTeamInviteRole] = useState('member')
  const [invitingSent, setInvitingSent] = useState(false)
  const hasTeamPlan = maxSeats > 1

  // Save state to sessionStorage before OAuth redirects, restore on return
  const saveState = useCallback(() => {
    const state = {
      step, businessName, businessType, businessDescription, idealClients, mainOffer,
      selectedSources, teamSize, pipelineStages, pipelineMode, aiPersonaName, aiPersonaStyle,
      aiCustomInstructions, websiteUrl, emailIntakeMode,
    }
    sessionStorage.setItem('onboarding_state', JSON.stringify(state))
  }, [step, businessName, businessType, businessDescription, idealClients, mainOffer,
    selectedSources, teamSize, pipelineStages, pipelineMode, aiPersonaName, aiPersonaStyle,
    aiCustomInstructions, websiteUrl, emailIntakeMode])

  // Restore state on mount — from sessionStorage (OAuth return) or from saved business profile (editing)
  useEffect(() => {
    // Load existing business profile from DB (for returning users editing their profile)
    fetch('/api/customers/business-profile', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (d.ok && d.data) {
          const p = d.data
          if (p.business_name && !businessName) setBusinessName(p.business_name)
          if (p.business_type && !businessType) setBusinessType(p.business_type)
          if (p.business_description && !businessDescription) setBusinessDescription(p.business_description)
          if (p.main_offer && !mainOffer) setMainOffer(p.main_offer)
          if (p.ideal_clients && !idealClients) setIdealClients(p.ideal_clients)
          if (p.team_size) setTeamSize(p.team_size)
          if (p.client_sources) {
            const sources = typeof p.client_sources === 'string' ? JSON.parse(p.client_sources) : p.client_sources
            if (Array.isArray(sources) && sources.length) setSelectedSources(sources)
          }
          if (p.pipeline_stages) {
            const stages = typeof p.pipeline_stages === 'string' ? JSON.parse(p.pipeline_stages) : p.pipeline_stages
            if (Array.isArray(stages) && stages.length) setPipelineStages(stages)
          }
          if (p.pipeline_mode) setPipelineMode(p.pipeline_mode)
          if (p.ai_persona_name) setAiPersonaName(p.ai_persona_name)
          if (p.ai_persona_style) setAiPersonaStyle(p.ai_persona_style)
          if (p.ai_custom_instructions) setAiCustomInstructions(p.ai_custom_instructions)
          if (p.website_url) setWebsiteUrl(p.website_url)
          if (p.email_intake_mode) setEmailIntakeMode(p.email_intake_mode)
        }
      })
      .catch(() => {})

    const saved = sessionStorage.getItem('onboarding_state')
    if (saved) {
      try {
        const s = JSON.parse(saved)
        if (s.step !== undefined) setStep(s.step)
        if (s.businessName) setBusinessName(s.businessName)
        if (s.businessType) setBusinessType(s.businessType)
        if (s.businessDescription) setBusinessDescription(s.businessDescription)
        if (s.idealClients) setIdealClients(s.idealClients)
        if (s.mainOffer) setMainOffer(s.mainOffer)
        if (s.selectedSources) setSelectedSources(s.selectedSources)
        if (s.teamSize) setTeamSize(s.teamSize)
        if (s.pipelineStages?.length) setPipelineStages(s.pipelineStages)
        if (s.pipelineMode) setPipelineMode(s.pipelineMode)
        if (s.aiPersonaName) setAiPersonaName(s.aiPersonaName)
        if (s.aiPersonaStyle) setAiPersonaStyle(s.aiPersonaStyle)
        if (s.aiCustomInstructions) setAiCustomInstructions(s.aiCustomInstructions)
        if (s.websiteUrl) setWebsiteUrl(s.websiteUrl)
        if (s.emailIntakeMode) setEmailIntakeMode(s.emailIntakeMode)
      } catch {}
    }
    // Check URL params for returning from OAuth
    const params = new URLSearchParams(window.location.search)
    if (params.get('email_connected') === 'true' || params.get('google_connected') === 'true') {
      setEmailConnected(true)
      // Stay on step 5 (connect accounts)
      if (saved) {
        try { const s = JSON.parse(saved); if (s.step !== undefined) setStep(s.step) } catch {}
      } else {
        setStep(5)
      }
    }
    if (params.get('stripe_connected') === 'true') {
      setStripeConnected(true)
      if (saved) {
        try { const s = JSON.parse(saved); if (s.step !== undefined) setStep(s.step) } catch {}
      } else {
        setStep(5)
      }
    }
    if (params.get('google_error')) {
      // Stay on connect step, show error
      if (saved) {
        try { const s = JSON.parse(saved); if (s.step !== undefined) setStep(s.step) } catch {}
      } else {
        setStep(5)
      }
    }
    // Also check connections and team plan
    checkConnections()
    fetch('/api/team', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.ok && d.data?.seats?.max) setMaxSeats(d.data.seats.max) })
      .catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Twilio inline setup
  const [showTwilioSetup, setShowTwilioSetup] = useState(false)
  const [twilioSid, setTwilioSid] = useState('')
  const [twilioToken, setTwilioToken] = useState('')
  const [twilioPhone, setTwilioPhone] = useState('')
  const [twilioSaving, setTwilioSaving] = useState(false)
  const [twilioError, setTwilioError] = useState('')

  async function scanWebsite() {
    if (!websiteUrl.trim()) return
    setScanning(true)
    setScanComplete(false)
    try {
      const res = await fetch('/api/ai/scan-website', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ url: websiteUrl }),
      })
      const data = await res.json()
      if (data.ok && data.data) {
        const d = data.data
        if (d.businessName && !businessName) setBusinessName(d.businessName)
        if (d.businessType) setBusinessType(d.businessType)
        if (d.businessDescription && !businessDescription) setBusinessDescription(d.businessDescription)
        if (d.mainOffer && !mainOffer) setMainOffer(d.mainOffer)
        if (d.idealClients && !idealClients) setIdealClients(d.idealClients)
        if (d.detectedTone) setAiPersonaStyle(d.detectedTone === 'casual' || d.detectedTone === 'playful' ? 'casual' : d.detectedTone === 'bold' ? 'professional' : 'professional')
        if (d.suggestedPipelineMode) setPipelineMode(d.suggestedPipelineMode === 'journey' ? 'journey' : 'deals')
        if (d.suggestedPipelineStages?.length >= 2) setPipelineStages(d.suggestedPipelineStages.map((s: string) => ({ name: s })))
        setScanComplete(true)
      }
    } catch {}
    setScanning(false)
  }

  function toggleSource(id: string) {
    setSelectedSources(prev =>
      prev.includes(id) ? prev.filter(s => s !== id) : [...prev, id]
    )
  }

  function updateStage(index: number, name: string) {
    setPipelineStages(prev => prev.map((s, i) => i === index ? { name } : s))
  }

  function removeStage(index: number) {
    setPipelineStages(prev => prev.filter((_, i) => i !== index))
  }

  function addStage() {
    setPipelineStages(prev => [...prev, { name: '' }])
  }

  async function suggestPipeline() {
    setLoadingPipeline(true)
    try {
      const res = await fetch('/api/ai/suggest-pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ businessType, description: `${businessDescription}. Main offer: ${mainOffer}. Ideal clients: ${idealClients}` }),
      })
      const data = await res.json()
      if (data.ok && data.stages) {
        setPipelineStages(data.stages.map((s: any) => ({ name: s.name })))
      }
    } catch {}
    setLoadingPipeline(false)
  }

  async function finish() {
    setFinishing(true)

    const validStages = pipelineStages.filter(s => s.name.trim())

    // Save business profile including persona
    try {
      await fetch('/api/customers/business-profile', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({
          businessName, businessType, businessDescription, mainOffer,
          idealClients, teamSize, clientSources: selectedSources,
          pipelineStages: validStages,
          pipelineMode: pipelineMode || 'deals',
          aiPersonaName: aiPersonaName.trim() || 'Scout',
          aiPersonaStyle,
          aiCustomInstructions: aiCustomInstructions.trim() || undefined,
          websiteUrl: websiteUrl.trim() || undefined,
          emailIntakeMode,
          onboardingComplete: true,
        }),
      })
    } catch {}

    // Create actual pipeline stages in the CRM
    // First try to update existing default pipeline, then create stages
    if (validStages.length >= 2) {
      try {
        // Get existing pipeline
        const pipelineRes = await fetch('/api/customers/pipelines', { credentials: 'include' })
        const pipelineData = await pipelineRes.json()
        const pipelines = Array.isArray(pipelineData.data) ? pipelineData.data : pipelineData.data?.items || []
        const defaultPipeline = pipelines.find((p: any) => p.is_default) || pipelines[0]

        if (defaultPipeline) {
          // Delete existing stages and recreate with user's custom stages
          // Use the pipeline-stages reorder endpoint to update them
          const stagesRes = await fetch(`/api/customers/pipeline-stages?pipelineId=${defaultPipeline.id}`, { credentials: 'include' })
          const stagesData = await stagesRes.json()
          const existingStages = Array.isArray(stagesData.data) ? stagesData.data : stagesData.data?.items || []

          // Update existing stages to match user's choices
          for (let i = 0; i < validStages.length; i++) {
            if (i < existingStages.length) {
              // Update existing stage
              await fetch(`/api/customers/pipeline-stages`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
                body: JSON.stringify({ id: existingStages[i].id, name: validStages[i].name, order: i + 1 }),
              }).catch(() => {})
            }
            // Note: creating new stages via API may need different approach depending on the API
          }
        }
      } catch (err) {
        console.log('[onboarding] Pipeline stage setup failed (non-blocking):', err)
      }
    }

    setFinishing(false)
  }

  const baseSteps = [
    { title: 'About Your Business', subtitle: 'Help us set up Launch OS the right way.' },
    { title: 'Your AI Assistant', subtitle: 'Give your AI helper a name and personality.' },
    { title: 'Your Offer & Clients', subtitle: 'So we can tailor everything to your business.' },
    { title: 'How You Get Clients', subtitle: 'This helps us suggest the right tools and workflows.' },
    { title: pipelineMode === 'journey' ? 'Customer Journey' : 'Your Sales Pipeline', subtitle: 'AI will suggest stages to track your progress.' },
    { title: 'Launch OS is Ready!', subtitle: `${aiPersonaName || 'Scout'} is set up and ready to help you grow.` },
    { title: 'Connect Your Accounts', subtitle: 'Optional but recommended for the best experience.' },
    { title: 'Invite Your Team', subtitle: 'Add team members to your workspace.' },
    { title: 'Get Started', subtitle: 'Take your first actions.' },
  ]
  // Skip the team step for solo plans
  const steps = hasTeamPlan ? baseSteps : baseSteps.filter(s => s.title !== 'Invite Your Team')

  const canAdvance = [
    businessName.trim() && businessType,
    aiPersonaName.trim(),
    mainOffer.trim(),
    true, // sources are optional
    pipelineMode !== '' && pipelineStages.length >= 2,
    true,
    true,
    true,
    true,
  ]

  // Check connection status on mount + when returning from OAuth
  function checkConnections() {
    fetch('/api/email/connections', { credentials: 'include' })
      .then(r => r.json()).then(d => { if (d.ok && d.data?.length > 0) setEmailConnected(true) }).catch(() => {})
    fetch('/api/payments/stripe/connections', { credentials: 'include' })
      .then(r => r.json()).then(d => { if (d.ok && d.data?.stripeAccountId) setStripeConnected(true) }).catch(() => {})
    fetch('/api/twilio/connections', { credentials: 'include' })
      .then(r => r.json()).then(d => { if (d.ok && d.data?.phoneNumber) setTwilioConnected(true) }).catch(() => {})
    fetch('/api/auth/me', { credentials: 'include' })
      .then(r => r.json()).then(d => { if (d?.id) setCalendarFeedId(d.id) }).catch(() => {})
  }

  async function saveTwilio() {
    if (!twilioSid.trim() || !twilioToken.trim() || !twilioPhone.trim()) return
    setTwilioSaving(true)
    setTwilioError('')
    // Auto-add + prefix if missing
    let phone = twilioPhone.trim()
    if (!phone.startsWith('+')) phone = '+' + phone
    try {
      const res = await fetch('/api/twilio/connections', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ accountSid: twilioSid.trim(), authToken: twilioToken.trim(), phoneNumber: phone }),
      })
      const data = await res.json()
      if (data.ok) { setTwilioConnected(true); setShowTwilioSetup(false) }
      else setTwilioError(data.error || 'Failed to connect. Check your credentials and try again.')
    } catch { setTwilioError('Connection failed. Check your internet connection.') }
    setTwilioSaving(false)
  }

  return (
    <div className="min-h-[calc(100vh-52px)] flex items-center justify-center p-6">
      <div className="w-full max-w-xl">
        {/* Progress */}
        <div className="flex items-center justify-center gap-1.5 mb-8">
          {steps.map((_, i) => (
            <div key={i} className={`h-1 rounded-full transition-all ${
              i === step ? 'w-8 bg-accent' : i < step ? 'w-4 bg-accent/40' : 'w-4 bg-border'
            }`} />
          ))}
        </div>

        {/* Header */}
        <div className="text-center mb-6">
          <h1 className="text-xl font-semibold">{steps[step].title}</h1>
          <p className="text-sm text-muted-foreground mt-1">{steps[step].subtitle}</p>
        </div>

        {/* Step 0: Business Info */}
        {step === 0 && (
          <div className="space-y-5">
            <Field label="Business Name" value={businessName} onChange={setBusinessName}
              placeholder="e.g. Acme Coaching" autoFocus />
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Website URL (optional)</label>
              <p className="text-xs text-muted-foreground mb-2">We'll scan your website to auto-fill your business details, colors, and services.</p>
              <div className="flex gap-2">
                <Input value={websiteUrl} onChange={e => { setWebsiteUrl(e.target.value); setScanComplete(false) }}
                  placeholder="https://yourbusiness.com" className="h-9 text-sm flex-1" />
                <Button type="button" size="sm" onClick={scanWebsite}
                  disabled={scanning || !websiteUrl.trim()} className="shrink-0 h-9">
                  {scanning ? <><Loader2 className="size-3.5 animate-spin mr-1.5" /> Scanning...</>
                    : <><Search className="size-3.5 mr-1.5" /> Scan My Website</>}
                </Button>
              </div>
              {scanComplete && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-1.5 flex items-center gap-1">
                  <Check className="size-3" /> Found your business info! Review and edit below.
                </p>
              )}
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-2">What type of business?</label>
              <div className="grid grid-cols-3 gap-2">
                {businessTypes.map(bt => (
                  <button key={bt.id} type="button" onClick={() => setBusinessType(bt.id)}
                    className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg border text-left transition text-sm ${
                      businessType === bt.id ? '' : 'hover:bg-muted/50 text-foreground/70 hover:text-foreground'
                    }`}
                    style={businessType === bt.id ? { borderColor: '#3B82F6', backgroundColor: '#EFF6FF', boxShadow: '0 0 0 1px rgba(59,130,246,0.3)' } : undefined}>
                    <bt.icon className="size-4 shrink-0" style={{ color: businessType === bt.id ? '#2563EB' : undefined }} />
                    <span className="text-xs leading-tight" style={businessType === bt.id ? { color: '#2563EB', fontWeight: 600 } : undefined}>{bt.label}</span>
                  </button>
                ))}
              </div>
            </div>
            <Field label="Brief description of your business" value={businessDescription} onChange={setBusinessDescription}
              placeholder="What do you do? What makes you different?" textarea />
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-2">Team size</label>
              <div className="flex gap-2">
                {[
                  { id: 'solo', label: 'Just me' },
                  { id: '2-5', label: '2-5 people' },
                  { id: '6-20', label: '6-20 people' },
                  { id: '20+', label: '20+' },
                ].map(ts => (
                  <button key={ts.id} type="button" onClick={() => setTeamSize(ts.id)}
                    className={`flex-1 px-3 py-2 rounded-lg border text-xs font-medium transition ${
                      teamSize === ts.id ? '' : 'text-foreground/60 hover:bg-muted/50 hover:text-foreground'
                    }`}
                    style={teamSize === ts.id ? SEL.card : undefined}>{ts.label}</button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Step 1: AI Persona */}
        {step === 1 && (
          <div className="space-y-5">
            <Field label="Name your AI assistant" value={aiPersonaName} onChange={setAiPersonaName}
              placeholder="e.g. Scout, Atlas, Sage" autoFocus />
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-2">Communication style</label>
              <div className="grid grid-cols-3 gap-2">
                {personaStyles.map(ps => (
                  <button key={ps.id} type="button" onClick={() => setAiPersonaStyle(ps.id)}
                    className={`flex flex-col items-center gap-2 px-3 py-4 rounded-lg border text-center transition ${
                      aiPersonaStyle === ps.id ? '' : 'hover:bg-muted/50 text-foreground/70 hover:text-foreground'
                    }`}
                    style={aiPersonaStyle === ps.id ? SEL.card : undefined}>
                    <ps.icon className="size-5" style={aiPersonaStyle === ps.id ? SEL.icon : { color: 'var(--muted-foreground)' }} />
                    <span className="text-xs font-medium leading-tight" style={aiPersonaStyle === ps.id ? SEL.text : undefined}>{ps.label}</span>
                    <span className="text-[10px] text-muted-foreground leading-tight">{ps.description}</span>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Any special instructions? <span className="normal-case font-normal">(optional)</span></label>
              <textarea value={aiCustomInstructions} onChange={e => setAiCustomInstructions(e.target.value)}
                placeholder='e.g. "Never use exclamation marks", "Always mention our money-back guarantee", "Keep responses under 2 sentences"'
                className="w-full rounded-md border bg-card px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring h-20" />
            </div>
            {/* Live preview */}
            <div className="rounded-lg border bg-muted/30 p-3">
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
          </div>
        )}

        {/* Step 2: Offer & Clients */}
        {step === 2 && (
          <div className="space-y-5">
            <Field label="What's your main offer?" value={mainOffer} onChange={setMainOffer}
              placeholder="e.g. 1-on-1 coaching for startup founders, Website design packages, Online fitness program" textarea autoFocus />
            <Field label="Who are your ideal clients?" value={idealClients} onChange={setIdealClients}
              placeholder="e.g. First-time entrepreneurs aged 25-40 who need help launching their business" textarea />
          </div>
        )}

        {/* Step 3: Client Sources */}
        {step === 3 && (
          <div className="space-y-5">
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-2">How do you find clients? <span className="normal-case font-normal">(select all that apply)</span></label>
              <div className="grid grid-cols-2 gap-2">
                {clientSources.map(cs => (
                  <button key={cs.id} type="button" onClick={() => toggleSource(cs.id)}
                    className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg border text-sm text-left transition ${
                      selectedSources.includes(cs.id) ? '' : 'hover:bg-muted/50 text-foreground/70 hover:text-foreground'
                    }`}
                    style={selectedSources.includes(cs.id) ? SEL.card : undefined}>
                    <cs.icon className="size-4 shrink-0" style={selectedSources.includes(cs.id) ? SEL.icon : { color: 'var(--muted-foreground)' }} />
                    <span className="text-xs" style={selectedSources.includes(cs.id) ? SEL.text : undefined}>{cs.label}</span>
                    {selectedSources.includes(cs.id) && <Check className="size-3 ml-auto shrink-0" style={{ color: '#2563EB' }} />}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Step 4: Pipeline */}
        {step === 4 && (
          <div className="space-y-4">
            {/* Pipeline Mode Selection */}
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-2">How do your customers buy?</label>
              <div className="grid grid-cols-2 gap-3">
                <button type="button" onClick={() => {
                  setPipelineMode('deals')
                  if (pipelineStages.length === 0) suggestPipeline()
                }}
                  className={`flex flex-col items-center gap-2 px-4 py-4 rounded-lg border text-center transition ${
                    pipelineMode === 'deals' ? '' : 'hover:bg-muted/50 text-foreground/70 hover:text-foreground'
                  }`}
                  style={pipelineMode === 'deals' ? SEL.card : undefined}>
                  <Kanban className="size-6" style={pipelineMode === 'deals' ? SEL.icon : { color: 'var(--muted-foreground)' }} />
                  <span className="text-sm font-medium" style={pipelineMode === 'deals' ? SEL.text : undefined}>Sales Process</span>
                  <span className="text-[11px] text-muted-foreground leading-tight">Proposals, negotiations, contracts</span>
                </button>
                <button type="button" onClick={() => {
                  setPipelineMode('journey')
                  setPipelineStages([
                    { name: 'Prospect' }, { name: 'First Contact' },
                    { name: 'Customer' }, { name: 'Repeat' }, { name: 'VIP' },
                  ])
                }}
                  className={`flex flex-col items-center gap-2 px-4 py-4 rounded-lg border text-center transition ${
                    pipelineMode === 'journey' ? '' : 'hover:bg-muted/50 text-foreground/70 hover:text-foreground'
                  }`}
                  style={pipelineMode === 'journey' ? SEL.card : undefined}>
                  <Users className="size-6" style={pipelineMode === 'journey' ? SEL.icon : { color: 'var(--muted-foreground)' }} />
                  <span className="text-sm font-medium" style={pipelineMode === 'journey' ? SEL.text : undefined}>Direct Purchase</span>
                  <span className="text-[11px] text-muted-foreground leading-tight">Customers buy directly, sign up, or walk in</span>
                </button>
              </div>
            </div>

            {/* Stages section */}
            {pipelineMode && (
              <>
                <div className="border-t pt-4">
                  <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-2">
                    {pipelineMode === 'journey' ? 'Lifecycle Stages' : 'Pipeline Stages'}
                  </label>
                </div>

                {pipelineStages.length === 0 && !loadingPipeline && (
                  <div className="text-center py-6">
                    <Kanban className="size-8 mx-auto mb-3 text-muted-foreground/30" />
                    <p className="text-sm text-muted-foreground mb-4">AI will suggest stages based on your business.</p>
                    <Button type="button" onClick={suggestPipeline}>
                      <Sparkles className="size-3.5 mr-1.5" /> Suggest Stages
                    </Button>
                  </div>
                )}

                {loadingPipeline && (
                  <div className="text-center py-6">
                    <Loader2 className="size-6 animate-spin mx-auto mb-3 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">Thinking about your pipeline...</p>
                  </div>
                )}

                {pipelineStages.length > 0 && (
                  <>
                    <p className="text-xs text-muted-foreground">Drag to reorder. Edit, add, or remove stages. You can always change these later.</p>
                    <div className="space-y-1.5">
                      {pipelineStages.map((stage, i) => (
                        <div key={i} className="flex items-center gap-2 group"
                          draggable
                          onDragStart={e => { e.dataTransfer.setData('text/plain', String(i)); e.dataTransfer.effectAllowed = 'move' }}
                          onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}
                          onDrop={e => {
                            e.preventDefault()
                            const fromIdx = parseInt(e.dataTransfer.getData('text/plain'))
                            if (isNaN(fromIdx) || fromIdx === i) return
                            const newStages = [...pipelineStages]
                            const [moved] = newStages.splice(fromIdx, 1)
                            newStages.splice(i, 0, moved)
                            setPipelineStages(newStages)
                          }}>
                          <GripVertical className="size-3.5 text-muted-foreground/40 cursor-grab shrink-0 hover:text-muted-foreground" />
                          <span className="w-5 text-center text-xs text-muted-foreground/60 font-medium tabular-nums shrink-0">{i + 1}</span>
                          <Input value={stage.name}
                            onChange={e => updateStage(i, e.target.value)}
                            placeholder="Stage name"
                            className="h-9 text-sm flex-1" />
                          <IconButton type="button" variant="ghost" size="sm"
                            onClick={() => removeStage(i)}
                            aria-label="Remove stage"
                            className="opacity-0 group-hover:opacity-100 transition">
                            <Trash2 className="size-3.5" />
                          </IconButton>
                        </div>
                      ))}
                    </div>
                    <div className="flex flex-col items-center gap-2 pt-3">
                      <Button type="button" variant="outline" size="sm" onClick={addStage}>
                        <Plus className="size-3.5 mr-1.5" /> Add Stage
                      </Button>
                      {pipelineMode === 'deals' && (
                        <button type="button" onClick={suggestPipeline}
                          className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
                          <Sparkles className="size-3" /> Regenerate with AI
                        </button>
                      )}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        )}

        {/* Step 5: Launch OS is Ready */}
        {step === 5 && (
          <div className="text-center space-y-6">
            <div className="w-16 h-16 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center mx-auto">
              <Check className="size-8 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div>
              <p className="text-xl font-semibold">Launch OS is ready{businessName ? `, ${businessName}` : ''}!</p>
              <p className="text-sm text-muted-foreground mt-2">{aiPersonaName || 'Scout'} is configured and ready to help you grow your business.</p>
            </div>

            {/* Setup Summary */}
            <div className="rounded-lg border bg-muted/20 p-4 text-left max-w-sm mx-auto">
              <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2">What we set up</p>
              <div className="space-y-1.5 text-xs">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="size-3 text-emerald-500 shrink-0" />
                  <span>{pipelineMode === 'journey' ? 'Customer journey' : 'Sales pipeline'} with {pipelineStages.filter(s => s.name.trim()).length} stages</span>
                </div>
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="size-3 text-emerald-500 shrink-0" />
                  <span>AI assistant "{aiPersonaName}" ({aiPersonaStyle} style)</span>
                </div>
                {websiteUrl && (
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="size-3 text-emerald-500 shrink-0" />
                    <span>Website scanned & imported</span>
                  </div>
                )}
              </div>
            </div>

            <p className="text-xs text-muted-foreground">Next, connect your email and payment accounts for the best experience.</p>
          </div>
        )}

        {/* Step 6: Connect Accounts */}
        {step === 6 && (
          <div className="space-y-3">
            {/* Gmail */}
            <div className="rounded-lg border p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${emailConnected ? 'bg-emerald-100 dark:bg-emerald-900/30' : 'bg-muted'}`}>
                    <Mail className={`size-4 ${emailConnected ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`} />
                  </div>
                  <div>
                    <p className="text-sm font-medium">Email (Gmail)</p>
                    <p className="text-xs text-muted-foreground">Send and receive emails through your Gmail account</p>
                  </div>
                </div>
                {emailConnected ? (
                  <span className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1"><CheckCircle2 className="size-3" /> Connected</span>
                ) : (
                  <Button type="button" variant="outline" size="sm" onClick={() => {
                    saveState()
                    window.location.href = '/api/calendar/google/auth?type=both&from=onboarding'
                  }}>
                    <Link className="size-3 mr-1.5" /> Connect Gmail
                  </Button>
                )}
              </div>
              {emailConnected && (
                <div className="mt-3 pt-3 border-t space-y-3">
                  <div>
                    <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-2">AI Email Intake</label>
                    <div className="grid grid-cols-3 gap-2">
                      {[
                        { id: 'auto' as const, label: 'Auto-import', desc: 'Add contacts automatically' },
                        { id: 'suggest' as const, label: 'Suggest only', desc: 'Review before adding' },
                        { id: 'off' as const, label: 'Off', desc: 'No inbox scanning' },
                      ].map(opt => (
                        <button key={opt.id} type="button" onClick={() => setEmailIntakeMode(opt.id)}
                          className={`px-3 py-2.5 rounded-lg border text-center transition ${
                            emailIntakeMode === opt.id ? '' : 'hover:bg-muted/50 text-foreground/70'
                          }`}
                          style={emailIntakeMode === opt.id ? SEL.card : undefined}>
                          <p className="text-xs font-medium" style={emailIntakeMode === opt.id ? SEL.text : undefined}>{opt.label}</p>
                          <p className="text-[10px] text-muted-foreground mt-0.5">{opt.desc}</p>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="pt-2 border-t">
                    <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-2">Brand Voice</label>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Mic className="size-4 text-amber-600" />
                        <div>
                          <p className="text-xs font-medium">Learn your writing style</p>
                          <p className="text-[10px] text-muted-foreground">AI analyzes your sent emails so drafts sound like you</p>
                        </div>
                      </div>
                      {voiceDone ? (
                        <span className="text-xs text-emerald-600 flex items-center gap-1"><CheckCircle2 className="size-3" /> Learned</span>
                      ) : (
                        <Button type="button" variant="outline" size="sm" disabled={voiceAnalyzing}
                          onClick={async () => {
                            setVoiceAnalyzing(true)
                            try {
                              const res = await fetch('/api/ai/learn-voice', {
                                method: 'POST', credentials: 'include',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ source: 'email' }),
                              })
                              const d = await res.json()
                              if (d.ok) setVoiceDone(true)
                            } catch {}
                            setVoiceAnalyzing(false)
                          }}>
                          {voiceAnalyzing ? <Loader2 className="size-3 mr-1.5 animate-spin" /> : <Sparkles className="size-3 mr-1.5" />}
                          {voiceAnalyzing ? 'Analyzing...' : 'Analyze'}
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Stripe */}
            <div className="rounded-lg border p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${stripeConnected ? 'bg-emerald-100 dark:bg-emerald-900/30' : 'bg-muted'}`}>
                    <CreditCard className={`size-4 ${stripeConnected ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`} />
                  </div>
                  <div>
                    <p className="text-sm font-medium">Payments (Stripe)</p>
                    <p className="text-xs text-muted-foreground">Accept payments from your customers</p>
                  </div>
                </div>
                {stripeConnected ? (
                  <span className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1"><CheckCircle2 className="size-3" /> Connected</span>
                ) : (
                  <Button type="button" variant="outline" size="sm" onClick={() => {
                    saveState()
                    window.location.href = '/api/payments/stripe/connect-oauth'
                  }}>
                    <Link className="size-3 mr-1.5" /> Connect Stripe
                  </Button>
                )}
              </div>
            </div>

            {/* Outlook — only show if Gmail not connected and Microsoft is configured */}
            {!emailConnected && process.env.NEXT_PUBLIC_MICROSOFT_CONFIGURED === 'true' && (
              <div className="rounded-lg border p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center">
                      <Mail className="size-4 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">Email & Calendar (Outlook)</p>
                      <p className="text-xs text-muted-foreground">Use your Outlook/Microsoft 365 account instead of Gmail</p>
                    </div>
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={() => {
                    saveState()
                    window.location.href = '/api/microsoft/auth'
                  }}>
                    <Link className="size-3 mr-1.5" /> Connect Outlook
                  </Button>
                </div>
              </div>
            )}

            {/* Calendar — .ics feed for Apple Calendar / other apps */}
            <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider pt-2">Calendar</p>
            {emailConnected && (
              <div className="rounded-lg border p-4">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
                    <CalendarDays className="size-4 text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-medium">Google Calendar</p>
                    <p className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1"><CheckCircle2 className="size-3" /> Connected with Gmail</p>
                  </div>
                </div>
              </div>
            )}
            <div className="rounded-lg border p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center">
                    <CalendarDays className="size-4 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">Apple Calendar</p>
                    <p className="text-xs text-muted-foreground">Subscribe to your bookings in Apple Calendar</p>
                  </div>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={() => setShowIcsGuide(showIcsGuide === 'apple' ? null : 'apple')}>
                  {showIcsGuide === 'apple' ? 'Hide' : 'Set Up'}
                </Button>
              </div>
              {showIcsGuide === 'apple' && (
                <div className="mt-3 pt-3 border-t">
                  <ol className="space-y-2 text-xs text-muted-foreground">
                    <li className="flex gap-2"><span className="font-semibold text-foreground shrink-0">1.</span> Copy this URL:</li>
                  </ol>
                  <div className="flex gap-2 mt-1 mb-2">
                    <Input value={calendarFeedId ? `${window.location.origin}/api/calendar/feed/${calendarFeedId}.ics` : 'Loading...'} readOnly
                      className="h-7 text-[10px] flex-1 font-mono" onClick={e => (e.target as HTMLInputElement).select()} />
                    <Button type="button" variant="outline" size="sm" className="h-7 text-[10px] px-2" onClick={() => {
                      navigator.clipboard.writeText(`${window.location.origin}/api/calendar/feed/${calendarFeedId}.ics`)
                    }}>Copy</Button>
                  </div>
                  <ol start={2} className="space-y-2 text-xs text-muted-foreground">
                    <li className="flex gap-2"><span className="font-semibold text-foreground shrink-0">2.</span> Open Apple Calendar</li>
                    <li className="flex gap-2"><span className="font-semibold text-foreground shrink-0">3.</span> Go to File → New Calendar Subscription</li>
                    <li className="flex gap-2"><span className="font-semibold text-foreground shrink-0">4.</span> Paste the URL and click Subscribe</li>
                  </ol>
                  <p className="text-[10px] text-muted-foreground/70 mt-2">Your bookings will automatically appear in Apple Calendar.</p>
                </div>
              )}
            </div>
            <div className="rounded-lg border p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center">
                    <CalendarDays className="size-4 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">Other Calendar Apps</p>
                    <p className="text-xs text-muted-foreground">Outlook desktop, Thunderbird, Fastmail, or any calendar app</p>
                  </div>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={() => setShowIcsGuide(showIcsGuide === 'other' ? null : 'other')}>
                  {showIcsGuide === 'other' ? 'Hide' : 'Set Up'}
                </Button>
              </div>
              {showIcsGuide === 'other' && (
                <div className="mt-3 pt-3 border-t">
                  <ol className="space-y-2 text-xs text-muted-foreground">
                    <li className="flex gap-2"><span className="font-semibold text-foreground shrink-0">1.</span> Copy this calendar feed URL:</li>
                  </ol>
                  <div className="flex gap-2 mt-1 mb-2">
                    <Input value={calendarFeedId ? `${window.location.origin}/api/calendar/feed/${calendarFeedId}.ics` : 'Loading...'} readOnly
                      className="h-7 text-[10px] flex-1 font-mono" onClick={e => (e.target as HTMLInputElement).select()} />
                    <Button type="button" variant="outline" size="sm" className="h-7 text-[10px] px-2" onClick={() => {
                      navigator.clipboard.writeText(`${window.location.origin}/api/calendar/feed/${calendarFeedId}.ics`)
                    }}>Copy</Button>
                  </div>
                  <ol start={2} className="space-y-2 text-xs text-muted-foreground">
                    <li className="flex gap-2"><span className="font-semibold text-foreground shrink-0">2.</span> In your calendar app, look for "Subscribe to calendar" or "Add calendar by URL"</li>
                    <li className="flex gap-2"><span className="font-semibold text-foreground shrink-0">3.</span> Paste the URL and save</li>
                  </ol>
                  <p className="text-[10px] text-muted-foreground/70 mt-2">Works with Outlook desktop, Thunderbird, Fastmail, Nextcloud, and most calendar apps that support .ics feeds.</p>
                </div>
              )}
            </div>

            <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider pt-2">SMS</p>
            {/* Twilio SMS */}
            <div className="rounded-lg border p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${twilioConnected ? 'bg-emerald-100 dark:bg-emerald-900/30' : 'bg-muted'}`}>
                    <MessageSquare className={`size-4 ${twilioConnected ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`} />
                  </div>
                  <div>
                    <p className="text-sm font-medium">SMS (Twilio)</p>
                    <p className="text-xs text-muted-foreground">Send text messages to contacts</p>
                  </div>
                </div>
                {twilioConnected ? (
                  <span className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1"><CheckCircle2 className="size-3" /> Connected</span>
                ) : (
                  <Button type="button" variant="outline" size="sm" onClick={() => setShowTwilioSetup(!showTwilioSetup)}>
                    <Link className="size-3 mr-1.5" /> Set Up
                  </Button>
                )}
              </div>
              {showTwilioSetup && !twilioConnected && (
                <div className="mt-3 pt-3 border-t space-y-3">
                  {/* Setup instructions */}
                  <details className="group">
                    <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground flex items-center gap-1">
                      <ArrowRight className="size-3 transition-transform group-open:rotate-90" />
                      How to get your Twilio credentials
                    </summary>
                    <ol className="mt-2 space-y-1.5 text-xs text-muted-foreground pl-4">
                      <li><span className="font-semibold text-foreground">1.</span> Go to <a href="https://www.twilio.com/try-twilio" target="_blank" rel="noopener" className="underline hover:text-foreground">twilio.com/try-twilio</a> and create an account</li>
                      <li><span className="font-semibold text-foreground">2.</span> On the Console dashboard, copy your <strong className="text-foreground">Account SID</strong> and <strong className="text-foreground">Auth Token</strong></li>
                      <li><span className="font-semibold text-foreground">3.</span> Go to Phone Numbers → Buy a Number → get a number (free trial includes one)</li>
                      <li><span className="font-semibold text-foreground">4.</span> Copy the phone number including country code (e.g. +18337028835)</li>
                    </ol>
                  </details>

                  {twilioError && <p className="text-xs text-red-600 dark:text-red-400 rounded bg-red-50 dark:bg-red-900/10 px-2 py-1.5">{twilioError}</p>}
                  <div>
                    <label className="text-[10px] text-muted-foreground block mb-0.5">Account SID</label>
                    <Input value={twilioSid} onChange={e => setTwilioSid(e.target.value)}
                      placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" className="h-8 text-xs font-mono" />
                  </div>
                  <div>
                    <label className="text-[10px] text-muted-foreground block mb-0.5">Auth Token</label>
                    <Input value={twilioToken} onChange={e => setTwilioToken(e.target.value)}
                      placeholder="Your auth token" type="password" className="h-8 text-xs" />
                  </div>
                  <div>
                    <label className="text-[10px] text-muted-foreground block mb-0.5">Twilio Phone Number</label>
                    <Input value={twilioPhone} onChange={e => setTwilioPhone(e.target.value)}
                      placeholder="+18337028835" className="h-8 text-xs font-mono" />
                    <p className="text-[10px] text-muted-foreground mt-0.5">Your Twilio number with country code (+ prefix added automatically)</p>
                  </div>
                  <div className="flex justify-end gap-2 pt-1">
                    <Button type="button" variant="ghost" size="sm" onClick={() => setShowTwilioSetup(false)}>Cancel</Button>
                    <Button type="button" size="sm" onClick={saveTwilio}
                      disabled={twilioSaving || !twilioSid.trim() || !twilioToken.trim() || !twilioPhone.trim()}>
                      {twilioSaving ? <><Loader2 className="size-3 animate-spin mr-1" /> Testing...</> : 'Save & Test'}
                    </Button>
                  </div>
                </div>
              )}
            </div>

            <p className="text-xs text-muted-foreground text-center">
              All connections can be managed in Settings at any time.
            </p>
          </div>
        )}

        {/* Step 7: Invite Your Team (only for team plans) */}
        {step === 7 && hasTeamPlan && (
          <div className="space-y-4 max-w-sm mx-auto">
            <p className="text-sm text-muted-foreground text-center">
              You can add up to {maxSeats - 1} team member{maxSeats > 2 ? 's' : ''}. You can always do this later in Settings.
            </p>
            {teamInviteEmails.map((email, i) => (
              <div key={i} className="flex gap-2">
                <Input
                  type="email"
                  value={email}
                  onChange={e => {
                    const updated = [...teamInviteEmails]
                    updated[i] = e.target.value
                    setTeamInviteEmails(updated)
                  }}
                  placeholder="team@example.com"
                  className="flex-1 h-9 text-sm"
                />
                {teamInviteEmails.length > 1 && (
                  <IconButton type="button" variant="ghost" size="sm" onClick={() => setTeamInviteEmails(prev => prev.filter((_, j) => j !== i))}>
                    <Trash2 className="size-3.5" />
                  </IconButton>
                )}
              </div>
            ))}
            {teamInviteEmails.length < maxSeats - 1 && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setTeamInviteEmails(prev => [...prev, ''])}>
                <Plus className="size-3.5 mr-1" /> Add another
              </Button>
            )}
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Role for invited members</label>
              <select value={teamInviteRole} onChange={e => setTeamInviteRole(e.target.value)}
                className="rounded-md border bg-background px-3 py-1.5 text-sm h-9 w-full">
                <option value="member">Member — can use the CRM</option>
                <option value="admin">Admin — can manage team and settings</option>
              </select>
            </div>
            {invitingSent && (
              <p className="text-xs text-emerald-600 text-center">Invites sent! They&apos;ll receive an email with a link to join.</p>
            )}
          </div>
        )}

        {/* Step 7 for solo plans / Step 8 for team plans: Get Started — First Actions */}
        {step === (hasTeamPlan ? 8 : 7) && (
          <div className="space-y-6">
            <div className="text-center">
              <p className="text-base font-medium">What would you like to do first?</p>
              <p className="text-sm text-muted-foreground mt-1">Pick any of these to get started, or go straight to your dashboard.</p>
            </div>
            <div className="grid gap-2 max-w-sm mx-auto">
              {[
                { href: '/backend/contacts', icon: Users, title: 'Add your first contact', desc: 'Or import from a spreadsheet' },
                { href: '/backend/landing-pages/create', icon: FileText, title: 'Create a landing page', desc: `${aiPersonaName || 'Scout'} builds it in minutes` },
                { href: '/backend/customers/deals/pipeline', icon: Kanban, title: pipelineMode === 'journey' ? 'View customer journey' : 'View your pipeline', desc: pipelineMode === 'journey' ? 'Track contacts through lifecycle stages' : 'Track deals from lead to close' },
                { href: '/backend/sequences', icon: Sparkles, title: 'Set up an automation', desc: 'Browse pre-built email sequence recipes' },
              ].map(item => (
                <a key={item.href} href={item.href} onClick={() => { sessionStorage.removeItem('onboarding_state') }}
                  className="flex items-center gap-3 px-4 py-3 rounded-lg border hover:bg-muted/50 transition group">
                  <item.icon className="size-4 text-muted-foreground/60 shrink-0" />
                  <div>
                    <p className="text-sm font-medium">{item.title}</p>
                    <p className="text-[11px] text-muted-foreground">{item.desc}</p>
                  </div>
                  <ArrowRight className="size-3.5 text-muted-foreground/30 ml-auto shrink-0" />
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Navigation */}
        <div className="flex items-center justify-between mt-8 pt-6 border-t">
          {step > 0 && step <= 4 ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setStep((step - 1) as Step)}>
              <ArrowLeft className="size-3.5 mr-1" /> Back
            </Button>
          ) : <div />}

          {step < 4 && (
            <Button type="button" size="sm" onClick={() => {
              const next = (step + 1) as Step
              setStep(next)
              if (next === 4 && !pipelineMode) {
                const journeyTypes = ['ecommerce', 'health', 'education', 'realestate']
                if (journeyTypes.includes(businessType)) {
                  setPipelineMode('journey')
                  setPipelineStages([
                    { name: 'Prospect' }, { name: 'First Contact' },
                    { name: 'Customer' }, { name: 'Repeat' }, { name: 'VIP' },
                  ])
                } else {
                  setPipelineMode('deals')
                  if (pipelineStages.length === 0) suggestPipeline()
                }
              }
            }} disabled={!canAdvance[step]}>
              Next <ArrowRight className="size-3.5 ml-1" />
            </Button>
          )}

          {step === 4 && (
            <Button type="button" size="sm" onClick={() => { finish(); setStep(5) }}
              disabled={finishing || pipelineStages.filter(s => s.name.trim()).length < 2}>
              {finishing ? <><Loader2 className="size-3.5 animate-spin mr-1.5" /> Setting up...</> : <>Finish Setup <Check className="size-3.5 ml-1" /></>}
            </Button>
          )}

          {step === 5 && (
            <div className="flex gap-2 mx-auto">
              <Button type="button" size="sm" onClick={() => { setStep(6); checkConnections() }}>
                Connect Accounts <ArrowRight className="size-3.5 ml-1" />
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setStep((hasTeamPlan ? 8 : 7) as Step)}>
                Skip
              </Button>
            </div>
          )}

          {step === 6 && (
            <Button type="button" size="sm" onClick={() => setStep(7)}>
              Continue <ArrowRight className="size-3.5 ml-1" />
            </Button>
          )}

          {step === 7 && hasTeamPlan && (
            <div className="flex gap-2 mx-auto">
              <Button type="button" size="sm" onClick={async () => {
                const validEmails = teamInviteEmails.filter(e => e.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim()))
                if (validEmails.length > 0) {
                  setInvitingSent(false)
                  for (const email of validEmails) {
                    await fetch('/api/team', {
                      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
                      body: JSON.stringify({ email: email.trim(), role: teamInviteRole }),
                    }).catch(() => {})
                  }
                  setInvitingSent(true)
                  setTimeout(() => setStep(8), 1500)
                } else {
                  setStep(8)
                }
              }}>
                {teamInviteEmails.some(e => e.trim()) ? 'Send Invites' : 'Continue'} <ArrowRight className="size-3.5 ml-1" />
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setStep(8)}>
                Skip
              </Button>
            </div>
          )}

          {step === (hasTeamPlan ? 8 : 7) && (
            <Button type="button" size="sm" onClick={() => {
              sessionStorage.removeItem('onboarding_state')
              window.location.href = '/backend/dashboards'
            }} className="mx-auto">
              Go to Dashboard →
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function Field({ label, value, onChange, placeholder, textarea, autoFocus }: {
  label: string; value: string; onChange: (v: string) => void; placeholder: string; textarea?: boolean; autoFocus?: boolean
}) {
  return (
    <div>
      <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">{label}</label>
      {textarea ? (
        <textarea value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} autoFocus={autoFocus}
          className="w-full rounded-md border bg-card px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring h-20" />
      ) : (
        <Input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} autoFocus={autoFocus} className="h-10 text-sm" />
      )}
    </div>
  )
}
