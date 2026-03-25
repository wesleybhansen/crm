'use client'

import { useState } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { ArrowRight, ArrowLeft, Sparkles, Check, Loader2, FileText, Users, Kanban } from 'lucide-react'

type Step = 0 | 1 | 2 | 3

const businessTypes = [
  { id: 'coaching', label: 'Coaching / Consulting', icon: '🎯' },
  { id: 'agency', label: 'Agency / Freelance', icon: '🏢' },
  { id: 'ecommerce', label: 'E-commerce / Products', icon: '🛍️' },
  { id: 'saas', label: 'Software / SaaS', icon: '💻' },
  { id: 'services', label: 'Professional Services', icon: '⚡' },
  { id: 'education', label: 'Education / Courses', icon: '📚' },
  { id: 'health', label: 'Health / Fitness', icon: '💪' },
  { id: 'realestate', label: 'Real Estate', icon: '🏠' },
  { id: 'other', label: 'Other', icon: '✨' },
]

const clientSources = [
  { id: 'landing-pages', label: 'Landing pages' },
  { id: 'social-media', label: 'Social media' },
  { id: 'referrals', label: 'Referrals' },
  { id: 'cold-outreach', label: 'Cold outreach' },
  { id: 'ads', label: 'Paid ads' },
  { id: 'events', label: 'Events / networking' },
  { id: 'content', label: 'Content / SEO' },
  { id: 'other', label: 'Other' },
]

export default function WelcomePage() {
  const [step, setStep] = useState<Step>(0)
  const [businessName, setBusinessName] = useState('')
  const [businessType, setBusinessType] = useState('')
  const [businessDescription, setBusinessDescription] = useState('')
  const [idealClients, setIdealClients] = useState('')
  const [selectedSources, setSelectedSources] = useState<string[]>([])
  const [pipelineStages, setPipelineStages] = useState<Array<{ name: string; order: number }>>([])
  const [loadingPipeline, setLoadingPipeline] = useState(false)
  const [finishing, setFinishing] = useState(false)

  function toggleSource(id: string) {
    setSelectedSources(prev =>
      prev.includes(id) ? prev.filter(s => s !== id) : [...prev, id]
    )
  }

  async function suggestPipeline() {
    setLoadingPipeline(true)
    try {
      const res = await fetch('/api/ai/suggest-pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ businessType, description: businessDescription }),
      })
      const data = await res.json()
      if (data.ok && data.stages) {
        setPipelineStages(data.stages)
      }
    } catch {}
    setLoadingPipeline(false)
  }

  async function finish() {
    setFinishing(true)
    // TODO: Save business profile, configure pipeline stages, store preferences
    // For now, just redirect to dashboard
    setTimeout(() => {
      window.location.href = '/backend/dashboards'
    }, 1000)
  }

  const steps = [
    { title: 'Your Business', subtitle: 'Tell us a bit about what you do.' },
    { title: 'Your Clients', subtitle: 'How do you find and serve clients?' },
    { title: 'Your Pipeline', subtitle: 'AI will suggest stages for tracking deals.' },
    { title: 'You\'re All Set', subtitle: 'Your CRM is ready to go.' },
  ]

  return (
    <div className="min-h-[calc(100vh-52px)] flex items-center justify-center p-6">
      <div className="w-full max-w-lg">
        {/* Progress dots */}
        <div className="flex items-center justify-center gap-2 mb-8">
          {steps.map((_, i) => (
            <div key={i} className={`w-2 h-2 rounded-full transition-all ${
              i === step ? 'w-6 bg-accent' : i < step ? 'bg-accent' : 'bg-border'
            }`} />
          ))}
        </div>

        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-2xl font-semibold">{steps[step].title}</h1>
          <p className="text-sm text-muted-foreground mt-1">{steps[step].subtitle}</p>
        </div>

        {/* Step 0: Business Info */}
        {step === 0 && (
          <div className="space-y-5">
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Business Name</label>
              <Input value={businessName} onChange={e => setBusinessName(e.target.value)}
                placeholder="Your business name" className="h-10" autoFocus />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-2">What type of business?</label>
              <div className="grid grid-cols-3 gap-2">
                {businessTypes.map(bt => (
                  <button key={bt.id} type="button" onClick={() => setBusinessType(bt.id)}
                    className={`p-3 rounded-lg border text-center transition text-sm ${
                      businessType === bt.id ? 'border-accent bg-accent/5 text-foreground' : 'hover:bg-muted/50 text-muted-foreground'
                    }`}>
                    <span className="text-lg block mb-1">{bt.icon}</span>
                    <span className="text-xs">{bt.label}</span>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Brief description</label>
              <textarea value={businessDescription} onChange={e => setBusinessDescription(e.target.value)}
                placeholder="What do you do? What do you offer?"
                className="w-full rounded-md border bg-card px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring h-20" />
            </div>
          </div>
        )}

        {/* Step 1: Clients */}
        {step === 1 && (
          <div className="space-y-5">
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Who are your ideal clients?</label>
              <textarea value={idealClients} onChange={e => setIdealClients(e.target.value)}
                placeholder="Describe your ideal customer — who do you serve?"
                className="w-full rounded-md border bg-card px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring h-20" autoFocus />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-2">How do you get clients?</label>
              <p className="text-xs text-muted-foreground mb-3">Select all that apply.</p>
              <div className="grid grid-cols-2 gap-2">
                {clientSources.map(cs => (
                  <button key={cs.id} type="button" onClick={() => toggleSource(cs.id)}
                    className={`px-3 py-2.5 rounded-lg border text-sm text-left transition flex items-center gap-2 ${
                      selectedSources.includes(cs.id) ? 'border-accent bg-accent/5' : 'hover:bg-muted/50 text-muted-foreground'
                    }`}>
                    {selectedSources.includes(cs.id) && <Check className="size-3.5 text-accent shrink-0" />}
                    {cs.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Step 2: Pipeline */}
        {step === 2 && (
          <div className="space-y-5">
            {pipelineStages.length === 0 && !loadingPipeline && (
              <div className="text-center py-6">
                <Kanban className="size-10 mx-auto mb-3 text-muted-foreground/30" />
                <p className="text-sm text-muted-foreground mb-4">AI will suggest pipeline stages based on your business type.</p>
                <Button type="button" onClick={suggestPipeline}>
                  <Sparkles className="size-4 mr-1.5" /> Suggest Pipeline Stages
                </Button>
              </div>
            )}

            {loadingPipeline && (
              <div className="text-center py-8">
                <Loader2 className="size-6 animate-spin mx-auto mb-3 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">AI is thinking about your pipeline...</p>
              </div>
            )}

            {pipelineStages.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground mb-3">AI suggested these stages. You can edit or reorder them later.</p>
                <div className="space-y-2">
                  {pipelineStages.map((stage, i) => (
                    <div key={i} className="flex items-center gap-3 px-4 py-2.5 rounded-lg border">
                      <div className="w-6 h-6 rounded-full bg-accent/10 text-accent flex items-center justify-center text-xs font-semibold shrink-0">
                        {i + 1}
                      </div>
                      <Input value={stage.name}
                        onChange={e => {
                          const updated = [...pipelineStages]
                          updated[i] = { ...stage, name: e.target.value }
                          setPipelineStages(updated)
                        }}
                        className="h-8 text-sm border-0 bg-transparent p-0 focus:ring-0" />
                    </div>
                  ))}
                </div>
                <button type="button" onClick={suggestPipeline} className="text-xs text-muted-foreground hover:text-foreground mt-3 flex items-center gap-1">
                  <Sparkles className="size-3" /> Regenerate suggestions
                </button>
              </div>
            )}
          </div>
        )}

        {/* Step 3: Done */}
        {step === 3 && (
          <div className="text-center space-y-6">
            <div className="w-16 h-16 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center mx-auto">
              <Check className="size-8 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div>
              <p className="text-base font-medium">Your CRM is ready, {businessName || 'there'}!</p>
              <p className="text-sm text-muted-foreground mt-2">Here's what you can do next:</p>
            </div>
            <div className="grid gap-3 text-left max-w-sm mx-auto">
              <a href="/backend/contacts" className="flex items-center gap-3 p-3 rounded-lg border hover:bg-muted/50 transition">
                <Users className="size-5 text-accent" />
                <div>
                  <p className="text-sm font-medium">Add your first contact</p>
                  <p className="text-xs text-muted-foreground">Import or manually add people you work with</p>
                </div>
              </a>
              <a href="/backend/landing-pages/create" className="flex items-center gap-3 p-3 rounded-lg border hover:bg-muted/50 transition">
                <FileText className="size-5 text-accent" />
                <div>
                  <p className="text-sm font-medium">Create a landing page</p>
                  <p className="text-xs text-muted-foreground">AI builds your page in minutes</p>
                </div>
              </a>
              <a href="/backend/customers/deals/pipeline" className="flex items-center gap-3 p-3 rounded-lg border hover:bg-muted/50 transition">
                <Kanban className="size-5 text-accent" />
                <div>
                  <p className="text-sm font-medium">Set up your pipeline</p>
                  <p className="text-xs text-muted-foreground">Track deals from lead to close</p>
                </div>
              </a>
            </div>
          </div>
        )}

        {/* Navigation */}
        <div className="flex items-center justify-between mt-8">
          {step > 0 && step < 3 ? (
            <Button type="button" variant="outline" onClick={() => setStep((step - 1) as Step)}>
              <ArrowLeft className="size-4 mr-1.5" /> Back
            </Button>
          ) : <div />}

          {step < 2 && (
            <Button type="button" onClick={() => {
              setStep((step + 1) as Step)
              if (step === 1 && pipelineStages.length === 0) suggestPipeline()
            }}
              disabled={step === 0 && !businessName.trim()}>
              Next <ArrowRight className="size-4 ml-1.5" />
            </Button>
          )}

          {step === 2 && (
            <Button type="button" onClick={() => setStep(3)}>
              Finish Setup <ArrowRight className="size-4 ml-1.5" />
            </Button>
          )}

          {step === 3 && (
            <Button type="button" onClick={finish} disabled={finishing} className="mx-auto">
              {finishing ? <><Loader2 className="size-4 animate-spin mr-1.5" /> Setting up...</> : 'Go to Dashboard →'}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
