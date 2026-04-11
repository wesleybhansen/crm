'use client'

import { useState, useEffect } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Plus, Send, Mail, X, Loader2, Users, Eye, FlaskConical, Sparkles, LayoutTemplate, ArrowLeft, Trash2, Pencil } from 'lucide-react'

type Campaign = {
  id: string; name: string; subject: string; body_html: string; status: string
  stats: string; created_at: string; sent_at: string | null
  segment_filter: any; template_id: string | null
}

type StyleTemplate = {
  id: string; name: string; category: string; html_template: string
  is_default: boolean; categoryColor: string
}

const STYLE_LABELS: Record<string, string> = {
  newsletter: 'Clean',
  announcement: 'Bold',
  product: 'Showcase',
  onboarding: 'Friendly',
  promotion: 'Vibrant',
  event: 'Elegant',
  'social-proof': 'Warm',
  educational: 'Professional',
  seasonal: 'Festive',
  general: 'Simple',
}

export default function CampaignsPage({ embedded }: { embedded?: boolean } = {}) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [tagFilter, setTagFilter] = useState('')
  const [audienceType, setAudienceType] = useState<'all' | 'list' | 'tag'>('all')
  const [selectedListId, setSelectedListId] = useState('')
  const [availableLists, setAvailableLists] = useState<Array<{ id: string; name: string; member_count: number }>>([])
  const [listsLoaded, setListsLoaded] = useState(false)
  const [availableTags, setAvailableTags] = useState<Array<{ slug: string; name: string }>>([])
  const [tagsLoaded, setTagsLoaded] = useState(false)
  const [creating, setCreating] = useState(false)
  const [sending, setSending] = useState<string | null>(null)
  const [drafting, setDrafting] = useState(false)
  const [showAiPrompt, setShowAiPrompt] = useState(false)
  const [aiDraftPrompt, setAiDraftPrompt] = useState('')
  const [testing, setTesting] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Template state
  const [step, setStep] = useState<'template' | 'compose' | 'preview'>('template')
  const [templates, setTemplates] = useState<StyleTemplate[]>([])
  const [loadingTemplates, setLoadingTemplates] = useState(false)
  const [selectedTemplate, setSelectedTemplate] = useState<StyleTemplate | null>(null)
  const [previewTemplate, setPreviewTemplate] = useState<StyleTemplate | null>(null)


  useEffect(() => { loadCampaigns() }, [])

  function loadCampaigns() {
    fetch('/api/email/templates', { credentials: 'include' })
      .then(r => r.json()).then(d => { if (d.ok) setTemplates(d.data || []) }).catch(() => {})

    fetch('/api/email/campaigns', { credentials: 'include' })
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
    setAudienceType('all')
    setSelectedListId('')

    setEditingId(null)
    loadTemplates()
  }

  function openEdit(campaign: Campaign) {
    setEditingId(campaign.id)
    setShowCreate(true)
    setStep('compose')
    setName(campaign.name)
    setSubject(campaign.subject)
    // Extract plain text from HTML body for editing
    const tempDiv = document.createElement('div')
    tempDiv.innerHTML = campaign.body_html || ''
    const bodyText = tempDiv.innerText || tempDiv.textContent || ''
    setBody(bodyText)
    setSelectedTemplate(null)

    // Restore audience
    const filter = campaign.segment_filter
      ? (typeof campaign.segment_filter === 'string' ? JSON.parse(campaign.segment_filter) : campaign.segment_filter)
      : null
    if (filter?.type === 'list' && filter.listId) {
      setAudienceType('list')
      setSelectedListId(filter.listId)
      if (!listsLoaded) {
        setListsLoaded(true)
        fetch('/api/email/lists', { credentials: 'include' }).then(r => r.json())
          .then(d => { if (d.ok) setAvailableLists(d.data || []) }).catch(() => {})
      }
    } else if (filter?.type === 'tag' && filter.tag) {
      setAudienceType('tag')
      setTagFilter(filter.tag)
    } else {
      setAudienceType('all')
      setTagFilter('')
      setSelectedListId('')
    }
    loadTemplates()
  }

  async function deleteCampaign(id: string) {
    if (!confirm('Delete this blast?')) return
    try {
      const res = await fetch(`/api/email/campaigns?id=${id}`, { method: 'DELETE', credentials: 'include' })
      const data = await res.json()
      if (data.ok) loadCampaigns()
      else alert(data.error || 'Failed to delete')
    } catch { alert('Failed to delete') }
  }

  function selectTemplate(template: StyleTemplate | null) {
    setSelectedTemplate(template)
    setStep('compose')
  }

  function buildFinalHtml(bodyContent: string, forPreview = false): string {
    let formattedBody = bodyContent.replace(/\n/g, '<br>')
    if (forPreview) {
      formattedBody = formattedBody
        .replace(/\{\{firstName\}\}/g, 'John')
        .replace(/\{\{name\}\}/g, 'John Smith')
        .replace(/\{\{email\}\}/g, 'john@example.com')
    }

    if (!selectedTemplate) {
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:-apple-system,system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#1a1a1a;font-size:15px;line-height:1.6}a{color:#3b82f6}</style></head><body>${formattedBody}</body></html>`
    }

    const html = selectedTemplate.html_template
      .replace(/\{\{content\}\}/g, formattedBody)
      .replace(/\{\{brand_primary\}\}/g, '#3B82F6')
      .replace(/\{\{brand_secondary\}\}/g, '#1E40AF')
      .replace(/\{\{brand_bg\}\}/g, '#f8fafc')
      .replace(/\{\{unsubscribe_url\}\}/g, '#')
      .replace(/\{\{preferences_url\}\}/g, '#')
      .replace(/\{\{preference_url\}\}/g, '#')
      .replace(/\{\{(?!firstName|name|email)[a-zA-Z_]+\}\}/g, '')

    return html
  }

  async function saveCampaign() {
    if (!name.trim() || !subject.trim() || !body.trim()) return
    setCreating(true)
    const payload = {
      name, subject,
      bodyHtml: buildFinalHtml(body),
      segmentFilter: audienceType === 'list' && selectedListId ? { type: 'list', listId: selectedListId }
        : audienceType === 'tag' && tagFilter ? { type: 'tag', tag: tagFilter } : null,
      templateId: selectedTemplate?.id || null,
    }
    try {
      const res = editingId
        ? await fetch('/api/email/campaigns', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
            body: JSON.stringify({ id: editingId, ...payload }),
          })
        : await fetch('/api/email/campaigns', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
            body: JSON.stringify(payload),
          })
      const data = await res.json()
      if (data.ok) { setName(''); setSubject(''); setBody(''); setTagFilter(''); setShowCreate(false); setSelectedTemplate(null); setEditingId(null); loadCampaigns() }
    } catch {}
    setCreating(false)
  }

  async function sendCampaign(id: string) {
    if (!confirm('Send this blast to all matching contacts?')) return
    setSending(id)
    try {
      const res = await fetch(`/api/email/campaigns-send?id=${id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      })
      const data = await res.json()
      if (data.ok) alert(`Blast sent to ${data.data.sent} of ${data.data.total} contacts.`)
      else alert(data.error || 'Failed to send blast')
      loadCampaigns()
    } catch { alert('Failed to send blast') }
    setSending(null)
  }

  async function draftWithAI() {
    setDrafting(true)
    try {
      const parts: string[] = []
      if (name.trim()) parts.push(`Blast name: ${name}`)
      if (aiDraftPrompt.trim()) parts.push(`User instructions: ${aiDraftPrompt}`)
      if (parts.length === 0) parts.push('Write a general marketing email blast')
      parts.push('IMPORTANT: Use {{firstName}} to personalize the greeting (e.g. "Hi {{firstName}},"). Available variables: {{firstName}}, {{name}}, {{email}}.')
      const context = parts.join('. ')
      const res = await fetch('/api/ai/draft-email', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ contactName: '{{firstName}}', purpose: 'campaign', context }),
      })
      const data = await res.json()
      if (data.ok) { setSubject(data.subject); setBody(data.body); setShowAiPrompt(false); setAiDraftPrompt('') }
    } catch {}
    setDrafting(false)
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
    <div className={embedded ? '' : 'p-6 max-w-4xl mx-auto'}>
      {!embedded && (
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-lg font-semibold">Email Blasts</h1>
            <p className="text-xs text-muted-foreground mt-0.5">Send blasts to your contact list</p>
          </div>
        </div>
      )}
      <div className={`flex items-center justify-between ${embedded ? 'mb-4' : 'mb-6'}`}>
        <div />
        <Button type="button" size="sm" onClick={openCreate}>
          <Plus className="size-3.5 mr-1.5" /> New Blast
        </Button>
      </div>

      {/* Create Blast Flow */}
      {showCreate && (
        <div className="rounded-lg border bg-card p-5 mb-6 space-y-4">
          {/* Step 1: Template Selection */}
          {step === 'template' && (
            <>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <LayoutTemplate className="size-4 text-muted-foreground" />
                  <h3 className="text-sm font-semibold">Choose a Style</h3>
                </div>
                <IconButton type="button" variant="ghost" size="sm" onClick={() => setShowCreate(false)} aria-label="Close"><X className="size-4" /></IconButton>
              </div>

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
                    className="w-full flex items-center gap-3 rounded-md border border p-3 hover:bg-muted/50 transition text-left"
                  >
                    <div className="w-16 h-12 rounded bg-muted flex items-center justify-center shrink-0">
                      <Mail className="size-5 text-muted-foreground/50" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">No Template (Plain)</p>
                      <p className="text-[11px] text-muted-foreground">Simple plain-text style email without a styled template</p>
                    </div>
                  </button>

                  {/* Templates */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-3">
                    {templates.map(t => (
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
                                  <span className="text-[10px] text-muted-foreground">{STYLE_LABELS[t.category] || t.category}</span>
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
                  <h3 className="text-sm font-semibold">{editingId ? 'Edit Blast' : 'New Blast'}</h3>
                  {selectedTemplate && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                      Template: {selectedTemplate.name}
                    </span>
                  )}
                  {!selectedTemplate && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">Plain</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => setShowAiPrompt(!showAiPrompt)} disabled={drafting} className="h-7 text-xs">
                    {drafting ? <Loader2 className="size-3 animate-spin mr-1" /> : <Sparkles className="size-3 mr-1" />} AI Draft
                  </Button>
                  <IconButton type="button" variant="ghost" size="sm" onClick={() => setShowCreate(false)} aria-label="Close"><X className="size-4" /></IconButton>
                </div>
              </div>
              {showAiPrompt && (
                <div className="rounded-md border bg-muted/30 p-3 space-y-2">
                  <p className="text-[11px] text-muted-foreground">Describe what you want to say (optional):</p>
                  <textarea value={aiDraftPrompt} onChange={e => setAiDraftPrompt(e.target.value)}
                    placeholder="e.g. Announce our new coaching program launching next month, mention the early bird discount"
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring h-16" />
                  <div className="flex gap-2">
                    <Button type="button" size="sm" onClick={draftWithAI} disabled={drafting} className="h-7 text-xs">
                      {drafting ? <><Loader2 className="size-3 animate-spin mr-1" /> Generating...</> : <><Sparkles className="size-3 mr-1" /> Generate</>}
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => { setShowAiPrompt(false); setAiDraftPrompt('') }} className="h-7 text-xs">Cancel</Button>
                  </div>
                </div>
              )}

              <div className="grid gap-4">
                <div>
                  <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Blast Name</label>
                  <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. March Newsletter" className="h-9 text-sm" autoFocus />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Send To</label>
                  <div className="flex gap-2">
                    <select value={audienceType} onChange={e => {
                      setAudienceType(e.target.value as 'all' | 'list' | 'tag')
                      if (e.target.value === 'list' && !listsLoaded) {
                        setListsLoaded(true)
                        fetch('/api/email/lists', { credentials: 'include' }).then(r => r.json())
                          .then(d => { if (d.ok) setAvailableLists(d.data || []) }).catch(() => {})
                      }
                    }} className="h-9 text-sm rounded-md border bg-background px-2 flex-1">
                      <option value="all">All contacts with email</option>
                      <option value="list">A mailing list</option>
                      <option value="tag">Contacts with a specific tag</option>
                    </select>
                    {audienceType === 'list' && (
                      <select value={selectedListId} onChange={e => setSelectedListId(e.target.value)}
                        className="h-9 text-sm rounded-md border bg-background px-2 flex-1">
                        <option value="">Select a list...</option>
                        {availableLists.map(l => <option key={l.id} value={l.id}>{l.name} ({l.member_count})</option>)}
                      </select>
                    )}
                    {audienceType === 'tag' && (
                      <select value={tagFilter} onChange={e => setTagFilter(e.target.value)}
                        onFocus={() => {
                          if (!tagsLoaded) {
                            setTagsLoaded(true)
                            fetch('/api/crm-contact-tags', { credentials: 'include' }).then(r => r.json())
                              .then(d => { if (d.ok) setAvailableTags((d.data || []).map((t: any) => ({ slug: t.slug || t.id, name: t.name || t.label }))) }).catch(() => {})
                          }
                        }}
                        className="h-9 text-sm rounded-md border bg-background px-2 flex-1">
                        <option value="">Select a tag...</option>
                        {availableTags.map(t => <option key={t.slug} value={t.slug}>{t.name}</option>)}
                      </select>
                    )}
                  </div>
                </div>
                <div>
                  <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Subject Line</label>
                  <Input value={subject} onChange={e => setSubject(e.target.value)} placeholder="Your email subject" className="h-9 text-sm" />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Email Body</label>
                  <textarea value={body} onChange={e => setBody(e.target.value)}
                    placeholder="Write your email... Use {{firstName}} for personalization."
                    className="w-full rounded-md border bg-card px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring h-32" />
                  <p className="text-[10px] text-muted-foreground mt-1">Variables: {'{{firstName}}'}, {'{{name}}'}, {'{{email}}'}</p>
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t">
                <Button type="button" variant="outline" size="sm" onClick={() => setStep('template')}>
                  <ArrowLeft className="size-3 mr-1" /> Change Template
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setShowCreate(false)}>Cancel</Button>
                <Button type="button" size="sm" onClick={() => setStep('preview')} disabled={!name.trim() || !subject.trim() || !body.trim()}>
                  Preview Blast
                </Button>
              </div>
            </>
          )}

          {/* Step 3: Preview */}
          {step === 'preview' && (
            <>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => setStep('compose')} className="text-muted-foreground hover:text-foreground transition">
                    <ArrowLeft className="size-4" />
                  </button>
                  <h3 className="text-sm font-semibold">Preview Blast</h3>
                </div>
                <IconButton type="button" variant="ghost" size="sm" onClick={() => setShowCreate(false)} aria-label="Close"><X className="size-4" /></IconButton>
              </div>

              <div className="rounded-lg border overflow-hidden">
                <div className="bg-muted/30 px-4 py-3 border-b">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs text-muted-foreground">Blast Name</p>
                      <p className="text-sm font-medium">{name}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-muted-foreground">Audience</p>
                      <p className="text-sm font-medium">
                        {audienceType === 'all' ? 'All contacts' : audienceType === 'list' ? availableLists.find(l => l.id === selectedListId)?.name || 'Selected list' : `Tag: ${tagFilter}`}
                      </p>
                    </div>
                  </div>
                </div>
                <div className="px-4 py-3 border-b">
                  <p className="text-xs text-muted-foreground mb-0.5">Subject</p>
                  <p className="text-sm font-medium">{subject}</p>
                </div>
                <div className="px-4 py-3">
                  <p className="text-xs text-muted-foreground mb-1">Email Body</p>
                      <iframe
                    srcDoc={buildFinalHtml(body, true)}
                    className="w-full h-[300px] rounded border"
                    sandbox=""
                  />
                </div>
              </div>

              {selectedTemplate && (
                <p className="text-xs text-muted-foreground">Template: {selectedTemplate.name} ({STYLE_LABELS[selectedTemplate.category] || selectedTemplate.category})</p>
              )}

              <div className="flex justify-end gap-2 pt-2 border-t">
                <Button type="button" variant="outline" size="sm" onClick={() => setStep('compose')}>
                  <ArrowLeft className="size-3 mr-1" /> Edit
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setShowCreate(false)}>Cancel</Button>
                <Button type="button" size="sm" onClick={saveCampaign} disabled={creating}>
                  {creating ? <Loader2 className="size-3 animate-spin mr-1" /> : <Mail className="size-3 mr-1" />} {editingId ? 'Save Blast' : 'Create Blast'}
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
                <p className="text-[10px] text-muted-foreground">{STYLE_LABELS[previewTemplate.category] || previewTemplate.category}</p>
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
          <p className="text-sm text-muted-foreground">No blasts yet. Create one to send a message to people on your lists.</p>
        </div>
      ) : (
        <div className="rounded-lg border divide-y">
          {campaigns.map(c => {
            const stats = typeof c.stats === 'string' ? JSON.parse(c.stats) : c.stats
            const isExpanded = expandedId === c.id
            const segFilter = c.segment_filter ? (typeof c.segment_filter === 'string' ? JSON.parse(c.segment_filter) : c.segment_filter) : null
            const audience = segFilter?.type === 'list' ? 'Mailing list' : segFilter?.type === 'tag' ? `Tag: ${segFilter.tag}` : 'All contacts'
            return (
              <div key={c.id}>
                <div className="flex items-center gap-3 px-5 py-4 cursor-pointer hover:bg-muted/30 transition" onClick={() => setExpandedId(isExpanded ? null : c.id)}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium truncate">{c.name}</p>
                      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 ${statusColors[c.status] || ''}`}>{c.status}</span>
                    </div>
                  </div>
                  {c.status === 'sent' && stats && (
                    <div className="flex gap-4 text-xs text-muted-foreground tabular-nums shrink-0">
                      <span>{stats.sent || 0} sent</span>
                      <span>{stats.opened || 0} opened</span>
                      <span>{stats.clicked || 0} clicked</span>
                    </div>
                  )}
                  {c.status === 'draft' && (
                    <div className="flex gap-1" onClick={e => e.stopPropagation()}>
                      <Button type="button" variant="outline" size="sm" onClick={() => openEdit(c)}>
                        <Pencil className="size-3 mr-1" /> Edit
                      </Button>
                      <Button type="button" variant="outline" size="sm" onClick={async () => {
                        setTesting(c.id)
                        try {
                          const res = await fetch(`/api/email/campaigns-test?id=${c.id}`, { method: 'POST', credentials: 'include' })
                          const data = await res.json()
                          if (data.ok) alert(`Test email sent to ${data.sentTo}`)
                          else alert(data.error || 'Failed to send test')
                        } catch { alert('Failed to send test') }
                        setTesting(null)
                      }} disabled={testing === c.id}>
                        {testing === c.id ? <Loader2 className="size-3 animate-spin mr-1" /> : <FlaskConical className="size-3 mr-1" />} Test
                      </Button>
                      <Button type="button" variant="outline" size="sm" onClick={() => sendCampaign(c.id)} disabled={sending === c.id}>
                        {sending === c.id ? <Loader2 className="size-3 animate-spin mr-1" /> : <Send className="size-3 mr-1" />} Send
                      </Button>
                    </div>
                  )}
                  <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                    <IconButton type="button" variant="ghost" size="sm" onClick={() => deleteCampaign(c.id)} aria-label="Delete">
                      <Trash2 className="size-3.5 text-red-500" />
                    </IconButton>
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0">{new Date(c.created_at).toLocaleDateString()}</span>
                </div>
                {isExpanded && (
                  <div className="px-5 pb-4 space-y-3 bg-muted/10">
                    <div className="grid grid-cols-2 gap-4 text-xs">
                      <div>
                        <p className="text-muted-foreground mb-0.5">Audience</p>
                        <p className="font-medium">{audience}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground mb-0.5">Subject</p>
                        <p className="font-medium">{c.subject}</p>
                      </div>
                    </div>
                    {c.body_html && (
                      <div>
                        <p className="text-xs text-muted-foreground mb-1">Body</p>
                        <iframe
                          srcDoc={c.body_html}
                          className="w-full h-[200px] rounded border bg-white"
                          sandbox=""
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
