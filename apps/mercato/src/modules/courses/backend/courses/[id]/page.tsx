'use client'

import { useState, useEffect, useRef } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Badge } from '@open-mercato/ui/primitives/badge'
import { Switch } from '@open-mercato/ui/primitives/switch'
import {
  ArrowLeft, Plus, Trash2, BookOpen, Video, FileText, Save, Loader2,
  Users, Globe, Sparkles, Eye, ChevronDown, ExternalLink, Play,
  Check, Clock, X,
} from 'lucide-react'

type Lesson = {
  id?: string; title: string; contentType: string; content: string; description: string
  videoUrl: string; fileUrl: string; dripDays: string; isFreePreview: boolean; durationMinutes: string
}
type Module = { id?: string; title: string; description: string; lessons: Lesson[] }
type Course = {
  id: string; title: string; description: string; slug: string; terms_text: string | null
  price: string; is_free: boolean; is_published: boolean; enrollment_count: number
  generation_status: string | null; teaching_style: string | null; target_audience: string | null
  landing_copy: any; modules?: Module[]
}

function getVideoEmbed(url: string): string | null {
  if (!url) return null
  // YouTube
  const ytMatch = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]+)/)
  if (ytMatch) return `https://www.youtube.com/embed/${ytMatch[1]}`
  // Vimeo
  const vmMatch = url.match(/vimeo\.com\/(\d+)/)
  if (vmMatch) return `https://player.vimeo.com/video/${vmMatch[1]}`
  // Loom
  const loomMatch = url.match(/loom\.com\/share\/([a-zA-Z0-9]+)/)
  if (loomMatch) return `https://www.loom.com/embed/${loomMatch[1]}`
  return null
}

export default function CourseEditorPage({ params }: { params: { id: string } }) {
  const [course, setCourse] = useState<Course | null>(null)
  const [modules, setModules] = useState<Module[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [generatingLesson, setGeneratingLesson] = useState<string | null>(null)

  const [editorTab, setEditorTab] = useState<'content' | 'landing' | 'students' | 'settings'>('content')
  const [enrollments, setEnrollments] = useState<any[]>([])
  const [enrollmentsLoading, setEnrollmentsLoading] = useState(false)

  // Course metadata editing
  const [editTitle, setEditTitle] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editSlug, setEditSlug] = useState('')
  const [editPrice, setEditPrice] = useState('')
  const [editIsFree, setEditIsFree] = useState(true)
  const [editTerms, setEditTerms] = useState('')
  const [editLandingStyle, setEditLandingStyle] = useState('warm')

  // PKB settings
  const [pkbApiKey, setPkbApiKey] = useState('')
  const [pkbStatus, setPkbStatus] = useState<'unknown' | 'connected' | 'error'>('unknown')
  const [pkbTesting, setPkbTesting] = useState(false)
  const [pkbSaving, setPkbSaving] = useState(false)

  // Landing page copy
  const [landingCopy, setLandingCopy] = useState<any>(null)
  const [generatingCopy, setGeneratingCopy] = useState(false)
  const [publishing, setPublishing] = useState(false)

  // PKB document picker
  const [showPkbPicker, setShowPkbPicker] = useState(false)
  const [pkbDocs, setPkbDocs] = useState<Array<{ id: string; title: string }>>([])
  const [pkbDocsLoading, setPkbDocsLoading] = useState(false)
  const [pkbTargetLesson, setPkbTargetLesson] = useState<{ modIdx: number; lesIdx: number } | null>(null)

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    loadCourse()
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [params.id])

  function loadCourse() {
    fetch(`/api/courses/courses/${params.id}`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (d.ok && d.data) {
          const c = d.data
          setCourse(c)
          setEditTitle(c.title); setEditDesc(c.description || ''); setEditSlug(c.slug)
          setEditPrice(c.price || ''); setEditIsFree(c.is_free); setEditTerms(c.terms_text || ''); setEditLandingStyle(c.landing_style || 'warm')
          if (c.landing_copy) setLandingCopy(typeof c.landing_copy === 'string' ? JSON.parse(c.landing_copy) : c.landing_copy)
          setModules(c.modules?.map((m: any) => ({
            id: m.id, title: m.title, description: m.description || '',
            lessons: (m.lessons || []).map((l: any) => ({
              id: l.id, title: l.title, contentType: l.content_type || 'text',
              content: l.content || '', description: l.description || '',
              videoUrl: l.video_url || '', fileUrl: l.file_url || '',
              dripDays: l.drip_days?.toString() || '',
              isFreePreview: l.is_free_preview || false,
              durationMinutes: l.duration_minutes?.toString() || '',
            })),
          })) || [])

          // Poll if generating
          if (c.generation_status === 'generating' && !pollRef.current) {
            pollRef.current = setInterval(() => {
              fetch(`/api/courses/courses/${params.id}`, { credentials: 'include' })
                .then(r => r.json()).then(poll => {
                  if (poll.ok && poll.data?.generation_status !== 'generating') {
                    if (pollRef.current) clearInterval(pollRef.current)
                    pollRef.current = null
                    loadCourse() // reload with generated content
                  }
                }).catch(() => {})
            }, 5000)
          }
        }
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }

  async function openPkbPicker(modIdx: number, lesIdx: number) {
    setPkbTargetLesson({ modIdx, lesIdx })
    setShowPkbPicker(true)
    if (pkbDocs.length === 0) {
      setPkbDocsLoading(true)
      try {
        const res = await fetch('/api/courses/pkb/documents', { credentials: 'include' })
        const d = await res.json()
        if (d.ok) setPkbDocs(d.data || [])
      } catch {}
      setPkbDocsLoading(false)
    }
  }

  async function insertPkbDoc(docId: string) {
    if (!pkbTargetLesson) return
    try {
      const res = await fetch(`/api/courses/pkb/documents?ids=${docId}`, { credentials: 'include' })
      const d = await res.json()
      if (d.ok && d.data?.[0]) {
        const doc = d.data[0]
        const { modIdx, lesIdx } = pkbTargetLesson
        const current = modules[modIdx].lessons[lesIdx].content
        updateLesson(modIdx, lesIdx, 'content', current ? `${current}\n\n--- From: ${doc.title} ---\n${doc.content}` : doc.content)
        setShowPkbPicker(false)
        setPkbTargetLesson(null)
      }
    } catch { alert('Failed to fetch document') }
  }

  async function loadEnrollments() {
    setEnrollmentsLoading(true)
    try {
      const res = await fetch(`/api/courses/enrollments?courseId=${params.id}`, { credentials: 'include' })
      const d = await res.json()
      if (d.ok) setEnrollments(d.data || [])
    } catch {}
    setEnrollmentsLoading(false)
  }

  // ── Module/Lesson operations ──
  function addModule() { setModules([...modules, { title: '', description: '', lessons: [] }]) }
  function updateModule(idx: number, field: string, value: string) { setModules(modules.map((m, i) => i === idx ? { ...m, [field]: value } : m)) }
  function addLesson(modIdx: number) {
    setModules(modules.map((m, i) => i === modIdx ? {
      ...m, lessons: [...m.lessons, { title: '', contentType: 'text', content: '', description: '', videoUrl: '', fileUrl: '', dripDays: '', isFreePreview: false, durationMinutes: '' }]
    } : m))
  }
  function updateLesson(modIdx: number, lesIdx: number, field: string, value: any) {
    setModules(modules.map((m, i) => i === modIdx ? {
      ...m, lessons: m.lessons.map((l, j) => j === lesIdx ? { ...l, [field]: value } : l)
    } : m))
  }

  async function deleteModule(modIdx: number) {
    const mod = modules[modIdx]
    if (!confirm(`Delete "${mod.title || 'this module'}" and all its lessons?`)) return
    if (mod.id) {
      await fetch(`/api/courses/modules/${mod.id}`, { method: 'DELETE', credentials: 'include' })
    }
    setModules(modules.filter((_, i) => i !== modIdx))
  }

  async function deleteLesson(modIdx: number, lesIdx: number) {
    const lesson = modules[modIdx].lessons[lesIdx]
    if (lesson.id) {
      await fetch(`/api/courses/lessons/${lesson.id}`, { method: 'DELETE', credentials: 'include' })
    }
    setModules(modules.map((m, i) => i === modIdx ? { ...m, lessons: m.lessons.filter((_, j) => j !== lesIdx) } : m))
  }

  async function generateLessonContent(modIdx: number, lesIdx: number) {
    const lesson = modules[modIdx].lessons[lesIdx]
    const mod = modules[modIdx]
    const key = `${modIdx}-${lesIdx}`
    setGeneratingLesson(key)
    try {
      const res = await fetch('/api/courses/ai/generate-lesson', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({
          courseTitle: editTitle, moduleTitle: mod.title, lessonTitle: lesson.title,
          lessonDescription: '', style: course?.teaching_style || 'professional',
          targetAudience: course?.target_audience || '',
        }),
      })
      const d = await res.json()
      if (d.ok && d.data?.content) {
        updateLesson(modIdx, lesIdx, 'content', d.data.content)
      }
    } catch {}
    setGeneratingLesson(null)
  }

  async function saveCourse() {
    setSaving(true)
    try {
      const res = await fetch(`/api/courses/courses/${params.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({
          title: editTitle, description: editDesc, slug: editSlug,
          price: editIsFree ? null : editPrice, isFree: editIsFree,
          termsText: editTerms || null, modules,
          landingCopy: landingCopy || undefined, landingStyle: editLandingStyle,
        }),
      })
      const data = await res.json()
      if (data.ok) {
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      } else {
        alert(data.error || 'Failed to save. Please try again.')
      }
    } catch {
      alert('Failed to save. Check your connection and try again.')
    }
    setSaving(false)
  }

  async function handlePublish() {
    if (!course) return
    if (course.is_published) {
      await fetch(`/api/courses/courses/${course.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ isPublished: false }),
      })
      loadCourse()
      return
    }
    // Publish: save everything including landing copy
    setPublishing(true)
    await fetch(`/api/courses/courses/${course.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({
        title: editTitle, description: editDesc, slug: editSlug,
        price: editIsFree ? null : editPrice, isFree: editIsFree,
        termsText: editTerms || null, modules, isPublished: true,
        landingCopy: landingCopy || undefined,
      }),
    })
    setPublishing(false)
    loadCourse()
  }

  async function generateLandingCopy() {
    if (!course) return
    setGeneratingCopy(true)
    await saveCourse()
    try {
      const res = await fetch('/api/courses/ai/generate-landing-copy', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ courseId: course.id }),
      })
      const d = await res.json()
      if (d.ok && d.data) {
        setLandingCopy(d.data)
      } else {
        alert(d.error || 'Failed to generate copy')
      }
    } catch { alert('Failed to generate copy') }
    setGeneratingCopy(false)
  }

  if (loading) return <div className="flex items-center justify-center py-24"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
  if (!course) return <div className="p-6 text-sm text-muted-foreground">Course not found</div>

  const totalLessons = modules.reduce((sum, m) => sum + m.lessons.length, 0)

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <a href="/backend/courses" className="text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /></a>
        <div className="flex-1">
          <input value={editTitle} onChange={e => setEditTitle(e.target.value)} placeholder="Course Title"
            className="text-xl font-bold w-full bg-transparent border-none outline-none placeholder:text-muted-foreground/40 focus:outline-none" />
          <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
            <span>{modules.length} modules · {totalLessons} lessons</span>
            <span>{course.enrollment_count} enrolled</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={handlePublish}>
            <Globe className="size-3.5 mr-1.5" /> {course.is_published ? 'Unpublish' : 'Publish'}
          </Button>
          {course.is_published && (
            <IconButton variant="ghost" size="sm" type="button" title="Preview" onClick={() => window.open(`/api/courses/public/${course.slug}`, '_blank')}>
              <ExternalLink className="size-4" />
            </IconButton>
          )}
          <Button type="button" onClick={saveCourse} disabled={saving}>
            {saving ? <Loader2 className="size-4 mr-1.5 animate-spin" /> : saved ? <Check className="size-4 mr-1.5" /> : <Save className="size-4 mr-1.5" />}
            {saving ? 'Saving...' : saved ? 'Saved' : 'Save'}
          </Button>
        </div>
      </div>

      {/* Generation status banner */}
      {course.generation_status === 'generating' && (
        <div className="border border-[rgba(217,119,6,.26)] bg-[rgba(217,119,6,.10)] dark:border-[rgba(245,158,11,.30)] dark:bg-[rgba(245,158,11,.13)] rounded-lg px-4 py-3 mb-6 flex items-center gap-3">
          <Loader2 className="size-4 animate-spin text-[#b45309] dark:text-[#fbbf24]" />
          <div>
            <p className="text-sm font-medium text-[#b45309] dark:text-[#fbbf24]">AI is generating lesson content...</p>
            <p className="text-xs text-[#b45309] dark:text-[#fbbf24]">This page will refresh automatically when complete.</p>
          </div>
        </div>
      )}
      {course.generation_status === 'failed' && (
        <div className="border border-[rgba(239,68,68,.24)] bg-[rgba(239,68,68,.10)] dark:border-[rgba(239,68,68,.30)] dark:bg-[rgba(239,68,68,.13)] rounded-lg px-4 py-3 mb-6">
          <p className="text-sm font-medium text-[#b91c1c] dark:text-[#f87171]">AI generation failed. You can still edit the course manually or try generating individual lessons.</p>
        </div>
      )}

      {/* Course metadata */}
      <div className="bg-card rounded-lg border p-5 mb-6 space-y-4">
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Description</label>
          <Textarea value={editDesc} onChange={e => setEditDesc(e.target.value)} placeholder="What will students learn?" rows={2} className="text-sm" />
        </div>
        <div className="border-t pt-4">
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Terms & Conditions (optional)</label>
          <Textarea value={editTerms} onChange={e => setEditTerms(e.target.value)}
            placeholder="Enter terms students must accept before enrolling (leave blank for none)"
            rows={2} className="text-xs" />
        </div>
        <div className="border-t pt-4">
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Pricing</label>
          <div className="flex items-center gap-3">
            <div className="flex gap-1">
              {[true, false].map(free => (
                <button key={String(free)} type="button" onClick={() => setEditIsFree(free)}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${editIsFree === free ? 'bg-accent text-accent-foreground border-accent' : 'text-muted-foreground border-border hover:border-accent/30'}`}>
                  {free ? 'Free' : 'Paid'}
                </button>
              ))}
            </div>
            {!editIsFree && (
              <div className="flex items-center gap-1">
                <span className="text-sm text-muted-foreground">$</span>
                <Input type="number" value={editPrice} onChange={e => setEditPrice(e.target.value)} placeholder="97.00" className="w-24 text-sm" step="0.01" />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Tab switcher */}
      <div className="flex items-center gap-1 border-b mb-6">
        <button type="button" onClick={() => setEditorTab('content')}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${editorTab === 'content' ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
          Content
        </button>
        <button type="button" onClick={() => setEditorTab('landing')}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${editorTab === 'landing' ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
          Landing Page
        </button>
        <button type="button" onClick={() => { setEditorTab('students'); if (enrollments.length === 0) loadEnrollments() }}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${editorTab === 'students' ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
          Students ({course.enrollment_count})
        </button>
        <button type="button" onClick={() => {
          setEditorTab('settings')
          if (pkbStatus === 'unknown') {
            fetch('/api/courses/pkb/config', { credentials: 'include' }).then(r => r.json()).then(d => {
              if (d.ok && d.data) { setPkbStatus(d.data.configured ? 'connected' : 'unknown') }
            }).catch(() => {})
          }
        }}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${editorTab === 'settings' ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
          Settings
        </button>
      </div>

      {/* Students tab */}
      {editorTab === 'students' && (
        <div>
          {enrollmentsLoading ? (
            <div className="text-center py-12 text-sm text-muted-foreground"><Loader2 className="size-5 animate-spin mx-auto mb-2" /> Loading students...</div>
          ) : enrollments.length === 0 ? (
            <div className="text-center py-12 text-sm text-muted-foreground">
              <Users className="size-8 mx-auto text-muted-foreground/30 mb-3" />
              <p>No students enrolled yet.</p>
              {course.is_published && <p className="text-xs mt-1">Share your course page: <a href={`/api/courses/public/${course.slug}`} target="_blank" className="text-accent underline">/course/{course.slug}</a></p>}
            </div>
          ) : (
            <div className="bg-card rounded-lg border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/30">
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Student</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Email</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Enrolled</th>
                    <th className="text-center px-4 py-3 font-medium text-muted-foreground">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {enrollments.map((e: any) => (
                    <tr key={e.id} className="border-b last:border-0">
                      <td className="px-4 py-3 font-medium">{e.student_name}</td>
                      <td className="px-4 py-3 text-muted-foreground">{e.student_email}</td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">{new Date(e.enrolled_at).toLocaleDateString()}</td>
                      <td className="px-4 py-3 text-center">
                        <Badge variant={e.completed_at ? 'green' : 'secondary'}>
                          {e.completed_at ? 'Completed' : e.status}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Landing Page tab */}
      {editorTab === 'landing' && (
        <div className="space-y-6">
          {/* Generate copy section */}
          <div className="bg-card rounded-xl border p-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-semibold text-sm">Landing Page Copy</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {landingCopy ? 'Edit the copy that appears on your public course page.' : 'Generate compelling copy for your course landing page with AI.'}
                </p>
              </div>
              <Button type="button" variant={landingCopy ? 'outline' : 'default'} size="sm" onClick={generateLandingCopy} disabled={generatingCopy}>
                {generatingCopy ? <><Loader2 className="size-3.5 mr-1.5 animate-spin" /> Generating...</> : <><Sparkles className="size-3.5 mr-1.5" /> {landingCopy ? 'Regenerate' : 'Generate Copy'}</>}
              </Button>
            </div>

            {!landingCopy && !generatingCopy && (
              <div className="rounded-lg bg-muted/30 p-8 text-center">
                <Sparkles className="size-8 mx-auto text-muted-foreground/30 mb-3" />
                <p className="text-sm text-muted-foreground mb-1">No landing page copy yet</p>
                <p className="text-xs text-muted-foreground/60">Click "Generate Copy" to create AI-written headlines, descriptions, FAQs, and more for your course page.</p>
              </div>
            )}

            {generatingCopy && !landingCopy && (
              <div className="rounded-lg bg-muted/30 p-8 text-center">
                <Loader2 className="size-6 animate-spin text-accent mx-auto mb-3" />
                <p className="text-sm font-medium">Generating landing page copy...</p>
                <p className="text-xs text-muted-foreground mt-1">AI is writing headlines, descriptions, FAQs, and more. This takes a few seconds.</p>
              </div>
            )}

            {landingCopy && (
              <div className="space-y-5">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Headline</label>
                  <Input value={landingCopy.headline || ''} onChange={(ev: any) => setLandingCopy({ ...landingCopy, headline: ev.target.value })} className="text-sm font-semibold" />
                </div>

                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Subheadline</label>
                  <Textarea value={landingCopy.subheadline || ''} onChange={(ev: any) => setLandingCopy({ ...landingCopy, subheadline: ev.target.value })} rows={2} className="text-sm" />
                </div>

                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">What You'll Learn</label>
                  <p className="text-[11px] text-muted-foreground/60 mb-2">Each bullet has a short title and a description — these appear as benefit cards on the landing page.</p>
                  <div className="space-y-2">
                    {(landingCopy.valueBullets || []).map((b: any, i: number) => {
                      const isObj = typeof b === 'object' && b.title !== undefined
                      return (
                        <div key={i} className="flex gap-2 items-start">
                          <div className="flex-1 space-y-1.5">
                            <Input value={isObj ? b.title : b} onChange={(ev: any) => {
                              const u = [...(landingCopy.valueBullets || [])]
                              u[i] = isObj ? { ...b, title: ev.target.value } : ev.target.value
                              setLandingCopy({ ...landingCopy, valueBullets: u })
                            }} placeholder="Short benefit title" className="text-sm h-8 font-medium" />
                            {isObj && <Input value={b.description || ''} onChange={(ev: any) => {
                              const u = [...(landingCopy.valueBullets || [])]
                              u[i] = { ...b, description: ev.target.value }
                              setLandingCopy({ ...landingCopy, valueBullets: u })
                            }} placeholder="One-sentence description" className="text-xs h-8" />}
                          </div>
                          <IconButton variant="ghost" size="xs" type="button" onClick={() => {
                            const u = (landingCopy.valueBullets || []).filter((_: any, j: number) => j !== i)
                            setLandingCopy({ ...landingCopy, valueBullets: u })
                          }}><X className="size-3 text-muted-foreground" /></IconButton>
                        </div>
                      )
                    })}
                    <button type="button" onClick={() => setLandingCopy({ ...landingCopy, valueBullets: [...(landingCopy.valueBullets || []), { title: '', description: '' }] })}
                      className="text-xs text-accent flex items-center gap-1">
                      <Plus className="size-3" /> Add Bullet
                    </button>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Highlights</label>
                  <p className="text-[11px] text-muted-foreground/60 mb-2">Feature cards that appear below the curriculum — each with a title and description.</p>
                  <div className="space-y-2">
                    {(landingCopy.highlights || []).map((h: any, i: number) => (
                      <div key={i} className="flex gap-2 items-start">
                        <div className="flex-1 space-y-1.5">
                          <Input value={h.title} onChange={(ev: any) => { const u = [...(landingCopy.highlights || [])]; u[i] = { ...h, title: ev.target.value }; setLandingCopy({ ...landingCopy, highlights: u }) }} placeholder="Title" className="text-sm h-8" />
                          <Input value={h.description} onChange={(ev: any) => { const u = [...(landingCopy.highlights || [])]; u[i] = { ...h, description: ev.target.value }; setLandingCopy({ ...landingCopy, highlights: u }) }} placeholder="Description" className="text-xs h-8" />
                        </div>
                        <IconButton variant="ghost" size="xs" type="button" onClick={() => { const u = (landingCopy.highlights || []).filter((_: any, j: number) => j !== i); setLandingCopy({ ...landingCopy, highlights: u }) }}>
                          <X className="size-3 text-muted-foreground" />
                        </IconButton>
                      </div>
                    ))}
                    <button type="button" onClick={() => setLandingCopy({ ...landingCopy, highlights: [...(landingCopy.highlights || []), { title: '', description: '' }] })}
                      className="text-xs text-accent flex items-center gap-1">
                      <Plus className="size-3" /> Add Highlight
                    </button>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Who Is This For</label>
                  <p className="text-[11px] text-muted-foreground/60 mb-2">Each persona has a short role title and one-sentence description. Icons are assigned automatically.</p>
                  <div className="space-y-2">
                    {(landingCopy.whoIsThisFor || []).map((w: any, i: number) => {
                      const isObj = typeof w === 'object' && w.title !== undefined
                      return (
                        <div key={i} className="flex gap-2 items-start">
                          <div className="flex-1 space-y-1.5">
                            <Input value={isObj ? w.title : String(w)} onChange={(ev: any) => {
                              const u = [...(landingCopy.whoIsThisFor || [])]
                              u[i] = isObj ? { ...w, title: ev.target.value } : ev.target.value
                              setLandingCopy({ ...landingCopy, whoIsThisFor: u })
                            }} className="text-sm h-8 font-medium" placeholder="The Freelancer" />
                            {isObj && <Input value={w.description || ''} onChange={(ev: any) => {
                              const u = [...(landingCopy.whoIsThisFor || [])]
                              u[i] = { ...w, description: ev.target.value }
                              setLandingCopy({ ...landingCopy, whoIsThisFor: u })
                            }} className="text-xs h-8" placeholder="One sentence about their situation" />}
                          </div>
                          <IconButton variant="ghost" size="xs" type="button" onClick={() => setLandingCopy({ ...landingCopy, whoIsThisFor: (landingCopy.whoIsThisFor || []).filter((_: any, j: number) => j !== i) })}>
                            <X className="size-3 text-muted-foreground" />
                          </IconButton>
                        </div>
                      )
                    })}
                    <button type="button" onClick={() => setLandingCopy({ ...landingCopy, whoIsThisFor: [...(landingCopy.whoIsThisFor || []), { title: '', description: '' }] })}
                      className="text-xs text-accent flex items-center gap-1">
                      <Plus className="size-3" /> Add Persona
                    </button>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">FAQ</label>
                  <p className="text-[11px] text-muted-foreground/60 mb-2">Frequently asked questions shown on the landing page.</p>
                  <div className="space-y-2">
                    {(landingCopy.faq || []).map((f: any, i: number) => (
                      <div key={i} className="flex gap-2 items-start">
                        <div className="flex-1 space-y-1.5">
                          <Input value={f.question} onChange={(ev: any) => { const u = [...(landingCopy.faq || [])]; u[i] = { ...f, question: ev.target.value }; setLandingCopy({ ...landingCopy, faq: u }) }} placeholder="Question" className="text-sm h-8" />
                          <Textarea value={f.answer} onChange={(ev: any) => { const u = [...(landingCopy.faq || [])]; u[i] = { ...f, answer: ev.target.value }; setLandingCopy({ ...landingCopy, faq: u }) }} placeholder="Answer" rows={2} className="text-xs" />
                        </div>
                        <IconButton variant="ghost" size="xs" type="button" onClick={() => { const u = (landingCopy.faq || []).filter((_: any, j: number) => j !== i); setLandingCopy({ ...landingCopy, faq: u }) }}>
                          <X className="size-3 text-muted-foreground" />
                        </IconButton>
                      </div>
                    ))}
                    <button type="button" onClick={() => setLandingCopy({ ...landingCopy, faq: [...(landingCopy.faq || []), { question: '', answer: '' }] })}
                      className="text-xs text-accent flex items-center gap-1">
                      <Plus className="size-3" /> Add FAQ
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1.5 block">CTA Button Text</label>
                    <Input value={landingCopy.ctaText || ''} onChange={(ev: any) => setLandingCopy({ ...landingCopy, ctaText: ev.target.value })} className="text-sm" placeholder="Enroll Now" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Social Proof Line</label>
                    <Input value={landingCopy.socialProofLine || ''} onChange={(ev: any) => setLandingCopy({ ...landingCopy, socialProofLine: ev.target.value })} className="text-sm" placeholder="Join 500+ students" />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Page Style */}
          <div className="bg-card rounded-xl border p-6">
            <h3 className="font-semibold text-sm mb-3">Page Style</h3>
            <div className="grid grid-cols-3 gap-3">
              {[
                { id: 'warm', label: 'Warm', desc: 'Soft tones, friendly feel', preview: 'bg-amber-50 border-amber-200' },
                { id: 'minimal', label: 'Minimal', desc: 'Clean, serif typography', preview: 'bg-gray-50 border-gray-200' },
                { id: 'dark', label: 'Dark', desc: 'Dark mode, purple accents', preview: 'bg-gray-900 border-purple-500' },
              ].map(s => (
                <button key={s.id} type="button" onClick={() => setEditLandingStyle(s.id)}
                  className={`rounded-lg border p-3 text-left transition-all ${editLandingStyle === s.id ? 'ring-2 ring-primary border-primary' : 'hover:border-accent/30'}`}>
                  <div className={`w-full h-8 rounded ${s.preview} border mb-2`} />
                  <p className="text-xs font-medium">{s.label}</p>
                  <p className="text-[10px] text-muted-foreground">{s.desc}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Save + Preview */}
          <div className="bg-muted/30 rounded-lg p-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">{course.is_published ? 'Your course page is live' : 'Save your changes'}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{course.is_published ? 'Save and preview your updated landing page.' : 'Click Save to persist your landing page copy and style.'}</p>
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" onClick={saveCourse} disabled={saving} size="sm">
                {saving ? <Loader2 className="size-3.5 mr-1.5 animate-spin" /> : saved ? <Check className="size-3.5 mr-1.5" /> : <Save className="size-3.5 mr-1.5" />}
                {saving ? 'Saving...' : saved ? 'Saved' : 'Save Changes'}
              </Button>
              {course.is_published && (
                <Button type="button" variant="outline" size="sm" onClick={() => window.open(`/api/courses/public/${course.slug}`, '_blank')}>
                  <Eye className="size-3.5 mr-1.5" /> Preview
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Settings tab */}
      {editorTab === 'settings' && (
        <div className="max-w-lg space-y-6">
          {/* PKB Connection */}
          <div className="bg-card rounded-xl border p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="size-10 rounded-lg border border-primary/30 bg-foreground/[.04] dark:bg-white/[.04] flex items-center justify-center">
                <BookOpen className="size-5 text-primary" />
              </div>
              <div>
                <h3 className="font-semibold text-sm">Knowledge Base</h3>
                <p className="text-xs text-muted-foreground">Connects automatically to pull your documents into AI course generation.</p>
              </div>
              {pkbStatus === 'connected' && <Badge variant="green" className="ml-auto">Connected</Badge>}
            </div>
            <div className="space-y-3">
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer font-medium hover:text-foreground transition-colors">Use a specific Knowledge Base key (optional)</summary>
                <div className="mt-2">
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">PKB API Key</label>
                  <Input value={pkbApiKey} onChange={e => setPkbApiKey(e.target.value)} placeholder="pkb_..." type="password" className="text-sm" />
                  <p className="text-[10px] text-muted-foreground mt-1.5">
                    Auto-connect handles this for you. Only paste a key to override which Knowledge Base account this reads from.
                  </p>
                </div>
              </details>
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" disabled={pkbTesting} onClick={async () => {
                  setPkbTesting(true)
                  // Only save a manual override when the user actually pasted a key.
                  if (pkbApiKey.trim()) {
                    await fetch('/api/courses/pkb/config', { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: pkbApiKey }) })
                  }
                  const res = await fetch('/api/courses/pkb/config', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' })
                  const d = await res.json()
                  if (d.ok) { setPkbStatus('connected'); alert(`Connected! Found ${d.data.documentCount} documents in your Knowledge Base.`) }
                  else { setPkbStatus('error'); alert(d.error || 'Connection failed. Try again in a moment.') }
                  setPkbTesting(false)
                }}>
                  {pkbTesting ? <><Loader2 className="size-3 animate-spin mr-1" /> Testing...</> : pkbStatus === 'connected' ? 'Recheck' : 'Connect & Test'}
                </Button>
              </div>
            </div>
          </div>

          {/* How it works */}
          <div className="bg-muted/30 rounded-lg p-4">
            <h4 className="text-xs font-semibold mb-2">How It Works</h4>
            <ol className="text-xs text-muted-foreground space-y-1.5 list-decimal list-inside">
              <li>Get your API key from your Personal Knowledge Base settings</li>
              <li>Paste it above and click "Test & Save"</li>
              <li>When creating a course with AI, select PKB documents as source material</li>
              <li>AI uses your documents as the foundation for course content</li>
            </ol>
          </div>
        </div>
      )}

      {/* Modules + Lessons */}
      {editorTab === 'content' && (
      <div className="space-y-4">
        {modules.map((mod, modIdx) => (
          <div key={modIdx} className="rounded-xl border bg-card">
            <div className="flex items-center gap-3 px-4 py-3 border-b bg-muted/20">
              <Badge variant="secondary" className="text-[10px] shrink-0">Module {modIdx + 1}</Badge>
              <Input value={mod.title} onChange={e => updateModule(modIdx, 'title', e.target.value)}
                placeholder="Module title" className="flex-1 h-8 text-sm border-0 bg-transparent font-medium focus-visible:ring-0" />
              <IconButton type="button" variant="ghost" size="sm" onClick={() => deleteModule(modIdx)} aria-label="Delete module" title="Delete module">
                <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
              </IconButton>
            </div>

            <div className="p-4 space-y-3">
              {mod.lessons.map((lesson, lesIdx) => {
                const embedUrl = getVideoEmbed(lesson.videoUrl)
                const isGenerating = generatingLesson === `${modIdx}-${lesIdx}`

                return (
                  <div key={lesIdx} className="rounded-lg border p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-muted-foreground/50 w-5 text-right shrink-0">{lesIdx + 1}</span>
                      <Input value={lesson.title} onChange={e => updateLesson(modIdx, lesIdx, 'title', e.target.value)}
                        placeholder="Lesson title" className="flex-1 h-8 text-sm" />
                      <select value={lesson.contentType} onChange={e => updateLesson(modIdx, lesIdx, 'contentType', e.target.value)}
                        className="h-8 rounded-md border bg-background px-2 text-[11px] w-28">
                        <option value="text">Text</option>
                        <option value="video">Video</option>
                        <option value="hybrid">Text + Video</option>
                        <option value="file">File</option>
                      </select>
                      <IconButton type="button" variant="ghost" size="xs" onClick={() => deleteLesson(modIdx, lesIdx)} title="Delete lesson">
                        <Trash2 className="size-3 text-muted-foreground hover:text-destructive" />
                      </IconButton>
                    </div>

                    {/* Content editor */}
                    {(lesson.contentType === 'text' || lesson.contentType === 'hybrid') && (
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[10px] text-muted-foreground">Lesson Content (Markdown)</span>
                          <div className="flex items-center gap-1">
                            <Button type="button" variant="ghost" size="sm" className="h-6 text-[10px] px-2"
                              onClick={() => openPkbPicker(modIdx, lesIdx)}>
                              <BookOpen className="size-2.5 mr-1 text-[#1d4ed8] dark:text-[#93c5fd]" /> Pull from KB
                            </Button>
                            <Button type="button" variant="ghost" size="sm" className="h-6 text-[10px] px-2"
                              disabled={isGenerating || !lesson.title.trim()}
                              onClick={() => generateLessonContent(modIdx, lesIdx)}>
                              {isGenerating ? <><Loader2 className="size-2.5 animate-spin mr-1" /> Generating...</> : <><Sparkles className="size-2.5 mr-1 text-primary" /> Generate with AI</>}
                            </Button>
                          </div>
                        </div>
                        <Textarea value={lesson.content} onChange={e => updateLesson(modIdx, lesIdx, 'content', e.target.value)}
                          placeholder="Write your lesson content here (supports Markdown)..."
                          className="text-xs font-mono min-h-[120px]" rows={6} />
                      </div>
                    )}

                    {/* Video embed */}
                    {(lesson.contentType === 'video' || lesson.contentType === 'hybrid') && (
                      <div className="space-y-2">
                        <Input value={lesson.videoUrl} onChange={e => updateLesson(modIdx, lesIdx, 'videoUrl', e.target.value)}
                          placeholder="YouTube, Vimeo, or Loom URL" className="h-8 text-xs" />
                        {embedUrl && (
                          <div className="rounded-lg overflow-hidden bg-black aspect-video">
                            <iframe src={embedUrl} className="w-full h-full" allowFullScreen frameBorder="0" />
                          </div>
                        )}
                        {lesson.videoUrl && !embedUrl && (
                          <p className="text-[10px] text-[#b45309] dark:text-[#fbbf24]">Paste a YouTube, Vimeo, or Loom URL to see the preview</p>
                        )}
                      </div>
                    )}

                    {/* Lesson description — shown for all content types */}
                    <Input value={lesson.description} onChange={e => updateLesson(modIdx, lesIdx, 'description', e.target.value)}
                      placeholder="Brief lesson description (visible to students)" className="h-7 text-xs" />

                    {/* Downloadable file URL */}
                    <div className="flex items-center gap-2">
                      <FileText className="size-3 text-muted-foreground/50 shrink-0" />
                      <Input value={lesson.fileUrl} onChange={e => updateLesson(modIdx, lesIdx, 'fileUrl', e.target.value)}
                        placeholder="Downloadable file URL (optional)" className="h-7 text-xs flex-1" />
                    </div>

                    {/* Lesson settings row */}
                    <div className="flex items-center gap-4 pt-1">
                      <div className="flex items-center gap-1.5">
                        <Clock className="size-3 text-muted-foreground/50" />
                        <Input type="number" value={lesson.durationMinutes} onChange={e => updateLesson(modIdx, lesIdx, 'durationMinutes', e.target.value)}
                          placeholder="min" className="w-14 h-6 text-[10px]" />
                        <span className="text-[10px] text-muted-foreground/50">min</span>
                      </div>
                      <div className="flex items-center gap-1.5" title="Unlock this lesson X days after student enrolls. Leave blank for immediate access.">
                        <span className="text-[10px] text-muted-foreground/50">Unlock after</span>
                        <Input type="number" value={lesson.dripDays} onChange={e => updateLesson(modIdx, lesIdx, 'dripDays', e.target.value)}
                          placeholder="0" className="w-12 h-6 text-[10px]" />
                        <span className="text-[10px] text-muted-foreground/50">days</span>
                      </div>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input type="checkbox" checked={lesson.isFreePreview} onChange={e => updateLesson(modIdx, lesIdx, 'isFreePreview', e.target.checked)}
                          className="rounded border-border size-3" />
                        <span className="text-[10px] text-muted-foreground">Free preview</span>
                      </label>
                    </div>
                  </div>
                )
              })}

              <button type="button" onClick={() => addLesson(modIdx)}
                className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 ml-6 py-1">
                <Plus className="size-3" /> Add Lesson
              </button>
            </div>
          </div>
        ))}

        <button type="button" onClick={addModule}
          className="w-full rounded-xl border p-5 text-sm text-muted-foreground hover:text-foreground hover:border-accent/30 transition flex items-center justify-center gap-2">
          <Plus className="size-4" /> Add Module
        </button>
      </div>
      )}

      {/* PKB Document Picker Modal */}
      {showPkbPicker && (
        <>
          <div className="fixed inset-0 bg-black/30 z-40" onClick={() => setShowPkbPicker(false)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-background rounded-xl border shadow-xl w-full max-w-lg max-h-[70vh] flex flex-col">
              <div className="flex items-center justify-between px-5 py-4 border-b shrink-0">
                <h3 className="font-semibold">Pull from Knowledge Base</h3>
                <IconButton variant="ghost" size="sm" type="button" onClick={() => setShowPkbPicker(false)}><X className="size-4" /></IconButton>
              </div>
              <div className="flex-1 overflow-y-auto p-4">
                {pkbDocsLoading ? (
                  <div className="text-center py-8 text-sm text-muted-foreground"><Loader2 className="size-5 animate-spin mx-auto mb-2" /> Loading documents...</div>
                ) : pkbDocs.length === 0 ? (
                  <div className="text-center py-8 text-sm text-muted-foreground">
                    <BookOpen className="size-8 mx-auto text-muted-foreground/30 mb-3" />
                    <p>No documents found.</p>
                    <p className="text-xs mt-1">Connect your PKB in <a href="/backend/settings-simple" className="text-accent underline">Settings</a> first.</p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {pkbDocs.map(doc => (
                      <button key={doc.id} type="button" onClick={() => insertPkbDoc(doc.id)}
                        className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-muted transition-colors flex items-center gap-3">
                        <BookOpen className="size-4 text-muted-foreground shrink-0" />
                        <span className="text-sm truncate">{doc.title}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
