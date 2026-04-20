'use client'

import { useState, useEffect, useRef } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { Switch } from '@open-mercato/ui/primitives/switch'
import { Label } from '@open-mercato/ui/primitives/label'
import {
  ArrowLeft, Sparkles, Globe, Upload, FileText, X, Loader2,
  Check, ChevronRight, Save, Mic, BookOpen, Zap, MessageSquare,
} from 'lucide-react'

const TONES = [
  { id: 'professional', label: 'Professional', desc: 'Business-appropriate, clear and direct' },
  { id: 'friendly', label: 'Friendly', desc: 'Warm, approachable, uses natural language' },
  { id: 'casual', label: 'Casual', desc: 'Relaxed, conversational, emoji-friendly' },
  { id: 'formal', label: 'Formal', desc: 'Polished, structured, executive-level' },
  { id: 'custom', label: 'Custom', desc: 'Define your own tone and style' },
]

export default function AiSetupPage() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [step, setStep] = useState(0)

  // Form state
  const [enabled, setEnabled] = useState(true)
  const [businessName, setBusinessName] = useState('')
  const [businessDescription, setBusinessDescription] = useState('')
  const [knowledgeBase, setKnowledgeBase] = useState('')
  const [tone, setTone] = useState('professional')
  const [customTone, setCustomTone] = useState('')
  const [instructions, setInstructions] = useState('')
  const [cloneVoice, setCloneVoice] = useState(false)

  // Import state
  const [importing, setImporting] = useState(false)
  const [websiteUrl, setWebsiteUrl] = useState('')
  const [uploadedFile, setUploadedFile] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const voiceFileRef = useRef<HTMLInputElement>(null)

  // Brand Voice state
  const [voiceProfile, setVoiceProfile] = useState<any>(null)
  const [voiceUpdatedAt, setVoiceUpdatedAt] = useState<string | null>(null)
  const [voiceSource, setVoiceSource] = useState<string | null>(null)

  // Email Intelligence state (step 4)
  const [eiEnabled, setEiEnabled] = useState(false)
  const [eiAutoCreate, setEiAutoCreate] = useState(true)
  const [eiAutoTimeline, setEiAutoTimeline] = useState(true)
  const [eiAutoEngagement, setEiAutoEngagement] = useState(true)
  const [eiAutoStage, setEiAutoStage] = useState(false)
  const [eiSaving, setEiSaving] = useState(false)
  const [voiceAnalyzing, setVoiceAnalyzing] = useState(false)
  const [voiceError, setVoiceError] = useState('')

  // Load existing settings + voice profile
  useEffect(() => {
    Promise.all([
      fetch('/api/inbox/ai-settings', { credentials: 'include' }).then(r => r.json()),
      fetch('/api/ai/learn-voice', { credentials: 'include' }).then(r => r.json()),
      fetch('/api/email/intelligence-settings', { credentials: 'include' }).then(r => r.json()),
    ]).then(([settings, voice, ei]) => {
      if (ei.ok && ei.data) {
        setEiEnabled(ei.data.is_enabled ?? false)
        setEiAutoCreate(ei.data.auto_create_contacts ?? true)
        setEiAutoTimeline(ei.data.auto_update_timeline ?? true)
        setEiAutoEngagement(ei.data.auto_update_engagement ?? true)
        setEiAutoStage(ei.data.auto_advance_stage ?? false)
      }
      if (settings.ok && settings.data) {
        setEnabled(settings.data.enabled ?? true)
        setBusinessName(settings.data.business_name || '')
        setBusinessDescription(settings.data.business_description || '')
        setKnowledgeBase(settings.data.knowledge_base || '')
        const t = settings.data.tone || 'professional'
        if (TONES.find(x => x.id === t && x.id !== 'custom')) { setTone(t) }
        else { setTone('custom'); setCustomTone(t) }
        setInstructions(settings.data.instructions || '')
      }
      if (voice.ok && voice.data?.profile) {
        setVoiceProfile(voice.data.profile)
        setVoiceUpdatedAt(voice.data.updatedAt)
        setVoiceSource(voice.data.source)
        setCloneVoice(true)
      }
    }).catch(() => {}).finally(() => setLoading(false))
  }, [])

  // Analyze voice from Gmail
  const analyzeGmail = async () => {
    setVoiceAnalyzing(true)
    setVoiceError('')
    try {
      const res = await fetch('/api/ai/learn-voice', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'gmail' }),
      })
      const d = await res.json()
      if (d.ok) {
        setVoiceProfile(d.data)
        setVoiceSource('gmail')
        setVoiceUpdatedAt(new Date().toISOString())
      } else {
        setVoiceError(d.error || 'Analysis failed')
      }
    } catch { setVoiceError('Failed to analyze') }
    setVoiceAnalyzing(false)
  }

  // Analyze voice from uploaded document
  const analyzeDocument = async (content: string) => {
    setVoiceAnalyzing(true)
    setVoiceError('')
    try {
      const res = await fetch('/api/ai/learn-voice', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'document', documentContent: content }),
      })
      const d = await res.json()
      if (d.ok) {
        setVoiceProfile(d.data)
        setVoiceSource('document')
        setVoiceUpdatedAt(new Date().toISOString())
      } else {
        setVoiceError(d.error || 'Analysis failed')
      }
    } catch { setVoiceError('Failed to analyze') }
    setVoiceAnalyzing(false)
  }

  const handleVoiceFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (event) => {
      const text = event.target?.result as string
      if (text) analyzeDocument(text)
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  // Import from website
  const handleImportWebsite = async () => {
    if (!websiteUrl.trim()) return
    setImporting(true)
    try {
      const res = await fetch('/api/chat/scrape-website', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: websiteUrl }),
      })
      const data = await res.json()
      if (data.ok && data.data?.content) {
        // Auto-fill business description if empty
        if (!businessDescription.trim()) {
          const lines = data.data.content.split('\n')
          const descLines = lines.slice(0, 5).join('\n')
          setBusinessDescription(descLines.substring(0, 500))
        }
        // Append to knowledge base
        setKnowledgeBase(prev => prev ? `${prev}\n\n--- Imported from ${data.data.url} ---\n${data.data.content}` : data.data.content)
        const pages = data.data.pagesScraped || 1
        alert(`Imported content from ${pages} page${pages > 1 ? 's' : ''}!`)
        setWebsiteUrl('')
      } else {
        alert(data.error || 'Failed to import')
      }
    } catch { alert('Failed to fetch website') }
    setImporting(false)
  }

  // File upload
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (event) => {
      const text = event.target?.result as string
      if (text) {
        setKnowledgeBase(prev => prev ? `${prev}\n\n--- From ${file.name} ---\n${text}` : text)
        setUploadedFile(file.name)
      }
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  const saveEiSettings = async (patch: Record<string, unknown>) => {
    setEiSaving(true)
    try {
      await fetch('/api/email/intelligence-settings', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
    } catch {}
    setEiSaving(false)
  }

  // Save
  const handleSave = async () => {
    setSaving(true)
    try {
      await fetch('/api/inbox/ai-settings', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled,
          businessName,
          businessDescription,
          knowledgeBase,
          tone: tone === 'custom' ? customTone : tone,
          instructions,
        }),
      })
      setSaved(true)
      setTimeout(() => { window.location.href = '/backend/inbox' }, 1200)
    } catch { alert('Failed to save') }
    setSaving(false)
  }

  if (loading) {
    return <div className="flex items-center justify-center py-24"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
  }

  const steps = ['Business Context', 'Knowledge Base', 'Tone & Rules', 'Email Intelligence']

  return (
    <div className="max-w-2xl mx-auto py-8 px-4">
      {/* Header */}
      <div className="flex items-center gap-3 mb-2">
        <a href="/backend/inbox" className="text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="size-4" />
        </a>
        <div className="flex items-center gap-2">
          <div className="size-8 rounded-lg bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center">
            <Sparkles className="size-4 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">AI Reply Assistant</h1>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Label htmlFor="ai-enabled" className="text-sm">Enabled</Label>
            <Switch id="ai-enabled" checked={enabled} onCheckedChange={setEnabled} />
          </div>
          <Button type="button" onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="size-4 mr-2 animate-spin" /> : saved ? <Check className="size-4 mr-2 text-emerald-500" /> : <Save className="size-4 mr-2" />}
            {saving ? 'Saving...' : saved ? 'Saved!' : 'Save'}
          </Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground mb-8 ml-11">Train the AI on your business so it can automatically draft personalized replies to customers in your inbox.</p>

      {/* Step navigation */}
      <div className="flex items-center gap-1 mb-8">
        {steps.map((label, idx) => (
          <button key={idx} type="button" onClick={() => setStep(idx)}
            className={`flex-1 relative py-3 text-center text-sm font-medium rounded-lg transition-colors ${step === idx ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300' : 'bg-muted/50 text-muted-foreground hover:text-foreground hover:bg-muted'}`}>
            <span className="text-[10px] font-bold text-violet-400 block mb-0.5">{idx + 1}</span>
            {label}
          </button>
        ))}
      </div>

      {/* ═══ Step 1: Business Context ═══ */}
      {step === 0 && (
        <div className="space-y-6">
          <div className="bg-card rounded-xl border p-6">
            <h2 className="text-sm font-semibold mb-1">Import from your website</h2>
            <p className="text-xs text-muted-foreground mb-4">We'll scan your website to automatically fill in your business details and knowledge base.</p>
            <div className="flex items-center gap-2">
              <Input value={websiteUrl} onChange={e => setWebsiteUrl(e.target.value)} placeholder="https://yourbusiness.com"
                className="flex-1" onKeyDown={e => { if (e.key === 'Enter') handleImportWebsite() }} />
              <Button type="button" variant="outline" onClick={handleImportWebsite} disabled={importing || !websiteUrl.trim()}>
                {importing ? <Loader2 className="size-4 mr-2 animate-spin" /> : <Globe className="size-4 mr-2" />}
                {importing ? 'Scanning...' : 'Scan Website'}
              </Button>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1.5 block">Business Name</label>
              <Input value={businessName} onChange={e => setBusinessName(e.target.value)} placeholder="Your Business Name" />
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">About Your Business</label>
              <Textarea value={businessDescription} onChange={e => setBusinessDescription(e.target.value)}
                placeholder="What does your business do? Who are your customers?"
                rows={5} className="text-sm" />
              <p className="text-[11px] text-muted-foreground mt-1">Describe your products/services, target audience, and unique value proposition.</p>
            </div>
          </div>

          <div className="flex justify-end">
            <Button type="button" onClick={() => setStep(1)}>Next: Knowledge Base <ChevronRight className="size-4 ml-1" /></Button>
          </div>
        </div>
      )}

      {/* ═══ Step 2: Knowledge Base ═══ */}
      {step === 1 && (
        <div className="space-y-6">
          <div>
            <h2 className="text-sm font-semibold mb-1">Knowledge Base</h2>
            <p className="text-xs text-muted-foreground mb-4">Add information the AI should reference when drafting replies — pricing, policies, FAQs, product details.</p>
          </div>

          {/* Upload + import options */}
          <div className="grid grid-cols-2 gap-3">
            <button type="button" onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-3 rounded-lg border p-4 hover:bg-muted/50 transition-colors text-left">
              <Upload className="size-5 text-muted-foreground shrink-0" />
              <div>
                <p className="text-xs font-medium">Upload Document</p>
                <p className="text-[10px] text-muted-foreground">TXT, PDF, MD, CSV</p>
              </div>
            </button>
            <button type="button" onClick={() => { setStep(0); setTimeout(() => document.querySelector<HTMLInputElement>('input[placeholder*="yourbusiness"]')?.focus(), 100) }}
              className="flex items-center gap-3 rounded-lg border p-4 hover:bg-muted/50 transition-colors text-left">
              <Globe className="size-5 text-muted-foreground shrink-0" />
              <div>
                <p className="text-xs font-medium">Import from Website</p>
                <p className="text-[10px] text-muted-foreground">Scan pages automatically</p>
              </div>
            </button>
            <input ref={fileInputRef} type="file" accept=".txt,.pdf,.md,.csv,.docx" className="hidden" onChange={handleFileUpload} />
          </div>

          {uploadedFile && (
            <div className="flex items-center gap-2">
              <FileText className="size-4 text-muted-foreground" />
              <span className="text-xs">{uploadedFile}</span>
              <button type="button" onClick={() => setUploadedFile(null)} className="text-muted-foreground hover:text-foreground"><X className="size-3" /></button>
            </div>
          )}

          <Textarea value={knowledgeBase} onChange={e => setKnowledgeBase(e.target.value)}
            placeholder="Paste or type your business information here..."
            rows={14} className="text-sm font-mono" />
          <p className="text-[11px] text-muted-foreground">Include pricing, timelines, policies, common questions — anything customers ask about. The more detail, the better the drafts.</p>

          <div className="flex justify-between">
            <Button type="button" variant="outline" onClick={() => setStep(0)}>Back</Button>
            <Button type="button" onClick={() => setStep(2)}>Next: Tone & Rules <ChevronRight className="size-4 ml-1" /></Button>
          </div>
        </div>
      )}

      {/* ═══ Step 3: Tone & Rules ═══ */}
      {step === 2 && (
        <div className="space-y-6">
          <div>
            <h2 className="text-sm font-semibold mb-1">Reply Tone</h2>
            <p className="text-xs text-muted-foreground mb-4">How should the AI sound when drafting replies?</p>
          </div>

          <div className="grid grid-cols-1 gap-2">
            {TONES.map(t => (
              <button key={t.id} type="button" onClick={() => setTone(t.id)}
                className={`flex items-center gap-3 rounded-lg border p-3 text-left transition-colors ${tone === t.id ? 'border-violet-400 bg-violet-50 dark:bg-violet-950/20' : 'hover:border-violet-200 hover:bg-muted/50'}`}>
                <div className={`size-4 rounded-full border-2 flex items-center justify-center shrink-0 ${tone === t.id ? 'border-violet-500' : 'border-muted-foreground/30'}`}>
                  {tone === t.id && <div className="size-2 rounded-full bg-violet-500" />}
                </div>
                <div>
                  <p className="text-sm font-medium">{t.label}</p>
                  <p className="text-[11px] text-muted-foreground">{t.desc}</p>
                </div>
              </button>
            ))}
          </div>

          {tone === 'custom' && (
            <div>
              <label className="text-sm font-medium mb-1.5 block">Describe your preferred tone</label>
              <Textarea value={customTone} onChange={e => setCustomTone(e.target.value)}
                placeholder="e.g. Warm and empathetic, uses 'we' language, avoids jargon, includes relevant emojis sparingly..."
                rows={3} className="text-sm" />
            </div>
          )}

          {/* Brand Voice Engine */}
          <div className="bg-card rounded-xl border p-4 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="size-9 rounded-lg bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
                  <Mic className="size-4 text-amber-600" />
                </div>
                <div>
                  <Label className="text-sm font-medium">Brand Voice Engine</Label>
                  <p className="text-[11px] text-muted-foreground">AI learns your writing style so email drafts sound like you</p>
                </div>
              </div>
              <Switch checked={cloneVoice} onCheckedChange={setCloneVoice} />
            </div>

            {cloneVoice && (
              <div className="space-y-3 pt-2 border-t">
                {!voiceProfile && !voiceAnalyzing && (
                  <>
                    <p className="text-sm text-muted-foreground">Choose a source to analyze your writing style:</p>
                    <div className="flex gap-2">
                      <Button type="button" variant="outline" size="sm" onClick={analyzeGmail} className="flex-1">
                        <MessageSquare className="size-3.5 mr-1.5" /> Analyze Gmail
                      </Button>
                      <Button type="button" variant="outline" size="sm" onClick={() => voiceFileRef.current?.click()} className="flex-1">
                        <Upload className="size-3.5 mr-1.5" /> Upload Sample
                      </Button>
                    </div>
                    <input ref={voiceFileRef} type="file" accept=".txt,.md,.pdf,.docx" onChange={handleVoiceFileUpload} className="hidden" />
                    <p className="text-[10px] text-muted-foreground">Gmail: analyzes your 25 most recent sent emails. Upload: provide a writing sample (.txt, .md, .pdf, .docx).</p>
                  </>
                )}

                {voiceAnalyzing && (
                  <div className="flex items-center gap-2 py-4 justify-center">
                    <Loader2 className="size-4 animate-spin text-amber-600" />
                    <span className="text-sm text-muted-foreground">Analyzing your writing style...</span>
                  </div>
                )}

                {voiceError && (
                  <div className="text-sm text-red-600 bg-red-50 dark:bg-red-900/20 rounded-lg p-3">{voiceError}</div>
                )}

                {voiceProfile && !voiceAnalyzing && (
                  <div className="space-y-3">
                    <div className="bg-muted/50 rounded-lg p-3 space-y-2">
                      <p className="text-sm font-medium">Your Writing Voice</p>
                      <p className="text-sm text-muted-foreground">{voiceProfile.style_summary}</p>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div className="bg-background rounded p-2">
                          <span className="text-muted-foreground">Greeting:</span>{' '}
                          <span className="font-medium">{voiceProfile.greeting_style || '—'}</span>
                        </div>
                        <div className="bg-background rounded p-2">
                          <span className="text-muted-foreground">Closing:</span>{' '}
                          <span className="font-medium">{voiceProfile.closing_style || '—'}</span>
                        </div>
                        <div className="bg-background rounded p-2">
                          <span className="text-muted-foreground">Formality:</span>{' '}
                          <span className="font-medium">{voiceProfile.formality_score}/5</span>
                        </div>
                        <div className="bg-background rounded p-2">
                          <span className="text-muted-foreground">Emoji:</span>{' '}
                          <span className="font-medium">{voiceProfile.uses_emoji ? 'Yes' : 'No'}</span>
                        </div>
                      </div>
                      {voiceProfile.sample_phrases?.length > 0 && (
                        <div className="flex flex-wrap gap-1 pt-1">
                          {voiceProfile.sample_phrases.map((phrase: string, i: number) => (
                            <span key={i} className="text-[10px] bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 rounded-full px-2 py-0.5">
                              {phrase}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center justify-between">
                      <p className="text-[10px] text-muted-foreground">
                        {voiceSource === 'gmail' ? 'Learned from Gmail' : 'Learned from document'}
                        {voiceUpdatedAt ? ` · ${new Date(voiceUpdatedAt).toLocaleDateString()}` : ''}
                      </p>
                      <div className="flex gap-2">
                        <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={analyzeGmail}>
                          Re-analyze Gmail
                        </Button>
                        <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => voiceFileRef.current?.click()}>
                          Upload new sample
                        </Button>
                      </div>
                    </div>
                    <input ref={voiceFileRef} type="file" accept=".txt,.md,.pdf,.docx" onChange={handleVoiceFileUpload} className="hidden" />
                  </div>
                )}
              </div>
            )}
          </div>

          <div>
            <label className="text-sm font-medium mb-1.5 block">Special Instructions</label>
            <Textarea value={instructions} onChange={e => setInstructions(e.target.value)}
              placeholder="Any specific rules for the AI to follow when drafting replies..."
              rows={3} className="text-sm" />
            <p className="text-[11px] text-muted-foreground mt-1">e.g. "Always mention our guarantee" or "Never discuss competitor pricing"</p>
          </div>

          <div className="flex justify-between">
            <Button type="button" variant="outline" onClick={() => setStep(1)}>Back</Button>
            <Button type="button" onClick={() => setStep(3)}>Next: Email Intelligence <ChevronRight className="size-4 ml-1" /></Button>
          </div>
        </div>
      )}

      {/* ═══ Step 4: Email Intelligence ═══ */}
      {step === 3 && (
        <div className="space-y-6">
          <div>
            <h2 className="text-sm font-semibold mb-1">Email Intelligence</h2>
            <p className="text-xs text-muted-foreground mb-4">Automatically scan your connected inbox to create contacts, log emails, and track engagement.</p>
          </div>

          <div className="rounded-lg border divide-y">
            <div className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="text-sm font-medium">Enable Inbox Scanning</p>
                <p className="text-xs text-muted-foreground">Scan your inbox every 15 minutes to keep your CRM up to date</p>
              </div>
              <button
                type="button"
                onClick={() => { const next = !eiEnabled; setEiEnabled(next); saveEiSettings({ is_enabled: next }) }}
                disabled={eiSaving}
                className={`relative w-10 h-5 rounded-full transition-colors ${eiEnabled ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600'}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform shadow-sm ${eiEnabled ? 'translate-x-5' : ''}`} />
              </button>
            </div>

            {eiEnabled && [
              { label: 'Auto-create contacts', desc: 'Create new contacts from unknown senders', value: eiAutoCreate, key: 'auto_create_contacts', set: setEiAutoCreate },
              { label: 'Update timeline', desc: 'Log inbound emails to contact timeline', value: eiAutoTimeline, key: 'auto_update_timeline', set: setEiAutoTimeline },
              { label: 'Update engagement', desc: 'Track email engagement scores', value: eiAutoEngagement, key: 'auto_update_engagement', set: setEiAutoEngagement },
              { label: 'Auto-advance stage', desc: 'Move prospects to leads when engagement is high', value: eiAutoStage, key: 'auto_advance_stage', set: setEiAutoStage },
            ].map(item => (
              <div key={item.key} className="flex items-center justify-between px-4 py-2.5">
                <div>
                  <p className="text-sm">{item.label}</p>
                  <p className="text-xs text-muted-foreground">{item.desc}</p>
                </div>
                <button
                  type="button"
                  onClick={() => { const next = !item.value; item.set(next); saveEiSettings({ [item.key]: next }) }}
                  disabled={eiSaving}
                  className={`relative w-9 h-[18px] rounded-full transition-colors ${item.value ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600'}`}
                >
                  <span className={`absolute top-[1px] left-[1px] w-4 h-4 bg-white rounded-full transition-transform shadow-sm ${item.value ? 'translate-x-[18px]' : ''}`} />
                </button>
              </div>
            ))}
          </div>

          <p className="text-xs text-muted-foreground">You can connect or change your email account any time in Settings → Email.</p>

          <div className="flex justify-between">
            <Button type="button" variant="outline" onClick={() => setStep(2)}>Back</Button>
            <Button type="button" onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="size-4 mr-2 animate-spin" /> : saved ? <Check className="size-4 mr-2 text-emerald-500" /> : <Save className="size-4 mr-2" />}
              {saving ? 'Saving...' : saved ? 'Saved!' : 'Finish Setup'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
