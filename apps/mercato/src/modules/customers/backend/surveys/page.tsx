'use client'

import { useState, useEffect, useCallback } from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { translateWithFallback } from '@open-mercato/shared/lib/i18n/translate'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Badge } from '@open-mercato/ui/primitives/badge'
import {
  Plus, Trash2, Copy, Code, ChevronUp, ChevronDown, Check,
  ArrowLeft, BarChart3, X, Eye, ExternalLink, Download, Send,
  ClipboardList, FileText, Star, Hash, Calendar, Mail, Phone,
  Type, AlignLeft, List, CheckSquare, CircleDot, Loader2,
} from 'lucide-react'

type SurveyField = { id: string; type: string; label: string; required?: boolean; options?: string[] }
type Survey = {
  id: string; title: string; description: string | null; slug: string
  fields: SurveyField[] | string; thank_you_message: string
  is_active: boolean; response_count: number; created_at: string
}
type ResponseSummary = { type: string; count: number; average?: number; distribution?: Record<string, number>; counts?: Record<string, number>; samples?: string[] }

const FIELD_TYPES = [
  { value: 'text', label: 'Short Text', icon: Type },
  { value: 'textarea', label: 'Long Text', icon: AlignLeft },
  { value: 'email', label: 'Email', icon: Mail },
  { value: 'phone', label: 'Phone', icon: Phone },
  { value: 'number', label: 'Number', icon: Hash },
  { value: 'date', label: 'Date', icon: Calendar },
  { value: 'select', label: 'Dropdown', icon: List },
  { value: 'multi_select', label: 'Multi Select', icon: CheckSquare },
  { value: 'radio', label: 'Radio Buttons', icon: CircleDot },
  { value: 'checkbox', label: 'Checkbox', icon: CheckSquare },
  { value: 'rating', label: 'Star Rating', icon: Star },
  { value: 'nps', label: 'NPS (0-10)', icon: BarChart3 },
]

const OPTION_TYPES = new Set(['select', 'multi_select', 'radio'])

// House palette for tinted-icon stat tiles (matches the CRM dashboard).
const STAT_COLORS = {
  violet: { icon: 'text-[#7c3aed] dark:text-[#a78bfa]', tile: 'bg-[rgba(124,58,237,0.10)] dark:bg-[rgba(139,92,246,0.16)]' },
  blue: { icon: 'text-[#1d4ed8] dark:text-[#60a5fa]', tile: 'bg-[rgba(37,99,235,0.10)] dark:bg-[rgba(59,130,246,0.15)]' },
  green: { icon: 'text-[#047857] dark:text-[#34d399]', tile: 'bg-[rgba(16,185,129,0.10)] dark:bg-[rgba(16,185,129,0.14)]' },
  amber: { icon: 'text-[#b45309] dark:text-[#fbbf24]', tile: 'bg-[rgba(217,119,6,0.10)] dark:bg-[rgba(245,158,11,0.13)]' },
} as const

// AMS-style compact sparkline with a soft colored area fill (color via currentColor).
function Sparkline({ data, className = '' }: { data: number[]; className?: string }) {
  const w = 84, h = 26, max = Math.max(...data, 1), n = Math.max(data.length - 1, 1)
  const pts = data.map((v, i) => `${(2 + (i * (w - 4)) / n).toFixed(1)},${(h - 4 - (v * (h - 8)) / max).toFixed(1)}`).join(' ')
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden className={`shrink-0 ${className}`}>
      <polygon points={`${pts} ${w - 2},${h} 2,${h}`} className="fill-current opacity-[.12]" />
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// Weekly counts (oldest -> newest) derived client-side from rows already in memory.
function weeklyCounts(dates: Array<string | null | undefined>, weeks = 8): number[] {
  const now = Date.now()
  const out = new Array(weeks).fill(0)
  for (const d of dates) {
    if (!d) continue
    const t = new Date(d).getTime()
    if (Number.isNaN(t)) continue
    const diff = Math.floor((now - t) / (7 * 24 * 60 * 60 * 1000))
    if (diff >= 0 && diff < weeks) out[weeks - 1 - diff]++
  }
  return out
}

function StatTile({ icon: Icon, label, value, color, series }: {
  icon: any; label: string; value: number; color: keyof typeof STAT_COLORS; series?: number[]
}) {
  const c = STAT_COLORS[color]
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between mb-3">
        <div className={`size-9 rounded-lg flex items-center justify-center ${c.tile}`}>
          <Icon className={`size-4 ${c.icon}`} />
        </div>
        {series && series.length > 0 && <Sparkline data={series} className={`${c.icon} opacity-90`} />}
      </div>
      <p className="text-2xl font-bold tabular-nums tracking-tight">{value.toLocaleString()}</p>
      <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
    </div>
  )
}

const TEMPLATES = [
  { id: 'nps', name: 'Net Promoter Score', desc: 'Measure customer loyalty', fields: [
    { id: 'nps1', type: 'nps', label: 'How likely are you to recommend us to a friend or colleague?', required: true },
    { id: 'nps2', type: 'textarea', label: 'What is the primary reason for your score?', required: false },
    { id: 'nps3', type: 'text', label: 'What could we do to improve your experience?', required: false },
  ]},
  { id: 'csat', name: 'Customer Satisfaction', desc: 'Gauge overall satisfaction', fields: [
    { id: 'cs1', type: 'rating', label: 'How satisfied are you with our product/service?', required: true },
    { id: 'cs2', type: 'radio', label: 'How would you rate the quality of customer support?', required: true, options: ['Excellent', 'Good', 'Average', 'Poor'] },
    { id: 'cs3', type: 'radio', label: 'Did our product meet your expectations?', required: true, options: ['Exceeded expectations', 'Met expectations', 'Below expectations'] },
    { id: 'cs4', type: 'textarea', label: 'Any additional comments or suggestions?', required: false },
  ]},
  { id: 'product', name: 'Product Feedback', desc: 'Collect feature requests & feedback', fields: [
    { id: 'pf1', type: 'radio', label: 'How often do you use our product?', required: true, options: ['Daily', 'Weekly', 'Monthly', 'Rarely'] },
    { id: 'pf2', type: 'rating', label: 'How easy is our product to use?', required: true },
    { id: 'pf3', type: 'multi_select', label: 'Which features do you use most?', required: false, options: ['Dashboard', 'Reports', 'Integrations', 'Automations', 'Other'] },
    { id: 'pf4', type: 'textarea', label: 'What feature would you most like to see added?', required: false },
    { id: 'pf5', type: 'nps', label: 'How likely are you to recommend our product?', required: true },
  ]},
  { id: 'event', name: 'Event Feedback', desc: 'Post-event satisfaction survey', fields: [
    { id: 'ev1', type: 'rating', label: 'How would you rate the event overall?', required: true },
    { id: 'ev2', type: 'radio', label: 'How relevant was the content to your needs?', required: true, options: ['Very relevant', 'Somewhat relevant', 'Not relevant'] },
    { id: 'ev3', type: 'radio', label: 'How likely are you to attend future events?', required: true, options: ['Very likely', 'Likely', 'Unlikely', 'Very unlikely'] },
    { id: 'ev4', type: 'text', label: 'What was your favorite part of the event?', required: false },
    { id: 'ev5', type: 'textarea', label: 'Any suggestions for improvement?', required: false },
  ]},
  { id: 'employee', name: 'Employee Satisfaction', desc: 'Internal team pulse check', fields: [
    { id: 'em1', type: 'rating', label: 'How satisfied are you with your role?', required: true },
    { id: 'em2', type: 'radio', label: 'Do you feel valued by your team?', required: true, options: ['Strongly agree', 'Agree', 'Neutral', 'Disagree'] },
    { id: 'em3', type: 'rating', label: 'How would you rate work-life balance?', required: true },
    { id: 'em4', type: 'textarea', label: 'What would make this a better place to work?', required: false },
    { id: 'em5', type: 'nps', label: 'How likely are you to recommend working here?', required: true },
  ]},
  { id: 'onboarding', name: 'Client Onboarding', desc: 'New client intake & expectations', fields: [
    { id: 'ob1', type: 'text', label: 'What is your primary goal for working together?', required: true },
    { id: 'ob2', type: 'radio', label: 'How did you hear about us?', required: true, options: ['Social media', 'Referral', 'Google search', 'Podcast/Content', 'Other'] },
    { id: 'ob3', type: 'radio', label: 'What is your timeline for achieving results?', required: true, options: ['Immediately', '1-3 months', '3-6 months', 'No rush'] },
    { id: 'ob4', type: 'textarea', label: 'What have you tried before that didn\'t work?', required: false },
    { id: 'ob5', type: 'text', label: 'What does success look like to you?', required: true },
  ]},
  { id: 'lead_qualify', name: 'Lead Qualification', desc: 'Qualify inbound leads automatically', fields: [
    { id: 'lq1', type: 'radio', label: 'What best describes your role?', required: true, options: ['Business owner', 'Freelancer', 'Marketing manager', 'Executive', 'Other'] },
    { id: 'lq2', type: 'radio', label: 'What is your company size?', required: true, options: ['Just me', '2-10', '11-50', '50+'] },
    { id: 'lq3', type: 'radio', label: 'What is your budget for this?', required: true, options: ['Under $500', '$500-$2,000', '$2,000-$10,000', '$10,000+'] },
    { id: 'lq4', type: 'radio', label: 'When are you looking to get started?', required: true, options: ['This week', 'This month', 'Next quarter', 'Just researching'] },
    { id: 'lq5', type: 'textarea', label: 'What specific challenge are you trying to solve?', required: true },
  ]},
  { id: 'course_feedback', name: 'Course Feedback', desc: 'Collect feedback from course students', fields: [
    { id: 'cf1', type: 'rating', label: 'How would you rate this course overall?', required: true },
    { id: 'cf2', type: 'radio', label: 'Was the course content relevant to your needs?', required: true, options: ['Very relevant', 'Somewhat relevant', 'Not relevant'] },
    { id: 'cf3', type: 'radio', label: 'How would you rate the pace of the course?', required: true, options: ['Too fast', 'Just right', 'Too slow'] },
    { id: 'cf4', type: 'text', label: 'What was the most valuable thing you learned?', required: false },
    { id: 'cf5', type: 'textarea', label: 'What could be improved?', required: false },
    { id: 'cf6', type: 'nps', label: 'How likely are you to recommend this course?', required: true },
  ]},
  { id: 'market_research', name: 'Market Research', desc: 'Validate ideas & understand your audience', fields: [
    { id: 'mr1', type: 'text', label: 'What is your biggest challenge related to [topic]?', required: true },
    { id: 'mr2', type: 'radio', label: 'How much time do you spend on this each week?', required: true, options: ['Less than 1 hour', '1-5 hours', '5-10 hours', '10+ hours'] },
    { id: 'mr3', type: 'radio', label: 'Have you paid for a solution before?', required: true, options: ['Yes, it worked', 'Yes, it didn\'t work', 'No, never'] },
    { id: 'mr4', type: 'number', label: 'How much would you pay monthly for a solution?', required: false },
    { id: 'mr5', type: 'textarea', label: 'Describe your ideal solution in one paragraph.', required: false },
  ]},
  { id: 'testimonial', name: 'Testimonial Request', desc: 'Collect client testimonials & reviews', fields: [
    { id: 'tr1', type: 'rating', label: 'How would you rate your experience working with us?', required: true },
    { id: 'tr2', type: 'textarea', label: 'What results have you achieved since working with us?', required: true },
    { id: 'tr3', type: 'textarea', label: 'What would you tell someone considering working with us?', required: true },
    { id: 'tr4', type: 'radio', label: 'Can we use your response as a public testimonial?', required: true, options: ['Yes, with my name', 'Yes, anonymously', 'No'] },
  ]},
]

export default function SurveysPage() {
  const t = useT()
  const translate = (key: string, fallback: string) => translateWithFallback(t, key, fallback)

  const [surveys, setSurveys] = useState<Survey[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<'list' | 'pick' | 'create' | 'responses'>('list')
  const [selectedSurvey, setSelectedSurvey] = useState<Survey | null>(null)
  const [responsesData, setResponsesData] = useState<{
    responses: Array<{ id: string; respondent_name: string | null; respondent_email: string | null; responses: Record<string, unknown>; created_at: string }>
    summary: Record<string, ResponseSummary>; totalResponses: number
  } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  // Create form
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [thankYouMessage, setThankYouMessage] = useState('Thank you for your response!')
  const [fields, setFields] = useState<SurveyField[]>([])
  const [saving, setSaving] = useState(false)
  const [showTemplates, setShowTemplates] = useState(false)
  const [editingSurveyId, setEditingSurveyId] = useState<string | null>(null)
  const [embedSurveyId, setEmbedSurveyId] = useState<string | null>(null)
  const [deactivatedOpen, setDeactivatedOpen] = useState(false)
  const [sendSurveyId, setSendSurveyId] = useState<string | null>(null)
  const [sendEmail, setSendEmail] = useState('')
  const [sendName, setSendName] = useState('')
  const [sendSubject, setSendSubject] = useState('')
  const [sendMessage, setSendMessage] = useState('')
  const [sendCc, setSendCc] = useState('')
  const [sendBcc, setSendBcc] = useState('')
  const [showSendCcBcc, setShowSendCcBcc] = useState(false)
  const [sending, setSending] = useState(false)
  const [allContacts, setAllContacts] = useState<Array<{ id: string; display_name: string; primary_email: string }>>([])
  const [contactsLoaded, setContactsLoaded] = useState(false)
  const [recipientSearch, setRecipientSearch] = useState('')
  const [recipientDropdownOpen, setRecipientDropdownOpen] = useState(false)

  const loadSurveys = useCallback(() => {
    setLoading(true)
    fetch('/api/surveys', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.ok) setSurveys(d.data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => { loadSurveys() }, [loadSurveys])

  function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(null), 2500) }

  function parseFields(f: SurveyField[] | string): SurveyField[] {
    if (typeof f === 'string') return JSON.parse(f)
    return f
  }

  async function handleCreate() {
    if (!title.trim()) return showToast('Title is required')
    if (fields.length === 0) return showToast('Add at least one field')
    for (const f of fields) {
      if (!f.label.trim()) return showToast('All fields must have a label')
      if (OPTION_TYPES.has(f.type) && (!f.options || f.options.filter(o => o.trim()).length < 2)) {
        return showToast(`"${f.label}" needs at least 2 options`)
      }
    }
    setSaving(true)
    try {
      const payload = {
        title: title.trim(), description: description.trim() || undefined,
        fields: fields.map(f => ({ ...f, options: OPTION_TYPES.has(f.type) ? f.options?.filter(o => o.trim()) : undefined })),
        thankYouMessage: thankYouMessage.trim(),
      }
      const res = editingSurveyId
        ? await fetch(`/api/surveys?id=${editingSurveyId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(payload) })
        : await fetch('/api/surveys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(payload) })
      const data = await res.json()
      if (data.ok) { resetForm(); setView('list'); loadSurveys(); showToast(editingSurveyId ? 'Survey updated' : 'Survey created') }
      else showToast(data.error || 'Failed to save survey')
    } catch { showToast('Failed to save survey') }
    setSaving(false)
  }

  function resetForm() { setTitle(''); setDescription(''); setThankYouMessage('Thank you for your response!'); setFields([]); setEditingSurveyId(null) }

  function editSurvey(s: Survey) {
    setEditingSurveyId(s.id)
    setTitle(s.title)
    setDescription(s.description || '')
    setThankYouMessage(s.thank_you_message || 'Thank you for your response!')
    setFields(parseFields(s.fields))
    setShowTemplates(false)
    setView('create')
  }
  function addField() { setFields([...fields, { id: crypto.randomUUID().substring(0, 8), type: 'text', label: '', required: false }]) }
  function updateField(i: number, u: Partial<SurveyField>) {
    const updated = [...fields]; updated[i] = { ...updated[i], ...u }
    if (u.type && OPTION_TYPES.has(u.type) && !updated[i].options?.length) updated[i].options = ['', '']
    setFields(updated)
  }
  function removeField(i: number) { setFields(fields.filter((_, j) => j !== i)) }
  function moveField(i: number, dir: -1 | 1) {
    const ni = i + dir; if (ni < 0 || ni >= fields.length) return
    const u = [...fields]; [u[i], u[ni]] = [u[ni], u[i]]; setFields(u)
  }

  async function toggleActive(s: Survey) {
    await fetch(`/api/surveys?id=${s.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ isActive: !s.is_active }) })
    loadSurveys()
  }

  async function deleteSurvey(s: Survey) {
    if (!confirm(`Permanently delete "${s.title}"? This cannot be undone.`)) return
    await fetch(`/api/surveys?id=${s.id}`, { method: 'DELETE', credentials: 'include' })
    loadSurveys(); showToast('Survey deleted')
  }

  function openSendSurvey(surveyId: string) {
    const survey = surveys.find(s => s.id === surveyId)
    setSendSurveyId(surveyId)
    setSendEmail(''); setSendName(''); setSendCc(''); setSendBcc(''); setShowSendCcBcc(false)
    setRecipientSearch(''); setRecipientDropdownOpen(false)
    setSendSubject(survey ? `We'd love your feedback — ${survey.title}` : 'We\'d love your feedback')
    setSendMessage('Hi there,\n\nWe\'d love to hear your thoughts. It only takes a minute to complete this short survey.\n\nYour feedback helps us improve — thank you!')
    if (!contactsLoaded) {
      setContactsLoaded(true)
      fetch('/api/customers/people?pageSize=100', { credentials: 'include' })
        .then(r => r.json())
        .then(d => {
          let items: any[] = []
          if (Array.isArray(d.data?.items)) items = d.data.items
          else if (Array.isArray(d.data)) items = d.data
          else if (Array.isArray(d.items)) items = d.items
          setAllContacts(items.filter((c: any) => c.primary_email || c.primaryEmail).map((c: any) => ({
            id: c.id,
            display_name: c.display_name || c.displayName || c.name || '',
            primary_email: c.primary_email || c.primaryEmail || c.email || '',
          })))
        }).catch(() => {})
    }
  }

  async function sendSurveyEmail() {
    if (!sendEmail.trim() || !sendSurveyId) return
    const survey = surveys.find(s => s.id === sendSurveyId)
    if (!survey) return
    setSending(true)
    try {
      const surveyUrl = `${window.location.origin}/api/surveys/public/${survey.slug}`
      const name = sendName.trim() ? sendName.trim().split(' ')[0] : 'there'
      const messageHtml = sendMessage.trim().replace(/\n/g, '<br>')
      await fetch('/api/email/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({
          to: sendEmail.trim(),
          cc: sendCc.trim() || undefined,
          bcc: sendBcc.trim() || undefined,
          subject: sendSubject,
          htmlBody: `<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:32px">
            <div style="color:#1e293b;font-size:15px;line-height:1.7;margin-bottom:24px">${messageHtml}</div>
            <a href="${surveyUrl}" style="display:inline-block;background:#3b82f6;color:white;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">Take the Survey</a>
            <p style="color:#94a3b8;font-size:12px;margin-top:24px">This survey takes about 2 minutes to complete.</p>
          </div>`,
        }),
      })
      showToast(`Survey sent to ${sendEmail.trim()}`)
      setSendSurveyId(null)
    } catch { showToast('Failed to send email') }
    setSending(false)
  }

  function copyLink(s: Survey) {
    navigator.clipboard.writeText(`${window.location.origin}/api/surveys/public/${s.slug}`)
    setCopied(s.id); setTimeout(() => setCopied(null), 2000)
  }

  async function viewResponses(s: Survey) {
    setSelectedSurvey(s); setView('responses')
    try {
      const res = await fetch(`/api/surveys/${s.id}/responses`, { credentials: 'include' })
      const data = await res.json()
      if (data.ok) setResponsesData(data.data)
    } catch {}
  }

  function exportCsv() {
    if (!responsesData || !selectedSurvey) return
    const sf = parseFields(selectedSurvey.fields)
    const headers = ['Date', 'Name', 'Email', ...sf.map(f => f.label)]
    const rows = responsesData.responses.map(r => {
      const a = typeof r.responses === 'string' ? JSON.parse(r.responses) : r.responses
      return [new Date(r.created_at).toLocaleDateString(), r.respondent_name || '', r.respondent_email || '', ...sf.map(f => { const v = a[`field_${f.id}`]; return Array.isArray(v) ? v.join('; ') : String(v ?? '') })]
    })
    const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `${selectedSurvey.title.replace(/[^a-z0-9]/gi, '_')}_responses.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  function applyTemplate(tpl: typeof TEMPLATES[0]) {
    setTitle(tpl.name); setDescription(tpl.desc)
    setFields(tpl.fields.map(f => ({ ...f, id: crypto.randomUUID().substring(0, 8) })))
    setShowTemplates(false)
  }

  // ═══ Responses View ═══
  if (view === 'responses' && selectedSurvey) {
    const surveyFields = parseFields(selectedSurvey.fields)
    return (
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <button onClick={() => { setView('list'); setSelectedSurvey(null); setResponsesData(null) }}
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-2">
              <ArrowLeft className="size-4" /> Back to Surveys
            </button>
            <h1 className="text-xl font-semibold">{selectedSurvey.title}</h1>
            <p className="text-sm text-muted-foreground">{responsesData?.totalResponses ?? 0} responses</p>
          </div>
          {responsesData && responsesData.totalResponses > 0 && (
            <Button type="button" variant="outline" size="sm" onClick={exportCsv}>
              <Download className="size-4 mr-1.5" /> Export CSV
            </Button>
          )}
        </div>

        {!responsesData ? (
          <div className="flex items-center justify-center py-16"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
        ) : responsesData.totalResponses === 0 ? (
          <div className="text-center py-16">
            <div className="size-14 rounded-2xl bg-muted flex items-center justify-center mx-auto mb-4">
              <BarChart3 className="size-7 text-muted-foreground" />
            </div>
            <p className="font-medium">No responses yet</p>
            <p className="text-sm text-muted-foreground mt-1">Share your survey link to start collecting feedback.</p>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="grid gap-4 md:grid-cols-2">
              {surveyFields.map(field => {
                const stat = responsesData.summary[field.id]
                if (!stat) return null
                return (
                  <div key={field.id} className="border rounded-xl p-5 bg-card">
                    <h3 className="font-medium text-sm mb-1">{field.label}</h3>
                    <p className="text-xs text-muted-foreground mb-3">{stat.count} responses</p>
                    {stat.type === 'numeric' && (
                      <div>
                        <div className="text-3xl font-bold tracking-tight">{stat.average}<span className="text-sm font-normal text-muted-foreground ml-1">avg</span></div>
                      </div>
                    )}
                    {(stat.type === 'choice' || stat.type === 'multi_choice') && stat.counts && (
                      <div className="space-y-2.5">
                        {Object.entries(stat.counts).sort(([,a],[,b]) => b - a).map(([val, count]) => {
                          const pct = stat.count > 0 ? Math.round((count / stat.count) * 100) : 0
                          return (
                            <div key={val}>
                              <div className="flex justify-between text-xs mb-1"><span className="font-medium">{val}</span><span className="text-muted-foreground">{count} ({pct}%)</span></div>
                              <div className="h-2 bg-muted rounded-full overflow-hidden"><div className="h-full bg-accent rounded-full transition-all" style={{ width: `${pct}%` }} /></div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                    {stat.type === 'text' && stat.samples && (
                      <div className="space-y-1.5 max-h-36 overflow-y-auto">
                        {stat.samples.map((sample, i) => (
                          <p key={i} className="text-xs bg-muted/60 px-3 py-1.5 rounded-lg">{String(sample)}</p>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            <div>
              <h2 className="text-sm font-semibold mb-3">Individual Responses</h2>
              <div className="border rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="bg-muted/50 border-b">
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground">Date</th>
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground">Name</th>
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground">Email</th>
                      {surveyFields.map(f => <th key={f.id} className="text-left px-4 py-3 font-medium text-muted-foreground">{f.label}</th>)}
                    </tr></thead>
                    <tbody>
                      {responsesData.responses.map(resp => {
                        const answers = typeof resp.responses === 'string' ? JSON.parse(resp.responses) : resp.responses
                        return (
                          <tr key={resp.id} className="border-b last:border-0 hover:bg-muted/20">
                            <td className="px-4 py-3 whitespace-nowrap">{new Date(resp.created_at).toLocaleDateString()}</td>
                            <td className="px-4 py-3">{resp.respondent_name || <span className="text-muted-foreground">—</span>}</td>
                            <td className="px-4 py-3">{resp.respondent_email || <span className="text-muted-foreground">—</span>}</td>
                            {surveyFields.map(f => {
                              const val = answers[`field_${f.id}`]
                              return <td key={f.id} className="px-4 py-3 max-w-48 truncate">{Array.isArray(val) ? val.join(', ') : String(val ?? '—')}</td>
                            })}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ═══ Pick View (template or scratch) ═══
  if (view === 'pick') {
    return (
      <div className="p-6">
        <button onClick={() => setView('list')}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-6">
          <ArrowLeft className="size-4" /> Back to Surveys
        </button>
        <h1 className="text-xl font-semibold mb-2">New Survey</h1>
        <p className="text-sm text-muted-foreground mb-6">Start from scratch or pick a template to get going fast.</p>

        <div className="grid grid-cols-2 gap-4 mb-8">
          <button type="button" onClick={() => { resetForm(); setView('create') }}
            className="rounded-xl border p-6 text-left hover:border-accent/40 hover:bg-accent/5 transition-all group">
            <div className="size-10 rounded-lg bg-muted flex items-center justify-center mb-3">
              <Plus className="size-5 text-muted-foreground group-hover:text-foreground" />
            </div>
            <h3 className="font-semibold mb-1">Start from Scratch</h3>
            <p className="text-xs text-muted-foreground">Build your own survey question by question.</p>
          </button>
          <button type="button" onClick={() => { resetForm(); setShowTemplates(true); setView('create') }}
            className="rounded-xl border border-accent/20 p-6 text-left hover:border-accent/40 hover:bg-accent/5 transition-all group">
            <div className="size-10 rounded-lg bg-accent/10 flex items-center justify-center mb-3">
              <FileText className="size-5 text-accent" />
            </div>
            <h3 className="font-semibold mb-1">Use a Template</h3>
            <p className="text-xs text-muted-foreground">Choose from {TEMPLATES.length} pre-built survey templates.</p>
          </button>
        </div>
      </div>
    )
  }

  // ═══ Create View ═══
  if (view === 'create') {
    const fieldTypeIcon = (type: string) => { const ft = FIELD_TYPES.find(f => f.value === type); return ft ? ft.icon : Type }
    return (
      <div className="p-6">
        <button onClick={() => { setView('list'); resetForm() }}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4">
          <ArrowLeft className="size-4" /> Back to Surveys
        </button>
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-semibold">{editingSurveyId ? 'Edit Survey' : 'Create Survey'}</h1>
          <div className="flex gap-2">
            {!editingSurveyId && (
              <Button type="button" variant="outline" size="sm" onClick={() => setShowTemplates(!showTemplates)}>
                <FileText className="size-4 mr-1.5" /> Templates
              </Button>
            )}
            {editingSurveyId && (
              <Button type="button" variant="outline" size="sm" onClick={() => {
                const s = surveys.find(s => s.id === editingSurveyId)
                if (s) window.open(`/api/surveys/public/${s.slug}`, '_blank')
              }}>
                <Eye className="size-4 mr-1.5" /> Preview
              </Button>
            )}
          </div>
        </div>

        {/* Templates */}
        {showTemplates && (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
            {TEMPLATES.map(tpl => (
              <button key={tpl.id} type="button" onClick={() => applyTemplate(tpl)}
                className="border rounded-xl p-4 text-left hover:border-accent/40 hover:bg-accent/5 transition-all">
                <div className="size-9 rounded-lg bg-accent/10 flex items-center justify-center mb-2.5">
                  <ClipboardList className="size-4.5 text-accent" />
                </div>
                <h3 className="text-sm font-semibold mb-0.5">{tpl.name}</h3>
                <p className="text-[11px] text-muted-foreground">{tpl.desc}</p>
                <p className="text-[10px] text-muted-foreground mt-1">{tpl.fields.length} questions</p>
              </button>
            ))}
          </div>
        )}

        <div className="space-y-5">
          {/* Survey info */}
          <div className="bg-card rounded-xl border p-5 space-y-4">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Survey Title</label>
              <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="Customer Satisfaction Survey" className="text-sm" autoFocus />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Description (optional)</label>
              <Textarea value={description} onChange={e => setDescription(e.target.value)} rows={2} placeholder="Help us improve our service..." className="text-sm" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Thank You Message</label>
              <Input value={thankYouMessage} onChange={e => setThankYouMessage(e.target.value)} className="text-sm" />
            </div>
          </div>

          {/* Questions */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold">Questions</h2>
              <Button type="button" variant="outline" size="sm" onClick={addField}>
                <Plus className="size-3.5 mr-1.5" /> Add Question
              </Button>
            </div>

            {fields.length === 0 && (
              <div className="text-center py-10 border border-dashed rounded-xl">
                <ClipboardList className="size-8 mx-auto text-muted-foreground/30 mb-3" />
                <p className="text-sm text-muted-foreground">No questions yet</p>
                <p className="text-xs text-muted-foreground mt-1">Add questions manually, use AI, or pick a template.</p>
              </div>
            )}

            <div className="space-y-3">
              {fields.map((field, index) => {
                const Icon = fieldTypeIcon(field.type)
                return (
                  <div key={field.id} className="border rounded-xl bg-card overflow-hidden">
                    <div className="flex items-center gap-3 p-4">
                      <div className="flex flex-col gap-0.5">
                        <button type="button" onClick={() => moveField(index, -1)} disabled={index === 0}
                          className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-20"><ChevronUp className="size-3.5" /></button>
                        <button type="button" onClick={() => moveField(index, 1)} disabled={index === fields.length - 1}
                          className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-20"><ChevronDown className="size-3.5" /></button>
                      </div>
                      <div className="size-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
                        <Icon className="size-4 text-muted-foreground" />
                      </div>
                      <Input value={field.label} onChange={e => updateField(index, { label: e.target.value })}
                        className="flex-1 text-sm" placeholder="Question text" />
                      <select value={field.type} onChange={e => updateField(index, { type: e.target.value })}
                        className="h-9 rounded-lg border bg-background px-2.5 text-xs w-32">
                        {FIELD_TYPES.map(ft => <option key={ft.value} value={ft.value}>{ft.label}</option>)}
                      </select>
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer whitespace-nowrap">
                        <input type="checkbox" checked={field.required || false} onChange={e => updateField(index, { required: e.target.checked })} className="rounded" />
                        Required
                      </label>
                      <IconButton variant="ghost" size="sm" type="button" onClick={() => removeField(index)} title="Remove">
                        <X className="size-4 text-muted-foreground hover:text-destructive" />
                      </IconButton>
                    </div>

                    {OPTION_TYPES.has(field.type) && (
                      <div className="px-4 pb-4 pt-0 ml-14">
                        <p className="text-[11px] text-muted-foreground mb-2">Options</p>
                        <div className="space-y-1.5">
                          {(field.options || []).map((opt, oi) => (
                            <div key={oi} className="flex items-center gap-2">
                              <span className="text-[10px] text-muted-foreground/50 w-4 text-right">{oi + 1}</span>
                              <Input value={opt} onChange={e => {
                                const u = [...fields]; u[index] = { ...u[index], options: [...(u[index].options || [])] }; u[index].options![oi] = e.target.value; setFields(u)
                              }} className="flex-1 h-7 text-xs" placeholder={`Option ${oi + 1}`} />
                              <button type="button" onClick={() => {
                                const u = [...fields]; u[index] = { ...u[index], options: (u[index].options || []).filter((_, j) => j !== oi) }; setFields(u)
                              }} className="p-0.5 text-muted-foreground hover:text-destructive"><X className="size-3" /></button>
                            </div>
                          ))}
                          <button type="button" onClick={() => {
                            const u = [...fields]; u[index] = { ...u[index], options: [...(u[index].options || []), ''] }; setFields(u)
                          }} className="text-[11px] text-accent ml-5">+ Add option</button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => { setView('list'); resetForm() }}>Cancel</Button>
            <Button type="button" onClick={handleCreate} disabled={saving}>
              {saving ? <><Loader2 className="size-4 mr-1.5 animate-spin" /> Saving...</> : editingSurveyId ? 'Save Changes' : 'Create Survey'}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // ═══ List View ═══
  const activeSurveys = surveys.filter(s => s.is_active)
  const inactiveSurveys = surveys.filter(s => !s.is_active)
  const totalResponses = surveys.reduce((sum, s) => sum + (s.response_count || 0), 0)
  const surveysWeekly = weeklyCounts(surveys.map(s => s.created_at))
  const CARD_COLORS: Array<keyof typeof STAT_COLORS> = ['violet', 'blue', 'green', 'amber']

  function renderSurveyCard(survey: Survey, isInactive?: boolean, idx = 0) {
    const cc = STAT_COLORS[CARD_COLORS[idx % CARD_COLORS.length]]
    return (
      <div key={survey.id} className={`bg-card rounded-xl border p-5 transition-colors ${isInactive ? 'opacity-70' : 'hover:border-accent/30'}`}>
        <div className="flex items-center gap-4">
          <div className={`size-11 rounded-lg flex items-center justify-center shrink-0 ${isInactive ? 'bg-muted' : cc.tile}`}>
            <ClipboardList className={`size-5 ${isInactive ? 'text-muted-foreground' : cc.icon}`} />
          </div>
          <div className="flex-1 min-w-0 cursor-pointer" onClick={() => editSurvey(survey)}>
            <div className="flex items-center gap-2 mb-1">
              <h3 className="font-semibold truncate">{survey.title}</h3>
              {!isInactive && (
                <Badge variant="green">Active</Badge>
              )}
            </div>
            {survey.description && <p className="text-xs text-muted-foreground line-clamp-1">{survey.description}</p>}
            <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1"><BarChart3 className="size-3" /> {survey.response_count} responses</span>
              <span>{parseFields(survey.fields).length} questions</span>
              <span>Created {new Date(survey.created_at).toLocaleDateString()}</span>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <IconButton variant="ghost" size="sm" type="button" title="Send via email" onClick={() => openSendSurvey(survey.id)}>
              <Send className="size-4" />
            </IconButton>
            <IconButton variant="ghost" size="sm" type="button" title="Copy link" onClick={() => copyLink(survey)}>
              {copied === survey.id ? <Check className="size-4 text-[#047857] dark:text-[#34d399]" /> : <Copy className="size-4" />}
            </IconButton>
            <IconButton variant="ghost" size="sm" type="button" title="Preview" onClick={() => window.open(`/api/surveys/public/${survey.slug}`, '_blank')}>
              <ExternalLink className="size-4" />
            </IconButton>
            <IconButton variant="ghost" size="sm" type="button" title="Embed" onClick={() => setEmbedSurveyId(embedSurveyId === survey.id ? null : survey.id)}>
              <Code className="size-4" />
            </IconButton>
            <IconButton variant="ghost" size="sm" type="button" title="Responses" onClick={() => viewResponses(survey)}>
              <BarChart3 className="size-4" />
            </IconButton>
            {isInactive ? (
              <Button type="button" variant="ghost" size="sm" className="h-8 text-xs" onClick={() => toggleActive(survey)}>Reactivate</Button>
            ) : (
              <Button type="button" variant="ghost" size="sm" className="h-8 text-xs" onClick={() => toggleActive(survey)}>Deactivate</Button>
            )}
            <IconButton variant="ghost" size="sm" type="button" title="Delete" onClick={() => deleteSurvey(survey)}>
              <Trash2 className="size-4 text-muted-foreground hover:text-destructive" />
            </IconButton>
          </div>
        </div>
        {embedSurveyId === survey.id && (
          <div className="mt-3 p-3 bg-muted/50 rounded-lg ml-15">
            <p className="text-xs font-medium mb-1.5">Embed code:</p>
            <code className="block text-xs bg-background p-2.5 rounded-lg border break-all select-all font-mono">
              {`<iframe src="${typeof window !== 'undefined' ? window.location.origin : ''}/api/surveys/public/${survey.slug}" width="100%" height="600" frameborder="0"></iframe>`}
            </code>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold">Surveys</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{activeSurveys.length} active survey{activeSurveys.length !== 1 ? 's' : ''}</p>
        </div>
        <Button type="button" onClick={() => setView('pick')}>
          <Plus className="size-4 mr-2" /> New Survey
        </Button>
      </div>

      {!loading && surveys.length > 0 && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          <StatTile icon={ClipboardList} label="Surveys" value={surveys.length} color="violet" series={surveysWeekly} />
          <StatTile icon={Check} label="Active" value={activeSurveys.length} color="green" />
          <StatTile icon={BarChart3} label="Responses" value={totalResponses} color="blue" />
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
      ) : activeSurveys.length === 0 && inactiveSurveys.length === 0 ? (
        <div className="rounded-xl border border-muted-foreground/20 p-12 text-center">
          <div className="inline-flex items-center justify-center size-14 rounded-2xl bg-accent/10 text-accent mb-4">
            <ClipboardList className="size-7" />
          </div>
          <h2 className="text-lg font-semibold mb-2">Create your first survey</h2>
          <p className="text-sm text-muted-foreground max-w-sm mx-auto mb-6">Collect feedback, measure satisfaction, and gather insights from your audience.</p>
          <Button type="button" onClick={() => setView('create')}><Plus className="size-4 mr-2" /> Get Started</Button>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Active surveys */}
          {activeSurveys.length === 0 ? (
            <div className="text-center py-10 border border-dashed rounded-xl">
              <p className="text-sm text-muted-foreground">No active surveys</p>
              <p className="text-xs text-muted-foreground mt-1">Create a new survey or reactivate a deactivated one.</p>
            </div>
          ) : (
            <div className="grid gap-3">
              {activeSurveys.map((s, i) => renderSurveyCard(s, false, i))}
            </div>
          )}

          {/* Deactivated surveys — collapsible */}
          {inactiveSurveys.length > 0 && (
            <div>
              <button type="button" onClick={() => setDeactivatedOpen(!deactivatedOpen)}
                className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors w-full">
                <ChevronDown className={`size-4 transition-transform ${deactivatedOpen ? 'rotate-180' : ''}`} />
                <span className="font-medium">Deactivated Surveys</span>
                <span className="text-xs">({inactiveSurveys.length})</span>
                <div className="flex-1 h-px bg-border ml-2" />
              </button>
              {deactivatedOpen && (
                <div className="grid gap-3 mt-3">
                  {inactiveSurveys.map(s => renderSurveyCard(s, true))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Send Survey Email Modal */}
      {sendSurveyId && (
        <>
          <div className="fixed inset-0 bg-black/30 z-40" onClick={() => setSendSurveyId(null)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-background rounded-xl border shadow-xl w-full max-w-lg p-6">
              <div className="flex items-center justify-between mb-5">
                <div>
                  <h3 className="font-semibold">Send Survey via Email</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">A survey link and CTA button will be included automatically below your message.</p>
                </div>
                <IconButton variant="ghost" size="sm" type="button" onClick={() => setSendSurveyId(null)}><X className="size-4" /></IconButton>
              </div>
              <div className="space-y-3">
                {/* Recipient with contact search */}
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">To</label>
                  <div className="relative">
                    {sendEmail ? (
                      <div className="flex items-center gap-2 px-3 py-2 border rounded-lg bg-muted/30">
                        <div className="size-7 rounded-full bg-accent/10 flex items-center justify-center text-xs font-bold text-accent shrink-0">
                          {(sendName || sendEmail)[0]?.toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          {sendName && <p className="text-sm font-medium truncate">{sendName}</p>}
                          <p className={`text-${sendName ? '[11px]' : 'sm'} text-muted-foreground truncate`}>{sendEmail}</p>
                        </div>
                        <button type="button" onClick={() => { setSendEmail(''); setSendName(''); setRecipientSearch('') }} className="text-muted-foreground hover:text-foreground">
                          <X className="size-3.5" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <Input
                          value={recipientSearch}
                          onChange={e => { setRecipientSearch(e.target.value); setRecipientDropdownOpen(true) }}
                          onFocus={() => setRecipientDropdownOpen(true)}
                          placeholder="Search contacts or type email..."
                          className="text-sm" autoFocus
                          onKeyDown={e => {
                            if (e.key === 'Enter' && recipientSearch.includes('@')) {
                              e.preventDefault()
                              setSendEmail(recipientSearch.trim()); setSendName(''); setRecipientSearch(''); setRecipientDropdownOpen(false)
                            }
                          }}
                        />
                        {recipientDropdownOpen && (
                          <div className="absolute z-30 top-full left-0 right-0 mt-1 bg-background border rounded-lg shadow-lg max-h-48 overflow-y-auto">
                            {allContacts
                              .filter(c => {
                                if (!recipientSearch.trim()) return true
                                const q = recipientSearch.toLowerCase()
                                return c.display_name.toLowerCase().includes(q) || c.primary_email.toLowerCase().includes(q)
                              })
                              .slice(0, 10)
                              .map(c => (
                                <button key={c.id} type="button"
                                  className="w-full text-left px-3 py-2.5 hover:bg-muted/50 flex items-center gap-2.5 text-sm border-b last:border-0"
                                  onClick={() => {
                                    setSendEmail(c.primary_email); setSendName(c.display_name)
                                    setRecipientSearch(''); setRecipientDropdownOpen(false)
                                  }}>
                                  <div className="size-7 rounded-full bg-accent/10 flex items-center justify-center text-[10px] font-bold text-accent shrink-0">
                                    {c.display_name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase() || '?'}
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <p className="font-medium truncate">{c.display_name}</p>
                                    <p className="text-[11px] text-muted-foreground truncate">{c.primary_email}</p>
                                  </div>
                                </button>
                              ))
                            }
                            {recipientSearch.includes('@') && (
                              <button type="button"
                                className="w-full text-left px-3 py-2.5 hover:bg-muted/50 flex items-center gap-2.5 text-sm text-accent"
                                onClick={() => { setSendEmail(recipientSearch.trim()); setSendName(''); setRecipientSearch(''); setRecipientDropdownOpen(false) }}>
                                <Mail className="size-4 shrink-0" />
                                <span>Send to {recipientSearch.trim()}</span>
                              </button>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>

                {/* CC/BCC toggle */}
                {!showSendCcBcc ? (
                  <button type="button" onClick={() => setShowSendCcBcc(true)} className="text-xs text-accent font-medium">+ Add CC / BCC</button>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium text-muted-foreground mb-1 block">CC</label>
                      <Input value={sendCc} onChange={e => setSendCc(e.target.value)} placeholder="cc@example.com" className="text-sm" />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground mb-1 block">BCC</label>
                      <Input value={sendBcc} onChange={e => setSendBcc(e.target.value)} placeholder="bcc@example.com" className="text-sm" />
                    </div>
                  </div>
                )}

                {/* Subject */}
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Subject</label>
                  <Input value={sendSubject} onChange={e => setSendSubject(e.target.value)} className="text-sm" />
                </div>

                {/* Message */}
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Message</label>
                  <Textarea value={sendMessage} onChange={e => setSendMessage(e.target.value)} rows={4} className="text-sm" />
                </div>

                <p className="text-[11px] text-muted-foreground bg-muted/30 rounded-lg px-3 py-2">
                  A "Take the Survey" button with a link to the survey will be included automatically below your message.
                </p>
              </div>

              <div className="flex justify-end gap-2 mt-5 pt-4 border-t">
                <Button type="button" variant="outline" onClick={() => setSendSurveyId(null)}>Cancel</Button>
                <Button type="button" onClick={sendSurveyEmail} disabled={sending || !sendEmail.trim()}>
                  {sending ? <><Loader2 className="size-4 mr-1.5 animate-spin" /> Sending...</> : <><Send className="size-4 mr-1.5" /> Send Survey</>}
                </Button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 bg-foreground text-background px-4 py-2.5 rounded-lg text-sm font-medium shadow-lg z-50 animate-in fade-in slide-in-from-bottom-4">
          {toast}
        </div>
      )}
    </div>
  )
}
