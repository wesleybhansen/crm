'use client'

import { useState, useEffect } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Badge } from '@open-mercato/ui/primitives/badge'
import {
  Plus, BookOpen, Globe, X, Loader2, Eye, Sparkles, Pencil,
  ChevronRight, Users, DollarSign, Trash2, ExternalLink,
  Zap, Layout, FileText, Upload, Database, File,
} from 'lucide-react'

type Course = {
  id: string; title: string; description: string | null; slug: string
  price: string | null; is_free: boolean; is_published: boolean
  enrollment_count: number; created_at: string; generation_status: string | null
}

const DEPTHS = [
  { id: 'quick', label: 'Quick', desc: '3-5 lessons, ~30 min total' },
  { id: 'standard', label: 'Standard', desc: '5-8 lessons, ~1-2 hours' },
  { id: 'comprehensive', label: 'Comprehensive', desc: '8-15 lessons, 3+ hours' },
]

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

const STYLES = [
  { id: 'professional', label: 'Professional', desc: 'Clear, structured, authoritative' },
  { id: 'conversational', label: 'Conversational', desc: 'Friendly, relatable, approachable' },
  { id: 'example-heavy', label: 'Example-Heavy', desc: 'Case studies and real scenarios' },
  { id: 'step-by-step', label: 'Step-by-Step', desc: 'Numbered steps and checklists' },
  { id: 'motivational', label: 'Motivational', desc: 'Energizing, action-oriented, inspiring' },
  { id: 'custom', label: 'Custom', desc: 'Describe your own teaching style' },
]

export default function CoursesPage() {
  const [courses, setCourses] = useState<Course[]>([])
  const [loading, setLoading] = useState(true)
  const [showMode, setShowMode] = useState<'none' | 'select' | 'ai-wizard' | 'manual'>('none')

  // AI wizard
  const [aiStep, setAiStep] = useState(0)
  const [aiTopic, setAiTopic] = useState('')
  const [aiAudience, setAiAudience] = useState('')
  const [aiDepth, setAiDepth] = useState('standard')
  const [aiStyle, setAiStyle] = useState('professional')
  const [aiNotes, setAiNotes] = useState('')
  const [aiGenerating, setAiGenerating] = useState(false)
  const [aiOutline, setAiOutline] = useState<any>(null)
  const [aiOutlineGenerating, setAiOutlineGenerating] = useState(false)
  const [aiCustomStyle, setAiCustomStyle] = useState('')
  const [aiIsFree, setAiIsFree] = useState(true)
  const [aiPrice, setAiPrice] = useState('')
  const [aiLandingStyle, setAiLandingStyle] = useState('warm')
  const [aiLandingCopy, setAiLandingCopy] = useState<any>(null)
  const [aiLandingCopyGenerating, setAiLandingCopyGenerating] = useState(false)

  // PKB
  const [pkbConfigured, setPkbConfigured] = useState(false)
  const [pkbDocs, setPkbDocs] = useState<Array<{ id: string; title: string }>>([])
  const [pkbSelectedDocs, setPkbSelectedDocs] = useState<string[]>([])
  const [pkbLoading, setPkbLoading] = useState(false)
  const [pkbSearch, setPkbSearch] = useState('')
  const [sourceDocContents, setSourceDocContents] = useState<Array<{ title: string; content: string }>>([])

  // File uploads
  const [uploadedFiles, setUploadedFiles] = useState<Array<{ name: string; content: string }>>([])

  // Manual create
  const [title, setTitle] = useState('')
  const [slug, setSlug] = useState('')
  const [description, setDescription] = useState('')
  const [price, setPrice] = useState('')
  const [isFree, setIsFree] = useState(true)
  const [creating, setCreating] = useState(false)

  useEffect(() => { loadCourses() }, [])

  // Check PKB config
  useEffect(() => {
    fetch('/api/courses/pkb/config', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.ok && d.data?.configured) { setPkbConfigured(true); loadPkbDocs() } })
      .catch(() => {})
  }, [])

  function loadPkbDocs() {
    setPkbLoading(true)
    fetch('/api/courses/pkb/documents', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.ok) setPkbDocs(Array.isArray(d.data) ? d.data : d.data?.documents || []) })
      .catch(() => {})
      .finally(() => setPkbLoading(false))
  }

  function loadCourses() {
    fetch('/api/courses/courses', { credentials: 'include' })
      .then(r => r.json()).then(d => { if (d.ok) setCourses(d.data || []); setLoading(false) }).catch(() => setLoading(false))
  }

  async function createManual() {
    if (!title.trim()) return
    // Auto-generate slug if empty
    const cleanSlug = slug || (title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Math.random().toString(36).substring(2, 6))
    setCreating(true)
    try {
      const res = await fetch('/api/courses/courses', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ title, slug: cleanSlug, description, price: isFree ? null : price, isFree }),
      })
      const d = await res.json()
      if (d.ok) { window.location.href = `/backend/courses/${d.data.id}` }
    } catch {}
    setCreating(false)
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (!files) return
    Array.from(files).forEach(file => {
      const reader = new FileReader()
      reader.onload = () => {
        const content = reader.result as string
        setUploadedFiles(prev => [...prev, { name: file.name, content: content.substring(0, 50000) }])
      }
      reader.readAsText(file)
    })
    e.target.value = ''
  }

  async function generateOutline() {
    if (!aiTopic.trim()) return
    setAiOutlineGenerating(true)
    try {
      // Fetch PKB doc contents if selected (batch fetch)
      let docs: Array<{ title: string; content: string }> = []
      if (pkbSelectedDocs.length > 0) {
        const res = await fetch(`/api/courses/pkb/documents?ids=${pkbSelectedDocs.slice(0, 5).join(',')}`, { credentials: 'include' })
        const d = await res.json()
        if (d.ok && Array.isArray(d.data)) {
          docs = d.data.map((doc: any) => ({ title: doc.title, content: (doc.content || '').substring(0, 8000) }))
        }
      }

      // Combine PKB docs + uploaded files as source documents
      const allSources = [
        ...docs,
        ...uploadedFiles.map(f => ({ title: f.name, content: f.content })),
      ]
      setSourceDocContents(allSources)

      const res = await fetch('/api/courses/ai/generate-outline', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ topic: aiTopic, targetAudience: aiAudience, depth: aiDepth, style: aiStyle === 'custom' ? aiCustomStyle : aiStyle, notes: aiNotes, sourceDocuments: allSources.length > 0 ? allSources : undefined }),
      })
      const d = await res.json()
      if (d.ok && d.data) {
        setAiOutline(d.data)
        setAiStep(3) // Go to review step
      } else { alert(d.error || 'Failed to generate outline') }
    } catch { alert('Failed to generate outline') }
    setAiOutlineGenerating(false)
  }

  async function generateAiLandingCopy() {
    if (!aiOutline) return
    setAiLandingCopyGenerating(true)
    try {
      // We need a temporary courseId — create via outline data
      const res = await fetch('/api/courses/ai/generate-landing-copy', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({
          courseTitle: aiOutline.title || aiTopic,
          courseDescription: aiOutline.description || '',
          modules: aiOutline.modules || [],
          targetAudience: aiAudience,
          isFree: aiIsFree,
          price: aiIsFree ? null : aiPrice,
        }),
      })
      const d = await res.json()
      if (d.ok && d.data) { setAiLandingCopy(d.data) }
      else { alert(d.error || 'Failed to generate copy') }
    } catch { alert('Failed to generate copy') }
    setAiLandingCopyGenerating(false)
  }

  async function generateFullCourse() {
    setAiGenerating(true)
    try {
      const res = await fetch('/api/courses/ai/generate-full-course', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({
          topic: aiTopic, targetAudience: aiAudience, depth: aiDepth, style: aiStyle === 'custom' ? aiCustomStyle : aiStyle, notes: aiNotes,
          outline: aiOutline || undefined,
          sourceDocuments: sourceDocContents.length > 0 ? sourceDocContents : undefined,
          isFree: aiIsFree, price: aiIsFree ? null : aiPrice,
          landingCopy: aiLandingCopy || undefined,
          landingStyle: aiLandingStyle,
        }),
      })
      const d = await res.json()
      if (d.ok && d.data?.courseId) {
        window.location.href = `/backend/courses/${d.data.courseId}`
      } else { alert(d.error || 'Failed to generate course') }
    } catch { alert('Failed to generate course') }
    setAiGenerating(false)
  }

  async function deleteCourse(id: string, e: React.MouseEvent) {
    e.stopPropagation()
    if (!confirm('Delete this course? This cannot be undone.')) return
    await fetch(`/api/courses/courses/${id}`, { method: 'DELETE', credentials: 'include' })
    loadCourses()
  }

  async function togglePublish(course: Course, e: React.MouseEvent) {
    e.stopPropagation()
    await fetch(`/api/courses/courses/${course.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ isPublished: !course.is_published }),
    })
    loadCourses()
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold">Courses</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Create and sell online courses to your audience.</p>
        </div>
        <Button type="button" onClick={() => setShowMode(showMode === 'none' ? 'select' : 'none')}>
          <Plus className="size-4 mr-2" /> New Course
        </Button>
      </div>

      {/* ═══ Creation Mode Selector ═══ */}
      {showMode === 'select' && (
        <div className="grid grid-cols-3 gap-4 mb-8">
          <button type="button" onClick={() => setShowMode('ai-wizard')}
            className="group rounded-xl border border-primary/30 p-6 text-left hover:border-primary/60 hover:bg-foreground/[.04] dark:hover:bg-white/[.04] transition-all">
            <div className="size-10 rounded-lg bg-primary text-primary-foreground flex items-center justify-center mb-3">
              <Sparkles className="size-5" />
            </div>
            <h3 className="font-semibold mb-1">AI Auto-Generate</h3>
            <p className="text-xs text-muted-foreground">Describe your topic and AI creates the entire course — outline, modules, and lesson content.</p>
          </button>

          <button type="button" onClick={() => { setShowMode('manual'); setTitle(''); setSlug(''); setDescription(''); setIsFree(true); setPrice('') }}
            className="group rounded-xl border p-6 text-left hover:border-accent/40 hover:bg-muted/50 transition-all">
            <div className="size-10 rounded-lg bg-muted flex items-center justify-center mb-3">
              <Zap className="size-5 text-muted-foreground group-hover:text-foreground" />
            </div>
            <h3 className="font-semibold mb-1">AI-Assisted</h3>
            <p className="text-xs text-muted-foreground">Create your own structure, then use AI to write individual lesson content as you go.</p>
          </button>

          <button type="button" onClick={() => { setShowMode('manual'); setTitle(''); setSlug(''); setDescription(''); setIsFree(true); setPrice('') }}
            className="group rounded-xl border p-6 text-left hover:border-accent/40 hover:bg-muted/50 transition-all">
            <div className="size-10 rounded-lg bg-muted flex items-center justify-center mb-3">
              <Pencil className="size-5 text-muted-foreground group-hover:text-foreground" />
            </div>
            <h3 className="font-semibold mb-1">Manual</h3>
            <p className="text-xs text-muted-foreground">Build everything from scratch — full control over every module, lesson, and piece of content.</p>
          </button>
        </div>
      )}

      {/* ═══ AI Wizard ═══ */}
      {showMode === 'ai-wizard' && (
        <div className="bg-card rounded-xl border shadow-sm p-6 mb-8 max-w-2xl mx-auto">
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-2">
              <Sparkles className="size-5 text-primary" />
              <h3 className="font-semibold">AI Course Generator</h3>
            </div>
            <IconButton variant="ghost" size="sm" type="button" onClick={() => setShowMode('none')} aria-label="Close"><X className="size-4" /></IconButton>
          </div>

          {/* Step indicators */}
          <div className="flex gap-1 mb-6">
            {['Topic', 'Sources', 'Settings', 'Outline', 'Landing Page', 'Generate'].map((label, i) => (
              <button key={i} type="button" onClick={() => { if (i <= aiStep) setAiStep(i) }}
                className={`flex-1 py-2 rounded-lg text-[11px] font-medium text-center transition-colors ${aiStep === i ? 'border border-primary bg-foreground/[.04] dark:bg-white/[.04] text-primary' : i < aiStep ? 'bg-foreground/[.04] dark:bg-white/[.04] text-primary' : 'bg-muted text-muted-foreground'}`}>
                {label}
              </button>
            ))}
          </div>

          {/* Step 0: Topic */}
          {aiStep === 0 && (
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium mb-1.5 block">What should this course teach?</label>
                <Textarea value={aiTopic} onChange={e => setAiTopic(e.target.value)}
                  placeholder="e.g. How to build a profitable freelance business from scratch" rows={3} className="text-sm" />
              </div>
              <div>
                <label className="text-sm font-medium mb-1.5 block">Who is this course for?</label>
                <Input value={aiAudience} onChange={e => setAiAudience(e.target.value)}
                  placeholder="e.g. Beginners looking to leave their 9-5 and start freelancing" className="text-sm" />
              </div>
              <div>
                <label className="text-sm font-medium mb-1.5 block">Additional context (optional)</label>
                <Textarea value={aiNotes} onChange={e => setAiNotes(e.target.value)}
                  placeholder="Any specific topics to cover, things to avoid, or context about your expertise..." rows={2} className="text-sm" />
              </div>
              <Button type="button" className="w-full" onClick={() => setAiStep(1)} disabled={!aiTopic.trim()}>
                Next: Source Material <ChevronRight className="size-4 ml-1" />
              </Button>
            </div>
          )}

          {/* Step 1: Source Material */}
          {aiStep === 1 && (
            <div className="space-y-5">
              <div>
                <h4 className="text-sm font-medium mb-1">Source Material</h4>
                <p className="text-xs text-muted-foreground mb-4">Provide documents for AI to use as the foundation for your course content. This is optional — AI can generate from scratch, but source material produces much better results.</p>
              </div>

              {/* File Upload */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Upload className="size-4 text-muted-foreground" />
                  <label className="text-sm font-medium">Upload Files</label>
                </div>
                <p className="text-xs text-muted-foreground mb-3">Upload .txt, .md, or .csv files with your existing content, notes, or outlines.</p>
                <label className="flex flex-col items-center justify-center border-2 border-dashed rounded-lg p-6 cursor-pointer hover:border-primary/40 hover:bg-foreground/[.04] dark:hover:bg-white/[.04] transition-colors">
                  <Upload className="size-5 text-muted-foreground mb-2" />
                  <span className="text-sm font-medium text-muted-foreground">Click to upload files</span>
                  <span className="text-[11px] text-muted-foreground/60 mt-1">TXT, MD, CSV — up to 50KB per file</span>
                  <input type="file" multiple accept=".txt,.md,.csv,.text,.markdown" onChange={handleFileUpload} className="hidden" />
                </label>
                {uploadedFiles.length > 0 && (
                  <div className="mt-3 space-y-1.5">
                    {uploadedFiles.map((f, i) => (
                      <div key={i} className="flex items-center gap-2 px-3 py-2 bg-muted/50 rounded-lg text-xs">
                        <File className="size-3.5 text-muted-foreground shrink-0" />
                        <span className="flex-1 truncate font-medium">{f.name}</span>
                        <span className="text-muted-foreground shrink-0">{(f.content.length / 1024).toFixed(1)}KB</span>
                        <button type="button" onClick={() => setUploadedFiles(prev => prev.filter((_, j) => j !== i))}
                          className="text-muted-foreground hover:text-destructive shrink-0">
                          <X className="size-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Divider */}
              {pkbConfigured && (
                <div className="flex items-center gap-3">
                  <div className="flex-1 h-px bg-border" />
                  <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">or</span>
                  <div className="flex-1 h-px bg-border" />
                </div>
              )}

              {/* PKB Documents */}
              {pkbConfigured && (
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <Database className="size-4 text-muted-foreground" />
                    <label className="text-sm font-medium">Knowledge Base Documents</label>
                  </div>
                  <p className="text-xs text-muted-foreground mb-3">Select documents from your connected Knowledge Base to use as course source material.</p>
                  {pkbLoading ? (
                    <div className="flex items-center gap-2 py-4 justify-center text-xs text-muted-foreground">
                      <Loader2 className="size-3.5 animate-spin" /> Loading documents...
                    </div>
                  ) : pkbDocs.length === 0 ? (
                    <div className="text-center py-4 text-xs text-muted-foreground">No documents found in your Knowledge Base.</div>
                  ) : (
                    <div className="border rounded-lg overflow-hidden">
                      <div className="px-3 py-2 border-b bg-muted/20">
                        <Input value={pkbSearch} onChange={e => setPkbSearch(e.target.value)}
                          placeholder="Search documents..." className="h-7 text-xs" />
                      </div>
                      <div className="max-h-48 overflow-y-auto">
                        {pkbDocs
                          .filter(doc => !pkbSearch.trim() || doc.title.toLowerCase().includes(pkbSearch.toLowerCase()))
                          .slice(0, 50).map(doc => (
                          <label key={doc.id} className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/50 cursor-pointer text-xs border-b last:border-b-0">
                            <input type="checkbox" checked={pkbSelectedDocs.includes(doc.id)}
                              onChange={e => setPkbSelectedDocs(prev => e.target.checked ? [...prev, doc.id] : prev.filter(x => x !== doc.id))}
                              className="rounded border-border" />
                            <FileText className="size-3.5 text-muted-foreground shrink-0" />
                            <span className="truncate">{doc.title}</span>
                          </label>
                        ))}
                        {pkbDocs.filter(doc => !pkbSearch.trim() || doc.title.toLowerCase().includes(pkbSearch.toLowerCase())).length === 0 && (
                          <div className="text-center py-3 text-[11px] text-muted-foreground">No documents match your search.</div>
                        )}
                      </div>
                    </div>
                  )}
                  {pkbSelectedDocs.length > 0 && (
                    <p className="text-[11px] text-[#1d4ed8] dark:text-[#60a5fa] mt-2 font-medium">{pkbSelectedDocs.length} document{pkbSelectedDocs.length > 1 ? 's' : ''} selected</p>
                  )}
                </div>
              )}

              {!pkbConfigured && uploadedFiles.length === 0 && (
                <div className="bg-muted/30 rounded-lg p-4 text-center">
                  <p className="text-xs text-muted-foreground">No source material? No problem — AI will generate the course from your topic description.</p>
                  <p className="text-[11px] text-muted-foreground/60 mt-1">
                    Want to pull from existing documents? <a href="/backend/settings-simple" className="text-accent underline font-medium">Connect your Knowledge Base in Settings</a>
                  </p>
                </div>
              )}

              {/* Source summary */}
              {(uploadedFiles.length > 0 || pkbSelectedDocs.length > 0) && (
                <div className="border border-primary/30 bg-foreground/[.04] dark:bg-white/[.04] rounded-lg p-3 flex items-center gap-2">
                  <Sparkles className="size-4 text-primary shrink-0" />
                  <p className="text-xs text-foreground">
                    AI will use {uploadedFiles.length + pkbSelectedDocs.length} source document{uploadedFiles.length + pkbSelectedDocs.length > 1 ? 's' : ''} to guide course creation — content will be more accurate and aligned with your material.
                  </p>
                </div>
              )}

              <div className="flex gap-2">
                <Button type="button" variant="outline" className="flex-1" onClick={() => setAiStep(0)}>Back</Button>
                <Button type="button" className="flex-1" onClick={() => setAiStep(2)}>
                  Next: Settings <ChevronRight className="size-4 ml-1" />
                </Button>
              </div>
            </div>
          )}

          {/* Step 2: Settings */}
          {aiStep === 2 && (
            <div className="space-y-5">
              <div>
                <label className="text-sm font-medium mb-2 block">Course Depth</label>
                <div className="grid gap-2">
                  {DEPTHS.map(d => (
                    <button key={d.id} type="button" onClick={() => setAiDepth(d.id)}
                      className={`flex items-center gap-3 rounded-lg border p-3 text-left transition-colors ${aiDepth === d.id ? 'border-primary bg-foreground/[.04] dark:bg-white/[.04]' : 'hover:bg-muted/50'}`}>
                      <div className={`size-4 rounded-full border-2 flex items-center justify-center shrink-0 ${aiDepth === d.id ? 'border-primary' : 'border-muted-foreground/30'}`}>
                        {aiDepth === d.id && <div className="size-2 rounded-full bg-primary" />}
                      </div>
                      <div><p className="text-sm font-medium">{d.label}</p><p className="text-[11px] text-muted-foreground">{d.desc}</p></div>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-sm font-medium mb-2 block">Teaching Style</label>
                <div className="grid grid-cols-2 gap-2">
                  {STYLES.map(s => (
                    <button key={s.id} type="button" onClick={() => setAiStyle(s.id)}
                      className={`rounded-lg border p-3 text-left transition-colors ${aiStyle === s.id ? 'border-primary bg-foreground/[.04] dark:bg-white/[.04]' : 'hover:bg-muted/50'}`}>
                      <p className="text-sm font-medium">{s.label}</p>
                      <p className="text-[10px] text-muted-foreground">{s.desc}</p>
                    </button>
                  ))}
                </div>
              </div>
              {aiStyle === 'custom' && (
                <div>
                  <label className="text-sm font-medium mb-1.5 block">Describe your teaching style</label>
                  <Textarea value={aiCustomStyle} onChange={e => setAiCustomStyle(e.target.value)}
                    placeholder="e.g. Use storytelling with real-world business case studies. Be direct and no-nonsense. Include action items after each concept."
                    rows={2} className="text-sm" />
                </div>
              )}
              <div className="flex gap-2">
                <Button type="button" variant="outline" className="flex-1" onClick={() => setAiStep(1)}>Back</Button>
                <Button type="button" className="flex-1" onClick={generateOutline} disabled={aiOutlineGenerating}>
                  {aiOutlineGenerating ? <><Loader2 className="size-4 mr-2 animate-spin" /> Generating Outline...</> : <>Generate Outline <ChevronRight className="size-4 ml-1" /></>}
                </Button>
              </div>
            </div>
          )}

          {/* Step 3: Outline Review */}
          {aiStep === 3 && !aiOutline && (
            <div className="text-center py-8">
              <Loader2 className="size-6 animate-spin text-primary mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">Generating course outline...</p>
            </div>
          )}

          {aiStep === 3 && aiOutline && (
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium mb-1 block">Course Title</label>
                <Input value={aiOutline.title || ''} onChange={e => setAiOutline({ ...aiOutline, title: e.target.value })} className="text-sm font-semibold" />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">Description</label>
                <Textarea value={aiOutline.description || ''} onChange={e => setAiOutline({ ...aiOutline, description: e.target.value })} rows={2} className="text-sm" />
              </div>
              <div>
                <label className="text-sm font-medium mb-2 block">Modules & Lessons</label>
                <p className="text-xs text-muted-foreground mb-3">Review and edit the outline. You can rename, reorder, add, or remove modules and lessons.</p>
                <div className="space-y-3">
                  {(aiOutline.modules || []).map((mod: any, mi: number) => (
                    <div key={mi} className="border rounded-lg p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-[10px] font-bold text-muted-foreground shrink-0">M{mi + 1}</span>
                        <Input value={mod.title} onChange={e => {
                          const updated = { ...aiOutline, modules: [...aiOutline.modules] }
                          updated.modules[mi] = { ...mod, title: e.target.value }
                          setAiOutline(updated)
                        }} className="h-7 text-xs font-semibold" />
                        <IconButton variant="ghost" size="xs" type="button" onClick={() => {
                          const updated = { ...aiOutline, modules: aiOutline.modules.filter((_: any, i: number) => i !== mi) }
                          setAiOutline(updated)
                        }}><Trash2 className="size-3 text-muted-foreground" /></IconButton>
                      </div>
                      <div className="space-y-1 ml-6">
                        {(mod.lessons || []).map((les: any, li: number) => (
                          <div key={li} className="flex items-center gap-2">
                            <span className="text-[9px] text-muted-foreground/50 w-4 text-right">{li + 1}</span>
                            <Input value={les.title} onChange={e => {
                              const updated = { ...aiOutline, modules: [...aiOutline.modules] }
                              const updatedLessons = [...mod.lessons]
                              updatedLessons[li] = { ...les, title: e.target.value }
                              updated.modules[mi] = { ...mod, lessons: updatedLessons }
                              setAiOutline(updated)
                            }} className="h-6 text-[11px] flex-1" />
                            <IconButton variant="ghost" size="xs" type="button" onClick={() => {
                              const updated = { ...aiOutline, modules: [...aiOutline.modules] }
                              updated.modules[mi] = { ...mod, lessons: mod.lessons.filter((_: any, i: number) => i !== li) }
                              setAiOutline(updated)
                            }}><X className="size-2.5 text-muted-foreground" /></IconButton>
                          </div>
                        ))}
                        <button type="button" onClick={() => {
                          const updated = { ...aiOutline, modules: [...aiOutline.modules] }
                          updated.modules[mi] = { ...mod, lessons: [...mod.lessons, { title: 'New Lesson', description: '', durationEstimate: 10 }] }
                          setAiOutline(updated)
                        }} className="text-[10px] text-accent ml-5">+ Add Lesson</button>
                      </div>
                    </div>
                  ))}
                  <button type="button" onClick={() => {
                    setAiOutline({ ...aiOutline, modules: [...(aiOutline.modules || []), { title: 'New Module', description: '', lessons: [{ title: 'New Lesson', description: '', durationEstimate: 10 }] }] })
                  }} className="text-xs text-accent flex items-center gap-1">
                    <Plus className="size-3" /> Add Module
                  </button>
                </div>
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="outline" className="flex-1" onClick={() => { setAiStep(2); setAiOutline(null) }}>Back</Button>
                <Button type="button" className="flex-1" onClick={() => { setAiStep(4); if (!aiLandingCopy) generateAiLandingCopy() }}>
                  Looks Good — Next: Landing Page <ChevronRight className="size-4 ml-1" />
                </Button>
              </div>
            </div>
          )}

          {/* Step 4: Landing Page */}
          {aiStep === 4 && (
            <div className="space-y-4">
              <div>
                <h4 className="text-sm font-medium mb-1">Landing Page Copy</h4>
                <p className="text-xs text-muted-foreground mb-3">Review and edit the AI-generated copy for your course landing page.</p>
              </div>

              {aiLandingCopyGenerating && !aiLandingCopy && (
                <div className="rounded-lg bg-muted/30 p-6 text-center">
                  <Loader2 className="size-5 animate-spin text-primary mx-auto mb-2" />
                  <p className="text-sm text-muted-foreground">Generating landing page copy...</p>
                </div>
              )}

              {aiLandingCopy && (
                <div className="space-y-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">Headline</label>
                    <Input value={aiLandingCopy.headline || ''} onChange={(ev: any) => setAiLandingCopy({ ...aiLandingCopy, headline: ev.target.value })} className="text-sm font-semibold" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">Subheadline</label>
                    <Textarea value={aiLandingCopy.subheadline || ''} onChange={(ev: any) => setAiLandingCopy({ ...aiLandingCopy, subheadline: ev.target.value })} rows={2} className="text-xs" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">Benefits ({(aiLandingCopy.valueBullets || []).length})</label>
                    <div className="space-y-1.5 max-h-32 overflow-y-auto">
                      {(aiLandingCopy.valueBullets || []).map((b: any, i: number) => (
                        <div key={i} className="flex gap-2 items-center">
                          <Input value={typeof b === 'object' ? b.title : b} onChange={(ev: any) => {
                            const u = [...(aiLandingCopy.valueBullets || [])]; u[i] = typeof b === 'object' ? { ...b, title: ev.target.value } : ev.target.value; setAiLandingCopy({ ...aiLandingCopy, valueBullets: u })
                          }} className="text-xs h-7 flex-1" placeholder="Benefit title" />
                          <IconButton variant="ghost" size="xs" type="button" onClick={() => setAiLandingCopy({ ...aiLandingCopy, valueBullets: (aiLandingCopy.valueBullets || []).filter((_: any, j: number) => j !== i) })}><X className="size-2.5 text-muted-foreground" /></IconButton>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">CTA Button</label>
                    <Input value={aiLandingCopy.ctaText || ''} onChange={(ev: any) => setAiLandingCopy({ ...aiLandingCopy, ctaText: ev.target.value })} className="text-xs h-7 w-48" />
                  </div>
                </div>
              )}

              {/* Page Style */}
              <div>
                <label className="text-sm font-medium mb-2 block">Page Style</label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { id: 'warm', label: 'Warm', desc: 'Soft tones, friendly feel', color: 'bg-amber-50 border-amber-200' },
                    { id: 'minimal', label: 'Minimal', desc: 'Clean, serif typography', color: 'bg-gray-50 border-gray-200' },
                    { id: 'dark', label: 'Dark', desc: 'Dark mode, purple accents', color: 'bg-gray-900 border-purple-500 text-white' },
                  ].map(s => (
                    <button key={s.id} type="button" onClick={() => setAiLandingStyle(s.id)}
                      className={`rounded-lg border p-3 text-left transition-all ${aiLandingStyle === s.id ? 'ring-2 ring-primary border-primary' : 'hover:border-accent/30'}`}>
                      <div className={`w-full h-6 rounded ${s.color} mb-2`} />
                      <p className="text-xs font-medium">{s.label}</p>
                      <p className="text-[10px] text-muted-foreground">{s.desc}</p>
                    </button>
                  ))}
                </div>
              </div>

              {/* Pricing */}
              <div>
                <label className="text-sm font-medium mb-2 block">Pricing</label>
                <div className="flex items-center gap-3">
                  <div className="flex gap-1.5">
                    {[true, false].map(free => (
                      <button key={String(free)} type="button" onClick={() => setAiIsFree(free)}
                        className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${aiIsFree === free ? 'bg-accent text-accent-foreground border-accent' : 'text-muted-foreground border-border hover:border-accent/30'}`}>
                        {free ? 'Free' : 'Paid'}
                      </button>
                    ))}
                  </div>
                  {!aiIsFree && (
                    <div className="flex items-center gap-1">
                      <span className="text-sm text-muted-foreground">$</span>
                      <Input type="number" value={aiPrice} onChange={e => setAiPrice(e.target.value)} placeholder="97.00" className="w-24 text-sm" step="0.01" />
                    </div>
                  )}
                </div>
              </div>

              <div className="flex gap-2">
                <Button type="button" variant="outline" className="flex-1" onClick={() => setAiStep(3)}>Back</Button>
                <Button type="button" variant="outline" size="sm" onClick={generateAiLandingCopy} disabled={aiLandingCopyGenerating}>
                  <Sparkles className="size-3 mr-1" /> Regenerate Copy
                </Button>
                <Button type="button" className="flex-1" onClick={() => setAiStep(5)}>
                  Next: Generate <ChevronRight className="size-4 ml-1" />
                </Button>
              </div>
            </div>
          )}

          {/* Step 5: Generate */}
          {aiStep === 5 && (
            <div className="space-y-4">
              <div className="bg-muted/50 rounded-lg p-4 space-y-2">
                <p className="text-sm"><span className="font-medium">Course:</span> {aiOutline?.title || aiTopic}</p>
                <p className="text-sm"><span className="font-medium">Modules:</span> {aiOutline?.modules?.length || 0}</p>
                <p className="text-sm"><span className="font-medium">Lessons:</span> {aiOutline?.modules?.reduce((s: number, m: any) => s + (m.lessons?.length || 0), 0) || 0}</p>
                <p className="text-sm"><span className="font-medium">Style:</span> {STYLES.find(s => s.id === aiStyle)?.label}</p>
                <p className="text-sm"><span className="font-medium">Page style:</span> {aiLandingStyle === 'dark' ? 'Dark' : aiLandingStyle === 'minimal' ? 'Minimal' : 'Warm'}</p>
                <p className="text-sm"><span className="font-medium">Pricing:</span> {aiIsFree ? 'Free' : `$${aiPrice || '0'}`}</p>
                {aiLandingCopy && <p className="text-sm"><span className="font-medium">Landing copy:</span> Ready</p>}
              </div>
              <p className="text-xs text-muted-foreground">AI will now write the content for each lesson. This takes 1-3 minutes. You'll be taken to the editor to review and refine.</p>
              <div className="flex gap-2">
                <Button type="button" variant="outline" className="flex-1" onClick={() => setAiStep(4)}>Back</Button>
                <Button type="button" className="flex-1" onClick={generateFullCourse} disabled={aiGenerating}>
                  {aiGenerating ? <><Loader2 className="size-4 mr-2 animate-spin" /> Generating...</> : <><Sparkles className="size-4 mr-2" /> Generate Course</>}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══ Manual Create ═══ */}
      {showMode === 'manual' && (
        <div className="bg-card rounded-xl border shadow-sm p-6 mb-8 max-w-2xl mx-auto">
          <div className="flex items-center justify-between mb-5">
            <h3 className="font-semibold">Create Course</h3>
            <IconButton variant="ghost" size="sm" type="button" onClick={() => setShowMode('none')} aria-label="Close"><X className="size-4" /></IconButton>
          </div>
          <div className="space-y-4">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Course Title</label>
              <Input value={title} onChange={e => { setTitle(e.target.value); setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Math.random().toString(36).substring(2, 6)) }}
                placeholder="e.g. Business Launch Accelerator" autoFocus />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Description</label>
              <Textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="What will students learn?" rows={2} className="text-sm" />
            </div>
            <div className="flex items-center gap-4">
              <div className="flex gap-2">
                {[true, false].map(free => (
                  <button key={String(free)} type="button" onClick={() => setIsFree(free)}
                    className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${isFree === free ? 'bg-accent text-accent-foreground border-accent' : 'text-muted-foreground hover:border-accent/40'}`}>
                    {free ? 'Free' : 'Paid'}
                  </button>
                ))}
              </div>
              {!isFree && (
                <div className="flex items-center gap-1">
                  <span className="text-sm text-muted-foreground">$</span>
                  <Input type="number" value={price} onChange={e => setPrice(e.target.value)} placeholder="97.00" className="w-24" step="0.01" />
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setShowMode('none')}>Cancel</Button>
              <Button type="button" onClick={createManual} disabled={creating || !title.trim()}>
                {creating ? <Loader2 className="size-4 mr-2 animate-spin" /> : <Plus className="size-4 mr-2" />} Create
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ Courses List ═══ */}
      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
      ) : courses.length === 0 && showMode === 'none' ? (
        <div className="rounded-xl border border-muted-foreground/20 p-12 text-center">
          <div className="inline-flex items-center justify-center size-14 rounded-2xl bg-accent/10 text-accent mb-4">
            <BookOpen className="size-7" />
          </div>
          <h2 className="text-lg font-semibold mb-2">Create your first course</h2>
          <p className="text-sm text-muted-foreground max-w-sm mx-auto mb-6">
            Build online courses with AI assistance, add videos and resources, and sell them to your audience.
          </p>
          <Button type="button" onClick={() => setShowMode('select')}>
            <Plus className="size-4 mr-2" /> Get Started
          </Button>
        </div>
      ) : courses.length > 0 && (
        <>
        <div className="grid grid-cols-3 gap-4 mb-6">
          <StatTile icon={BookOpen} label="Courses" value={courses.length} color="violet" series={weeklyCounts(courses.map(c => c.created_at))} />
          <StatTile icon={Globe} label="Published" value={courses.filter(c => c.is_published).length} color="green" />
          <StatTile icon={Users} label="Enrollments" value={courses.reduce((s, c) => s + (c.enrollment_count || 0), 0)} color="blue" />
        </div>
        <div className="grid gap-4">
          {courses.map((c, ci) => {
            const cc = STAT_COLORS[(['violet', 'blue', 'green', 'amber'] as const)[ci % 4]]
            return (
            <div key={c.id} className="bg-card rounded-xl border p-5 hover:border-accent/30 transition-colors cursor-pointer" onClick={() => window.location.href = `/backend/courses/${c.id}`}>
              <div className="flex items-center gap-4">
                <div className={`size-12 rounded-lg ${cc.tile} flex items-center justify-center shrink-0`}>
                  <BookOpen className={`size-6 ${cc.icon}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-semibold">{c.title}</h3>
                    <Badge variant={c.is_published ? 'green' : 'amber'}>
                      {c.is_published ? 'Published' : 'Draft'}
                    </Badge>
                    {c.generation_status === 'generating' && (
                      <Badge variant="amber" className="gap-1">
                        <Loader2 className="size-2.5 animate-spin" /> AI generating...
                      </Badge>
                    )}
                  </div>
                  {c.description && <p className="text-xs text-muted-foreground line-clamp-1">{c.description}</p>}
                  <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1"><DollarSign className="size-3" /> {c.is_free ? 'Free' : `$${Number(c.price).toFixed(2)}`}</span>
                    <span className="flex items-center gap-1"><Users className="size-3" /> {c.enrollment_count} enrolled</span>
                    {c.is_published && <span className="flex items-center gap-1"><Globe className="size-3" /> Published</span>}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
                  <IconButton variant="ghost" size="sm" type="button" title="Edit course" onClick={() => window.location.href = `/backend/courses/${c.id}`}>
                    <Pencil className="size-4 text-muted-foreground" />
                  </IconButton>
                  {c.is_published && (
                    <IconButton variant="ghost" size="sm" type="button" title="View public page" onClick={() => window.open(`/api/courses/public/${c.slug}`, '_blank')}>
                      <ExternalLink className="size-4" />
                    </IconButton>
                  )}
                  <Button type="button" variant="ghost" size="sm" className="h-8 text-xs" onClick={e => togglePublish(c, e)}>
                    {c.is_published ? 'Unpublish' : 'Publish'}
                  </Button>
                  <IconButton variant="ghost" size="sm" type="button" title="Delete" onClick={e => deleteCourse(c.id, e)}>
                    <Trash2 className="size-4 text-muted-foreground hover:text-destructive" />
                  </IconButton>
                </div>
              </div>
            </div>
            )
          })}
        </div>
        </>
      )}
    </div>
  )
}
