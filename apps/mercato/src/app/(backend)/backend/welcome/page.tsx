'use client'

import { useState } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { ArrowRight, ArrowLeft, Sparkles, Check, Loader2, FileText, Users, Kanban, Plus, Trash2, GripVertical, Target, Briefcase, ShoppingBag, Monitor, Wrench, GraduationCap, Heart, Home, Lightbulb, Globe, Megaphone, UserPlus, Search, CalendarDays, Presentation, PenTool } from 'lucide-react'

type Step = 0 | 1 | 2 | 3 | 4

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
  const [loadingPipeline, setLoadingPipeline] = useState(false)
  const [finishing, setFinishing] = useState(false)

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
    setTimeout(() => { window.location.href = '/backend/dashboards' }, 1000)
  }

  const steps = [
    { title: 'About Your Business', subtitle: 'Help us set up your CRM the right way.' },
    { title: 'Your Offer & Clients', subtitle: 'So we can tailor everything to your business.' },
    { title: 'How You Get Clients', subtitle: 'This helps us suggest the right tools and workflows.' },
    { title: 'Your Sales Pipeline', subtitle: 'AI will suggest stages to track your deals.' },
    { title: 'You\'re All Set!', subtitle: 'Your CRM is configured and ready.' },
  ]

  const canAdvance = [
    businessName.trim() && businessType,
    mainOffer.trim(),
    true, // sources are optional
    pipelineStages.length >= 2,
    true,
  ]

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
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-2">What type of business?</label>
              <div className="grid grid-cols-3 gap-2">
                {businessTypes.map(bt => (
                  <button key={bt.id} type="button" onClick={() => setBusinessType(bt.id)}
                    className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg border text-left transition text-sm ${
                      businessType === bt.id ? 'border-accent bg-accent/5' : 'hover:bg-muted/50 text-foreground/70 hover:text-foreground'
                    }`}>
                    <bt.icon className={`size-4 shrink-0 ${businessType === bt.id ? 'text-accent' : 'text-muted-foreground/60'}`} />
                    <span className={`text-xs leading-tight ${businessType === bt.id ? 'text-foreground' : ''}`}>{bt.label}</span>
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
                      teamSize === ts.id ? 'border-accent bg-accent/5 text-foreground' : 'text-foreground/60 hover:bg-muted/50 hover:text-foreground'
                    }`}>{ts.label}</button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Step 1: Offer & Clients */}
        {step === 1 && (
          <div className="space-y-5">
            <Field label="What's your main offer?" value={mainOffer} onChange={setMainOffer}
              placeholder="e.g. 1-on-1 coaching for startup founders, Website design packages, Online fitness program" textarea autoFocus />
            <Field label="Who are your ideal clients?" value={idealClients} onChange={setIdealClients}
              placeholder="e.g. First-time entrepreneurs aged 25-40 who need help launching their business" textarea />
          </div>
        )}

        {/* Step 2: Client Sources */}
        {step === 2 && (
          <div className="space-y-5">
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-2">How do you find clients? <span className="normal-case font-normal">(select all that apply)</span></label>
              <div className="grid grid-cols-2 gap-2">
                {clientSources.map(cs => (
                  <button key={cs.id} type="button" onClick={() => toggleSource(cs.id)}
                    className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg border text-sm text-left transition ${
                      selectedSources.includes(cs.id) ? 'border-accent bg-accent/5' : 'hover:bg-muted/50 text-foreground/70 hover:text-foreground'
                    }`}>
                    <cs.icon className={`size-4 shrink-0 ${selectedSources.includes(cs.id) ? 'text-accent' : 'text-muted-foreground/60'}`} />
                    <span className="text-xs">{cs.label}</span>
                    {selectedSources.includes(cs.id) && <Check className="size-3 text-accent ml-auto shrink-0" />}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Step 3: Pipeline */}
        {step === 3 && (
          <div className="space-y-4">
            {pipelineStages.length === 0 && !loadingPipeline && (
              <div className="text-center py-8">
                <Kanban className="size-8 mx-auto mb-3 text-muted-foreground/30" />
                <p className="text-sm text-muted-foreground mb-4">AI will suggest pipeline stages based on your business.</p>
                <Button type="button" onClick={suggestPipeline}>
                  <Sparkles className="size-3.5 mr-1.5" /> Suggest Stages
                </Button>
              </div>
            )}

            {loadingPipeline && (
              <div className="text-center py-8">
                <Loader2 className="size-6 animate-spin mx-auto mb-3 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Thinking about your pipeline...</p>
              </div>
            )}

            {pipelineStages.length > 0 && (
              <>
                <p className="text-xs text-muted-foreground">Edit, add, or remove stages. You can always change these later.</p>
                <div className="space-y-1.5">
                  {pipelineStages.map((stage, i) => (
                    <div key={i} className="flex items-center gap-2 group">
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
                <div className="flex items-center gap-3 pt-1">
                  <button type="button" onClick={addStage}
                    className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
                    <Plus className="size-3" /> Add stage
                  </button>
                  <span className="text-muted-foreground/30">|</span>
                  <button type="button" onClick={suggestPipeline}
                    className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
                    <Sparkles className="size-3" /> Regenerate
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Step 4: Done */}
        {step === 4 && (
          <div className="text-center space-y-6">
            <div className="w-14 h-14 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center mx-auto">
              <Check className="size-7 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div>
              <p className="text-base font-medium">Your CRM is ready{businessName ? `, ${businessName}` : ''}!</p>
              <p className="text-sm text-muted-foreground mt-1">Here are some things to do next:</p>
            </div>
            <div className="grid gap-2 text-left max-w-sm mx-auto">
              {[
                { href: '/backend/contacts', icon: Users, title: 'Add your first contact', desc: 'Start building your list' },
                { href: '/backend/landing-pages/create', icon: FileText, title: 'Create a landing page', desc: 'AI builds it in minutes' },
                { href: '/backend/customers/deals/pipeline', icon: Kanban, title: 'View your pipeline', desc: 'Track deals from lead to close' },
              ].map(item => (
                <a key={item.href} href={item.href}
                  className="flex items-center gap-3 px-4 py-3 rounded-lg border hover:bg-muted/50 hover:border-accent/30 transition group">
                  <item.icon className="size-4 text-muted-foreground/60 group-hover:text-accent transition shrink-0" />
                  <div>
                    <p className="text-sm font-medium">{item.title}</p>
                    <p className="text-[11px] text-muted-foreground">{item.desc}</p>
                  </div>
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Navigation */}
        <div className="flex items-center justify-between mt-8 pt-6 border-t">
          {step > 0 && step < 4 ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setStep((step - 1) as Step)}>
              <ArrowLeft className="size-3.5 mr-1" /> Back
            </Button>
          ) : <div />}

          {step < 3 && (
            <Button type="button" size="sm" onClick={() => {
              const next = (step + 1) as Step
              setStep(next)
              if (next === 3 && pipelineStages.length === 0) suggestPipeline()
            }} disabled={!canAdvance[step]}>
              Next <ArrowRight className="size-3.5 ml-1" />
            </Button>
          )}

          {step === 3 && (
            <Button type="button" size="sm" onClick={() => setStep(4)}
              disabled={pipelineStages.filter(s => s.name.trim()).length < 2}>
              Finish Setup <Check className="size-3.5 ml-1" />
            </Button>
          )}

          {step === 4 && (
            <Button type="button" size="sm" onClick={finish} disabled={finishing} className="mx-auto">
              {finishing ? <><Loader2 className="size-3.5 animate-spin mr-1.5" /> Loading...</> : 'Go to Dashboard →'}
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
