'use client'

import { useState, useEffect } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import {
  ArrowRight, Loader2, RefreshCw, Trash2, ChevronUp, ChevronDown, Sparkles, Check,
  Layout, AlertTriangle, Cog, MessageSquare, Building2, BookOpen, ArrowRightLeft,
  Gift, DollarSign, HelpCircle, Target, BarChart3,
} from 'lucide-react'
import { SECTION_DEFINITIONS } from '../constants'
import type { WizardActions } from '../hooks/useWizardState'
import type { GeneratedSection, SectionType } from '../types'

const SECTION_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  Layout, AlertTriangle, Sparkles, Cog, MessageSquare, Building2, BookOpen,
  ArrowRightLeft, Gift, DollarSign, HelpCircle, Target, BarChart3,
}

interface Props {
  wizard: WizardActions
}

export function Step5CopyReview({ wizard }: Props) {
  const { state, setGeneratedCopy, updateSection, removeSection, reorderSections, selectHeadlineVariant, selectCtaVariant, setThankYou, nextStep } = wizard
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refineInputs, setRefineInputs] = useState<Record<number, string>>({})
  const [refiningIndex, setRefiningIndex] = useState<number | null>(null)

  const hasContent = state.generatedSections.length > 0

  useEffect(() => {
    if (hasContent || loading) return
    generateCopy()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const generateCopy = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/landing_pages/ai/generate-copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          pageType: state.pageType,
          subType: state.subType,
          framework: state.framework,
          sections: state.sections,
          businessContext: state.businessContext,
        }),
      })
      const data = await res.json()
      if (data.ok && data.data) {
        setGeneratedCopy(data.data.sections, data.data.metaTitle, data.data.metaDescription, data.data.thankYouHeadline || 'Thank you!', data.data.thankYouMessage || "We'll be in touch soon.")
      } else {
        setError(data.error || 'Failed to generate copy')
      }
    } catch {
      setError('Network error — please try again')
    } finally {
      setLoading(false)
    }
  }

  const handleRefineSection = async (index: number) => {
    const instruction = refineInputs[index]
    if (!instruction?.trim()) return
    setRefiningIndex(index)
    try {
      const res = await fetch('/api/landing_pages/ai/refine-section', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          section: state.generatedSections[index],
          instruction,
          businessContext: state.businessContext,
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (data.ok && data.data?.section) {
        updateSection(index, data.data.section)
        setRefineInputs((prev) => ({ ...prev, [index]: '' }))
      } else {
        setError(data.error || 'Section refinement failed')
      }
    } catch {
      setError('Failed to refine section — please try again')
    }
    setRefiningIndex(null)
  }

  const handleFieldChange = (index: number, field: string, value: string) => {
    const section = { ...state.generatedSections[index], [field]: value }
    updateSection(index, section)
  }

  const handleItemChange = (sectionIndex: number, itemIndex: number, field: 'title' | 'description', value: string) => {
    const section = { ...state.generatedSections[sectionIndex] }
    const items = [...(section.items || [])]
    items[itemIndex] = { ...items[itemIndex], [field]: value }
    updateSection(sectionIndex, { ...section, items })
  }

  const handleFaqChange = (sectionIndex: number, faqIndex: number, field: 'question' | 'answer', value: string) => {
    const section = { ...state.generatedSections[sectionIndex] }
    const faqItems = [...(section.faqItems || [])]
    faqItems[faqIndex] = { ...faqItems[faqIndex], [field]: value }
    updateSection(sectionIndex, { ...section, faqItems })
  }

  const getSectionIcon = (sectionType: SectionType) => {
    const def = SECTION_DEFINITIONS[sectionType]
    if (!def) return Layout
    return SECTION_ICONS[def.icon] || Layout
  }

  if (loading) {
    return (
      <div className="max-w-[640px] mx-auto px-6 py-20 text-center">
        <Loader2 className="size-8 animate-spin mx-auto mb-4 text-muted-foreground" />
        <h2 className="text-lg font-semibold mb-1">Generating your copy...</h2>
        <p className="text-sm text-muted-foreground">
          Creating {state.sections.length} sections tailored to your offer. This usually takes 10-20 seconds.
        </p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="max-w-[640px] mx-auto px-6 py-20 text-center">
        <p className="text-sm text-destructive mb-4">{error}</p>
        <Button onClick={generateCopy}>Try Again</Button>
      </div>
    )
  }

  return (
    <div className="max-w-[640px] mx-auto px-6 py-8">
      <div className="text-center mb-6">
        <h1 className="text-xl font-semibold mb-1">Review your copy</h1>
        <p className="text-sm text-muted-foreground">
          Edit any section, pick your favorite headlines, or ask AI to refine specific parts.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {state.generatedSections.map((section, index) => {
          const def = SECTION_DEFINITIONS[section.type]
          const isRefining = refiningIndex === index
          const Icon = getSectionIcon(section.type)

          return (
            <div
              key={`${section.type}-${index}`}
              className="rounded border border-border bg-card p-4"
            >
              {/* Section Header */}
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Icon className="size-4 text-muted-foreground" />
                  <span className="text-sm font-medium">{def?.label || section.type}</span>
                </div>
                <div className="flex items-center gap-0.5">
                  {index > 0 && (
                    <button onClick={() => reorderSections(index, index - 1)} className="p-1 rounded hover:bg-muted text-muted-foreground">
                      <ChevronUp className="size-3.5" />
                    </button>
                  )}
                  {index < state.generatedSections.length - 1 && (
                    <button onClick={() => reorderSections(index, index + 1)} className="p-1 rounded hover:bg-muted text-muted-foreground">
                      <ChevronDown className="size-3.5" />
                    </button>
                  )}
                  {def?.optional && (
                    <button onClick={() => removeSection(index)} className="p-1 rounded hover:bg-muted text-destructive">
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {/* Headline Variants */}
              {section.headlineVariants && section.headlineVariants.length > 1 && (
                <div className="mb-3">
                  <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">
                    Pick a headline
                  </label>
                  <div className="flex flex-col gap-1.5">
                    {section.headlineVariants.map((variant, vi) => (
                      <button
                        key={vi}
                        onClick={() => selectHeadlineVariant(index, vi)}
                        className={[
                          'rounded border px-3 py-2 text-left text-sm transition-colors cursor-pointer',
                          section.selectedHeadline === vi
                            ? 'border-accent bg-accent/5 font-medium'
                            : 'border-border hover:border-accent/50',
                        ].join(' ')}
                      >
                        {variant}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Editable Fields */}
              {section.headline && !section.headlineVariants?.length && (
                <div className="mb-3">
                  <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Headline</label>
                  <input
                    value={section.headline}
                    onChange={(e) => handleFieldChange(index, 'headline', e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              )}

              {section.subtitle !== undefined && (
                <div className="mb-3">
                  <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Subtitle</label>
                  <textarea
                    value={section.subtitle || ''}
                    onChange={(e) => handleFieldChange(index, 'subtitle', e.target.value)}
                    rows={2}
                    className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              )}

              {section.body !== undefined && (
                <div className="mb-3">
                  <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Body</label>
                  <textarea
                    value={section.body || ''}
                    onChange={(e) => handleFieldChange(index, 'body', e.target.value)}
                    rows={4}
                    className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              )}

              {section.beforeText !== undefined && (
                <>
                  <div className="mb-3">
                    <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Before (Current Pain)</label>
                    <textarea
                      value={section.beforeText || ''}
                      onChange={(e) => handleFieldChange(index, 'beforeText', e.target.value)}
                      rows={2}
                      className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div className="mb-3">
                    <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">After (Desired Outcome)</label>
                    <textarea
                      value={section.afterText || ''}
                      onChange={(e) => handleFieldChange(index, 'afterText', e.target.value)}
                      rows={2}
                      className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                </>
              )}

              {/* Items */}
              {section.items && section.items.length > 0 && (
                <div className="mb-3">
                  <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Items</label>
                  {section.items.map((item, ii) => (
                    <div key={ii} className="flex gap-2 mb-2">
                      <input
                        value={item.title}
                        onChange={(e) => handleItemChange(index, ii, 'title', e.target.value)}
                        placeholder="Title"
                        className="flex-[0_0_35%] rounded-md border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                      <input
                        value={item.description}
                        onChange={(e) => handleItemChange(index, ii, 'description', e.target.value)}
                        placeholder="Description"
                        className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                    </div>
                  ))}
                </div>
              )}

              {/* FAQ Items */}
              {section.faqItems && section.faqItems.length > 0 && (
                <div className="mb-3">
                  <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">FAQ</label>
                  {section.faqItems.map((faq, fi) => (
                    <div key={fi} className="mb-2 rounded border border-input p-2">
                      <input
                        value={faq.question}
                        onChange={(e) => handleFaqChange(index, fi, 'question', e.target.value)}
                        placeholder="Question"
                        className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs font-medium mb-1.5 focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                      <textarea
                        value={faq.answer}
                        onChange={(e) => handleFaqChange(index, fi, 'answer', e.target.value)}
                        placeholder="Answer"
                        rows={2}
                        className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                    </div>
                  ))}
                </div>
              )}

              {/* CTA Variants */}
              {section.ctaVariants && section.ctaVariants.length > 1 && (
                <div className="mb-3">
                  <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">
                    Pick a button text
                  </label>
                  <div className="flex gap-2 flex-wrap">
                    {section.ctaVariants.map((variant, ci) => (
                      <button
                        key={ci}
                        onClick={() => selectCtaVariant(index, ci)}
                        className={[
                          'rounded-full border px-3 py-1 text-xs font-medium transition-colors cursor-pointer',
                          section.selectedCta === ci
                            ? 'border-accent bg-accent text-white'
                            : 'border-border hover:border-accent/50',
                        ].join(' ')}
                      >
                        {variant}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Pricing fields */}
              {section.price !== undefined && (
                <div className="flex gap-3 mb-3">
                  <div className="flex-1">
                    <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Price</label>
                    <input value={section.price || ''} onChange={(e) => handleFieldChange(index, 'price', e.target.value)} className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring" />
                  </div>
                  <div className="flex-1">
                    <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Price Note</label>
                    <input value={section.priceNote || ''} onChange={(e) => handleFieldChange(index, 'priceNote', e.target.value)} className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring" />
                  </div>
                </div>
              )}

              {section.guaranteeText !== undefined && section.type === 'pricing' && (
                <div className="mb-3">
                  <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Guarantee</label>
                  <input value={section.guaranteeText || ''} onChange={(e) => handleFieldChange(index, 'guaranteeText', e.target.value)} className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring" />
                </div>
              )}

              {/* AI Refine */}
              <div className="flex gap-2 pt-3 border-t border-border">
                <input
                  value={refineInputs[index] || ''}
                  onChange={(e) => setRefineInputs((prev) => ({ ...prev, [index]: e.target.value }))}
                  placeholder="Ask AI to refine... e.g. 'make shorter' or 'add urgency'"
                  onKeyDown={(e) => e.key === 'Enter' && handleRefineSection(index)}
                  className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleRefineSection(index)}
                  disabled={isRefining || !refineInputs[index]?.trim()}
                  className="h-7 px-2"
                >
                  {isRefining ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                </Button>
              </div>
            </div>
          )
        })}
      </div>

      {/* Thank You Message */}
      {state.pageType !== 'book-a-call' && (
        <div className="rounded border border-border bg-card p-4 mt-4">
          <div className="flex items-center gap-2 mb-3">
            <Check className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium">Thank You Message</span>
          </div>
          <p className="text-xs text-muted-foreground mb-3">
            Shown after someone submits the form on your landing page.
          </p>
          <div className="mb-3">
            <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Headline</label>
            <input
              value={state.thankYouHeadline}
              onChange={(e) => setThankYou(e.target.value, state.thankYouMessage)}
              placeholder="Thank you!"
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Message</label>
            <textarea
              value={state.thankYouMessage}
              onChange={(e) => setThankYou(state.thankYouHeadline, e.target.value)}
              placeholder="We'll be in touch soon."
              rows={2}
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>
      )}

      {/* Regenerate All + Continue */}
      <div className="flex justify-between items-center mt-6">
        <Button variant="ghost" onClick={generateCopy} className="gap-1.5">
          <RefreshCw className="size-4" />
          Regenerate All
        </Button>
        <Button onClick={nextStep} className="gap-1.5">
          Choose a Style
          <ArrowRight className="size-4" />
        </Button>
      </div>
    </div>
  )
}
