'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { ArrowLeft, ArrowRight, Sparkles, Globe, Loader2, Eye, LayoutTemplate, Plus, Trash2, ChevronDown, ChevronRight, Check } from 'lucide-react'

type TemplateInfo = { id: string; name: string; category: string; style: string; hasForm: boolean }
type Step = 'template' | 'wizard' | 'preview'

const categoryLabels: Record<string, string> = {
  'lead-magnet': 'Lead Capture', 'booking': 'Booking & Consultation', 'webinar': 'Webinar & Events',
  'saas': 'Software & SaaS', 'services': 'Professional Services', 'physical-product': 'Physical Products',
  'info-product': 'Digital Products & Courses', 'systems': 'Systems & Frameworks', 'experiences': 'Experiences',
  'page': 'Utility Pages', 'thank-you': 'Thank You Pages',
}

const templateNames: Record<string, string> = {
  'lead-magnet-bold': 'Bold & Energetic', 'lead-magnet-dark': 'Dark & Premium', 'lead-magnet-minimal': 'Clean Minimal', 'lead-magnet-warm': 'Warm & Friendly',
  'booking-bold': 'Bold', 'booking-dark': 'Dark', 'booking-minimal': 'Minimal', 'booking-noir': 'Noir', 'booking-teal': 'Teal Accent', 'booking-warm': 'Warm',
  'webinar-bold': 'Bold', 'webinar-dark': 'Dark', 'webinar-noir': 'Noir', 'webinar-teal': 'Teal', 'webinar-warm': 'Warm',
  'saas-template-light': 'Light & Clean', 'saas-template-noir': 'Dark Noir', 'saas-terminal': 'Terminal / Dev', 'saas-vercel': 'Vercel-Inspired',
  'services-art-deco': 'Art Deco', 'services-dark-luxe': 'Dark Luxury', 'services-stripe': 'Stripe-Inspired', 'services-superhuman': 'Superhuman-Style', 'services-template-corporate': 'Corporate', 'services-template-warm': 'Warm & Approachable',
  'physical-product-apple': 'Apple-Inspired', 'physical-product-bold': 'Bold', 'physical-product-nordic': 'Nordic Minimal', 'physical-product-shopify': 'Shopify-Style', 'physical-product-warm': 'Warm',
  'info-product-editorial': 'Editorial', 'info-product-glass': 'Glassmorphism', 'info-product-gumroad': 'Gumroad-Style', 'info-product-notion': 'Notion-Style', 'info-product-pastel': 'Soft Pastel',
  'systems-brutalist': 'Brutalist', 'systems-cyberpunk': 'Cyberpunk', 'systems-figma': 'Figma-Style', 'systems-linear': 'Linear-Style', 'systems-noir': 'Noir',
  'experiences-airbnb': 'Airbnb-Style', 'experiences-editorial': 'Editorial', 'experiences-organic': 'Organic', 'experiences-pastel': 'Pastel', 'experiences-raycast': 'Raycast-Style',
  'thank-you-bold': 'Bold', 'thank-you-dark': 'Dark', 'thank-you-minimal': 'Minimal', 'thank-you-warm': 'Warm',
  'booking-classic': 'Classic', 'lead-magnet-classic': 'Classic', 'lead-magnet-waitlist': 'Waitlist', 'webinar-classic': 'Classic',
}

const defaultCtas: Record<string, string> = {
  'lead-magnet': 'Download Free Guide', 'booking': 'Book Your Free Call', 'webinar': 'Reserve Your Spot',
  'saas': 'Start Free Trial', 'services': 'Get a Free Quote', 'physical-product': 'Buy Now',
  'info-product': 'Get Instant Access', 'systems': 'Get the Framework', 'experiences': 'Book Now',
  'page': 'Get Started', 'thank-you': 'Continue',
}

const tones = [
  { id: 'professional', label: 'Professional' },
  { id: 'casual', label: 'Casual' },
  { id: 'energetic', label: 'Energetic' },
  { id: 'motivating', label: 'Motivating' },
  { id: 'luxurious', label: 'Luxurious' },
  { id: 'authoritative', label: 'Authoritative' },
  { id: 'custom', label: 'Custom' },
]

interface WizardData {
  businessName: string
  pageGoal: string
  targetAudience: string
  tone: string
  customTone: string
  additionalDetails: string
  ctaText: string
  benefits: string[]
  testimonialQuote: string
  testimonialName: string
  testimonialRole: string
  stat1Value: string
  stat1Label: string
  stat2Value: string
  stat2Label: string
  primaryColor: string
  slug: string
}

export default function CreateLandingPage() {
  const [step, setStep] = useState<Step>('template')
  const [templates, setTemplates] = useState<Record<string, TemplateInfo[]>>({})
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [wizardStep, setWizardStep] = useState(0)
  const [generating, setGenerating] = useState(false)
  const [generatedHtml, setGeneratedHtml] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [previewKey, setPreviewKey] = useState(0)
  const [revisionInput, setRevisionInput] = useState('')
  const [revising, setRevising] = useState(false)
  const [lastAiCall, setLastAiCall] = useState(0)
  const [aiError, setAiError] = useState<string | null>(null)

  const [data, setData] = useState<WizardData>({
    businessName: '', pageGoal: '', targetAudience: '', tone: 'professional', customTone: '', additionalDetails: '',
    ctaText: '', benefits: ['', '', ''], testimonialQuote: '', testimonialName: '',
    testimonialRole: '', stat1Value: '', stat1Label: '', stat2Value: '', stat2Label: '',
    primaryColor: '', slug: '',
  })

  useEffect(() => {
    fetch('/api/landing_pages/templates', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.ok) setTemplates(d.data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  function updateData(key: keyof WizardData, value: any) {
    setData(prev => {
      const next = { ...prev, [key]: value }
      if (key === 'businessName' && !prev.slug) {
        next.slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      }
      return next
    })
  }

  function updateBenefit(index: number, value: string) {
    setData(prev => {
      const benefits = [...prev.benefits]
      benefits[index] = value
      return { ...prev, benefits }
    })
  }

  function addBenefit() {
    setData(prev => ({ ...prev, benefits: [...prev.benefits, ''] }))
  }

  function removeBenefit(index: number) {
    setData(prev => ({ ...prev, benefits: prev.benefits.filter((_, i) => i !== index) }))
  }

  function selectTemplate(tmpl: TemplateInfo) {
    setSelectedTemplate(tmpl)
    setData(prev => ({
      ...prev,
      ctaText: prev.ctaText || defaultCtas[tmpl.category] || 'Get Started',
    }))
    setStep('wizard')
    setWizardStep(0)
    setGeneratedHtml(null)
  }

  async function generateWithAI() {
    if (!selectedTemplate) return

    // Rate limit: minimum 15 seconds between AI calls
    const now = Date.now()
    const elapsed = now - lastAiCall
    if (elapsed < 15000 && lastAiCall > 0) {
      const wait = Math.ceil((15000 - elapsed) / 1000)
      setAiError(`Please wait ${wait} seconds before generating again.`)
      return
    }

    setGenerating(true)
    setAiError(null)
    setLastAiCall(now)

    const messages = [
      { role: 'user' as const, content: buildPromptFromWizard() },
    ]

    try {
      const res = await fetch('/api/landing_pages/ai/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ templateId: selectedTemplate.id, templateCategory: selectedTemplate.category, messages }),
      })
      const result = await res.json()
      if (result.ok && result.html) {
        setGeneratedHtml(result.html)
        setPreviewKey(k => k + 1)
        setAiError(null)
        if (step !== 'preview') setStep('preview')
      } else {
        const errMsg = result.error || 'Generation failed'
        if (errMsg.includes('Resource exhausted') || errMsg.includes('429')) {
          setAiError('AI rate limit reached. Wait 30-60 seconds and try again. Consider upgrading to a paid Gemini plan for unlimited use.')
        } else {
          setAiError(errMsg)
        }
        if (step === 'preview' && !generatedHtml) setStep('wizard')
      }
    } catch (err: any) {
      setAiError('Network error — check your connection and try again.')
    } finally {
      setGenerating(false)
    }
  }

  function buildPromptFromWizard(): string {
    const parts = [
      `Business: ${data.businessName}`,
      `This page is for: ${data.pageGoal}`,
      `Target audience: ${data.targetAudience}`,
      `Tone: ${data.tone === 'custom' ? data.customTone || 'professional' : data.tone}`,
      `CTA button text: ${data.ctaText}`,
    ]
    const validBenefits = data.benefits.filter(b => b.trim())
    if (validBenefits.length > 0) {
      parts.push(`Key benefits/features:\n${validBenefits.map((b, i) => `${i + 1}. ${b}`).join('\n')}`)
    }
    if (data.testimonialQuote) {
      parts.push(`Testimonial: "${data.testimonialQuote}" — ${data.testimonialName || 'Customer'}, ${data.testimonialRole || 'Client'}`)
    }
    if (data.stat1Value) parts.push(`Stat: ${data.stat1Value} ${data.stat1Label}`)
    if (data.stat2Value) parts.push(`Stat: ${data.stat2Value} ${data.stat2Label}`)
    if (data.additionalDetails.trim()) parts.push(`Additional instructions: ${data.additionalDetails}`)

    return parts.join('\n')
  }

  async function publishPage() {
    if (!data.businessName || !data.slug || !selectedTemplate) return
    setSaving(true)

    try {
      const baseUrl = window.location.origin
      const formAction = `${baseUrl}/api/landing_pages/public/${data.slug}/submit`

      // Inject form handler into the generated HTML so forms capture leads into CRM
      let publishHtml = generatedHtml || ''
      publishHtml = publishHtml.replace(/onsubmit="[^"]*"/gi, '')
      const formScript = `<script>(function(){document.querySelectorAll('form').forEach(function(f){f.addEventListener('submit',function(e){e.preventDefault();var d={};new FormData(f).forEach(function(v,k){d[k]=v});var b=f.querySelector('[type="submit"]');if(b){b.disabled=true;b.textContent='Sending...';}fetch('${formAction}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:d})}).then(function(r){return r.json()}).then(function(r){if(r.ok){f.innerHTML='<div style=\"text-align:center;padding:24px\"><h3 style=\"margin-bottom:8px\">Thank you!</h3><p>'+(r.message||'We\\'ll be in touch.')+'</p></div>'}}).catch(function(){if(b){b.disabled=false;b.textContent='Try Again'}})})})})();</script>`
      publishHtml = publishHtml.replace('</body>', formScript + '\n</body>')

      // Create the page
      const cr = await fetch('/api/landing_pages/pages', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({
          title: data.businessName + (data.pageGoal ? ' — ' + data.pageGoal : ''),
          slug: data.slug,
          templateId: selectedTemplate.id,
          templateCategory: selectedTemplate.category,
          config: { wizardData: data },
        }),
      })
      const cd = await cr.json()
      if (!cd.ok) { alert(cd.error || 'Failed to create'); setSaving(false); return }

      // Publish with the AI-generated HTML + form handler injected
      await fetch(`/api/landing_pages/pages/${cd.data.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ status: 'published', publishedHtml: publishHtml }),
      })

      window.location.href = '/backend/landing-pages'
    } catch { alert('Failed to save') }
    setSaving(false)
  }

  // Wizard screens config
  const wizardScreens = [
    { title: 'The Basics', subtitle: 'Tell us about your business and this page.' },
    { title: 'Your Offer', subtitle: 'What will visitors get? Why should they care?' },
    { title: 'Social Proof', subtitle: 'Optional — add credibility with testimonials and stats.' },
  ]

  if (loading) return <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">Loading templates...</div>

  return (
    <div className="flex flex-col h-[calc(100vh-52px)]">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-6 py-3 border-b shrink-0">
        <button type="button" className="text-muted-foreground hover:text-foreground"
          onClick={() => {
            if (step === 'wizard' && wizardStep > 0) setWizardStep(s => s - 1)
            else if (step === 'wizard') setStep('template')
            else if (step === 'preview') setStep('wizard')
            else window.history.back()
          }}>
          <ArrowLeft className="size-4" />
        </button>
        <div className="flex items-center gap-3 ml-2 text-xs">
          {[
            { key: 'template', icon: LayoutTemplate, label: 'Style' },
            { key: 'wizard', icon: Sparkles, label: 'Describe' },
            { key: 'preview', icon: Eye, label: 'Publish' },
          ].map((s, i) => (
            <div key={s.key} className="flex items-center gap-2">
              {i > 0 && <ArrowRight className="size-3 text-muted-foreground/30" />}
              <span className={`flex items-center gap-1.5 font-medium ${step === s.key ? 'text-foreground' : 'text-muted-foreground/50'}`}>
                <s.icon className="size-3.5" /> {s.label}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Step 1: Template picker */}
      {step === 'template' && (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-5xl mx-auto">
            <h1 className="text-lg font-semibold mb-1">Choose a style</h1>
            <p className="text-sm text-muted-foreground mb-6">Pick the look you like. AI handles the content.</p>
            {Object.entries(templates).map(([category, items]) => (
              <div key={category} className="mb-8">
                <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">{categoryLabels[category] || category}</h2>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                  {items.map(tmpl => (
                    <button key={tmpl.id} type="button" onClick={() => selectTemplate(tmpl)}
                      className="group relative rounded-lg border overflow-hidden hover:border-ring hover:shadow-md transition text-left bg-card">
                      <div className="aspect-[4/3] bg-muted relative overflow-hidden">
                        <iframe src={`/api/landing_pages/templates/preview/${tmpl.id}`}
                          className="pointer-events-none border-0"
                          style={{ transform: 'scale(0.25)', transformOrigin: 'top left', width: '400%', height: '400%' }}
                          loading="lazy" title={templateNames[tmpl.id] || tmpl.style} />
                        <div className="absolute inset-0 bg-gradient-to-t from-background/90 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition flex items-end justify-center pb-3">
                          <span className="text-xs font-medium bg-foreground text-background px-3 py-1.5 rounded-full flex items-center gap-1.5">
                            <Sparkles className="size-3" /> Use this
                          </span>
                        </div>
                      </div>
                      <div className="px-3 py-2.5">
                        <p className="text-sm font-medium truncate">{templateNames[tmpl.id] || tmpl.style}</p>
                        <p className="text-[11px] text-muted-foreground">{categoryLabels[tmpl.category] || tmpl.category}</p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Step 2: Wizard */}
      {step === 'wizard' && selectedTemplate && (
        <div className="flex-1 flex overflow-hidden">
          {/* Left: Form */}
          <div className="w-[420px] shrink-0 border-r flex flex-col overflow-hidden">
            <div className="px-6 py-4 border-b">
              <p className="text-xs text-muted-foreground mb-1">Step {wizardStep + 1} of {wizardScreens.length}</p>
              <h2 className="text-base font-semibold">{wizardScreens[wizardStep].title}</h2>
              <p className="text-xs text-muted-foreground mt-0.5">{wizardScreens[wizardStep].subtitle}</p>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4">
              {/* Screen 1: Basics */}
              {wizardStep === 0 && (
                <div className="space-y-4 pb-4">
                  <Field label="Business Name" value={data.businessName} onChange={v => updateData('businessName', v)} placeholder="Acme Coaching" autoFocus />
                  <Field label="What's this page for?" value={data.pageGoal} onChange={v => updateData('pageGoal', v)} placeholder="Free 7-day meal plan download" textarea />
                  <Field label="Who's your target audience?" value={data.targetAudience} onChange={v => updateData('targetAudience', v)} placeholder="Busy professionals aged 30-50 who want to lose weight" textarea />
                  <div>
                    <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-2">Tone</label>
                    <div className="flex flex-wrap gap-2">
                      {tones.map(t => (
                        <button key={t.id} type="button" onClick={() => updateData('tone', t.id)}
                          className={`px-3 py-1.5 rounded-md text-xs font-medium border transition ${
                            data.tone === t.id ? 'bg-foreground text-background border-foreground' : 'border-border text-muted-foreground hover:text-foreground'
                          }`}>
                          {t.label}
                        </button>
                      ))}
                    </div>
                    {data.tone === 'custom' && (
                      <Input value={data.customTone} onChange={e => updateData('customTone', e.target.value)}
                        placeholder="Describe your tone — e.g. friendly but direct, like talking to a smart friend"
                        className="mt-2 h-9 text-sm" autoFocus />
                    )}
                  </div>
                  <Field label="URL Slug" value={data.slug} onChange={v => updateData('slug', v)} placeholder="my-landing-page" prefix="/p/" />
                </div>
              )}

              {/* Screen 2: Offer */}
              {wizardStep === 1 && (
                <div className="space-y-4 pb-4">
                  <Field label="Call-to-Action Button Text" value={data.ctaText} onChange={v => updateData('ctaText', v)} placeholder="Download Free Guide" />
                  <div>
                    <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-2">
                      Benefits / Features — what do they get?
                    </label>
                    <div className="space-y-2">
                      {data.benefits.map((b, i) => (
                        <div key={i} className="flex gap-2">
                          <Input value={b} onChange={e => updateBenefit(i, e.target.value)}
                            placeholder={`Benefit ${i + 1}`} className="flex-1 h-9 text-sm" />
                          {data.benefits.length > 1 && (
                            <IconButton type="button" variant="ghost" size="sm" onClick={() => removeBenefit(i)} aria-label="Remove">
                              <Trash2 className="size-3.5" />
                            </IconButton>
                          )}
                        </div>
                      ))}
                      {data.benefits.length < 8 && (
                        <button type="button" onClick={addBenefit}
                          className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 py-1">
                          <Plus className="size-3" /> Add another
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Screen 3: Social Proof + Additional Details */}
              {wizardStep === 2 && (
                <div className="space-y-4 pb-4">
                  <p className="text-xs text-muted-foreground">These are optional. AI can generate placeholders you edit later.</p>
                  <div className="space-y-3 rounded-lg border p-4">
                    <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block">Testimonial</label>
                    <Field label="" value={data.testimonialQuote} onChange={v => updateData('testimonialQuote', v)} placeholder="This completely changed how I approach my business..." textarea />
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="Name" value={data.testimonialName} onChange={v => updateData('testimonialName', v)} placeholder="Jane Doe" />
                      <Field label="Title" value={data.testimonialRole} onChange={v => updateData('testimonialRole', v)} placeholder="CEO, Acme Co" />
                    </div>
                  </div>
                  <div className="space-y-3 rounded-lg border p-4">
                    <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block">Stats</label>
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="Number" value={data.stat1Value} onChange={v => updateData('stat1Value', v)} placeholder="500+" />
                      <Field label="Label" value={data.stat1Label} onChange={v => updateData('stat1Label', v)} placeholder="Happy clients" />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="Number" value={data.stat2Value} onChange={v => updateData('stat2Value', v)} placeholder="4.9/5" />
                      <Field label="Label" value={data.stat2Label} onChange={v => updateData('stat2Label', v)} placeholder="Average rating" />
                    </div>
                  </div>
                  <div>
                    <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Anything else the AI should know?</label>
                    <textarea value={data.additionalDetails} onChange={e => updateData('additionalDetails', e.target.value)}
                      placeholder="Any other details, preferences, or instructions for the AI — e.g. 'emphasize that this is risk-free' or 'mention our 30-day guarantee' or 'keep it under 500 words'"
                      className="w-full rounded-md border bg-card px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring h-20" />
                  </div>
                </div>
              )}
            </div>

            {/* Wizard navigation */}
            <div className="px-6 py-4 border-t space-y-2">
              {wizardStep < wizardScreens.length - 1 ? (
                <Button type="button" className="w-full" onClick={() => setWizardStep(s => s + 1)}
                  disabled={wizardStep === 0 && (!data.businessName.trim() || !data.pageGoal.trim())}>
                  Next <ArrowRight className="size-4 ml-1.5" />
                </Button>
              ) : (
                <Button type="button" className="w-full" onClick={() => { setStep('preview'); generateWithAI() }}
                  disabled={generating || !data.businessName.trim()}>
                  {generating ? <><Loader2 className="size-4 animate-spin mr-2" /> Generating...</> : <><Sparkles className="size-4 mr-2" /> Generate & Preview</>}
                </Button>
              )}
              {wizardStep > 0 && (
                <Button type="button" variant="outline" className="w-full" onClick={() => setWizardStep(s => s - 1)}>
                  Back
                </Button>
              )}
            </div>
          </div>

          {/* Right: Preview */}
          <div className="flex-1 bg-muted/20 relative overflow-hidden">
            {generatedHtml ? (
              <iframe key={previewKey} srcDoc={generatedHtml} className="w-full h-full border-0" title="Preview" sandbox="allow-scripts" />
            ) : (
              <>
                <iframe src={`/api/landing_pages/templates/preview/${selectedTemplate.id}`}
                  className="w-full h-full border-0 opacity-20" title="Template preview" />
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="text-center text-muted-foreground px-8 bg-background/80 rounded-xl p-6">
                    <Eye className="size-8 mx-auto mb-3 opacity-40" />
                    <p className="text-sm font-medium">Live preview</p>
                    <p className="text-xs mt-1">Complete the wizard and click Generate to see your page.</p>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Step 3: Preview + Publish */}
      {step === 'preview' && (
        <div className="flex-1 flex overflow-hidden">
          <div className="flex-1 bg-muted/20">
            {generatedHtml ? (
              <iframe key={previewKey} srcDoc={generatedHtml} className="w-full h-full border-0" title="Preview" sandbox="allow-scripts" />
            ) : generating ? (
              <div className="flex items-center justify-center h-full">
                <div className="text-center">
                  <Loader2 className="size-8 animate-spin mx-auto mb-3 text-muted-foreground" />
                  <p className="text-sm font-medium">Building your page...</p>
                  <p className="text-xs text-muted-foreground mt-1">AI is writing your copy and assembling the page.</p>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center h-full">
                <div className="text-center max-w-md px-8">
                  {aiError ? (
                    <>
                      <p className="text-sm font-medium text-destructive mb-2">Generation Issue</p>
                      <p className="text-xs text-muted-foreground">{aiError}</p>
                      <Button type="button" variant="outline" size="sm" className="mt-4" onClick={() => setStep('wizard')}>
                        Go Back & Try Again
                      </Button>
                    </>
                  ) : (
                    <>
                      <p className="text-sm text-muted-foreground">Click "Generate" to create your page.</p>
                      <Button type="button" size="sm" className="mt-4" onClick={generateWithAI} disabled={generating}>
                        <Sparkles className="size-3 mr-1.5" /> Generate Page
                      </Button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="w-96 border-l flex flex-col shrink-0">
            <div className="p-5 border-b space-y-3">
              <h2 className="text-sm font-semibold">Page Settings</h2>
              <Field label="Page Title" value={data.businessName + (data.pageGoal ? ' — ' + data.pageGoal : '')}
                onChange={() => {}} placeholder="" disabled />
              <div>
                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">URL</label>
                <div className="flex items-center gap-1">
                  <span className="text-xs text-muted-foreground">/p/</span>
                  <Input value={data.slug} onChange={e => updateData('slug', e.target.value)} className="flex-1 h-8 text-sm" />
                </div>
              </div>
            </div>

            <div className="p-5 border-b flex-1 overflow-y-auto space-y-4">
              <div>
                <h2 className="text-sm font-semibold mb-1 flex items-center gap-1.5">
                  <Sparkles className="size-3.5 text-accent" /> Refine with AI
                </h2>
                <p className="text-[11px] text-muted-foreground mb-3">
                  Tell the AI what to change and it will update the page.
                </p>
                <textarea value={revisionInput} onChange={e => setRevisionInput(e.target.value)}
                  placeholder='Examples:&#10;• "Make the headline more urgent"&#10;• "Add a money-back guarantee"&#10;• "Remove the stats section"&#10;• "Make it sound more casual"'
                  className="w-full rounded-md border bg-card px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring h-28" disabled={revising} />
                {aiError && <p className="text-xs text-destructive mt-1">{aiError}</p>}
                <Button type="button" size="sm" className="w-full mt-2"
                  onClick={async () => {
                    if (!revisionInput.trim() || !generatedHtml) return
                    const now = Date.now()
                    if (now - lastAiCall < 15000 && lastAiCall > 0) {
                      setAiError(`Please wait ${Math.ceil((15000 - (now - lastAiCall)) / 1000)}s before making changes.`)
                      return
                    }
                    setRevising(true)
                    setAiError(null)
                    setLastAiCall(now)
                    try {
                      const res = await fetch('/api/landing_pages/ai/revise', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
                        body: JSON.stringify({ currentHtml: generatedHtml, feedback: revisionInput.trim() }),
                      })
                      const result = await res.json()
                      if (result.ok && result.html) {
                        setGeneratedHtml(result.html)
                        setPreviewKey(k => k + 1)
                        setRevisionInput('')
                        setAiError(null)
                      } else {
                        const errMsg = result.error || 'Revision failed'
                        if (errMsg.includes('Resource exhausted') || errMsg.includes('429')) {
                          setAiError('Rate limit reached. Wait 30-60 seconds and try again.')
                        } else {
                          setAiError(errMsg)
                        }
                      }
                    } catch { setAiError('Network error — try again.') }
                    setRevising(false)
                  }}
                  disabled={!revisionInput.trim() || revising || !generatedHtml}>
                  {revising ? <><Loader2 className="size-3 animate-spin mr-1.5" /> Applying...</> : 'Apply Changes'}
                </Button>
              </div>

              <div className="border-t pt-4 space-y-2">
                <Button type="button" variant="outline" size="sm" className="w-full" onClick={() => setStep('wizard')}>
                  Edit Details
                </Button>
                <Button type="button" variant="outline" size="sm" className="w-full" onClick={generateWithAI} disabled={generating}>
                  {generating ? <><Loader2 className="size-3 animate-spin mr-1.5" /> Regenerating...</> : <><Sparkles className="size-3 mr-1.5" /> Regenerate Fresh</>}
                </Button>
              </div>
            </div>

            <div className="p-5">
              <Button type="button" className="w-full h-10" onClick={publishPage} disabled={saving || generating || !generatedHtml}>
                {saving ? <><Loader2 className="size-4 animate-spin mr-2" /> Publishing...</> : <><Globe className="size-4 mr-2" /> Publish Page</>}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Reusable field component
function Field({ label, value, onChange, placeholder, textarea, prefix, autoFocus, disabled }: {
  label: string; value: string; onChange: (v: string) => void; placeholder: string
  textarea?: boolean; prefix?: string; autoFocus?: boolean; disabled?: boolean
}) {
  return (
    <div>
      {label && <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">{label}</label>}
      {prefix ? (
        <div className="flex items-center gap-1">
          <span className="text-xs text-muted-foreground">{prefix}</span>
          <Input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
            className="flex-1 h-9 text-sm" autoFocus={autoFocus} disabled={disabled} />
        </div>
      ) : textarea ? (
        <textarea value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
          className="w-full rounded-md border bg-card px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring h-16"
          autoFocus={autoFocus} disabled={disabled} />
      ) : (
        <Input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
          className="h-9 text-sm" autoFocus={autoFocus} disabled={disabled} />
      )}
    </div>
  )
}
