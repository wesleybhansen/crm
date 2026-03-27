'use client'

import { useState, useEffect } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Plus, Send, Mail, X, Loader2, Users, Eye, Sparkles, FlaskConical, Wand2, LayoutTemplate, ArrowLeft, Paintbrush, Trash2 } from 'lucide-react'

type Campaign = {
  id: string; name: string; subject: string; status: string
  stats: string; created_at: string; sent_at: string | null
}

type StyleTemplate = {
  id: string; name: string; category: string; html_template: string
  is_default: boolean; categoryColor: string
}

const CATEGORY_LABELS: Record<string, string> = {
  newsletter: 'Newsletter',
  announcement: 'Announcement',
  product: 'Product',
  onboarding: 'Onboarding',
  promotion: 'Promotion',
  event: 'Event',
  'social-proof': 'Social Proof',
  educational: 'Educational',
  seasonal: 'Seasonal',
  general: 'General',
}

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [tagFilter, setTagFilter] = useState('')
  const [creating, setCreating] = useState(false)
  const [sending, setSending] = useState<string | null>(null)
  const [drafting, setDrafting] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [optimizing, setOptimizing] = useState(false)
  const [subjectFeedback, setSubjectFeedback] = useState<{ score: number; feedback: string; alternatives: string[] } | null>(null)

  // Template state
  const [step, setStep] = useState<'template' | 'compose'>('template')
  const [templates, setTemplates] = useState<StyleTemplate[]>([])
  const [loadingTemplates, setLoadingTemplates] = useState(false)
  const [selectedTemplate, setSelectedTemplate] = useState<StyleTemplate | null>(null)
  const [previewTemplate, setPreviewTemplate] = useState<StyleTemplate | null>(null)

  // AI template generation state
  const [showAiGen, setShowAiGen] = useState(false)
  const [aiPrimary, setAiPrimary] = useState('#3B82F6')
  const [aiSecondary, setAiSecondary] = useState('#1E40AF')
  const [aiBg, setAiBg] = useState('#ffffff')
  const [aiTone, setAiTone] = useState('professional')
  const [aiLayout, setAiLayout] = useState('standard single column')
  const [generatingTemplate, setGeneratingTemplate] = useState(false)

  useEffect(() => { loadCampaigns() }, [])

  function loadCampaigns() {
    fetch('/api/email/templates', { credentials: 'include' })
      .then(r => r.json()).then(d => { if (d.ok) setTemplates(d.data || []) }).catch(() => {})

    fetch('/api/campaigns', { credentials: 'include' })
      .then(r => r.json()).then(d => { if (d.ok) setCampaigns(d.data || []); setLoading(false) }).catch(() => setLoading(false))
  }

  function loadTemplates() {
    setLoadingTemplates(true)
    fetch('/api/email/templates', { credentials: 'include' })
      .then(r => r.json()).then(d => { if (d.ok) setTemplates(d.data || []) }).catch(() => {})
      .finally(() => setLoadingTemplates(false))
  }

  function openCreate() {
    setShowCreate(true)
    setStep('template')
    setSelectedTemplate(null)
    setName('')
    setSubject('')
    setBody('')
    setTagFilter('')
    setSubjectFeedback(null)
    setShowAiGen(false)
    loadTemplates()
  }

  function selectTemplate(template: StyleTemplate | null) {
    setSelectedTemplate(template)
    setStep('compose')
  }

  function buildFinalHtml(bodyContent: string): string {
    if (!selectedTemplate) {
      return `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:20px">${bodyContent.replace(/\n/g, '<br>')}</body></html>`
    }
    const html = selectedTemplate.html_template
      .replace(/\{\{content\}\}/g, bodyContent.replace(/\n/g, '<br>'))
      .replace(/\{\{brand_primary\}\}/g, '#3B82F6')
      .replace(/\{\{brand_secondary\}\}/g, '#1E40AF')
      .replace(/\{\{brand_bg\}\}/g, '#ffffff')
    return html
  }

  async function createCampaign() {
    if (!name.trim() || !subject.trim() || !body.trim()) return
    setCreating(true)
    try {
      const res = await fetch('/api/campaigns', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({
          name, subject,
          bodyHtml: buildFinalHtml(body),
          segmentFilter: tagFilter ? { tag: tagFilter } : null,
          templateId: selectedTemplate?.id || null,
        }),
      })
      const data = await res.json()
      if (data.ok) { setName(''); setSubject(''); setBody(''); setTagFilter(''); setShowCreate(false); setSelectedTemplate(null); loadCampaigns() }
    } catch {}
    setCreating(false)
  }

  async function sendCampaign(id: string) {
    if (!confirm('Send this campaign to all matching contacts?')) return
    setSending(id)
    try {
      const res = await fetch(`/api/campaigns/${id}/send`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      })
      const data = await res.json()
      if (data.ok) alert(`Campaign sent to ${data.data.sent} of ${data.data.total} contacts.`)
      else alert(data.error || 'Send failed')
      loadCampaigns()
    } catch { alert('Failed') }
    setSending(null)
  }

  async function draftWithAI() {
    if (!name.trim()) return
    setDrafting(true)
    try {
      const res = await fetch('/api/ai/draft-email', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ contactName: 'valued subscriber', purpose: 'campaign', context: `Campaign name: ${name}` }),
      })
      const data = await res.json()
      if (data.ok) { setSubject(data.subject); setBody(data.body) }
    } catch {}
    setDrafting(false)
  }

  async function generateAiTemplate() {
    setGeneratingTemplate(true)
    try {
      const res = await fetch('/api/ai/generate-email-template', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({
          brandColors: { primary: aiPrimary, secondary: aiSecondary, background: aiBg },
          tone: aiTone,
          layoutPreference: aiLayout,
        }),
      })
      const data = await res.json()
      if (data.ok && data.htmlTemplate) {
        const saveRes = await fetch('/api/email/templates', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ name: `AI: ${aiTone} ${aiLayout}`, category: 'general', htmlTemplate: data.htmlTemplate }),
        })
        const saveData = await saveRes.json()
        if (saveData.ok) {
          setShowAiGen(false)
          loadTemplates()
        }
      } else {
        alert(data.error || 'Failed to generate template')
      }
    } catch { alert('Failed to generate template') }
    setGeneratingTemplate(false)
  }

  async function deleteTemplate(id: string) {
    if (!confirm('Delete this custom template?')) return
    try {
      const res = await fetch(`/api/email/templates?id=${id}`, { method: 'DELETE', credentials: 'include' })
      const data = await res.json()
      if (data.ok) loadTemplates()
      else alert(data.error || 'Failed to delete')
    } catch { alert('Failed') }
  }

  const statusColors: Record<string, string> = {
    draft: 'bg-muted text-muted-foreground',
    sending: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
    sent: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  }

  const groupedTemplates = templates.reduce<Record<string, StyleTemplate[]>>((acc, t) => {
    const cat = t.category || 'general'
    if (!acc[cat]) acc[cat] = []
    acc[cat].push(t)
    return acc
  }, {})

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-semibold">Email Campaigns</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Send broadcasts to your contact list</p>
        </div>
        <Button type="button" size="sm" onClick={openCreate}>
          <Plus className="size-3.5 mr-1.5" /> New Campaign
        </Button>
      </div>

      {/* Create Campaign Flow */}
      {showCreate && (
        <div className="rounded-lg border bg-card p-5 mb-6 space-y-4">
          {/* Step 1: Template Selection */}
          {step === 'template' && (
            <>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <LayoutTemplate className="size-4 text-muted-foreground" />
                  <h3 className="text-sm font-semibold">Choose a Template</h3>
                </div>
                <div className="flex items-center gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => setShowAiGen(!showAiGen)}>
                    <Sparkles className="size-3 mr-1.5" /> AI Generate
                  </Button>
                  <IconButton type="button" variant="ghost" size="sm" onClick={() => setShowCreate(false)} aria-label="Close"><X className="size-4" /></IconButton>
                </div>
              </div>

              {/* AI Template Generator */}
              {showAiGen && (
                <div className="rounded-md border bg-muted/30 p-4 space-y-3">
                  <p className="text-xs font-semibold text-muted-foreground">Generate a custom template with AI</p>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Primary Color</label>
                      <div className="flex items-center gap-2">
                        <input type="color" value={aiPrimary} onChange={e => setAiPrimary(e.target.value)} className="w-8 h-8 rounded border cursor-pointer" />
                        <Input value={aiPrimary} onChange={e => setAiPrimary(e.target.value)} className="h-8 text-xs flex-1" />
                      </div>
                    </div>
                    <div>
                      <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Secondary Color</label>
                      <div className="flex items-center gap-2">
                        <input type="color" value={aiSecondary} onChange={e => setAiSecondary(e.target.value)} className="w-8 h-8 rounded border cursor-pointer" />
                        <Input value={aiSecondary} onChange={e => setAiSecondary(e.target.value)} className="h-8 text-xs flex-1" />
                      </div>
                    </div>
                    <div>
                      <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Background</label>
                      <div className="flex items-center gap-2">
                        <input type="color" value={aiBg} onChange={e => setAiBg(e.target.value)} className="w-8 h-8 rounded border cursor-pointer" />
                        <Input value={aiBg} onChange={e => setAiBg(e.target.value)} className="h-8 text-xs flex-1" />
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Tone</label>
                      <select value={aiTone} onChange={e => setAiTone(e.target.value)} className="w-full h-8 rounded-md border bg-card px-2 text-xs">
                        <option value="professional">Professional</option>
                        <option value="casual">Casual & Friendly</option>
                        <option value="bold">Bold & Energetic</option>
                        <option value="elegant">Elegant & Minimal</option>
                        <option value="playful">Playful & Fun</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Layout</label>
                      <select value={aiLayout} onChange={e => setAiLayout(e.target.value)} className="w-full h-8 rounded-md border bg-card px-2 text-xs">
                        <option value="standard single column">Single Column</option>
                        <option value="two column with sidebar">Two Column with Sidebar</option>
                        <option value="hero image with content below">Hero + Content</option>
                        <option value="card-based grid layout">Card Grid</option>
                      </select>
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <Button type="button" size="sm" onClick={generateAiTemplate} disabled={generatingTemplate}>
                      {generatingTemplate ? <Loader2 className="size-3 animate-spin mr-1.5" /> : <Paintbrush className="size-3 mr-1.5" />}
                      {generatingTemplate ? 'Generating...' : 'Generate Template'}
                    </Button>
                  </div>
                </div>
              )}

              {loadingTemplates ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <>
                  {/* No Template Option */}
                  <button
                    type="button"
                    onClick={() => selectTemplate(null)}
                    className="w-full flex items-center gap-3 rounded-md border border-dashed p-3 hover:bg-muted/50 transition text-left"
                  >
                    <div className="w-16 h-12 rounded bg-muted flex items-center justify-center shrink-0">
                      <Mail className="size-5 text-muted-foreground/50" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">No Template (Plain)</p>
                      <p className="text-[11px] text-muted-foreground">Simple plain-text style email without a styled template</p>
                    </div>
                  </button>

                  {/* Grouped Templates */}
                  {Object.entries(groupedTemplates).map(([category, catTemplates]) => (
                    <div key={category}>
                      <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2 mt-3">
                        {CATEGORY_LABELS[category] || category}
                      </p>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                        {catTemplates.map(t => (
                          <div key={t.id} className="group relative">
                            <button
                              type="button"
                              onClick={() => selectTemplate(t)}
                              className="w-full rounded-lg border overflow-hidden hover:ring-2 hover:ring-ring transition text-left"
                            >
                              <div
                                className="h-24 flex items-center justify-center relative"
                                style={{ background: `linear-gradient(135deg, ${t.categoryColor}22, ${t.categoryColor}11)` }}
                              >
                                <div className="w-[80%] h-[80%] rounded bg-white/80 shadow-sm flex flex-col items-center justify-center gap-1 px-2">
                                  <div className="w-8 h-1 rounded-full" style={{ backgroundColor: t.categoryColor }} />
                                  <div className="w-12 h-0.5 rounded-full bg-gray-200" />
                                  <div className="w-10 h-0.5 rounded-full bg-gray-200" />
                                  <div className="w-6 h-2 rounded-sm mt-0.5" style={{ backgroundColor: t.categoryColor }} />
                                </div>
                              </div>
                              <div className="px-3 py-2 border-t">
                                <p className="text-xs font-medium truncate">{t.name}</p>
                                <div className="flex items-center justify-between mt-0.5">
                                  <span className="text-[10px] text-muted-foreground">{CATEGORY_LABELS[t.category] || t.category}</span>
                                  {t.is_default && <span className="text-[9px] px-1 py-0.5 rounded bg-muted text-muted-foreground">Default</span>}
                                </div>
                              </div>
                            </button>
                            <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition">
                              <IconButton type="button" variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); setPreviewTemplate(t) }} aria-label="Preview">
                                <Eye className="size-3" />
                              </IconButton>
                              {!t.is_default && (
                                <IconButton type="button" variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); deleteTemplate(t.id) }} aria-label="Delete">
                                  <Trash2 className="size-3 text-red-500" />
                                </IconButton>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </>
              )}
            </>
          )}

          {/* Step 2: Compose */}
          {step === 'compose' && (
            <>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => setStep('template')} className="text-muted-foreground hover:text-foreground transition">
                    <ArrowLeft className="size-4" />
                  </button>
                  <h3 className="text-sm font-semibold">New Campaign</h3>
                  {selectedTemplate && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                      Template: {selectedTemplate.name}
                    </span>
                  )}
                  {!selectedTemplate && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">Plain</span>
                  )}
                </div>
                <IconButton type="button" variant="ghost" size="sm" onClick={() => setShowCreate(false)} aria-label="Close"><X className="size-4" /></IconButton>
              </div>
              <div className="grid gap-3">
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Campaign Name</label>
                    <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. March Newsletter" className="h-9 text-sm" autoFocus />
                  </div>
                  <div className="w-40">
                    <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Filter by Tag</label>
                    <Input value={tagFilter} onChange={e => setTagFilter(e.target.value)} placeholder="e.g. newsletter" className="h-9 text-sm" />
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Subject Line</label>
                    <Button type="button" variant="outline" size="sm" onClick={async () => {
                      if (!subject.trim()) return
                      setOptimizing(true); setSubjectFeedback(null)
                      try {
                        const res = await fetch('/api/ai/optimize-subject', {
                          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
                          body: JSON.stringify({ subject }),
                        })
                        const data = await res.json()
                        if (data.ok) setSubjectFeedback({ score: data.score, feedback: data.feedback, alternatives: data.alternatives })
                      } catch {}
                      setOptimizing(false)
                    }} disabled={optimizing || !subject.trim()} className="h-6 text-[10px] px-2">
                      {optimizing ? <Loader2 className="size-3 animate-spin mr-1" /> : <Wand2 className="size-3 mr-1" />} Optimize
                    </Button>
                  </div>
                  <Input value={subject} onChange={e => { setSubject(e.target.value); setSubjectFeedback(null) }} placeholder="Your email subject" className="h-9 text-sm" />
                  {subjectFeedback && (
                    <div className="mt-2 rounded border bg-muted/30 p-2.5 space-y-1.5">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-semibold ${subjectFeedback.score >= 7 ? 'text-emerald-600' : subjectFeedback.score >= 4 ? 'text-amber-600' : 'text-red-600'}`}>
                          {subjectFeedback.score}/10
                        </span>
                        <span className="text-[10px] text-muted-foreground">{subjectFeedback.feedback}</span>
                      </div>
                      {subjectFeedback.alternatives?.length > 0 && (
                        <div className="space-y-1">
                          <p className="text-[10px] text-muted-foreground font-medium">Suggestions:</p>
                          {subjectFeedback.alternatives.map((alt, i) => (
                            <button key={i} type="button" onClick={() => { setSubject(alt); setSubjectFeedback(null) }}
                              className="block w-full text-left text-[11px] px-2 py-1 rounded hover:bg-muted transition truncate">
                              {alt}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Email Body</label>
                    <Button type="button" variant="outline" size="sm" onClick={draftWithAI} disabled={drafting || !name.trim()} className="h-6 text-[10px] px-2">
                      {drafting ? <Loader2 className="size-3 animate-spin mr-1" /> : <Sparkles className="size-3 mr-1" />} AI Draft
                    </Button>
                  </div>
                  <textarea value={body} onChange={e => setBody(e.target.value)}
                    placeholder="Write your email... Use {{firstName}} for personalization."
                    className="w-full rounded-md border bg-card px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring h-32" />
                  <p className="text-[10px] text-muted-foreground mt-1">Variables: {'{{firstName}}'}, {'{{name}}'}, {'{{email}}'}</p>
                </div>

                {/* Template Preview */}
                {selectedTemplate && body.trim() && (
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Preview</label>
                    </div>
                    <div className="rounded-md border overflow-hidden bg-white">
                      <iframe
                        srcDoc={buildFinalHtml(body)}
                        className="w-full h-64 pointer-events-none"
                        title="Template Preview"
                        sandbox=""
                      />
                    </div>
                  </div>
                )}
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t">
                <Button type="button" variant="outline" size="sm" onClick={() => setStep('template')}>
                  <ArrowLeft className="size-3 mr-1" /> Change Template
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setShowCreate(false)}>Cancel</Button>
                <Button type="button" size="sm" onClick={createCampaign} disabled={creating || !name.trim() || !subject.trim() || !body.trim()}>
                  {creating ? <Loader2 className="size-3 animate-spin mr-1" /> : <Mail className="size-3 mr-1" />} Create Campaign
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Template Preview Modal */}
      {previewTemplate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setPreviewTemplate(null)}>
          <div className="bg-card rounded-lg shadow-xl w-[680px] max-h-[80vh] overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <div>
                <p className="text-sm font-semibold">{previewTemplate.name}</p>
                <p className="text-[10px] text-muted-foreground">{CATEGORY_LABELS[previewTemplate.category] || previewTemplate.category}</p>
              </div>
              <IconButton type="button" variant="ghost" size="sm" onClick={() => setPreviewTemplate(null)} aria-label="Close">
                <X className="size-4" />
              </IconButton>
            </div>
            <div className="overflow-auto bg-white" style={{ maxHeight: 'calc(80vh - 56px)' }}>
              <iframe
                srcDoc={previewTemplate.html_template
                  .replace(/\{\{content\}\}/g, '<p style="color:#6b7280;font-style:italic">Your email content will appear here...</p>')
                  .replace(/\{\{subject\}\}/g, 'Preview Subject Line')
                  .replace(/\{\{brand_primary\}\}/g, '#3B82F6')
                  .replace(/\{\{brand_secondary\}\}/g, '#1E40AF')
                  .replace(/\{\{brand_bg\}\}/g, '#ffffff')
                  .replace(/\{\{unsubscribe_url\}\}/g, '#')
                  .replace(/\{\{preference_url\}\}/g, '#')}
                className="w-full h-[600px]"
                title="Template Preview"
                sandbox=""
              />
            </div>
          </div>
        </div>
      )}

      {/* Campaign List */}
      {loading ? <div className="text-sm text-muted-foreground">Loading...</div> :
      campaigns.length === 0 ? (
        <div className="rounded-lg border p-12 text-center">
          <Mail className="size-8 mx-auto mb-3 text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">No campaigns yet. Create one to send a broadcast to your contacts.</p>
        </div>
      ) : (
        <div className="rounded-lg border divide-y">
          {campaigns.map(c => {
            const stats = typeof c.stats === 'string' ? JSON.parse(c.stats) : c.stats
            return (
              <div key={c.id} className="flex items-center gap-4 px-5 py-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{c.name}</p>
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${statusColors[c.status] || ''}`}>{c.status}</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">{c.subject}</p>
                </div>
                {c.status === 'sent' && stats && (
                  <div className="flex gap-4 text-xs text-muted-foreground tabular-nums shrink-0">
                    <span>{stats.sent || 0} sent</span>
                    <span>{stats.opened || 0} opened</span>
                    <span>{stats.clicked || 0} clicked</span>
                  </div>
                )}
                {c.status === 'draft' && (
                  <div className="flex gap-1">
                    <Button type="button" variant="outline" size="sm" onClick={async () => {
                      setTesting(c.id)
                      try {
                        const res = await fetch(`/api/campaigns/${c.id}/test`, { method: 'POST', credentials: 'include' })
                        const data = await res.json()
                        if (data.ok) alert(`Test email sent to ${data.sentTo}`)
                        else alert(data.error || 'Failed to send test')
                      } catch { alert('Failed') }
                      setTesting(null)
                    }} disabled={testing === c.id}>
                      {testing === c.id ? <Loader2 className="size-3 animate-spin mr-1" /> : <FlaskConical className="size-3 mr-1" />} Test
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => sendCampaign(c.id)} disabled={sending === c.id}>
                      {sending === c.id ? <Loader2 className="size-3 animate-spin mr-1" /> : <Send className="size-3 mr-1" />} Send
                    </Button>
                  </div>
                )}
                <span className="text-xs text-muted-foreground shrink-0">{new Date(c.created_at).toLocaleDateString()}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
