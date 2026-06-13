'use client'

import { useState, useEffect, useCallback } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Badge } from '@open-mercato/ui/primitives/badge'
import {
  Plus, ClipboardList, Globe, Eye, BarChart3, Copy, Trash2, Check, Code, Link2,
  MoreHorizontal, Pencil, ExternalLink, FileText, Mail, Phone,
  Star, MessageSquare, Calendar, Briefcase, Users, Zap,
} from 'lucide-react'

type Form = {
  id: string
  name: string
  slug: string
  status: 'draft' | 'published'
  submission_count: number
  fields: FormField[]
  theme: FormTheme
  settings: FormSettings
  created_at: string
  updated_at: string
}

type FormField = {
  id: string
  type: string
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

type TemplateCategory = 'all' | 'contact' | 'booking' | 'feedback' | 'lead_gen'

type Template = {
  id: string
  name: string
  description: string
  category: TemplateCategory
  icon: React.ReactNode
  fieldCount: number
  fields: Omit<FormField, 'id' | 'order'>[]
  settings: Partial<FormSettings>
}

const templates: Template[] = [
  {
    id: 'contact',
    name: 'Contact Form',
    description: 'Simple contact form with name, email, and message',
    category: 'contact',
    icon: <Mail className="size-5" />,
    fieldCount: 5,
    fields: [
      { type: 'short_text', label: 'First Name', placeholder: 'John', required: true, width: 'half', crm_mapping: 'contact.first_name' },
      { type: 'short_text', label: 'Last Name', placeholder: 'Doe', required: true, width: 'half', crm_mapping: 'contact.last_name' },
      { type: 'email', label: 'Email', placeholder: 'john@example.com', required: true, width: 'full', crm_mapping: 'contact.email' },
      { type: 'phone', label: 'Phone', placeholder: '+1 (555) 000-0000', required: false, width: 'full', crm_mapping: 'contact.phone' },
      { type: 'long_text', label: 'Message', placeholder: 'How can we help you?', required: true, width: 'full' },
    ],
    settings: { submitLabel: 'Send Message', successMessage: 'Thank you! We\'ll be in touch soon.' },
  },
  {
    id: 'quote_request',
    name: 'Quote Request',
    description: 'Detailed quote request with service selection and budget',
    category: 'lead_gen',
    icon: <Briefcase className="size-5" />,
    fieldCount: 9,
    fields: [
      { type: 'short_text', label: 'Full Name', placeholder: 'John Doe', required: true, width: 'half', crm_mapping: 'contact.first_name' },
      { type: 'short_text', label: 'Company', placeholder: 'Acme Inc.', required: false, width: 'half', crm_mapping: 'company.name' },
      { type: 'email', label: 'Email', placeholder: 'john@company.com', required: true, width: 'half', crm_mapping: 'contact.email' },
      { type: 'phone', label: 'Phone', placeholder: '+1 (555) 000-0000', required: true, width: 'half', crm_mapping: 'contact.phone' },
      { type: 'select', label: 'Service Interested In', required: true, width: 'full', options: ['Web Development', 'Mobile App', 'Design', 'Consulting', 'Other'] },
      { type: 'select', label: 'Budget Range', required: false, width: 'half', options: ['Under $5k', '$5k - $15k', '$15k - $50k', '$50k+'] },
      { type: 'select', label: 'Timeline', required: false, width: 'half', options: ['ASAP', '1-2 months', '3-6 months', 'Flexible'] },
      { type: 'long_text', label: 'Project Details', placeholder: 'Tell us about your project...', required: true, width: 'full' },
      { type: 'checkbox', label: 'How did you hear about us?', required: false, width: 'full', options: ['Google', 'Social Media', 'Referral', 'Other'] },
    ],
    settings: { submitLabel: 'Request Quote', successMessage: 'Thanks! We\'ll prepare your quote within 24 hours.', createContact: true },
  },
  {
    id: 'consultation_booking',
    name: 'Consultation Booking',
    description: 'Book a free consultation with preferred date and time',
    category: 'booking',
    icon: <Calendar className="size-5" />,
    fieldCount: 7,
    fields: [
      { type: 'short_text', label: 'Name', placeholder: 'Your full name', required: true, width: 'half', crm_mapping: 'contact.first_name' },
      { type: 'email', label: 'Email', placeholder: 'you@example.com', required: true, width: 'half', crm_mapping: 'contact.email' },
      { type: 'phone', label: 'Phone', placeholder: '+1 (555) 000-0000', required: true, width: 'full', crm_mapping: 'contact.phone' },
      { type: 'select', label: 'Consultation Type', required: true, width: 'full', options: ['Strategy Session', 'Technical Review', 'Product Demo', 'General Inquiry'] },
      { type: 'date', label: 'Preferred Date', required: true, width: 'half' },
      { type: 'select', label: 'Preferred Time', required: true, width: 'half', options: ['Morning (9-12)', 'Afternoon (12-3)', 'Evening (3-6)'] },
      { type: 'long_text', label: 'What would you like to discuss?', placeholder: 'Brief description of your needs...', required: false, width: 'full' },
    ],
    settings: { submitLabel: 'Book Consultation', successMessage: 'Your consultation request has been received! We\'ll confirm your time slot via email.' },
  },
  {
    id: 'customer_feedback',
    name: 'Customer Feedback',
    description: 'Collect customer satisfaction ratings and feedback',
    category: 'feedback',
    icon: <Star className="size-5" />,
    fieldCount: 6,
    fields: [
      { type: 'short_text', label: 'Name', placeholder: 'Your name', required: false, width: 'half' },
      { type: 'email', label: 'Email', placeholder: 'you@example.com', required: false, width: 'half' },
      { type: 'rating', label: 'Overall Satisfaction', required: true, width: 'full' },
      { type: 'radio', label: 'Would you recommend us?', required: true, width: 'full', options: ['Definitely', 'Probably', 'Not sure', 'Probably not', 'Definitely not'] },
      { type: 'long_text', label: 'What did you like most?', placeholder: 'Tell us what went well...', required: false, width: 'full' },
      { type: 'long_text', label: 'What could we improve?', placeholder: 'How can we do better?', required: false, width: 'full' },
    ],
    settings: { submitLabel: 'Submit Feedback', successMessage: 'Thank you for your feedback! It helps us improve.' },
  },
  {
    id: 'newsletter_signup',
    name: 'Newsletter Signup',
    description: 'Simple email capture for newsletter subscriptions',
    category: 'lead_gen',
    icon: <Zap className="size-5" />,
    fieldCount: 3,
    fields: [
      { type: 'short_text', label: 'First Name', placeholder: 'Your name', required: false, width: 'half', crm_mapping: 'contact.first_name' },
      { type: 'email', label: 'Email Address', placeholder: 'you@example.com', required: true, width: 'half', crm_mapping: 'contact.email' },
      { type: 'checkbox', label: 'Interests', required: false, width: 'full', options: ['Product Updates', 'Industry News', 'Tips & Tutorials', 'Case Studies'] },
    ],
    settings: { submitLabel: 'Subscribe', successMessage: 'You\'re in! Check your email for a confirmation.', createContact: true },
  },
  {
    id: 'event_registration',
    name: 'Event Registration',
    description: 'Register attendees for events and webinars',
    category: 'booking',
    icon: <Users className="size-5" />,
    fieldCount: 7,
    fields: [
      { type: 'short_text', label: 'Full Name', placeholder: 'John Doe', required: true, width: 'half', crm_mapping: 'contact.first_name' },
      { type: 'email', label: 'Email', placeholder: 'john@example.com', required: true, width: 'half', crm_mapping: 'contact.email' },
      { type: 'short_text', label: 'Company', placeholder: 'Acme Inc.', required: false, width: 'half', crm_mapping: 'company.name' },
      { type: 'short_text', label: 'Job Title', placeholder: 'Marketing Manager', required: false, width: 'half' },
      { type: 'select', label: 'How did you hear about this event?', required: false, width: 'full', options: ['Email', 'Social Media', 'Colleague', 'Website', 'Other'] },
      { type: 'checkbox', label: 'Sessions of Interest', required: false, width: 'full', options: ['Keynote', 'Workshop A', 'Workshop B', 'Panel Discussion', 'Networking'] },
      { type: 'long_text', label: 'Dietary Requirements or Accessibility Needs', placeholder: 'Let us know if you have any special requirements...', required: false, width: 'full' },
    ],
    settings: { submitLabel: 'Register Now', successMessage: 'You\'re registered! Check your email for event details.', createContact: true },
  },
  {
    id: 'support_request',
    name: 'Support Request',
    description: 'Submit support tickets with priority and category',
    category: 'feedback',
    icon: <MessageSquare className="size-5" />,
    fieldCount: 7,
    fields: [
      { type: 'short_text', label: 'Name', placeholder: 'Your name', required: true, width: 'half', crm_mapping: 'contact.first_name' },
      { type: 'email', label: 'Email', placeholder: 'you@example.com', required: true, width: 'half', crm_mapping: 'contact.email' },
      { type: 'select', label: 'Category', required: true, width: 'half', options: ['Technical Issue', 'Billing', 'Feature Request', 'General Question'] },
      { type: 'select', label: 'Priority', required: true, width: 'half', options: ['Low', 'Medium', 'High', 'Critical'] },
      { type: 'short_text', label: 'Subject', placeholder: 'Brief description of your issue', required: true, width: 'full' },
      { type: 'long_text', label: 'Description', placeholder: 'Provide as much detail as possible...', required: true, width: 'full' },
      { type: 'file', label: 'Attachments', required: false, width: 'full' },
    ],
    settings: { submitLabel: 'Submit Ticket', successMessage: 'Your support request has been submitted. We\'ll respond within 24 hours.' },
  },
  {
    id: 'lead_capture',
    name: 'Lead Capture',
    description: 'Capture leads with company info and interest level',
    category: 'lead_gen',
    icon: <FileText className="size-5" />,
    fieldCount: 8,
    fields: [
      { type: 'short_text', label: 'First Name', placeholder: 'John', required: true, width: 'half', crm_mapping: 'contact.first_name' },
      { type: 'short_text', label: 'Last Name', placeholder: 'Doe', required: true, width: 'half', crm_mapping: 'contact.last_name' },
      { type: 'email', label: 'Work Email', placeholder: 'john@company.com', required: true, width: 'half', crm_mapping: 'contact.email' },
      { type: 'phone', label: 'Phone', placeholder: '+1 (555) 000-0000', required: false, width: 'half', crm_mapping: 'contact.phone' },
      { type: 'short_text', label: 'Company', placeholder: 'Acme Inc.', required: true, width: 'half', crm_mapping: 'company.name' },
      { type: 'select', label: 'Company Size', required: false, width: 'half', options: ['1-10', '11-50', '51-200', '201-1000', '1000+'] },
      { type: 'select', label: 'Interest Level', required: false, width: 'full', options: ['Just exploring', 'Evaluating solutions', 'Ready to purchase', 'Need demo first'] },
      { type: 'long_text', label: 'Anything else you\'d like us to know?', placeholder: 'Optional message...', required: false, width: 'full' },
    ],
    settings: { submitLabel: 'Get Started', successMessage: 'Thanks for your interest! A team member will reach out shortly.', createContact: true },
  },
]

const categoryLabels: Record<TemplateCategory, string> = {
  all: 'All',
  contact: 'Contact',
  booking: 'Booking',
  feedback: 'Feedback',
  lead_gen: 'Lead Gen',
}

const categoryIcons: Record<TemplateCategory, React.ReactNode> = {
  all: <ClipboardList className="size-3.5" />,
  contact: <Mail className="size-3.5" />,
  booking: <Calendar className="size-3.5" />,
  feedback: <Star className="size-3.5" />,
  lead_gen: <Zap className="size-3.5" />,
}

const statusVariants: Record<string, 'amber' | 'green'> = {
  draft: 'amber',
  published: 'green',
}

type Submission = {
  id: string
  form_id: string
  data: Record<string, unknown>
  contact_name: string | null
  contact_email: string | null
  created_at: string
  form_name?: string
}

export default function FormsListPage() {
  const [forms, setForms] = useState<Form[]>([])
  const [loading, setLoading] = useState(true)
  const [showTemplateModal, setShowTemplateModal] = useState(false)
  const [selectedCategory, setSelectedCategory] = useState<TemplateCategory>('all')
  const [creating, setCreating] = useState(false)
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  function copyText(text: string, id: string) {
    navigator.clipboard.writeText(text).then(() => { setCopiedId(id); setTimeout(() => setCopiedId(null), 2000) })
  }
  const [pageTab, setPageTab] = useState<'forms' | 'responses'>('forms')
  const [submissions, setSubmissions] = useState<Submission[]>([])
  const [loadingSubs, setLoadingSubs] = useState(false)
  const [subsFilterFormId, setSubsFilterFormId] = useState<string>('')

  const loadForms = useCallback(() => {
    fetch('/api/forms', { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => { if (d.ok) setForms(d.data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  const loadAllSubmissions = useCallback(async (formsList: Form[]) => {
    setLoadingSubs(true)
    const allSubs: Submission[] = []
    for (const f of formsList) {
      try {
        const res = await fetch(`/api/forms/${f.id}/submissions?pageSize=100`, { credentials: 'include' })
        const d = await res.json()
        if (d.ok && d.data) {
          for (const sub of d.data) {
            allSubs.push({ ...sub, form_name: f.name, data: typeof sub.data === 'string' ? JSON.parse(sub.data) : (sub.data || {}) })
          }
        }
      } catch { /* skip */ }
    }
    allSubs.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    setSubmissions(allSubs)
    setLoadingSubs(false)
  }, [])

  useEffect(() => { loadForms() }, [loadForms])

  const filteredTemplates = selectedCategory === 'all'
    ? templates
    : templates.filter((t) => t.category === selectedCategory)

  async function createFromTemplate(template: Template | null) {
    if (creating) return
    setCreating(true)
    try {
      const uid = () => Math.random().toString(36).substring(2) + Date.now().toString(36)
      const body = template
        ? {
            name: template.name,
            fields: template.fields.map((f, i) => ({ ...f, id: uid(), order: i })),
            settings: { submitLabel: 'Submit', successMessage: 'Thank you for your submission!', createContact: false, ...(template.settings || {}) },
            theme: { primaryColor: '#2563eb', font: 'Inter', corners: 'rounded', background: '#ffffff' },
            templateId: template.id,
          }
        : {
            name: 'Untitled Form',
            fields: [],
            settings: { submitLabel: 'Submit', successMessage: 'Thank you for your submission!', createContact: false },
            theme: { primaryColor: '#2563eb', font: 'Inter', corners: 'rounded', background: '#ffffff' },
          }

      const res = await fetch('/api/forms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (data.ok && data.data?.id) {
        window.location.href = `/backend/forms/builder?id=${data.data.id}`
      } else {
        alert(`Failed to create form: ${data.error || 'Unknown error'}`)
        setCreating(false)
      }
    } catch (err) {
      alert(`Error: ${err instanceof Error ? err.message : String(err)}`)
      setCreating(false)
    }
  }

  async function duplicateForm(form: Form, event: React.MouseEvent) {
    event.stopPropagation()
    setOpenMenuId(null)
    try {
      const res = await fetch("/api/forms", { credentials: "include",
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `${form.name} (Copy)`,
          fields: form.fields,
          settings: form.settings,
          theme: form.theme,
        }),
      })
      const data = await res.json()
      if (data.ok) loadForms()
    } catch { /* ignore */ }
  }

  async function deleteForm(form: Form, event: React.MouseEvent) {
    event.stopPropagation()
    setOpenMenuId(null)
    if (!confirm(`Delete "${form.name}"? This cannot be undone.`)) return
    try {
      await fetch(`/api/forms/${form.id}`, { method: 'DELETE', credentials: 'include' })
      loadForms()
    } catch { /* ignore */ }
  }

  const hasForms = forms.length > 0

  function renderTemplateGallery(inModal: boolean) {
    return (
      <div className={inModal ? '' : 'max-w-4xl mx-auto'}>
        {!inModal && (
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center size-14 rounded-2xl bg-accent/10 text-accent mb-4">
              <ClipboardList className="size-7" />
            </div>
            <h2 className="text-xl font-semibold mb-2">Collect leads, feedback, and bookings</h2>
            <p className="text-muted-foreground text-sm max-w-md mx-auto">
              Forms that automatically create contacts and trigger automations. Start from a template or build your own.
            </p>
          </div>
        )}

        <div className="flex items-center justify-center gap-1.5 mb-6">
          {(Object.keys(categoryLabels) as TemplateCategory[]).map((cat) => (
            <Button
              key={cat}
              type="button"
              variant={selectedCategory === cat ? 'default' : 'outline'}
              size="sm"
              onClick={() => setSelectedCategory(cat)}
              className="gap-1.5"
            >
              {categoryIcons[cat]}
              {categoryLabels[cat]}
            </Button>
          ))}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredTemplates.map((template) => (
            <div
              key={template.id}
              className="group rounded-lg border bg-card p-5 hover:border-accent/60 hover:shadow-sm transition-all"
            >
              <div className="flex items-start gap-3 mb-3">
                <div className="flex items-center justify-center size-10 rounded-lg bg-muted text-muted-foreground group-hover:bg-accent/10 group-hover:text-accent transition-colors">
                  {template.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-medium text-sm">{template.name}</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">{template.fieldCount} fields</p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground mb-4 line-clamp-2">{template.description}</p>
              <button
                type="button"
                disabled={creating}
                onClick={() => createFromTemplate(template)}
                className="inline-flex items-center justify-center gap-1.5 w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-50"
              >
                {creating ? 'Creating...' : 'Use this template'}
                {!creating && <ExternalLink className="size-3" />}
              </button>
            </div>
          ))}
        </div>

      </div>
    )
  }

  if (loading) {
    return (
      <div className="p-6">
        <div className="text-muted-foreground text-sm">Loading...</div>
      </div>
    )
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold">Forms</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={creating}
            onClick={() => createFromTemplate(null)}
            className="inline-flex items-center gap-2 rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-50"
          >
            <Plus className="size-4" /> {creating ? 'Creating...' : 'Create a Form'}
          </button>
          {hasForms && (
            <Button type="button" onClick={() => setShowTemplateModal(true)}>
              <Plus className="size-4 mr-2" /> From Template
            </Button>
          )}
        </div>
      </div>

      {/* Tab switcher */}
      {hasForms && (
        <div className="flex items-center gap-1 mb-6 border-b">
          <button
            type="button"
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${pageTab === 'forms' ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            onClick={() => setPageTab('forms')}
          >
            Forms ({forms.length})
          </button>
          <button
            type="button"
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${pageTab === 'responses' ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            onClick={() => { setPageTab('responses'); if (submissions.length === 0 && forms.length > 0) loadAllSubmissions(forms) }}
          >
            Responses
          </button>
        </div>
      )}

      {/* ── Responses Tab ── */}
      {pageTab === 'responses' && (
        <div>
          {/* Filter by form */}
          <div className="flex items-center gap-3 mb-4">
            <select
              value={subsFilterFormId}
              onChange={(e) => setSubsFilterFormId(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">All forms</option>
              {forms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
            <Button type="button" variant="outline" size="sm" onClick={() => loadAllSubmissions(forms)}>
              Refresh
            </Button>
          </div>

          {loadingSubs ? (
            <div className="text-center py-16 text-sm text-muted-foreground">Loading submissions...</div>
          ) : (() => {
            const filtered = subsFilterFormId ? submissions.filter((s) => s.form_id === subsFilterFormId) : submissions
            if (filtered.length === 0) {
              return (
                <div className="rounded-xl border-muted-foreground/20 p-12 text-center">
                  <BarChart3 className="size-8 mx-auto text-muted-foreground/30 mb-3" />
                  <p className="text-sm text-muted-foreground">No submissions yet</p>
                  <p className="text-xs text-muted-foreground/60 mt-1">Responses will appear here when people fill out your forms.</p>
                </div>
              )
            }
            return (
              <div className="space-y-3">
                {filtered.map((sub) => {
                  const data = sub.data || {}
                  const formMatch = forms.find((f) => f.id === sub.form_id)
                  const fieldLabels: Record<string, string> = {}
                  if (formMatch) {
                    const fields = typeof formMatch.fields === 'string' ? JSON.parse(formMatch.fields as unknown as string) : (formMatch.fields || [])
                    for (const f of fields) fieldLabels[f.id] = f.label
                  }
                  return (
                    <div key={sub.id} className="bg-card rounded-lg border p-4">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] px-2 py-0.5 rounded bg-muted text-muted-foreground font-medium">{sub.form_name || 'Unknown Form'}</span>
                          {sub.contact_name && <span className="text-sm font-medium">{sub.contact_name}</span>}
                          {sub.contact_email && <span className="text-xs text-muted-foreground">{sub.contact_email}</span>}
                          {!sub.contact_name && !sub.contact_email && <span className="text-xs text-muted-foreground">Anonymous</span>}
                        </div>
                        <span className="text-[10px] text-muted-foreground">{new Date(sub.created_at).toLocaleString()}</span>
                      </div>
                      <div className="grid gap-1.5">
                        {Object.entries(data).filter(([key]) => !key.startsWith('_') && key !== 'funnel_sid' && key !== 'funnel_step' && key !== 'funnel_slug').map(([key, value]) => {
                          const label = fieldLabels[key] || key
                          const display = Array.isArray(value) ? (value as string[]).join(', ') : String(value || '')
                          if (!display) return null
                          return (
                            <div key={key} className="flex gap-3 text-sm">
                              <span className="text-muted-foreground font-medium min-w-[120px] shrink-0 text-xs">{label}</span>
                              <span className="text-foreground break-words text-xs">{display}</span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          })()}
        </div>
      )}

      {pageTab === 'forms' && (<>


      {!hasForms ? (
        <div className="rounded-xl border bg-card/50 p-8 sm:p-12">
          {renderTemplateGallery(false)}
        </div>
      ) : (
        <div className="rounded-lg border divide-y">
          {forms.map((form) => {
            const publicUrl = `${window.location.origin}/api/forms/public/${form.slug}`
            const embedCode = `<iframe src="${publicUrl}" width="100%" height="600" frameborder="0" style="border:none;border-radius:8px"></iframe>`
            return (
              <div key={form.id} className="px-5 py-5">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center shrink-0">
                    <ClipboardList className="size-5 text-accent" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <h3 className="text-sm font-medium truncate">{form.name}</h3>
                      <Badge variant={statusVariants[form.status] || 'secondary'} className="shrink-0">
                        {form.status}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {form.submission_count} submission{form.submission_count !== 1 ? 's' : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button type="button" variant="ghost" size="sm" className="h-8 text-xs"
                      onClick={() => window.location.href = `/backend/forms/builder?id=${form.id}`}>
                      <Pencil className="size-3 mr-1" /> Edit
                    </Button>
                    {form.status === 'published' && (
                      <>
                        <Button type="button" variant="ghost" size="sm" className="h-8 text-xs"
                          onClick={() => window.open(publicUrl, '_blank')}>
                          <Eye className="size-3 mr-1" /> View
                        </Button>
                        <Button type="button" variant="ghost" size="sm" className="h-8 text-xs"
                          onClick={() => copyText(publicUrl, `link-${form.id}`)}>
                          {copiedId === `link-${form.id}` ? <Check className="size-3 mr-1" /> : <Link2 className="size-3 mr-1" />}
                          {copiedId === `link-${form.id}` ? 'Copied!' : 'Link'}
                        </Button>
                        <Button type="button" variant="ghost" size="sm" className="h-8 text-xs"
                          onClick={() => copyText(embedCode, `embed-${form.id}`)}>
                          {copiedId === `embed-${form.id}` ? <Check className="size-3 mr-1" /> : <Code className="size-3 mr-1" />}
                          {copiedId === `embed-${form.id}` ? 'Copied!' : 'Embed'}
                        </Button>
                      </>
                    )}
                    <Button type="button" variant="ghost" size="sm" className="h-8 text-xs"
                      onClick={() => window.location.href = `/backend/forms/builder?id=${form.id}&tab=responses`}>
                      <BarChart3 className="size-3 mr-1" /> Responses
                    </Button>
                    <IconButton variant="ghost" size="xs" type="button" aria-label="More"
                      onClick={() => setOpenMenuId(openMenuId === form.id ? null : form.id)}>
                      <MoreHorizontal className="size-3.5" />
                    </IconButton>
                    {openMenuId === form.id && (
                      <div className="absolute right-5 mt-24 w-36 rounded-md border bg-popover shadow-md z-10 py-1">
                        <button type="button" className="flex items-center w-full px-3 py-1.5 text-xs hover:bg-muted gap-2"
                          onClick={(e) => duplicateForm(form, e)}><Copy className="size-3" /> Duplicate</button>
                        <button type="button" className="flex items-center w-full px-3 py-1.5 text-xs hover:bg-muted gap-2 text-destructive"
                          onClick={(e) => deleteForm(form, e)}><Trash2 className="size-3" /> Delete</button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      </>)}

      {/* Template Gallery Modal */}
      {showTemplateModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setShowTemplateModal(false)}
        >
          <div
            className="bg-background rounded-xl border shadow-xl max-w-3xl w-full max-h-[85vh] overflow-y-auto p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-semibold">Choose a template</h2>
              <IconButton
                variant="ghost"
                size="sm"
                type="button"
                aria-label="Close"
                onClick={() => setShowTemplateModal(false)}
              >
                <Plus className="size-4 rotate-45" />
              </IconButton>
            </div>
            {renderTemplateGallery(true)}
          </div>
        </div>
      )}

      {/* Close menu on outside click */}
      {openMenuId && (
        <div className="fixed inset-0 z-[5]" onClick={() => setOpenMenuId(null)} />
      )}
    </div>
  )
}
