'use client'

import { useState, useEffect } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Plus, BookOpen, Users, DollarSign, Globe, X, Loader2, Eye } from 'lucide-react'

type Course = {
  id: string; title: string; description: string | null; slug: string
  price: string | null; is_free: boolean; is_published: boolean
  enrollment_count: number; created_at: string
}

export default function CoursesPage() {
  const [courses, setCourses] = useState<Course[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [title, setTitle] = useState('')
  const [slug, setSlug] = useState('')
  const [description, setDescription] = useState('')
  const [price, setPrice] = useState('')
  const [isFree, setIsFree] = useState(true)
  const [creating, setCreating] = useState(false)

  useEffect(() => { loadCourses() }, [])

  function loadCourses() {
    fetch('/api/courses/courses', { credentials: 'include' })
      .then(r => r.json()).then(d => { if (d.ok) setCourses(d.data || []); setLoading(false) }).catch(() => setLoading(false))
  }

  async function createCourse() {
    if (!title.trim() || !slug.trim()) return
    setCreating(true)
    try {
      const res = await fetch('/api/courses/courses', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ title, slug, description, price: isFree ? null : price, isFree }),
      })
      if ((await res.json()).ok) { setTitle(''); setSlug(''); setDescription(''); setShowCreate(false); loadCourses() }
    } catch {}
    setCreating(false)
  }

  async function togglePublish(course: Course) {
    await fetch(`/api/courses/courses/${course.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ isPublished: !course.is_published }),
    })
    loadCourses()
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-semibold">Courses</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Create and sell online courses</p>
        </div>
        <Button type="button" size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="size-3.5 mr-1.5" /> New Course
        </Button>
      </div>

      {/* Create Course */}
      {showCreate && (
        <div className="rounded-lg border bg-card p-5 mb-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">New Course</h3>
            <IconButton type="button" variant="ghost" size="sm" onClick={() => setShowCreate(false)} aria-label="Close"><X className="size-4" /></IconButton>
          </div>
          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Course Title</label>
                <Input value={title} onChange={e => { setTitle(e.target.value); if (!slug) setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-')) }}
                  placeholder="e.g. Business Launch Accelerator" className="h-9 text-sm" autoFocus />
              </div>
              <div>
                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">URL Slug</label>
                <Input value={slug} onChange={e => setSlug(e.target.value)} placeholder="business-launch" className="h-9 text-sm" />
              </div>
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Description</label>
              <Input value={description} onChange={e => setDescription(e.target.value)} placeholder="What will students learn?" className="h-9 text-sm" />
            </div>
            <div className="flex items-center gap-4">
              <div className="flex gap-2">
                <button type="button" onClick={() => setIsFree(true)}
                  className={`px-3 py-1.5 rounded-lg border text-xs font-medium ${isFree ? 'border-accent bg-accent/5 text-accent' : 'text-muted-foreground'}`}>
                  Free
                </button>
                <button type="button" onClick={() => setIsFree(false)}
                  className={`px-3 py-1.5 rounded-lg border text-xs font-medium ${!isFree ? 'border-accent bg-accent/5 text-accent' : 'text-muted-foreground'}`}>
                  Paid
                </button>
              </div>
              {!isFree && (
                <div className="flex items-center gap-1">
                  <span className="text-sm text-muted-foreground">$</span>
                  <Input type="number" value={price} onChange={e => setPrice(e.target.value)} placeholder="97.00" className="w-24 h-9 text-sm" step="0.01" />
                </div>
              )}
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2 border-t">
            <Button type="button" variant="outline" size="sm" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button type="button" size="sm" onClick={createCourse} disabled={creating || !title.trim() || !slug.trim()}>
              {creating ? <Loader2 className="size-3 animate-spin mr-1" /> : <Plus className="size-3 mr-1" />} Create
            </Button>
          </div>
        </div>
      )}

      {/* Courses List */}
      {loading ? <div className="text-sm text-muted-foreground">Loading...</div> :
      courses.length === 0 ? (
        <div className="rounded-lg border p-12 text-center">
          <BookOpen className="size-8 mx-auto mb-3 text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">No courses yet. Create your first course to start teaching.</p>
        </div>
      ) : (
        <div className="rounded-lg border divide-y">
          {courses.map(c => (
            <div key={c.id} className="flex items-center gap-4 px-5 py-4">
              <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center shrink-0">
                <BookOpen className="size-5 text-accent" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">{c.title}</p>
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                    c.is_published ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' : 'bg-muted text-muted-foreground'
                  }`}>{c.is_published ? 'Published' : 'Draft'}</span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {c.is_free ? 'Free' : `$${Number(c.price).toFixed(2)}`} · {c.enrollment_count} enrolled · /course/{c.slug}
                </p>
              </div>
              <div className="flex gap-2 shrink-0">
                <Button type="button" variant="outline" size="sm" onClick={() => window.location.href = `/backend/courses/${c.id}`}>
                  <Eye className="size-3 mr-1" /> Edit
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => togglePublish(c)}>
                  <Globe className="size-3 mr-1" /> {c.is_published ? 'Unpublish' : 'Publish'}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
