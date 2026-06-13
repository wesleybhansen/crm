'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Button } from '@open-mercato/ui/primitives/button'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Badge } from '@open-mercato/ui/primitives/badge'
import {
  ArrowLeft, GripVertical, Trash2, Plus, Eye, Globe, Palette, Check,
  Type, AlignLeft, Mail, Phone, Hash, Calendar,
  ChevronDown, CheckSquare, Circle, Star, ToggleLeft as ToggleLeftIcon,
  Upload, SeparatorHorizontal, Copy, X, Loader2,
} from 'lucide-react'

// ── Template helper ──
function getTemplateFields(templateId: string): { name: string; fields: any[]; settings: any } | null {
  // Inline template data matching the list page templates
  const templates: Record<string, { name: string; fields: any[]; settings: any }> = {
    contact: { name: 'Contact Form', fields: [
      { type: 'short_text', label: 'First Name', placeholder: 'John', required: true, width: 'half', crm_mapping: 'contact.first_name' },
      { type: 'short_text', label: 'Last Name', placeholder: 'Doe', required: true, width: 'half', crm_mapping: 'contact.last_name' },
      { type: 'email', label: 'Email', placeholder: 'john@example.com', required: true, width: 'full', crm_mapping: 'contact.email' },
      { type: 'phone', label: 'Phone', placeholder: '+1 (555) 000-0000', required: false, width: 'full', crm_mapping: 'contact.phone' },
      { type: 'long_text', label: 'Message', placeholder: 'How can we help you?', required: true, width: 'full' },
    ], settings: { submitLabel: 'Send Message', successMessage: 'Thank you! We\'ll be in touch soon.', createContact: true } },
    quote_request: { name: 'Quote Request', fields: [
      { type: 'short_text', label: 'Full Name', required: true, width: 'half', crm_mapping: 'contact.first_name' },
      { type: 'email', label: 'Email', required: true, width: 'half', crm_mapping: 'contact.email' },
      { type: 'phone', label: 'Phone', required: true, width: 'half', crm_mapping: 'contact.phone' },
      { type: 'short_text', label: 'Company', required: false, width: 'half', crm_mapping: 'company.name' },
      { type: 'select', label: 'Service', required: true, width: 'full', options: ['Web Development', 'Mobile App', 'Design', 'Consulting', 'Other'] },
      { type: 'long_text', label: 'Project Description', required: true, width: 'full' },
      { type: 'select', label: 'Budget Range', required: false, width: 'half', options: ['Under $1K', '$1K-$5K', '$5K-$10K', '$10K+'] },
      { type: 'select', label: 'Timeline', required: false, width: 'half', options: ['ASAP', '1-2 weeks', '1 month', 'Flexible'] },
    ], settings: { submitLabel: 'Request Quote', successMessage: 'Thank you! We\'ll send you a quote within 24 hours.', createContact: true } },
    consultation: { name: 'Free Consultation', fields: [
      { type: 'short_text', label: 'Full Name', required: true, width: 'full', crm_mapping: 'contact.first_name' },
      { type: 'email', label: 'Email', required: true, width: 'half', crm_mapping: 'contact.email' },
      { type: 'phone', label: 'Phone', required: false, width: 'half', crm_mapping: 'contact.phone' },
      { type: 'date', label: 'Preferred Date', required: true, width: 'half' },
      { type: 'select', label: 'Preferred Time', required: true, width: 'half', options: ['Morning', 'Afternoon', 'Evening'] },
      { type: 'long_text', label: 'What would you like to discuss?', required: true, width: 'full' },
    ], settings: { submitLabel: 'Book Consultation', successMessage: 'Booked! We\'ll confirm your consultation shortly.', createContact: true } },
    satisfaction: { name: 'Customer Satisfaction Survey', fields: [
      { type: 'rating', label: 'How satisfied are you?', required: true, width: 'full' },
      { type: 'long_text', label: 'What did we do well?', required: false, width: 'full' },
      { type: 'long_text', label: 'What could we improve?', required: false, width: 'full' },
      { type: 'rating', label: 'How likely are you to recommend us?', required: true, width: 'full' },
    ], settings: { submitLabel: 'Submit Feedback', successMessage: 'Thank you for your feedback!' } },
    newsletter: { name: 'Newsletter Signup', fields: [
      { type: 'email', label: 'Email Address', placeholder: 'you@example.com', required: true, width: 'full', crm_mapping: 'contact.email' },
      { type: 'short_text', label: 'First Name', placeholder: 'Optional', required: false, width: 'full', crm_mapping: 'contact.first_name' },
    ], settings: { submitLabel: 'Subscribe', successMessage: 'You\'re subscribed! Check your email.', createContact: true } },
  }
  const uid = () => Math.random().toString(36).substring(2) + Date.now().toString(36)
  const t = templates[templateId]
  if (!t) return null
  return { name: t.name, fields: t.fields.map((f: any, i: number) => ({ ...f, id: uid(), order: i, required: f.required ?? false, width: f.width ?? 'full' })), settings: { submitLabel: 'Submit', successMessage: 'Thank you!', createContact: false, ...t.settings } }
}

// ── Types ──

type FormField = {
  id: string
  type: FieldType
  label: string
  placeholder?: string
  description?: string
  required: boolean
  width: 'full' | 'half'
  options?: string[]
  crm_mapping?: string
  validation?: Record<string, unknown>
  order: number
}

type FieldType =
  | 'short_text' | 'long_text' | 'email' | 'phone' | 'number' | 'date'
  | 'select' | 'multi_select' | 'radio' | 'checkbox' | 'rating' | 'yes_no'
  | 'file'
  | 'section' | 'page_break'

type FormTheme = {
  primaryColor: string
  font: string
  corners: 'sharp' | 'rounded' | 'pill'
  background: string
}

type FormSettings = {
  submitLabel: string
  successMessage: string
  redirectUrl?: string
  notifyEmail?: string
  createContact: boolean
}

type Form = {
  id: string
  name: string
  slug: string
  description?: string
  status: 'draft' | 'published'
  submission_count: number
  fields: FormField[]
  theme: FormTheme
  settings: FormSettings
  created_at: string
  updated_at: string
}

// ── Field palette config ──

type PaletteGroup = { label: string; items: PaletteItem[] }
type PaletteItem = { type: FieldType; label: string; icon: React.ReactNode }

const paletteGroups: PaletteGroup[] = [
  {
    label: 'Inputs',
    items: [
      { type: 'short_text', label: 'Short Text', icon: <Type className="size-4" /> },
      { type: 'long_text', label: 'Long Text', icon: <AlignLeft className="size-4" /> },
      { type: 'email', label: 'Email', icon: <Mail className="size-4" /> },
      { type: 'phone', label: 'Phone', icon: <Phone className="size-4" /> },
      { type: 'number', label: 'Number', icon: <Hash className="size-4" /> },
      { type: 'date', label: 'Date', icon: <Calendar className="size-4" /> },
    ],
  },
  {
    label: 'Choices',
    items: [
      { type: 'select', label: 'Dropdown', icon: <ChevronDown className="size-4" /> },
      { type: 'multi_select', label: 'Multi Select', icon: <CheckSquare className="size-4" /> },
      { type: 'radio', label: 'Radio Buttons', icon: <Circle className="size-4" /> },
      { type: 'checkbox', label: 'Checkboxes', icon: <CheckSquare className="size-4" /> },
      { type: 'rating', label: 'Rating', icon: <Star className="size-4" /> },
      { type: 'yes_no', label: 'Yes / No', icon: <ToggleLeftIcon className="size-4" /> },
    ],
  },
  {
    label: 'Special',
    items: [
      { type: 'file', label: 'File Upload', icon: <Upload className="size-4" /> },
    ],
  },
  {
    label: 'Layout',
    items: [
      { type: 'section', label: 'Section Header', icon: <Type className="size-4" /> },
      { type: 'page_break', label: 'Page Break', icon: <SeparatorHorizontal className="size-4" /> },
    ],
  },
]

const fieldDefaults: Record<FieldType, Partial<FormField>> = {
  short_text: { label: 'Short Text', placeholder: 'Enter text...' },
  long_text: { label: 'Long Text', placeholder: 'Enter your message...' },
  email: { label: 'Email', placeholder: 'you@example.com' },
  phone: { label: 'Phone', placeholder: '+1 (555) 000-0000' },
  number: { label: 'Number', placeholder: '0' },
  date: { label: 'Date' },
  select: { label: 'Dropdown', options: ['Option 1', 'Option 2', 'Option 3'] },
  multi_select: { label: 'Multi Select', options: ['Option 1', 'Option 2', 'Option 3'] },
  radio: { label: 'Radio Group', options: ['Option 1', 'Option 2', 'Option 3'] },
  checkbox: { label: 'Checkboxes', options: ['Option 1', 'Option 2', 'Option 3'] },
  rating: { label: 'Rating' },
  yes_no: { label: 'Yes or No' },
  file: { label: 'File Upload' },
  section: { label: 'Section Title' },
  page_break: { label: 'Page Break' },
}

const crmMappingOptions = [
  { value: '', label: 'None' },
  { value: 'contact.first_name', label: 'Contact First Name' },
  { value: 'contact.last_name', label: 'Contact Last Name' },
  { value: 'contact.email', label: 'Contact Email' },
  { value: 'contact.phone', label: 'Contact Phone' },
  { value: 'company.name', label: 'Company Name' },
  { value: 'deal.title', label: 'Deal Title' },
  { value: 'deal.value', label: 'Deal Value' },
]

const fontOptions = ['Inter', 'DM Sans', 'Georgia', 'Merriweather', 'Poppins', 'Space Grotesk']

// ── Main Component ──

export default function FormBuilderPage() {
  const [form, setForm] = useState<Form | null>(null)
  const [fields, setFields] = useState<FormField[]>([])
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [lastSaved, setLastSaved] = useState<Date | null>(null)
  const [showTheme, setShowTheme] = useState(false)

  const [editingName, setEditingName] = useState(false)
  const [formName, setFormName] = useState('')
  const [theme, setTheme] = useState<FormTheme>({ primaryColor: '#2563eb', font: 'Inter', corners: 'rounded', background: '#ffffff' })
  const [loading, setLoading] = useState(true)
  const [publishing, setPublishing] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [showAddFieldMenu, setShowAddFieldMenu] = useState(false)
  const [formDescription, setFormDescription] = useState('')
  const [activeTab, setActiveTab] = useState<'builder' | 'responses' | 'published'>('builder')
  const [submissions, setSubmissions] = useState<any[]>([])
  const [loadingSubmissions, setLoadingSubmissions] = useState(false)

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const selectedField = fields.find((f) => f.id === selectedFieldId) ?? null

  // ── Load submissions ──

  const loadSubmissions = useCallback(async (formId: string) => {
    setLoadingSubmissions(true)
    try {
      const res = await fetch(`/api/forms/${formId}/submissions?pageSize=100`, { credentials: 'include' })
      const d = await res.json()
      if (d.ok) setSubmissions(d.data || [])
    } catch { /* silent */ }
    setLoadingSubmissions(false)
  }, [])

  // ── Load form ──

  const initRef = useRef(false)

  useEffect(() => {
    if (initRef.current) return
    initRef.current = true

    const params = new URLSearchParams(window.location.search)
    const formId = params.get('id')
    const templateId = params.get('template')
    if (params.get('tab') === 'responses') setActiveTab('responses')

    async function init() {
      try {
        if (formId) {
          // Load existing form
          const res = await fetch(`/api/forms/${formId}`, { credentials: 'include' })
          const d = await res.json()
          if (d.ok && d.data) {
            const raw = d.data
            const parsedFields = typeof raw.fields === 'string' ? JSON.parse(raw.fields) : (raw.fields || [])
            const parsedTheme = typeof raw.theme === 'string' ? JSON.parse(raw.theme) : (raw.theme || {})
            const parsedSettings = typeof raw.settings === 'string' ? JSON.parse(raw.settings) : (raw.settings || {})
            const loadedForm = { ...raw, fields: parsedFields, theme: parsedTheme, settings: parsedSettings } as Form
            setForm(loadedForm)
            setFields(parsedFields)
            setFormName(loadedForm.name)
            setFormDescription(loadedForm.description || '')
            setTheme({ primaryColor: '#2563eb', font: 'Inter', corners: 'rounded', background: '#ffffff', ...parsedTheme })
            loadSubmissions(loadedForm.id)
          } else {
            window.location.href = '/backend/forms'
          }
        } else {
          // Create a new form (blank or from template)
          const templateData = templateId ? getTemplateFields(templateId) : null
          const body = templateData
            ? { name: templateData.name, fields: templateData.fields, settings: templateData.settings, theme: { primaryColor: '#2563eb', font: 'Inter', corners: 'rounded', background: '#ffffff' }, templateId }
            : { name: 'Untitled Form', fields: [], settings: { submitLabel: 'Submit', successMessage: 'Thank you for your submission!', createContact: false }, theme: { primaryColor: '#2563eb', font: 'Inter', corners: 'rounded', background: '#ffffff' } }

          const res = await fetch('/api/forms', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(body),
          })
          const d = await res.json()
          if (d.ok && d.data) {
            // Update URL with the new form ID without reloading
            window.history.replaceState({}, '', `/backend/forms/builder?id=${d.data.id}`)
            const raw = d.data
            const parsedFields = typeof raw.fields === 'string' ? JSON.parse(raw.fields) : (raw.fields || [])
            const parsedTheme = typeof raw.theme === 'string' ? JSON.parse(raw.theme) : (raw.theme || {})
            const parsedSettings = typeof raw.settings === 'string' ? JSON.parse(raw.settings) : (raw.settings || {})
            const loadedForm = { ...raw, fields: parsedFields, theme: parsedTheme, settings: parsedSettings } as Form
            setForm(loadedForm)
            setFields(parsedFields)
            setFormName(loadedForm.name)
            setFormDescription(loadedForm.description || '')
            setTheme({ primaryColor: '#2563eb', font: 'Inter', corners: 'rounded', background: '#ffffff', ...parsedTheme })
          } else {
            alert(`Failed to create form: ${d.error || 'Unknown error'}`)
            window.location.href = '/backend/forms'
          }
        }
      } catch (err) {
        alert(`Error: ${err instanceof Error ? err.message : String(err)}`)
        window.location.href = '/backend/forms'
      }
      setLoading(false)
    }
    init()
  }, [])

  // ── Auto-save ──

  const triggerSave = useCallback((updatedFields?: FormField[], updatedName?: string, updatedTheme?: FormTheme, updatedDescription?: string, updatedSettings?: Form['settings']) => {
    if (!form) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      setSaving(true)
      try {
        const res = await fetch(`/api/forms/${form.id}`, { credentials: 'include',
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: updatedName ?? formName,
            description: updatedDescription ?? formDescription,
            fields: (updatedFields ?? fields).map((f, i) => ({ ...f, order: i })),
            theme: updatedTheme ?? theme,
            settings: updatedSettings ?? form.settings,
          }),
        })
        const data = await res.json()
        if (data.ok && data.data) {
          const raw = data.data
          const parsed = {
            ...raw,
            fields: typeof raw.fields === 'string' ? JSON.parse(raw.fields) : (raw.fields || []),
            theme: typeof raw.theme === 'string' ? JSON.parse(raw.theme) : (raw.theme || {}),
            settings: typeof raw.settings === 'string' ? JSON.parse(raw.settings) : (raw.settings || {}),
          } as Form
          setForm(parsed)
        }
        setLastSaved(new Date())
      } catch { /* silent */ }
      setSaving(false)
    }, 1500)
  }, [form, fields, formName, formDescription, theme])

  // ── Field operations ──

  function addField(type: FieldType) {
    const defaults = fieldDefaults[type] || {}
    const newField: FormField = {
      id: crypto.randomUUID(),
      type,
      label: defaults.label || type,
      placeholder: defaults.placeholder,
      required: false,
      width: 'full',
      options: defaults.options ? [...defaults.options] : undefined,
      order: fields.length,
    }
    const updated = [...fields, newField]
    setFields(updated)
    setSelectedFieldId(newField.id)
    triggerSave(updated)
  }

  function updateField(fieldId: string, patch: Partial<FormField>) {
    const updated = fields.map((f) => f.id === fieldId ? { ...f, ...patch } : f)
    setFields(updated)
    triggerSave(updated)
  }

  function deleteField(fieldId: string) {
    const updated = fields.filter((f) => f.id !== fieldId)
    setFields(updated)
    if (selectedFieldId === fieldId) setSelectedFieldId(null)
    triggerSave(updated)
  }

  function duplicateField(fieldId: string) {
    const source = fields.find((f) => f.id === fieldId)
    if (!source) return
    const idx = fields.indexOf(source)
    const copy: FormField = { ...source, id: crypto.randomUUID(), label: `${source.label} (Copy)` }
    const updated = [...fields.slice(0, idx + 1), copy, ...fields.slice(idx + 1)]
    setFields(updated)
    setSelectedFieldId(copy.id)
    triggerSave(updated)
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = fields.findIndex((f) => f.id === active.id)
    const newIndex = fields.findIndex((f) => f.id === over.id)
    const updated = arrayMove(fields, oldIndex, newIndex)
    setFields(updated)
    triggerSave(updated)
  }

  // ── Name editing ──

  function handleNameSubmit() {
    setEditingName(false)
    if (formName.trim() && formName !== form?.name) {
      triggerSave(undefined, formName.trim())
    }
  }

  // ── Theme update ──

  function updateTheme(patch: Partial<FormTheme>) {
    const updated = { ...theme, ...patch }
    setTheme(updated)
    triggerSave(undefined, undefined, updated)
  }

  // ── Publish ──

  async function publishForm() {
    if (!form) return
    setPublishing(true)
    try {
      const res = await fetch(`/api/forms/${form.id}`, { credentials: 'include',
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'published' }),
      })
      const data = await res.json()
      if (data.ok && data.data) {
        const raw = data.data
        const parsedFields = typeof raw.fields === 'string' ? JSON.parse(raw.fields) : (raw.fields || [])
        const parsedTheme = typeof raw.theme === 'string' ? JSON.parse(raw.theme) : (raw.theme || {})
        const parsedSettings = typeof raw.settings === 'string' ? JSON.parse(raw.settings) : (raw.settings || {})
        setForm({ ...raw, fields: parsedFields, theme: parsedTheme, settings: parsedSettings } as Form)
        setActiveTab('published')
      }
    } catch { /* silent */ }
    setPublishing(false)
  }

  function copyToClipboard(text: string, label: string) {
    navigator.clipboard.writeText(text)
    setCopied(label)
    setTimeout(() => setCopied(null), 2000)
  }

  // ── Loading state ──

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!form) return null

  const publicUrl = form.slug ? `${window.location.origin}/api/forms/public/${form.slug}` : ''
  const embedCode = publicUrl ? `<iframe src="${publicUrl}" width="100%" height="600" frameborder="0"></iframe>` : ''

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* ── Top Bar ── */}
      <div className="flex items-center justify-between border-b px-4 h-14 shrink-0 bg-card">
        <div className="flex items-center gap-3">
          <IconButton
            variant="ghost"
            size="sm"
            type="button"
            aria-label="Back to forms"
            onClick={() => window.location.href = '/backend/forms'}
          >
            <ArrowLeft className="size-4" />
          </IconButton>

          {editingName ? (
            <Input
              ref={nameInputRef}
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              onBlur={handleNameSubmit}
              onKeyDown={(e) => { if (e.key === 'Enter') handleNameSubmit(); if (e.key === 'Escape') { setFormName(form.name); setEditingName(false) } }}
              className="h-8 w-64 text-sm font-medium"
              autoFocus
            />
          ) : (
            <button
              type="button"
              className="text-sm font-medium hover:text-accent transition-colors px-1 py-0.5 rounded hover:bg-muted"
              onClick={() => { setEditingName(true); setTimeout(() => nameInputRef.current?.select(), 50) }}
            >
              {formName || 'Untitled Form'}
            </button>
          )}

          <span className="text-xs text-muted-foreground">
            {saving ? 'Saving...' : lastSaved ? `Saved ${lastSaved.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
          </span>

          {/* Tab switcher */}
          <div className="flex items-center ml-4 border rounded-lg overflow-hidden">
            <button
              type="button"
              className={`px-3 py-1 text-xs font-medium transition-colors ${activeTab === 'builder' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              onClick={() => setActiveTab('builder')}
            >
              Builder
            </button>
            <button
              type="button"
              className={`px-3 py-1 text-xs font-medium transition-colors ${activeTab === 'responses' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              onClick={() => { setActiveTab('responses'); if (form) loadSubmissions(form.id) }}
            >
              Responses {form && form.submission_count > 0 ? `(${form.submission_count})` : ''}
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setShowTheme(true)}>
            <Palette className="size-3.5 mr-1.5" /> Theme
          </Button>
          {form.status === 'published' && publicUrl && (
            <Button type="button" variant="outline" size="sm" onClick={() => window.open(publicUrl, '_blank')}>
              <Eye className="size-3.5 mr-1.5" /> Preview
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            disabled={publishing}
            onClick={() => form.status === 'published' ? setActiveTab('published') : publishForm()}
          >
            {publishing ? <Loader2 className="size-3.5 mr-1.5 animate-spin" /> : <Globe className="size-3.5 mr-1.5" />}
            {form.status === 'published' ? 'Share' : 'Publish'}
          </Button>
        </div>
      </div>

      {/* ── Responses Tab ── */}
      {activeTab === 'responses' && (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-4xl mx-auto">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-lg font-semibold">Responses</h2>
                <p className="text-sm text-muted-foreground">{submissions.length} submission{submissions.length !== 1 ? 's' : ''}</p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => form && loadSubmissions(form.id)}>
                Refresh
              </Button>
            </div>

            {loadingSubmissions ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
              </div>
            ) : submissions.length === 0 ? (
              <div className="rounded-xl border-muted-foreground/20 p-12 text-center">
                <div className="inline-flex items-center justify-center size-12 rounded-xl bg-muted text-muted-foreground mb-3">
                  <AlignLeft className="size-5" />
                </div>
                <p className="text-sm text-muted-foreground mb-1">No responses yet</p>
                <p className="text-xs text-muted-foreground/70">Submissions will appear here when someone fills out your form.</p>
                {form?.status === 'published' && publicUrl && (
                  <Button type="button" variant="outline" size="sm" className="mt-4" onClick={() => window.open(publicUrl, '_blank')}>
                    <Eye className="size-3.5 mr-1.5" /> Open form
                  </Button>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                {submissions.map((sub: any) => {
                  const data = typeof sub.data === 'string' ? JSON.parse(sub.data) : (sub.data || {})
                  const fieldLabels: Record<string, string> = {}
                  for (const f of fields) { fieldLabels[f.id] = f.label }

                  return (
                    <div key={sub.id} className="bg-card rounded-lg border p-4">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          {sub.contact_name && (
                            <span className="text-sm font-medium">{sub.contact_name}</span>
                          )}
                          {sub.contact_email && (
                            <span className="text-xs text-muted-foreground">{sub.contact_email}</span>
                          )}
                          {!sub.contact_name && !sub.contact_email && (
                            <span className="text-xs text-muted-foreground">Anonymous</span>
                          )}
                        </div>
                        <span className="text-[10px] text-muted-foreground">
                          {new Date(sub.created_at).toLocaleString()}
                        </span>
                      </div>
                      <div className="grid gap-2">
                        {Object.entries(data).filter(([key]) => !key.startsWith('_') && key !== 'funnel_sid' && key !== 'funnel_step' && key !== 'funnel_slug').map(([key, value]) => {
                          const label = fieldLabels[key] || key
                          const display = Array.isArray(value) ? (value as string[]).join(', ') : String(value || '')
                          if (!display) return null
                          return (
                            <div key={key} className="flex gap-3 text-sm">
                              <span className="text-muted-foreground font-medium min-w-[120px] shrink-0">{label}</span>
                              <span className="text-foreground break-words">{display}</span>
                            </div>
                          )
                        })}
                      </div>
                      {sub.referrer && (
                        <p className="text-[10px] text-muted-foreground/50 mt-2">Source: {sub.referrer}</p>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Main Layout (Builder) ── */}
      {activeTab === 'builder' && <div className="flex flex-1 overflow-hidden">
        {/* ── Left Panel: Field Palette ── */}
        <div className="w-56 border-r bg-card overflow-y-auto shrink-0 p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-3 px-1">Add Fields</p>
          {paletteGroups.map((group) => (
            <div key={group.label} className="mb-4">
              <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70 mb-1.5 px-1">{group.label}</p>
              <div className="space-y-0.5">
                {group.items.map((item) => (
                  <button
                    key={item.type}
                    type="button"
                    className="flex items-center gap-2.5 w-full rounded-md px-2.5 py-2 text-xs hover:bg-muted transition-colors text-left"
                    onClick={() => addField(item.type)}
                  >
                    <span className="text-muted-foreground">{item.icon}</span>
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* ── Center: Canvas ── */}
        <div className="flex-1 overflow-y-auto p-6 bg-muted/30">
          <div className="max-w-xl mx-auto">
            {/* Form title & description (always visible) */}
            <div className="bg-card rounded-lg border p-5 mb-4">
              <input
                type="text"
                value={formName}
                onChange={(e) => {
                  setFormName(e.target.value)
                  triggerSave(undefined, e.target.value)
                }}
                placeholder="Form Title"
                className="w-full text-xl font-bold bg-transparent border-none outline-none placeholder:text-muted-foreground/40 mb-2"
              />
              <input
                type="text"
                value={formDescription}
                onChange={(e) => {
                  setFormDescription(e.target.value)
                  triggerSave(undefined, undefined, undefined, e.target.value)
                }}
                placeholder="Add a description (optional)"
                className="w-full text-sm text-muted-foreground bg-transparent border-none outline-none placeholder:text-muted-foreground/30"
              />
            </div>

            {fields.length === 0 ? (
              <div className="rounded-xl border-muted-foreground/20 p-12 text-center">
                <div className="inline-flex items-center justify-center size-12 rounded-xl bg-muted text-muted-foreground mb-3">
                  <Plus className="size-5" />
                </div>
                <p className="text-sm text-muted-foreground mb-1">No fields yet</p>
                <p className="text-xs text-muted-foreground/70">Click a field type on the left or use the button below to add fields.</p>
              </div>
            ) : (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={fields.map((f) => f.id)} strategy={verticalListSortingStrategy}>
                  <div className="space-y-2">
                    {fields.map((field) => (
                      <SortableField
                        key={field.id}
                        field={field}
                        isSelected={field.id === selectedFieldId}
                        onSelect={setSelectedFieldId}
                        onDelete={deleteField}
                        onDuplicate={duplicateField}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            )}

            {/* Add field dropdown */}
            <div className="mt-4 text-center relative">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-muted-foreground"
                onClick={() => setShowAddFieldMenu(!showAddFieldMenu)}
              >
                <Plus className="size-3.5 mr-1.5" /> Add field <ChevronDown className="size-3 ml-1.5" />
              </Button>

              {showAddFieldMenu && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowAddFieldMenu(false)} />
                  <div className="absolute z-20 mt-1 left-1/2 -translate-x-1/2 w-56 bg-card rounded-lg border shadow-lg py-1 max-h-72 overflow-y-auto">
                    {paletteGroups.map((group) => (
                      <div key={group.label}>
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 px-3 pt-2 pb-1">{group.label}</p>
                        {group.items.map((item) => (
                          <button
                            key={item.type}
                            type="button"
                            className="flex items-center gap-2.5 w-full px-3 py-1.5 text-xs hover:bg-muted transition-colors text-left"
                            onClick={() => { addField(item.type); setShowAddFieldMenu(false) }}
                          >
                            <span className="text-muted-foreground">{item.icon}</span>
                            {item.label}
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* ── Right Panel: Properties ── */}
        <div className="w-72 border-l bg-card overflow-y-auto shrink-0">
          {selectedField ? (
            <FieldProperties
              field={selectedField}
              onChange={(patch) => updateField(selectedField.id, patch)}
              onDelete={() => deleteField(selectedField.id)}
            />
          ) : (
            <div className="p-4 space-y-5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Form Settings</p>

              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Submit Button Text</label>
                <Input
                  value={form.settings?.submitLabel || 'Submit'}
                  onChange={(e) => {
                    const nextSettings = { ...form.settings, submitLabel: e.target.value }
                    setForm({ ...form, settings: nextSettings } as Form)
                    triggerSave(undefined, undefined, undefined, undefined, nextSettings)
                  }}
                  className="h-8 text-sm"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Success Message</label>
                <Input
                  value={form.settings?.successMessage || ''}
                  onChange={(e) => {
                    const nextSettings = { ...form.settings, successMessage: e.target.value }
                    setForm({ ...form, settings: nextSettings } as Form)
                    triggerSave(undefined, undefined, undefined, undefined, nextSettings)
                  }}
                  className="h-8 text-sm"
                  placeholder="Thank you for your submission!"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Notification Email</label>
                <Input
                  value={form.settings?.notifyEmail || ''}
                  onChange={(e) => {
                    const nextSettings = { ...form.settings, notifyEmail: e.target.value }
                    setForm({ ...form, settings: nextSettings } as Form)
                    triggerSave(undefined, undefined, undefined, undefined, nextSettings)
                  }}
                  className="h-8 text-sm"
                  placeholder="you@company.com"
                  type="email"
                />
                <p className="text-[10px] text-muted-foreground mt-1">Get an email each time someone submits this form.</p>
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Redirect URL (optional)</label>
                <Input
                  value={form.settings?.redirectUrl || ''}
                  onChange={(e) => {
                    const nextSettings = { ...form.settings, redirectUrl: e.target.value }
                    setForm({ ...form, settings: nextSettings } as Form)
                    triggerSave(undefined, undefined, undefined, undefined, nextSettings)
                  }}
                  className="h-8 text-sm"
                  placeholder="https://yoursite.com/thank-you"
                />
                <p className="text-[10px] text-muted-foreground mt-1">Redirect to this URL after submission instead of showing the success message.</p>
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Auto-create CRM contact</label>
                  <p className="text-[10px] text-muted-foreground/60">From email field submissions</p>
                </div>
                <button
                  type="button"
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${form.settings?.createContact ? 'bg-accent' : 'bg-muted'}`}
                  onClick={() => {
                    const nextSettings = { ...form.settings, createContact: !form.settings?.createContact }
                    setForm({ ...form, settings: nextSettings } as Form)
                    triggerSave(undefined, undefined, undefined, undefined, nextSettings)
                  }}
                >
                  <span className={`inline-block size-3.5 rounded-full bg-white shadow transition-transform ${form.settings?.createContact ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
                </button>
              </div>

              <div className="pt-3 border-t">
                <p className="text-[10px] text-muted-foreground text-center">Click a field on the canvas to edit its properties</p>
              </div>
            </div>
          )}
        </div>
      </div>}

      {/* ── Theme Modal ── */}
      {showTheme && (
        <ModalOverlay onClose={() => setShowTheme(false)}>
          <div className="bg-background rounded-xl border shadow-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-5">
              <h3 className="font-semibold">Theme Settings</h3>
              <IconButton variant="ghost" size="sm" type="button" aria-label="Close" onClick={() => setShowTheme(false)}>
                <X className="size-4" />
              </IconButton>
            </div>

            <div className="space-y-4">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Primary Color</label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={theme.primaryColor}
                    onChange={(e) => updateTheme({ primaryColor: e.target.value })}
                    className="size-9 rounded border cursor-pointer"
                  />
                  <Input
                    value={theme.primaryColor}
                    onChange={(e) => updateTheme({ primaryColor: e.target.value })}
                    className="h-9 w-28 text-sm font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Font</label>
                <select
                  value={theme.font}
                  onChange={(e) => updateTheme({ font: e.target.value })}
                  className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                >
                  {fontOptions.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Corners</label>
                <div className="flex gap-1.5">
                  {(['sharp', 'rounded', 'pill'] as const).map((c) => (
                    <Button
                      key={c}
                      type="button"
                      variant={theme.corners === c ? 'default' : 'outline'}
                      size="sm"
                      className="flex-1 capitalize"
                      onClick={() => updateTheme({ corners: c })}
                    >
                      {c}
                    </Button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Background</label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={theme.background}
                    onChange={(e) => updateTheme({ background: e.target.value })}
                    className="size-9 rounded border cursor-pointer"
                  />
                  <Input
                    value={theme.background}
                    onChange={(e) => updateTheme({ background: e.target.value })}
                    className="h-9 w-28 text-sm font-mono"
                  />
                </div>
              </div>
            </div>
          </div>
        </ModalOverlay>
      )}

      {/* ── Published Screen ── */}
      {activeTab === 'published' && (
        <div className="flex-1 flex items-center justify-center p-6 bg-muted/30">
          <div className="max-w-lg w-full">
            <div className="bg-card rounded-xl border shadow-sm p-8 text-center">
              <div className="inline-flex items-center justify-center size-14 rounded-full border border-[rgba(16,185,129,.26)] bg-[rgba(16,185,129,.10)] text-[#047857] dark:border-[rgba(16,185,129,.30)] dark:bg-[rgba(16,185,129,.14)] dark:text-[#34d399] mb-5">
                <Check className="size-7" />
              </div>
              <h2 className="text-xl font-bold mb-2">Your form is published!</h2>
              <p className="text-sm text-muted-foreground mb-8">Share it with your audience or embed it on your website.</p>

              <div className="space-y-5 text-left">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Shareable Link</label>
                  <div className="flex gap-2">
                    <Input value={publicUrl} readOnly className="h-9 text-xs font-mono" />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => copyToClipboard(publicUrl, 'link')}
                    >
                      {copied === 'link' ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                    </Button>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Embed HTML</label>
                  <div className="flex gap-2">
                    <textarea
                      readOnly
                      value={embedCode}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono resize-none h-20"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="shrink-0 self-start"
                      onClick={() => copyToClipboard(embedCode, 'embed')}
                    >
                      {copied === 'embed' ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                    </Button>
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1">Paste this into any HTML page to embed your form.</p>
                </div>
              </div>

              <div className="flex items-center justify-center gap-3 mt-8 pt-6 border-t">
                <Button type="button" variant="outline" onClick={() => window.open(publicUrl, '_blank')}>
                  <Eye className="size-4 mr-2" /> Preview
                </Button>
                <Button type="button" variant="outline" onClick={() => setActiveTab('builder')}>
                  <ArrowLeft className="size-4 mr-2" /> Back to editor
                </Button>
                <Button type="button" onClick={() => window.location.href = '/backend/forms'}>
                  Back to forms
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Sortable Field Component ──

function SortableField({
  field,
  isSelected,
  onSelect,
  onDelete,
  onDuplicate,
}: {
  field: FormField
  isSelected: boolean
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onDuplicate: (id: string) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: field.id })
  const style = { transform: CSS.Transform.toString(transform), transition }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group relative rounded-lg border bg-card p-4 transition cursor-pointer ${
        isSelected ? 'ring-2 ring-accent border-accent' : 'hover:border-accent/40'
      }`}
      onClick={() => onSelect(field.id)}
    >
      {/* Drag handle */}
      <div
        className="absolute left-1.5 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-4 text-muted-foreground" />
      </div>

      {/* Field preview */}
      <div className="ml-5 mr-14">
        {field.type === 'section' ? (
          <h3 className="text-base font-semibold">{field.label}</h3>
        ) : field.type === 'page_break' ? (
          <div className="flex items-center gap-3 py-1">
            <div className="flex-1 border-t border" />
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Page Break</span>
            <div className="flex-1 border-t border" />
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium">
                {field.label}
                {field.required && <span className="text-destructive ml-0.5">*</span>}
              </label>
              {field.crm_mapping && (
                <Badge variant="blue">CRM</Badge>
              )}
            </div>
            {field.description && (
              <p className="text-xs text-muted-foreground mt-0.5">{field.description}</p>
            )}
            <div className="mt-1.5 pointer-events-none">
              <FieldPreview field={field} />
            </div>
          </>
        )}
      </div>

      {/* Action buttons */}
      <div className="absolute right-2 top-2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <IconButton
          variant="ghost"
          size="xs"
          type="button"
          aria-label="Duplicate field"
          onClick={(e) => { e.stopPropagation(); onDuplicate(field.id) }}
        >
          <Copy className="size-3" />
        </IconButton>
        <IconButton
          variant="ghost"
          size="xs"
          type="button"
          aria-label="Delete field"
          onClick={(e) => { e.stopPropagation(); onDelete(field.id) }}
        >
          <Trash2 className="size-3 text-muted-foreground hover:text-destructive" />
        </IconButton>
      </div>
    </div>
  )
}

// ── Field Preview (disabled mock inputs) ──

function FieldPreview({ field }: { field: FormField }) {
  switch (field.type) {
    case 'short_text':
    case 'email':
    case 'phone':
    case 'number':
    case 'date':
      return (
        <div className="h-9 rounded-md border border-input bg-muted/30 px-3 flex items-center text-sm text-muted-foreground">
          {field.placeholder || field.type}
        </div>
      )
    case 'long_text':
      return (
        <div className="h-20 rounded-md border border-input bg-muted/30 px-3 pt-2 text-sm text-muted-foreground">
          {field.placeholder || 'Enter text...'}
        </div>
      )
    case 'select':
      return (
        <div className="h-9 rounded-md border border-input bg-muted/30 px-3 flex items-center justify-between text-sm text-muted-foreground">
          <span>{field.options?.[0] || 'Select...'}</span>
          <ChevronDown className="size-3.5" />
        </div>
      )
    case 'multi_select':
      return (
        <div className="h-9 rounded-md border border-input bg-muted/30 px-3 flex items-center justify-between text-sm text-muted-foreground">
          <span>Select multiple...</span>
          <ChevronDown className="size-3.5" />
        </div>
      )
    case 'radio':
      return (
        <div className="space-y-1.5">
          {(field.options || []).map((opt, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className="size-4 rounded-full border-2 border-muted-foreground/30" />
              <span className="text-sm text-muted-foreground">{opt}</span>
            </div>
          ))}
        </div>
      )
    case 'checkbox':
      return (
        <div className="space-y-1.5">
          {(field.options || []).map((opt, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className="size-4 rounded border-2 border-muted-foreground/30" />
              <span className="text-sm text-muted-foreground">{opt}</span>
            </div>
          ))}
        </div>
      )
    case 'rating':
      return (
        <div className="flex gap-1">
          {Array.from({ length: 5 }).map((_, i) => (
            <Star key={i} className="size-5 text-muted-foreground/30" />
          ))}
        </div>
      )
    case 'yes_no':
      return (
        <div className="flex gap-2">
          <div className="h-8 px-4 rounded-md border border-input bg-muted/30 flex items-center text-sm text-muted-foreground">Yes</div>
          <div className="h-8 px-4 rounded-md border border-input bg-muted/30 flex items-center text-sm text-muted-foreground">No</div>
        </div>
      )
    case 'file':
      return (
        <div className="h-20 rounded-md border-muted-foreground/20 flex flex-col items-center justify-center text-muted-foreground">
          <Upload className="size-4 mb-1" />
          <span className="text-xs">Click or drag to upload</span>
        </div>
      )
    default:
      return null
  }
}

// ── Field Properties Panel ──

function FieldProperties({
  field,
  onChange,
  onDelete,
}: {
  field: FormField
  onChange: (patch: Partial<FormField>) => void
  onDelete: () => void
}) {
  const isLayout = field.type === 'section' || field.type === 'page_break'
  const hasOptions = ['select', 'multi_select', 'radio', 'checkbox'].includes(field.type)

  return (
    <div className="p-4 space-y-4">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Field Properties</p>

      {/* Label */}
      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1 block">Label</label>
        <Input
          value={field.label}
          onChange={(e) => onChange({ label: e.target.value })}
          className="h-8 text-sm"
        />
      </div>

      {/* Placeholder — not for layout or choice fields */}
      {!isLayout && !hasOptions && field.type !== 'rating' && field.type !== 'yes_no' && field.type !== 'file' && (
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">Placeholder</label>
          <Input
            value={field.placeholder || ''}
            onChange={(e) => onChange({ placeholder: e.target.value })}
            className="h-8 text-sm"
          />
        </div>
      )}

      {/* Description */}
      {!isLayout && (
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">Help Text</label>
          <Input
            value={field.description || ''}
            onChange={(e) => onChange({ description: e.target.value })}
            className="h-8 text-sm"
            placeholder="Optional description shown below the field"
          />
        </div>
      )}

      {/* Required */}
      {!isLayout && (
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-muted-foreground">Required</label>
          <button
            type="button"
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${field.required ? 'bg-accent' : 'bg-muted'}`}
            onClick={() => onChange({ required: !field.required })}
          >
            <span className={`inline-block size-3.5 rounded-full bg-white shadow transition-transform ${field.required ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
          </button>
        </div>
      )}

      {/* Width */}
      {!isLayout && (
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Width</label>
          <div className="flex gap-1">
            <Button
              type="button"
              variant={field.width === 'full' ? 'default' : 'outline'}
              size="sm"
              className="flex-1 text-xs"
              onClick={() => onChange({ width: 'full' })}
            >
              Full
            </Button>
            <Button
              type="button"
              variant={field.width === 'half' ? 'default' : 'outline'}
              size="sm"
              className="flex-1 text-xs"
              onClick={() => onChange({ width: 'half' })}
            >
              Half
            </Button>
          </div>
        </div>
      )}

      {/* Options editor */}
      {hasOptions && (
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Options</label>
          <div className="space-y-1.5">
            {(field.options || []).map((opt, idx) => (
              <div key={idx} className="flex items-center gap-1.5">
                <Input
                  value={opt}
                  onChange={(e) => {
                    const updated = [...(field.options || [])]
                    updated[idx] = e.target.value
                    onChange({ options: updated })
                  }}
                  className="h-7 text-xs flex-1"
                />
                <IconButton
                  variant="ghost"
                  size="xs"
                  type="button"
                  aria-label="Remove option"
                  onClick={() => {
                    const updated = (field.options || []).filter((_, i) => i !== idx)
                    onChange({ options: updated })
                  }}
                >
                  <X className="size-3" />
                </IconButton>
              </div>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-auto text-xs px-0 text-muted-foreground"
              onClick={() => onChange({ options: [...(field.options || []), `Option ${(field.options?.length || 0) + 1}`] })}
            >
              <Plus className="size-3 mr-1" /> Add option
            </Button>
          </div>
        </div>
      )}

      {/* Number validation */}
      {field.type === 'number' && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Min</label>
            <Input
              type="number"
              value={field.validation?.min as string || ''}
              onChange={(e) => onChange({ validation: { ...field.validation, min: e.target.value ? Number(e.target.value) : undefined } })}
              className="h-7 text-xs"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Max</label>
            <Input
              type="number"
              value={field.validation?.max as string || ''}
              onChange={(e) => onChange({ validation: { ...field.validation, max: e.target.value ? Number(e.target.value) : undefined } })}
              className="h-7 text-xs"
            />
          </div>
        </div>
      )}

      {/* Rating max stars */}
      {field.type === 'rating' && (
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">Max Stars</label>
          <div className="flex gap-1">
            {[5, 10].map((n) => (
              <Button
                key={n}
                type="button"
                variant={((field.validation?.maxStars as number) || 5) === n ? 'default' : 'outline'}
                size="sm"
                className="flex-1 text-xs"
                onClick={() => onChange({ validation: { ...field.validation, maxStars: n } })}
              >
                {n} stars
              </Button>
            ))}
          </div>
        </div>
      )}

      {/* CRM Mapping */}
      {!isLayout && (
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">CRM Mapping</label>
          <select
            value={field.crm_mapping || ''}
            onChange={(e) => onChange({ crm_mapping: e.target.value || undefined })}
            className="w-full h-8 rounded-md border border-input bg-background px-2 text-xs"
          >
            {crmMappingOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <p className="text-[10px] text-muted-foreground mt-1">Map this field to a CRM contact or company field</p>
        </div>
      )}

      {/* Delete */}
      <div className="pt-3 border-t">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full text-destructive hover:text-destructive hover:bg-destructive/10 text-xs"
          onClick={onDelete}
        >
          <Trash2 className="size-3 mr-1.5" /> Delete Field
        </Button>
      </div>
    </div>
  )
}

// ── Modal Overlay ──

function ModalOverlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}
