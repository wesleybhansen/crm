'use client'

import { useState, useEffect } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import {
  ArrowLeft, Save, Eye, Globe, ChevronDown, ChevronUp, Plus, Trash2, GripVertical,
  Type, Image, Link2, FileText, MessageSquare, BarChart3, HelpCircle, Layout, Loader2, Check,
  Monitor, Tablet, Smartphone, Sparkles, BookOpen, ArrowRightLeft, Gift, DollarSign, Target,
  AlertTriangle, Zap,
} from 'lucide-react'

type Section = {
  id: string
  type: string
  fields: Record<string, any>
  html: string
}

type PageData = {
  id: string
  title: string
  slug: string
  status: string
  template_id: string | null
  published_html: string | null
}

const SECTION_TYPES = [
  { id: 'hero', label: 'Hero', icon: Layout, fields: ['headline', 'subtitle', 'ctaText', 'ctaUrl'] },
  { id: 'features', label: 'Features', icon: BarChart3, fields: ['headline', 'items'] },
  { id: 'testimonials', label: 'Testimonials', icon: MessageSquare, fields: ['headline', 'items'] },
  { id: 'cta', label: 'Call to Action', icon: Link2, fields: ['headline', 'description', 'ctaText', 'ctaUrl'] },
  { id: 'faq', label: 'FAQ', icon: HelpCircle, fields: ['headline', 'items'] },
  { id: 'stats', label: 'Stats', icon: BarChart3, fields: ['items'] },
  { id: 'content', label: 'Text Block', icon: Type, fields: ['headline', 'description'] },
  { id: 'image', label: 'Image', icon: Image, fields: ['imageUrl', 'altText', 'caption'] },
  { id: 'button', label: 'Button', icon: Link2, fields: ['ctaText', 'ctaUrl'] },
  { id: 'footer', label: 'Footer', icon: FileText, fields: ['termsUrl', 'privacyUrl', 'copyright'] },
  // v2 section types
  { id: 'pain-points', label: 'Pain Points', icon: AlertTriangle, fields: ['headline', 'items'] },
  { id: 'how-it-works', label: 'How It Works', icon: Zap, fields: ['headline', 'items'] },
  { id: 'story-narrative', label: 'Your Story', icon: BookOpen, fields: ['headline', 'body'] },
  { id: 'before-after', label: 'Before & After', icon: ArrowRightLeft, fields: ['headline', 'beforeText', 'afterText'] },
  { id: 'offer-breakdown', label: 'What You Get', icon: Gift, fields: ['headline', 'items'] },
  { id: 'pricing', label: 'Pricing', icon: DollarSign, fields: ['headline', 'price', 'priceNote', 'guaranteeText', 'ctaText'] },
  { id: 'cta-block', label: 'Final CTA', icon: Target, fields: ['headline', 'subtitle', 'ctaText'] },
  { id: 'features-benefits', label: 'Features & Benefits', icon: BarChart3, fields: ['headline', 'items'] },
]

const SECTION_LABELS: Record<string, string> = {
  nav: 'Navigation', hero: 'Hero', features: 'Features', testimonials: 'Testimonials',
  cta: 'Call to Action', faq: 'FAQ', stats: 'Stats', form: 'Form', footer: 'Footer',
  content: 'Content', pricing: 'Pricing', image: 'Image', button: 'Button',
  'pain-points': 'Pain Points', 'how-it-works': 'How It Works', 'story-narrative': 'Your Story',
  'before-after': 'Before & After', 'offer-breakdown': 'What You Get', 'cta-block': 'Final CTA',
  'features-benefits': 'Features & Benefits', 'logo-bar': 'Trust Badges',
}

export default function EditLandingPage({ pageId }: { pageId: string }) {
  const [page, setPage] = useState<PageData | null>(null)
  const [sections, setSections] = useState<Section[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [expandedSection, setExpandedSection] = useState<string | null>(null)
  const [showAddMenu, setShowAddMenu] = useState(false)
  const [previewMode, setPreviewMode] = useState(false)
  const [title, setTitle] = useState('')

  // Form customization
  const [formFields, setFormFields] = useState<Array<{ name: string; type: string; label: string; required: boolean; placeholder: string }>>([])
  const [successMessage, setSuccessMessage] = useState('')
  const [redirectUrl, setRedirectUrl] = useState('')
  const [viewport, setViewport] = useState<'desktop' | 'tablet' | 'mobile'>('desktop')

  // v2 AI refinement
  const [aiRefineInputs, setAiRefineInputs] = useState<Record<string, string>>({})
  const [aiRefiningSection, setAiRefiningSection] = useState<string | null>(null)
  const [livePreviewHtml, setLivePreviewHtml] = useState<string | null>(null)
  const [isV2, setIsV2] = useState(false)

  useEffect(() => {
    loadPage()
  }, [pageId])

  async function loadPage() {
    setLoading(true)
    try {
      const [pageRes, sectionsRes] = await Promise.all([
        fetch(`/api/pages/${pageId}`, { credentials: 'include' }).then(r => r.json()),
        fetch(`/api/pages/${pageId}/sections`, { credentials: 'include' }).then(r => r.json()),
      ])

      if (pageRes.ok) {
        setPage(pageRes.data)
        setTitle(pageRes.data.title)
        // Detect v2 wizard pages
        const config = typeof pageRes.data.config === 'string' ? JSON.parse(pageRes.data.config) : pageRes.data.config
        if (config?.wizardVersion === 2) {
          setIsV2(true)
        }
        // Load form config
        if (pageRes.data.forms?.length > 0) {
          const form = pageRes.data.forms[0]
          const fields = typeof form.fields === 'string' ? JSON.parse(form.fields) : (form.fields || [])
          setFormFields(fields)
          setSuccessMessage(form.success_message || '')
          setRedirectUrl(form.redirect_url || '')
        }
      }
      if (sectionsRes.ok) {
        setSections(sectionsRes.data.sections || [])
      }
    } catch {}
    setLoading(false)
  }

  function updateSectionField(sectionId: string, fieldKey: string, value: any) {
    setSections(prev => prev.map(s =>
      s.id === sectionId ? { ...s, fields: { ...s.fields, [fieldKey]: value } } : s
    ))
  }

  function updateSectionItem(sectionId: string, itemIndex: number, field: string, value: string) {
    setSections(prev => prev.map(s => {
      if (s.id !== sectionId || !s.fields.items) return s
      const items = [...s.fields.items]
      items[itemIndex] = { ...items[itemIndex], [field]: value }
      return { ...s, fields: { ...s.fields, items } }
    }))
  }

  function addItem(sectionId: string) {
    setSections(prev => prev.map(s => {
      if (s.id !== sectionId) return s
      const items = [...(s.fields.items || [])]
      if (s.type === 'testimonials') items.push({ quote: '', name: '', role: '' })
      else if (s.type === 'faq') items.push({ question: '', answer: '' })
      else if (s.type === 'stats') items.push({ value: '', label: '' })
      else items.push({ title: '', description: '' })
      return { ...s, fields: { ...s.fields, items } }
    }))
  }

  // Handle faqItems for v2 faq sections
  function addFaqItem(sectionId: string) {
    setSections(prev => prev.map(s => {
      if (s.id !== sectionId) return s
      const faqItems = [...(s.fields.faqItems || [])]
      faqItems.push({ question: '', answer: '' })
      return { ...s, fields: { ...s.fields, faqItems } }
    }))
  }

  function removeItem(sectionId: string, index: number) {
    setSections(prev => prev.map(s => {
      if (s.id !== sectionId || !s.fields.items) return s
      const items = s.fields.items.filter((_: any, i: number) => i !== index)
      return { ...s, fields: { ...s.fields, items } }
    }))
  }

  function moveSection(index: number, dir: -1 | 1) {
    const newIndex = index + dir
    if (newIndex < 0 || newIndex >= sections.length) return
    setSections(prev => {
      const arr = [...prev]
      ;[arr[index], arr[newIndex]] = [arr[newIndex], arr[index]]
      return arr
    })
  }

  function deleteSection(index: number) {
    setSections(prev => prev.filter((_, i) => i !== index))
  }

  function addSection(type: string) {
    const id = `section-new-${Date.now()}`
    const fields: Record<string, any> = {}
    if (['features', 'testimonials', 'faq', 'stats', 'pain-points', 'how-it-works', 'offer-breakdown', 'features-benefits'].includes(type)) fields.items = []
    setSections(prev => [...prev, { id, type, fields, html: '' }])
    setShowAddMenu(false)
    setExpandedSection(id)
  }

  async function handleAiRefine(section: Section) {
    const instruction = aiRefineInputs[section.id]
    if (!instruction?.trim()) return
    setAiRefiningSection(section.id)
    try {
      const res = await fetch('/api/landing-page-ai/refine-section', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          section: { type: section.type, ...section.fields },
          instruction,
          businessContext: { businessName: title, targetAudience: '', tone: 'professional' },
          pageId,
        }),
      })
      const data = await res.json()
      if (data.ok && data.data?.section) {
        const refined = data.data.section
        const newFields: Record<string, any> = {}
        for (const [key, value] of Object.entries(refined)) {
          if (key !== 'type') newFields[key] = value
        }
        setSections(prev => prev.map(s =>
          s.id === section.id ? { ...s, fields: { ...s.fields, ...newFields } } : s
        ))
        setAiRefineInputs(prev => ({ ...prev, [section.id]: '' }))
      }
    } catch {}
    setAiRefiningSection(null)
  }

  // Live preview for v2 pages — fetch rendered HTML when sections change
  async function refreshV2Preview() {
    if (!isV2 || !page) return
    const config = typeof page.config === 'string' ? JSON.parse(page.config) : (page as any).config
    if (!config?.styleId) return
    try {
      const generatedSections = sections.map(s => ({ type: s.type, ...s.fields }))
      const res = await fetch('/api/landing-page-ai/preview-style', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          sections: generatedSections,
          styleId: config.styleId,
          businessName: config.businessContext?.businessName || title,
          formFields: config.formFields || [],
        }),
      })
      const data = await res.json()
      if (data.ok && data.html) {
        setLivePreviewHtml(data.html)
      }
    } catch {}
  }

  async function saveSections() {
    setSaving(true)
    try {
      // Save title
      await fetch(`/api/pages/${pageId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ title, formFields, successMessage, redirectUrl }),
      })
      // Save sections
      await fetch(`/api/pages/${pageId}/sections`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ sections }),
      })
    } catch {}
    setSaving(false)
  }

  async function publishPage() {
    setPublishing(true)
    try {
      await saveSections()
      const res = await fetch(`/api/pages/${pageId}/publish`, {
        method: 'POST', credentials: 'include',
      })
      const data = await res.json()
      if (data.ok) {
        setPage(prev => prev ? { ...prev, status: 'published' } : prev)
        alert('Page published!')
      } else {
        alert(data.error || 'Failed to publish')
      }
    } catch { alert('Failed to publish') }
    setPublishing(false)
  }

  function renderFieldEditor(section: Section) {
    const fields = section.fields || {}

    return (
      <div className="space-y-3 p-4">
        {/* Headline */}
        {(section.type !== 'image' && section.type !== 'button' && section.type !== 'footer') && (
          <div>
            <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Headline</label>
            <Input value={fields.headline || ''} onChange={e => updateSectionField(section.id, 'headline', e.target.value)}
              placeholder="Section headline" className="h-8 text-sm" />
          </div>
        )}

        {/* Subtitle / Description */}
        {['hero', 'cta', 'content'].includes(section.type) && (
          <div>
            <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">
              {section.type === 'hero' ? 'Subtitle' : 'Description'}
            </label>
            <textarea value={fields.subtitle || fields.description || ''} onChange={e => updateSectionField(section.id, section.type === 'hero' ? 'subtitle' : 'description', e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm resize-none h-16 focus:outline-none focus:ring-1 focus:ring-ring" />
          </div>
        )}

        {/* CTA Button */}
        {['hero', 'cta', 'button'].includes(section.type) && (
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Button Text</label>
              <Input value={fields.ctaText || ''} onChange={e => updateSectionField(section.id, 'ctaText', e.target.value)}
                placeholder="Get Started" className="h-8 text-sm" />
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Button URL</label>
              <Input value={fields.ctaUrl || ''} onChange={e => updateSectionField(section.id, 'ctaUrl', e.target.value)}
                placeholder="#form or https://..." className="h-8 text-sm" />
            </div>
          </div>
        )}

        {/* Image */}
        {section.type === 'image' && (
          <>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Upload Image</label>
              <input type="file" accept="image/*" className="text-xs" onChange={async (e) => {
                const file = e.target.files?.[0]
                if (!file) return
                const formData = new FormData()
                formData.append('file', file)
                try {
                  const res = await fetch(`/api/pages/${pageId}/images`, { method: 'POST', body: formData, credentials: 'include' })
                  const data = await res.json()
                  if (data.ok) {
                    updateSectionField(section.id, 'imageUrl', data.data.url)
                  } else {
                    alert(data.error || 'Upload failed')
                  }
                } catch { alert('Upload failed') }
              }} />
              {fields.imageUrl && (
                <img src={fields.imageUrl} alt={fields.altText || ''} className="mt-2 max-h-24 rounded border object-contain" />
              )}
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Or paste URL</label>
              <Input value={fields.imageUrl || ''} onChange={e => updateSectionField(section.id, 'imageUrl', e.target.value)}
                placeholder="https://..." className="h-8 text-sm" />
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Alt Text</label>
              <Input value={fields.altText || ''} onChange={e => updateSectionField(section.id, 'altText', e.target.value)}
                className="h-8 text-sm" />
            </div>
          </>
        )}

        {/* Footer */}
        {section.type === 'footer' && (
          <>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Terms & Conditions URL</label>
              <Input value={fields.termsUrl || ''} onChange={e => updateSectionField(section.id, 'termsUrl', e.target.value)}
                placeholder="https://yoursite.com/terms" className="h-8 text-sm" />
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Privacy Policy URL</label>
              <Input value={fields.privacyUrl || ''} onChange={e => updateSectionField(section.id, 'privacyUrl', e.target.value)}
                placeholder="https://yoursite.com/privacy" className="h-8 text-sm" />
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Copyright Text</label>
              <Input value={fields.copyright || ''} onChange={e => updateSectionField(section.id, 'copyright', e.target.value)}
                placeholder="© 2026 Your Company" className="h-8 text-sm" />
            </div>
          </>
        )}

        {/* v2: Story body */}
        {section.type === 'story-narrative' && (
          <div>
            <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Story</label>
            <textarea value={fields.body || ''} onChange={e => updateSectionField(section.id, 'body', e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm resize-none h-24 focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder="Tell your story..." />
          </div>
        )}

        {/* v2: Before/After */}
        {section.type === 'before-after' && (
          <>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Before (Current Pain)</label>
              <textarea value={fields.beforeText || ''} onChange={e => updateSectionField(section.id, 'beforeText', e.target.value)}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm resize-none h-16 focus:outline-none focus:ring-1 focus:ring-ring"
                placeholder="What life looks like now..." />
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">After (Desired Outcome)</label>
              <textarea value={fields.afterText || ''} onChange={e => updateSectionField(section.id, 'afterText', e.target.value)}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm resize-none h-16 focus:outline-none focus:ring-1 focus:ring-ring"
                placeholder="What life looks like after..." />
            </div>
          </>
        )}

        {/* v2: Pricing */}
        {section.type === 'pricing' && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Price</label>
                <Input value={fields.price || ''} onChange={e => updateSectionField(section.id, 'price', e.target.value)}
                  placeholder="$99" className="h-8 text-sm" />
              </div>
              <div>
                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Price Note</label>
                <Input value={fields.priceNote || ''} onChange={e => updateSectionField(section.id, 'priceNote', e.target.value)}
                  placeholder="One-time payment" className="h-8 text-sm" />
              </div>
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Guarantee</label>
              <Input value={fields.guaranteeText || ''} onChange={e => updateSectionField(section.id, 'guaranteeText', e.target.value)}
                placeholder="30-day money-back guarantee" className="h-8 text-sm" />
            </div>
          </>
        )}

        {/* v2: CTA Block subtitle */}
        {section.type === 'cta-block' && (
          <div>
            <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Subtitle</label>
            <textarea value={fields.subtitle || ''} onChange={e => updateSectionField(section.id, 'subtitle', e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm resize-none h-12 focus:outline-none focus:ring-1 focus:ring-ring" />
          </div>
        )}

        {/* AI Refine (v2 pages) */}
        {isV2 && (
          <div className="pt-2 mt-2 border-t">
            <div className="flex gap-1.5">
              <Input
                value={aiRefineInputs[section.id] || ''}
                onChange={e => setAiRefineInputs(prev => ({ ...prev, [section.id]: e.target.value }))}
                placeholder="Ask AI to refine... e.g. 'make shorter'"
                className="h-7 text-xs flex-1"
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handleAiRefine(section)
                  }
                }}
              />
              <Button
                type="button" variant="ghost" size="sm"
                disabled={aiRefiningSection === section.id || !aiRefineInputs[section.id]?.trim()}
                onClick={() => handleAiRefine(section)}
                className="h-7 text-xs px-2"
              >
                {aiRefiningSection === section.id ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
              </Button>
            </div>
          </div>
        )}

        {/* Form section */}
        {section.type === 'form' && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">Configure form fields below. Changes apply when you save.</p>
            {formFields.map((field, fi) => (
              <div key={fi} className="flex gap-2 items-center">
                <Input value={field.label} onChange={e => {
                  const updated = [...formFields]
                  updated[fi] = { ...updated[fi], label: e.target.value, name: e.target.value.toLowerCase().replace(/\s+/g, '_') }
                  setFormFields(updated)
                }} placeholder="Field label" className="h-7 text-xs flex-1" />
                <select value={field.type} onChange={e => {
                  const updated = [...formFields]
                  updated[fi] = { ...updated[fi], type: e.target.value }
                  setFormFields(updated)
                }} className="h-7 text-xs rounded border bg-background px-1">
                  <option value="text">Text</option>
                  <option value="email">Email</option>
                  <option value="phone">Phone</option>
                  <option value="textarea">Textarea</option>
                  <option value="select">Dropdown</option>
                  <option value="checkbox">Checkbox</option>
                </select>
                <label className="flex items-center gap-1 text-xs">
                  <input type="checkbox" checked={field.required} onChange={e => {
                    const updated = [...formFields]
                    updated[fi] = { ...updated[fi], required: e.target.checked }
                    setFormFields(updated)
                  }} /> Req
                </label>
                <IconButton type="button" variant="ghost" size="xs" onClick={() => setFormFields(prev => prev.filter((_, i) => i !== fi))} aria-label="Remove field">
                  <Trash2 className="size-3 text-red-500" />
                </IconButton>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={() => setFormFields(prev => [...prev, { name: '', type: 'text', label: '', required: false, placeholder: '' }])} className="h-7 text-xs">
              <Plus className="size-3 mr-1" /> Add Field
            </Button>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Success Message</label>
              <Input value={successMessage} onChange={e => setSuccessMessage(e.target.value)} placeholder="Thank you!" className="h-8 text-sm" />
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Redirect URL (optional)</label>
              <Input value={redirectUrl} onChange={e => setRedirectUrl(e.target.value)} placeholder="https://..." className="h-8 text-sm" />
            </div>
          </div>
        )}

        {/* Repeater items (features, testimonials, FAQ, stats) */}
        {fields.items && Array.isArray(fields.items) && (
          <div className="space-y-2">
            <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block">Items</label>
            {fields.items.map((item: any, i: number) => (
              <div key={i} className="rounded border bg-muted/20 p-2 space-y-1.5">
                {section.type === 'testimonials' ? (
                  <>
                    <textarea value={item.quote || ''} onChange={e => updateSectionItem(section.id, i, 'quote', e.target.value)}
                      placeholder="Quote..." className="w-full rounded border bg-background px-2 py-1 text-xs resize-none h-12" />
                    <div className="grid grid-cols-2 gap-1">
                      <Input value={item.name || ''} onChange={e => updateSectionItem(section.id, i, 'name', e.target.value)} placeholder="Name" className="h-6 text-xs" />
                      <Input value={item.role || ''} onChange={e => updateSectionItem(section.id, i, 'role', e.target.value)} placeholder="Role" className="h-6 text-xs" />
                    </div>
                  </>
                ) : section.type === 'faq' ? (
                  <>
                    <Input value={item.question || ''} onChange={e => updateSectionItem(section.id, i, 'question', e.target.value)} placeholder="Question" className="h-6 text-xs" />
                    <textarea value={item.answer || ''} onChange={e => updateSectionItem(section.id, i, 'answer', e.target.value)}
                      placeholder="Answer..." className="w-full rounded border bg-background px-2 py-1 text-xs resize-none h-12" />
                  </>
                ) : section.type === 'stats' ? (
                  <div className="grid grid-cols-2 gap-1">
                    <Input value={item.value || ''} onChange={e => updateSectionItem(section.id, i, 'value', e.target.value)} placeholder="100+" className="h-6 text-xs" />
                    <Input value={item.label || ''} onChange={e => updateSectionItem(section.id, i, 'label', e.target.value)} placeholder="Customers" className="h-6 text-xs" />
                  </div>
                ) : (
                  <>
                    <Input value={item.title || ''} onChange={e => updateSectionItem(section.id, i, 'title', e.target.value)} placeholder="Title" className="h-6 text-xs" />
                    <textarea value={item.description || ''} onChange={e => updateSectionItem(section.id, i, 'description', e.target.value)}
                      placeholder="Description..." className="w-full rounded border bg-background px-2 py-1 text-xs resize-none h-10" />
                  </>
                )}
                <button type="button" onClick={() => removeItem(section.id, i)} className="text-[10px] text-red-500 hover:text-red-700">Remove</button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={() => addItem(section.id)} className="h-6 text-[10px]">
              <Plus className="size-3 mr-0.5" /> Add Item
            </Button>
          </div>
        )}
      </div>
    )
  }

  if (loading) return <div className="p-6 text-center text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin mx-auto mb-2" /> Loading editor...</div>
  if (!page) return <div className="p-6 text-center text-sm text-muted-foreground">Page not found</div>

  if (previewMode && page.published_html) {
    return (
      <div className="h-full flex flex-col">
        <div className="flex items-center justify-between px-4 py-2 border-b bg-card">
          <Button type="button" variant="ghost" size="sm" onClick={() => setPreviewMode(false)}><ArrowLeft className="size-3 mr-1" /> Back to Editor</Button>
          <span className="text-xs text-muted-foreground">Preview: {page.title}</span>
          <div />
        </div>
        <iframe srcDoc={page.published_html} className="flex-1 w-full" sandbox="allow-scripts" />
      </div>
    )
  }

  return (
    <div className="flex h-[calc(100vh-64px)]">
      {/* Left: Section Editor */}
      <div className="w-[400px] border-r overflow-y-auto bg-card">
        <div className="p-4 border-b space-y-3">
          <div className="flex items-center gap-2">
            <a href="/backend/landing-pages" className="text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /></a>
            <h1 className="text-sm font-semibold flex-1">Edit Page</h1>
            <Button type="button" variant="outline" size="sm" onClick={saveSections} disabled={saving} className="h-7 text-xs">
              {saving ? <Loader2 className="size-3 animate-spin mr-1" /> : <Save className="size-3 mr-1" />} Save
            </Button>
            <Button type="button" size="sm" onClick={publishPage} disabled={publishing} className="h-7 text-xs">
              {publishing ? <Loader2 className="size-3 animate-spin mr-1" /> : <Globe className="size-3 mr-1" />} Publish
            </Button>
          </div>
          <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="Page title" className="h-8 text-sm" />
          {page.status === 'published' && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">Published</span>
              <button type="button" onClick={() => setPreviewMode(true)} className="text-[10px] text-blue-600 hover:underline flex items-center gap-0.5">
                <Eye className="size-3" /> Preview
              </button>
              <a href={`/api/landing-pages/public/${page.slug}`} target="_blank" className="text-[10px] text-blue-600 hover:underline flex items-center gap-0.5">
                <Globe className="size-3" /> View Live
              </a>
            </div>
          )}
        </div>

        {/* Sections */}
        <div className="divide-y">
          {sections.map((section, index) => {
            const isExpanded = expandedSection === section.id
            const Icon = SECTION_TYPES.find(t => t.id === section.type)?.icon || Layout
            return (
              <div key={section.id}>
                <div className="flex items-center gap-2 px-4 py-2 hover:bg-muted/50 cursor-pointer" onClick={() => setExpandedSection(isExpanded ? null : section.id)}>
                  <GripVertical className="size-3.5 text-muted-foreground/50" />
                  <Icon className="size-3.5 text-muted-foreground" />
                  <span className="text-xs font-medium flex-1">{SECTION_LABELS[section.type] || section.type}</span>
                  <div className="flex items-center gap-0.5" onClick={e => e.stopPropagation()}>
                    <IconButton type="button" variant="ghost" size="xs" onClick={() => moveSection(index, -1)} disabled={index === 0} aria-label="Move up">
                      <ChevronUp className="size-3" />
                    </IconButton>
                    <IconButton type="button" variant="ghost" size="xs" onClick={() => moveSection(index, 1)} disabled={index === sections.length - 1} aria-label="Move down">
                      <ChevronDown className="size-3" />
                    </IconButton>
                    <IconButton type="button" variant="ghost" size="xs" onClick={() => deleteSection(index)} aria-label="Delete">
                      <Trash2 className="size-3 text-red-500" />
                    </IconButton>
                  </div>
                  {isExpanded ? <ChevronUp className="size-3 text-muted-foreground" /> : <ChevronDown className="size-3 text-muted-foreground" />}
                </div>
                {isExpanded && renderFieldEditor(section)}
              </div>
            )
          })}
        </div>

        {/* Add Section */}
        <div className="p-4 border-t">
          <div className="relative">
            <Button type="button" variant="outline" size="sm" onClick={() => setShowAddMenu(!showAddMenu)} className="w-full h-8 text-xs">
              <Plus className="size-3 mr-1" /> Add Section
            </Button>
            {showAddMenu && (
              <div className="absolute bottom-full left-0 right-0 mb-1 bg-card border rounded-lg shadow-lg p-2 grid grid-cols-2 gap-1 z-10">
                {SECTION_TYPES.map(t => (
                  <button key={t.id} type="button" onClick={() => addSection(t.id)}
                    className="flex items-center gap-2 px-2 py-1.5 text-xs rounded hover:bg-muted transition text-left">
                    <t.icon className="size-3 text-muted-foreground" /> {t.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Right: Live Preview */}
      <div className="flex-1 bg-muted/30 flex flex-col">
        <div className="px-4 py-2 border-b bg-card flex items-center justify-between">
          <div className="flex items-center gap-1">
            <span className="text-xs text-muted-foreground mr-2">Preview</span>
            <button type="button" onClick={() => setViewport('desktop')}
              className={`p-1 rounded ${viewport === 'desktop' ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'}`} title="Desktop">
              <Monitor className="size-3.5" />
            </button>
            <button type="button" onClick={() => setViewport('tablet')}
              className={`p-1 rounded ${viewport === 'tablet' ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'}`} title="Tablet">
              <Tablet className="size-3.5" />
            </button>
            <button type="button" onClick={() => setViewport('mobile')}
              className={`p-1 rounded ${viewport === 'mobile' ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'}`} title="Mobile">
              <Smartphone className="size-3.5" />
            </button>
          </div>
          <div className="flex items-center gap-2">
            {isV2 && (
              <button type="button" onClick={refreshV2Preview} className="text-xs text-blue-600 hover:underline flex items-center gap-0.5">
                <Eye className="size-3" /> Refresh
              </button>
            )}
            {page.published_html && (
              <button type="button" onClick={() => setPreviewMode(true)} className="text-xs text-blue-600 hover:underline">Full Screen</button>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-hidden p-4 flex justify-center">
          {(isV2 && livePreviewHtml) ? (
            <iframe srcDoc={livePreviewHtml}
              className="h-full rounded-lg border shadow-sm bg-white transition-all"
              style={{ width: viewport === 'mobile' ? '375px' : viewport === 'tablet' ? '768px' : '100%' }}
              sandbox="allow-scripts" />
          ) : page.published_html ? (
            <iframe srcDoc={page.published_html}
              className="h-full rounded-lg border shadow-sm bg-white transition-all"
              style={{ width: viewport === 'mobile' ? '375px' : viewport === 'tablet' ? '768px' : '100%' }}
              sandbox="allow-scripts" />
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
              <div className="text-center">
                <Layout className="size-8 mx-auto mb-2 opacity-30" />
                {isV2 ? (
                  <>
                    <p>Edit sections and click Refresh to preview.</p>
                    <Button type="button" variant="outline" size="sm" onClick={refreshV2Preview} className="mt-2 h-7 text-xs">
                      <Eye className="size-3 mr-1" /> Refresh Preview
                    </Button>
                  </>
                ) : (
                  <>
                    <p>No preview available yet.</p>
                    <p className="text-xs mt-1">Create your page content first, then publish to see a preview.</p>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
