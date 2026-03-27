'use client'

import { useState, useEffect, useCallback } from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { translateWithFallback } from '@open-mercato/shared/lib/i18n/translate'
import { Button } from '@open-mercato/ui/primitives/button'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import {
  Plus, Trash2, Copy, Code, ToggleLeft, ToggleRight, ChevronUp, ChevronDown,
  GripVertical, Sparkles, ArrowLeft, BarChart3, X,
} from 'lucide-react'

type SurveyField = {
  id: string
  type: string
  label: string
  required?: boolean
  options?: string[]
}

type Survey = {
  id: string
  title: string
  description: string | null
  slug: string
  fields: SurveyField[] | string
  thank_you_message: string
  is_active: boolean
  response_count: number
  created_at: string
}

type ResponseSummary = {
  type: string
  count: number
  average?: number
  distribution?: Record<string, number>
  counts?: Record<string, number>
  samples?: string[]
}

const FIELD_TYPES = [
  { value: 'text', label: 'Short Text' },
  { value: 'textarea', label: 'Long Text' },
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'select', label: 'Dropdown' },
  { value: 'multi_select', label: 'Multi Select' },
  { value: 'radio', label: 'Radio Buttons' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'rating', label: 'Star Rating' },
  { value: 'nps', label: 'NPS (0-10)' },
]

const OPTION_TYPES = new Set(['select', 'multi_select', 'radio'])

export default function SurveysPage() {
  const t = useT()
  const translate = (key: string, fallback: string) => translateWithFallback(t, key, fallback)

  const [surveys, setSurveys] = useState<Survey[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<'list' | 'create' | 'responses'>('list')
  const [selectedSurvey, setSelectedSurvey] = useState<Survey | null>(null)
  const [responsesData, setResponsesData] = useState<{
    responses: Array<{ id: string; respondent_name: string | null; respondent_email: string | null; responses: Record<string, unknown>; created_at: string }>
    summary: Record<string, ResponseSummary>
    totalResponses: number
  } | null>(null)

  // Create form state
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [thankYouMessage, setThankYouMessage] = useState('Thank you for your response!')
  const [fields, setFields] = useState<SurveyField[]>([])
  const [saving, setSaving] = useState(false)
  const [aiLoading, setAiLoading] = useState(false)
  const [embedSurveyId, setEmbedSurveyId] = useState<string | null>(null)

  const loadSurveys = useCallback(() => {
    setLoading(true)
    fetch('/api/surveys')
      .then((r) => r.json())
      .then((d) => { if (d.ok) setSurveys(d.data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => { loadSurveys() }, [loadSurveys])

  function parseFields(fields: SurveyField[] | string): SurveyField[] {
    if (typeof fields === 'string') return JSON.parse(fields)
    return fields
  }

  async function handleCreate() {
    if (!title.trim()) return alert('Title is required')
    if (fields.length === 0) return alert('Add at least one field')
    for (const f of fields) {
      if (!f.label.trim()) return alert('All fields must have a label')
      if (OPTION_TYPES.has(f.type) && (!f.options || f.options.filter(o => o.trim()).length < 2)) {
        return alert(`Field "${f.label}" needs at least 2 options`)
      }
    }

    setSaving(true)
    try {
      const res = await fetch('/api/surveys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || undefined,
          fields: fields.map(f => ({
            ...f,
            options: OPTION_TYPES.has(f.type) ? f.options?.filter(o => o.trim()) : undefined,
          })),
          thankYouMessage: thankYouMessage.trim(),
        }),
      })
      const data = await res.json()
      if (data.ok) {
        resetForm()
        setView('list')
        loadSurveys()
      } else {
        alert(data.error || 'Failed to create survey')
      }
    } catch {
      alert('Failed to create survey')
    } finally {
      setSaving(false)
    }
  }

  function resetForm() {
    setTitle('')
    setDescription('')
    setThankYouMessage('Thank you for your response!')
    setFields([])
  }

  function addField() {
    setFields([...fields, { id: crypto.randomUUID().substring(0, 8), type: 'text', label: '', required: false }])
  }

  function updateField(index: number, updates: Partial<SurveyField>) {
    const updated = [...fields]
    updated[index] = { ...updated[index], ...updates }
    // When changing type to an option type, initialize options
    if (updates.type && OPTION_TYPES.has(updates.type) && !updated[index].options?.length) {
      updated[index].options = ['', '']
    }
    setFields(updated)
  }

  function removeField(index: number) {
    setFields(fields.filter((_, i) => i !== index))
  }

  function moveField(index: number, direction: -1 | 1) {
    const newIndex = index + direction
    if (newIndex < 0 || newIndex >= fields.length) return
    const updated = [...fields]
    const temp = updated[index]
    updated[index] = updated[newIndex]
    updated[newIndex] = temp
    setFields(updated)
  }

  function addOption(fieldIndex: number) {
    const updated = [...fields]
    updated[fieldIndex].options = [...(updated[fieldIndex].options || []), '']
    setFields(updated)
  }

  function updateOption(fieldIndex: number, optionIndex: number, value: string) {
    const updated = [...fields]
    const opts = [...(updated[fieldIndex].options || [])]
    opts[optionIndex] = value
    updated[fieldIndex].options = opts
    setFields(updated)
  }

  function removeOption(fieldIndex: number, optionIndex: number) {
    const updated = [...fields]
    updated[fieldIndex].options = (updated[fieldIndex].options || []).filter((_, i) => i !== optionIndex)
    setFields(updated)
  }

  async function toggleActive(survey: Survey) {
    try {
      const res = await fetch(`/api/surveys?id=${survey.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !survey.is_active }),
      })
      const data = await res.json()
      if (data.ok) loadSurveys()
    } catch { /* ignore */ }
  }

  async function deleteSurvey(survey: Survey) {
    if (!confirm(`Delete "${survey.title}"?`)) return
    try {
      await fetch(`/api/surveys?id=${survey.id}`, { method: 'DELETE' })
      loadSurveys()
    } catch { alert('Failed to delete') }
  }

  function copyLink(survey: Survey) {
    const url = `${window.location.origin}/api/surveys/public/${survey.slug}`
    navigator.clipboard.writeText(url)
    alert('Link copied to clipboard!')
  }

  function showEmbed(surveyId: string) {
    setEmbedSurveyId(embedSurveyId === surveyId ? null : surveyId)
  }

  async function viewResponses(survey: Survey) {
    setSelectedSurvey(survey)
    setView('responses')
    try {
      const res = await fetch(`/api/surveys/${survey.id}/responses`)
      const data = await res.json()
      if (data.ok) setResponsesData(data.data)
    } catch { /* ignore */ }
  }

  async function generateWithAi() {
    if (!description.trim() && !title.trim()) return alert('Enter a title or description first')
    setAiLoading(true)
    try {
      const prompt = `Generate survey fields for a survey about: ${title} ${description}. Return a JSON array of objects with these properties: id (short unique string), type (one of: text, textarea, email, phone, number, date, select, multi_select, radio, checkbox, rating, nps), label (the question text), required (boolean), options (string array, only for select/multi_select/radio types). Generate 5-8 relevant questions. Return ONLY the JSON array, no explanation.`
      const res = await fetch('/api/ai/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: prompt }),
      })
      const data = await res.json()
      if (data.ok && data.data?.message) {
        const text = data.data.message
        const jsonMatch = text.match(/\[[\s\S]*\]/)
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0])
          if (Array.isArray(parsed)) {
            setFields(parsed.map((f: SurveyField) => ({
              id: f.id || crypto.randomUUID().substring(0, 8),
              type: f.type || 'text',
              label: f.label || '',
              required: f.required || false,
              options: f.options,
            })))
          }
        }
      }
    } catch {
      alert('AI generation failed. Add fields manually.')
    } finally {
      setAiLoading(false)
    }
  }

  // ---- Responses View ----
  if (view === 'responses' && selectedSurvey) {
    const surveyFields = parseFields(selectedSurvey.fields)
    return (
      <div className="p-6">
        <button onClick={() => { setView('list'); setSelectedSurvey(null); setResponsesData(null) }}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4">
          <ArrowLeft className="size-4" /> Back to Surveys
        </button>
        <h1 className="text-xl font-semibold mb-1">{selectedSurvey.title}</h1>
        <p className="text-sm text-muted-foreground mb-6">{responsesData?.totalResponses ?? 0} responses</p>

        {!responsesData ? (
          <p className="text-muted-foreground">Loading responses...</p>
        ) : responsesData.totalResponses === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <BarChart3 className="size-12 mx-auto mb-3 opacity-30" />
            <p>No responses yet</p>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Summary cards */}
            <div className="grid gap-4 md:grid-cols-2">
              {surveyFields.map((field) => {
                const stat = responsesData.summary[field.id]
                if (!stat) return null
                return (
                  <div key={field.id} className="border rounded-lg p-4 bg-card">
                    <h3 className="font-medium text-sm mb-2">{field.label}</h3>
                    <p className="text-xs text-muted-foreground mb-2">{stat.count} answers</p>
                    {stat.type === 'numeric' && (
                      <div>
                        <div className="text-2xl font-semibold">{stat.average}</div>
                        <p className="text-xs text-muted-foreground">average</p>
                        {stat.distribution && (
                          <div className="flex gap-1 mt-2 flex-wrap">
                            {Object.entries(stat.distribution).sort(([a],[b]) => Number(a) - Number(b)).map(([val, count]) => (
                              <span key={val} className="text-xs bg-muted px-2 py-0.5 rounded">{val}: {count}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    {(stat.type === 'choice' || stat.type === 'multi_choice') && stat.counts && (
                      <div className="space-y-1.5">
                        {Object.entries(stat.counts).sort(([,a],[,b]) => b - a).map(([val, count]) => {
                          const pct = stat.count > 0 ? Math.round((count / stat.count) * 100) : 0
                          return (
                            <div key={val}>
                              <div className="flex justify-between text-xs mb-0.5">
                                <span>{val}</span>
                                <span className="text-muted-foreground">{count} ({pct}%)</span>
                              </div>
                              <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                                <div className="h-full bg-blue-500 rounded-full" style={{ width: `${pct}%` }} />
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                    {stat.type === 'text' && stat.samples && (
                      <div className="space-y-1 max-h-32 overflow-y-auto">
                        {stat.samples.map((sample, i) => (
                          <p key={i} className="text-xs bg-muted px-2 py-1 rounded">{String(sample)}</p>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {/* Individual responses table */}
            <div>
              <h2 className="text-sm font-semibold mb-3">Individual Responses</h2>
              <div className="border rounded-lg overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-muted/50 border-b">
                        <th className="text-left px-3 py-2 font-medium">Date</th>
                        <th className="text-left px-3 py-2 font-medium">Name</th>
                        <th className="text-left px-3 py-2 font-medium">Email</th>
                        {surveyFields.map((f) => (
                          <th key={f.id} className="text-left px-3 py-2 font-medium">{f.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {responsesData.responses.map((resp) => {
                        const answers = typeof resp.responses === 'string' ? JSON.parse(resp.responses) : resp.responses
                        return (
                          <tr key={resp.id} className="border-b last:border-0 hover:bg-muted/30">
                            <td className="px-3 py-2 whitespace-nowrap">{new Date(resp.created_at).toLocaleDateString()}</td>
                            <td className="px-3 py-2">{resp.respondent_name || '-'}</td>
                            <td className="px-3 py-2">{resp.respondent_email || '-'}</td>
                            {surveyFields.map((f) => {
                              const val = answers[`field_${f.id}`]
                              const display = Array.isArray(val) ? val.join(', ') : String(val ?? '-')
                              return <td key={f.id} className="px-3 py-2 max-w-48 truncate">{display}</td>
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

  // ---- Create View ----
  if (view === 'create') {
    return (
      <div className="p-6 max-w-3xl">
        <button onClick={() => { setView('list'); resetForm() }}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4">
          <ArrowLeft className="size-4" /> Back to Surveys
        </button>
        <h1 className="text-xl font-semibold mb-6">{translate('surveys.create.title', 'Create Survey')}</h1>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Title</label>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg text-sm bg-background" placeholder="Customer Satisfaction Survey" />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Description</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2}
              className="w-full px-3 py-2 border rounded-lg text-sm bg-background resize-none" placeholder="Help us improve our service..." />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Thank You Message</label>
            <input type="text" value={thankYouMessage} onChange={(e) => setThankYouMessage(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg text-sm bg-background" />
          </div>

          <div className="border-t pt-4 mt-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold">Fields</h2>
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" onClick={generateWithAi} disabled={aiLoading}>
                  <Sparkles className="size-4 mr-1.5" /> {aiLoading ? 'Generating...' : 'Generate Survey'}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={addField}>
                  <Plus className="size-4 mr-1.5" /> Add Field
                </Button>
              </div>
            </div>

            {fields.length === 0 && (
              <div className="text-center py-8 text-muted-foreground border border-dashed rounded-lg">
                <p className="text-sm">No fields yet. Add fields manually or use AI to generate them.</p>
              </div>
            )}

            <div className="space-y-3">
              {fields.map((field, index) => (
                <div key={field.id} className="border rounded-lg p-3 bg-card">
                  <div className="flex items-start gap-2">
                    <div className="flex flex-col gap-0.5 pt-1">
                      <button type="button" onClick={() => moveField(index, -1)} disabled={index === 0}
                        className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30">
                        <ChevronUp className="size-3.5" />
                      </button>
                      <button type="button" onClick={() => moveField(index, 1)} disabled={index === fields.length - 1}
                        className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30">
                        <ChevronDown className="size-3.5" />
                      </button>
                    </div>
                    <div className="flex-1 grid gap-2 grid-cols-[1fr_150px_auto]">
                      <input type="text" value={field.label} onChange={(e) => updateField(index, { label: e.target.value })}
                        className="px-2.5 py-1.5 border rounded text-sm bg-background" placeholder="Question label" />
                      <select value={field.type} onChange={(e) => updateField(index, { type: e.target.value })}
                        className="px-2.5 py-1.5 border rounded text-sm bg-background">
                        {FIELD_TYPES.map((ft) => (
                          <option key={ft.value} value={ft.value}>{ft.label}</option>
                        ))}
                      </select>
                      <div className="flex items-center gap-2">
                        <label className="flex items-center gap-1 text-xs text-muted-foreground whitespace-nowrap cursor-pointer">
                          <input type="checkbox" checked={field.required || false}
                            onChange={(e) => updateField(index, { required: e.target.checked })} />
                          Required
                        </label>
                        <button type="button" onClick={() => removeField(index)}
                          className="p-1 text-muted-foreground hover:text-red-500">
                          <X className="size-4" />
                        </button>
                      </div>
                    </div>
                  </div>

                  {OPTION_TYPES.has(field.type) && (
                    <div className="mt-2 ml-7 space-y-1.5">
                      <p className="text-xs text-muted-foreground">Options:</p>
                      {(field.options || []).map((opt, oi) => (
                        <div key={oi} className="flex items-center gap-1.5">
                          <input type="text" value={opt} onChange={(e) => updateOption(index, oi, e.target.value)}
                            className="flex-1 px-2 py-1 border rounded text-sm bg-background" placeholder={`Option ${oi + 1}`} />
                          <button type="button" onClick={() => removeOption(index, oi)}
                            className="p-0.5 text-muted-foreground hover:text-red-500">
                            <X className="size-3.5" />
                          </button>
                        </div>
                      ))}
                      <button type="button" onClick={() => addOption(index)}
                        className="text-xs text-blue-600 hover:text-blue-800">+ Add option</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-4 border-t">
            <Button type="button" variant="outline" onClick={() => { setView('list'); resetForm() }}>Cancel</Button>
            <Button type="button" onClick={handleCreate} disabled={saving}>
              {saving ? 'Creating...' : 'Create Survey'}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // ---- List View ----
  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold">{translate('surveys.list.title', 'Surveys')}</h1>
          <p className="text-sm text-muted-foreground mt-1">{surveys.length} surveys</p>
        </div>
        <Button type="button" onClick={() => setView('create')}>
          <Plus className="size-4 mr-2" /> New Survey
        </Button>
      </div>

      {loading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : surveys.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <BarChart3 className="size-12 mx-auto mb-3 opacity-30" />
          <p className="font-medium">No surveys yet</p>
          <p className="text-sm mt-1">Create your first survey to start collecting feedback.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {surveys.map((survey) => (
            <div key={survey.id} className="border rounded-lg p-4 bg-card hover:bg-accent/30 transition-colors">
              <div className="flex items-center justify-between">
                <div className="flex-1 min-w-0 cursor-pointer" onClick={() => viewResponses(survey)}>
                  <h3 className="font-medium truncate">{survey.title}</h3>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    {survey.response_count} responses &middot; Created {new Date(survey.created_at).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex items-center gap-1 ml-4">
                  <button type="button" onClick={() => toggleActive(survey)}
                    className="p-1.5 text-muted-foreground hover:text-foreground" title={survey.is_active ? 'Deactivate' : 'Activate'}>
                    {survey.is_active
                      ? <ToggleRight className="size-5 text-emerald-500" />
                      : <ToggleLeft className="size-5" />}
                  </button>
                  <button type="button" onClick={() => copyLink(survey)}
                    className="p-1.5 text-muted-foreground hover:text-foreground" title="Copy Link">
                    <Copy className="size-4" />
                  </button>
                  <button type="button" onClick={() => showEmbed(survey.id)}
                    className="p-1.5 text-muted-foreground hover:text-foreground" title="Embed Code">
                    <Code className="size-4" />
                  </button>
                  <button type="button" onClick={() => viewResponses(survey)}
                    className="p-1.5 text-muted-foreground hover:text-foreground" title="View Responses">
                    <BarChart3 className="size-4" />
                  </button>
                  <button type="button" onClick={() => deleteSurvey(survey)}
                    className="p-1.5 text-muted-foreground hover:text-red-500" title="Delete">
                    <Trash2 className="size-4" />
                  </button>
                </div>
              </div>
              {embedSurveyId === survey.id && (
                <div className="mt-3 p-3 bg-muted rounded-lg">
                  <p className="text-xs font-medium mb-1.5">Embed this survey:</p>
                  <code className="block text-xs bg-background p-2 rounded border break-all select-all">
                    {`<iframe src="${typeof window !== 'undefined' ? window.location.origin : ''}/api/surveys/public/${survey.slug}" width="100%" height="600" frameborder="0"></iframe>`}
                  </code>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
