'use client'

import { useState, useEffect } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import {
  Plus, X, Loader2, GitBranch, Play, Pause, Trash2, Mail, Clock, Pencil,
  Filter, MessageSquare, Users, ChevronDown, ChevronRight, Sparkles, UserPlus,
  BookOpen, Download, Tag, Zap, Target,
} from 'lucide-react'

type Recipe = {
  id: string; name: string; description: string; category: string
  triggerType: string; triggerConfig: Record<string, unknown>
  steps: { stepOrder: number; stepType: string; config: Record<string, unknown> }[]
}

type Sequence = {
  id: string; name: string; description: string | null
  trigger_type: string; trigger_config: any; status: string
  step_count: number; enrollment_count: number
  created_at: string
}

type Step = {
  id?: string; stepOrder: number; stepType: string; config: any
  branchConfig?: any; isGoal?: boolean; goalConfig?: any
}

type Enrollment = {
  id: string; contact_id: string; display_name: string; primary_email: string
  status: string; current_step_order: number; enrolled_at: string
}

const TRIGGER_TYPES = [
  { value: 'manual', label: 'Manual enrollment', hasSubOptions: false },
  { value: 'form_submit', label: 'Form submission', hasSubOptions: true, subLabel: 'Which form?', subEndpoint: '/api/forms?pageSize=50', subKey: 'formId' },
  { value: 'tag_added', label: 'Tag added to contact', hasSubOptions: true, subLabel: 'Which tag?', subEndpoint: '/api/crm-contact-tags', subKey: 'tagSlug' },
  { value: 'contact_created', label: 'New contact created', hasSubOptions: false },
  { value: 'deal_stage_changed', label: 'Deal stage changed', hasSubOptions: true, subLabel: 'Which stage?', subEndpoint: '/api/business-profile', subKey: 'stage' },
  { value: 'deal_won', label: 'Deal won', hasSubOptions: false },
  { value: 'booking_created', label: 'Booking created', hasSubOptions: true, subLabel: 'Which booking page?', subEndpoint: '/api/calendar/booking-pages', subKey: 'bookingPageId' },
  { value: 'invoice_paid', label: 'Invoice paid', hasSubOptions: false },
  { value: 'event_registered', label: 'Event registration', hasSubOptions: true, subLabel: 'Which event?', subEndpoint: '/api/crm-events', subKey: 'eventId' },
  { value: 'course_enrolled', label: 'Course enrollment', hasSubOptions: true, subLabel: 'Which course?', subEndpoint: '/api/courses', subKey: 'courseId' },
  { value: 'product_purchased', label: 'Product purchased', hasSubOptions: true, subLabel: 'Which product?', subEndpoint: '/api/payments/products', subKey: 'productId' },
] as const

const STEP_TYPES = [
  { value: 'email', label: 'Send Email', icon: Mail },
  { value: 'wait', label: 'Wait', icon: Clock },
  { value: 'condition', label: 'Condition', icon: Filter },
  { value: 'sms', label: 'Send SMS', icon: MessageSquare },
  { value: 'branch', label: 'If/Else Branch', icon: GitBranch },
  { value: 'goal', label: 'Goal (End When)', icon: Target },
]

function TriggerSubOptions({ triggerType, config, onChange }: { triggerType: string; config: Record<string, any>; onChange: (c: Record<string, any>) => void }) {
  const trigger = TRIGGER_TYPES.find(t => t.value === triggerType)
  const [options, setOptions] = useState<Array<{ id: string; name: string }>>([])
  const [loaded, setLoaded] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!trigger?.hasSubOptions || !trigger.subEndpoint || loaded === triggerType) return
    setLoaded(triggerType)
    setLoading(true)
    fetch(trigger.subEndpoint, { credentials: 'include' }).then(r => r.json())
      .then(d => {
        if (triggerType === 'deal_stage_changed') {
          const stages = d.data?.pipeline_stages
          const parsed = typeof stages === 'string' ? JSON.parse(stages) : (stages || [])
          const fallback = ['New Lead', 'Contacted', 'Qualified', 'Proposal', 'Won', 'Lost']
          const stageList = parsed.length > 0 ? parsed : fallback
          setOptions(stageList.map((s: any) => ({ id: s.name || s, name: s.name || s })))
        } else {
          const items = d.data || d.items || []
          setOptions(items.map((i: any) => ({ id: i.id || i.slug, name: i.name || i.title || i.label || i.display_name || i.id })))
        }
      }).catch(() => {})
      .finally(() => setLoading(false))
  }, [triggerType])

  if (!trigger?.hasSubOptions) return null

  return (
    <div>
      <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">{trigger.subLabel || 'Filter'} (optional)</label>
      {loading ? (
        <p className="text-xs text-muted-foreground">Loading...</p>
      ) : (
        <select value={config[trigger.subKey!] || ''} onChange={e => onChange({ [trigger.subKey!]: e.target.value || undefined })}
          className="w-full h-9 rounded-md border bg-card px-3 text-sm">
          <option value="">Any (all)</option>
          {options.length === 0 && <option disabled>No options found</option>}
          {options.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      )}
    </div>
  )
}

const statusColors: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground',
  active: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  paused: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  archived: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
}

export default function SequencesPage({ embedded }: { embedded?: boolean } = {}) {
  const [sequences, setSequences] = useState<Sequence[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<'list' | 'create' | 'detail'>('list')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedSequence, setSelectedSequence] = useState<any>(null)
  const [enrollments, setEnrollments] = useState<Enrollment[]>([])
  const [aiDraftIdx, setAiDraftIdx] = useState<number | null>(null)
  const [aiStepPrompt, setAiStepPrompt] = useState('')
  const [aiStepDrafting, setAiStepDrafting] = useState(false)

  // Create form
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [triggerType, setTriggerType] = useState('manual')
  const [triggerConfig, setTriggerConfig] = useState<any>({})
  const [steps, setSteps] = useState<Step[]>([
    { stepOrder: 1, stepType: 'email', config: { subject: '', bodyHtml: '' } },
  ])
  const [saving, setSaving] = useState(false)

  // Enroll modal
  const [showEnroll, setShowEnroll] = useState(false)
  const [enrollContactId, setEnrollContactId] = useState('')
  const [enrollSelectedIds, setEnrollSelectedIds] = useState<Set<string>>(new Set())
  const [enrolling, setEnrolling] = useState(false)
  const [enrollSearch, setEnrollSearch] = useState('')
  const [enrollContactList, setEnrollContactList] = useState<Array<{ id: string; display_name: string; primary_email: string | null }>>([])
  const [enrollContactListLoading, setEnrollContactListLoading] = useState(false)
  const [enrollContactListLoaded, setEnrollContactListLoaded] = useState(false)

  // Recipes modal
  const [showRecipes, setShowRecipes] = useState(false)
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [recipesLoading, setRecipesLoading] = useState(false)
  const [installingRecipeId, setInstallingRecipeId] = useState<string | null>(null)

  useEffect(() => { loadSequences() }, [])

  function loadSequences() {
    fetch('/api/sequences', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.ok) setSequences(d.data || []) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  async function createSequence() {
    if (!name.trim() || steps.length === 0) return
    setSaving(true)
    const isEditing = !!selectedId
    try {
      const url = isEditing ? `/api/sequences/${selectedId}` : '/api/sequences'
      const method = isEditing ? 'PUT' : 'POST'
      const res = await fetch(url, {
        method, headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({
          name, description: description || null, triggerType, triggerConfig,
          steps: steps.map((s, i) => ({
            stepOrder: i + 1, stepType: s.stepType, config: s.config,
            branchConfig: s.branchConfig || null, isGoal: s.isGoal || false, goalConfig: s.goalConfig || null,
          })),
        }),
      })
      const data = await res.json()
      if (data.ok) {
        // If editing a paused sequence, ask if user wants to resume
        if (isEditing) {
          const shouldResume = confirm('Changes saved! Would you like to resume this sequence?')
          if (shouldResume) {
            await updateStatus(selectedId!, 'active')
          }
        }
        resetForm()
        setSelectedId(null)
        setView('list')
        loadSequences()
      } else {
        alert(data.error || `Failed to ${isEditing ? 'update' : 'create'} sequence`)
      }
    } catch { alert('Failed') }
    setSaving(false)
  }

  function resetForm() {
    setName(''); setDescription(''); setTriggerType('manual'); setTriggerConfig({})
    setSteps([{ stepOrder: 1, stepType: 'email', config: { subject: '', bodyHtml: '' } }])
  }

  async function openDetail(id: string) {
    setSelectedId(id)
    setSelectedSequence(null)
    setView('detail')
    try {
      const [seqRes, enrollRes] = await Promise.all([
        fetch(`/api/sequences/${id}`, { credentials: 'include' }).then(r => r.json()),
        fetch(`/api/sequences/${id}/enrollments`, { credentials: 'include' }).then(r => r.json()).catch(() => ({ ok: false })),
      ])
      if (seqRes.ok && seqRes.data) {
        setSelectedSequence(seqRes.data)
      } else {
        // If the detail fetch fails, go back to list
        console.error('[sequences] Detail fetch failed:', seqRes)
        setView('list')
      }
      if (enrollRes.ok) setEnrollments(enrollRes.data || [])
    } catch (err) {
      console.error('[sequences] Detail fetch error:', err)
      setView('list')
    }
  }

  async function updateStatus(id: string, status: string) {
    const res = await fetch(`/api/sequences/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ status }),
    })
    const data = await res.json()
    if (data.ok) { loadSequences(); if (selectedId === id) openDetail(id) }
    else alert(data.error || 'Failed')
  }

  async function deleteSequence(id: string) {
    if (!confirm('Delete this sequence? Active enrollments will stop.')) return
    const res = await fetch(`/api/sequences/${id}`, { method: 'DELETE', credentials: 'include' })
    const data = await res.json()
    if (data.ok) { loadSequences(); if (selectedId === id) { setView('list'); setSelectedId(null) } }
  }

  async function enrollContacts() {
    const ids = Array.from(enrollSelectedIds)
    if (ids.length === 0 || !selectedId) return
    setEnrolling(true)
    let succeeded = 0
    let failed = 0
    for (const contactId of ids) {
      try {
        const res = await fetch(`/api/sequences/${selectedId}/enroll`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ contactId }),
        })
        const data = await res.json()
        if (data.ok) succeeded++
        else failed++
      } catch { failed++ }
    }
    if (failed > 0) alert(`Enrolled ${succeeded} of ${ids.length} contacts. ${failed} failed (may already be enrolled).`)
    setEnrollSelectedIds(new Set())
    setEnrollSearch('')
    setShowEnroll(false)
    openDetail(selectedId)
    setEnrolling(false)
  }

  async function loadRecipes() {
    setRecipesLoading(true)
    try {
      const res = await fetch('/api/sequences/recipes', { credentials: 'include' })
      const data = await res.json()
      if (data.ok) setRecipes(data.data || [])
    } catch { /* ignore */ }
    setRecipesLoading(false)
  }

  async function installRecipe(recipeId: string) {
    setInstallingRecipeId(recipeId)
    try {
      const res = await fetch('/api/sequences/recipes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ recipeId }),
      })
      const data = await res.json()
      if (data.ok && data.data) {
        setShowRecipes(false)
        loadSequences()
        // Open the installed sequence in edit mode
        const seq = data.data
        setName(seq.name || '')
        setDescription(seq.description || '')
        setTriggerType(seq.trigger_type || 'manual')
        setTriggerConfig(typeof seq.trigger_config === 'string' ? JSON.parse(seq.trigger_config) : (seq.trigger_config || {}))
        const seqSteps = seq.steps || []
        setSteps(seqSteps.map((s: any) => ({
          stepOrder: s.step_order || s.stepOrder || 1,
          stepType: s.step_type || s.stepType || 'email',
          config: typeof s.config === 'string' ? JSON.parse(s.config) : (s.config || {}),
        })))
        setSelectedId(seq.id)
        setView('create')
      } else {
        alert(data.error || 'Failed to install recipe')
      }
    } catch { alert('Failed to install recipe') }
    setInstallingRecipeId(null)
  }

  function openRecipesModal() {
    setShowRecipes(true)
    loadRecipes()
  }

  function addStep() {
    setSteps([...steps, { stepOrder: steps.length + 1, stepType: 'wait', config: { delay: 1, unit: 'days' } }])
  }

  function removeStep(idx: number) {
    if (steps.length <= 1) return
    setSteps(steps.filter((_, i) => i !== idx))
  }

  function updateStep(idx: number, updates: Partial<Step>) {
    setSteps(steps.map((s, i) => {
      if (i !== idx) return s
      const merged = { ...s, ...updates }
      if (updates.stepType && updates.stepType !== s.stepType) {
        switch (updates.stepType) {
          case 'email': merged.config = { subject: '', bodyHtml: '' }; merged.branchConfig = undefined; merged.isGoal = false; merged.goalConfig = undefined; break
          case 'wait': merged.config = { delay: 1, unit: 'days' }; merged.branchConfig = undefined; merged.isGoal = false; merged.goalConfig = undefined; break
          case 'condition': merged.config = { field: 'tag', operator: 'has', value: '' }; merged.branchConfig = undefined; merged.isGoal = false; merged.goalConfig = undefined; break
          case 'sms': merged.config = { message: '' }; merged.branchConfig = undefined; merged.isGoal = false; merged.goalConfig = undefined; break
          case 'branch': merged.config = {}; merged.branchConfig = { condition: { field: 'tag', operator: 'has', value: '' }, trueStepOrder: null, falseStepOrder: null }; merged.isGoal = false; merged.goalConfig = undefined; break
          case 'goal': merged.config = {}; merged.isGoal = true; merged.goalConfig = { type: 'tag_added', value: '' }; merged.branchConfig = undefined; break
        }
      }
      return merged
    }))
  }

  async function aiDraftStep(idx: number) {
    const step = steps[idx]
    if (step.stepType !== 'email') return
    setAiStepDrafting(true)
    try {
      const userInstructions = aiStepPrompt.trim()
        ? `User instructions: ${aiStepPrompt}. `
        : ''
      const res = await fetch('/api/ai/draft-email', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({
          contactName: 'valued contact',
          purpose: 'follow-up',
          context: `${userInstructions}Sequence: ${name}. Step ${idx + 1} of ${steps.length}. ${description || ''}`,
        }),
      })
      const data = await res.json()
      if (data.ok) {
        updateStep(idx, { config: { ...step.config, subject: data.subject, bodyHtml: data.body } })
        setAiDraftIdx(null); setAiStepPrompt('')
      }
    } catch {}
    setAiStepDrafting(false)
  }

  // ── LIST VIEW ──
  if (view === 'list') {
    return (
      <div className={embedded ? '' : 'p-6 max-w-4xl mx-auto'}>
        {!embedded && (
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-lg font-semibold">Sequences</h1>
              <p className="text-xs text-muted-foreground mt-0.5">Automated email drip sequences and follow-ups</p>
            </div>
          </div>
        )}
        <div className={`flex items-center justify-between ${embedded ? 'mb-4' : 'mb-6'}`}>
          <div />
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={openRecipesModal}>
              <BookOpen className="size-3.5 mr-1.5" /> Browse Recipes
            </Button>
            <Button type="button" size="sm" onClick={() => { resetForm(); setView('create') }}>
              <Plus className="size-3.5 mr-1.5" /> New Sequence
            </Button>
          </div>
        </div>

        {loading ? <div className="text-sm text-muted-foreground">Loading...</div> :
        sequences.length === 0 ? (
          <div className="rounded-lg border p-12 text-center">
            <GitBranch className="size-8 mx-auto mb-3 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground mb-3">No sequences yet. Create one to automate your follow-ups.</p>
            <Button type="button" size="sm" onClick={() => { resetForm(); setView('create') }}>
              <Plus className="size-3.5 mr-1.5" /> Create Sequence
            </Button>
          </div>
        ) : (
          <div className="rounded-lg border divide-y">
            {sequences.map(seq => (
              <div key={seq.id} className="flex items-center gap-4 px-5 py-4 hover:bg-muted/30 cursor-pointer transition"
                onClick={() => openDetail(seq.id)}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{seq.name}</p>
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${statusColors[seq.status] || ''}`}>
                      {seq.status}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {TRIGGER_TYPES.find(t => t.value === seq.trigger_type)?.label || seq.trigger_type}
                    {' · '}{seq.step_count} step{seq.step_count !== 1 ? 's' : ''}
                    {' · '}{seq.enrollment_count} enrolled
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
                  {seq.status === 'draft' && (
                    <Button type="button" variant="outline" size="sm" onClick={() => updateStatus(seq.id, 'active')}>
                      <Play className="size-3 mr-1" /> Activate
                    </Button>
                  )}
                  {seq.status === 'active' && (
                    <Button type="button" variant="outline" size="sm" onClick={() => updateStatus(seq.id, 'paused')}>
                      <Pause className="size-3 mr-1" /> Pause
                    </Button>
                  )}
                  {seq.status === 'paused' && (
                    <Button type="button" variant="outline" size="sm" onClick={() => updateStatus(seq.id, 'active')}>
                      <Play className="size-3 mr-1" /> Resume
                    </Button>
                  )}
                  <IconButton type="button" variant="ghost" size="sm" onClick={() => deleteSequence(seq.id)} aria-label="Delete">
                    <Trash2 className="size-3.5 text-muted-foreground" />
                  </IconButton>
                </div>
                <span className="text-xs text-muted-foreground shrink-0">
                  {new Date(seq.created_at).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Recipes Modal */}
        {showRecipes && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setShowRecipes(false)}>
            <div className="bg-card rounded-lg border shadow-lg w-[640px] max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between px-5 py-4 border-b shrink-0">
                <div>
                  <h2 className="text-sm font-semibold">Automation Recipes</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">One-click installable sequence templates with pre-written emails</p>
                </div>
                <IconButton type="button" variant="ghost" size="sm" onClick={() => setShowRecipes(false)} aria-label="Close">
                  <X className="size-4" />
                </IconButton>
              </div>
              <div className="overflow-y-auto flex-1 p-5">
                {recipesLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="size-5 animate-spin text-muted-foreground" />
                  </div>
                ) : recipes.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-12">No recipes available.</p>
                ) : (
                  <div className="grid gap-3">
                    {recipes.map(recipe => {
                      const emailSteps = recipe.steps.filter(s => s.stepType === 'email').length
                      const triggerLabel = TRIGGER_TYPES.find(t => t.value === recipe.triggerType)?.label || recipe.triggerType
                      const isInstalling = installingRecipeId === recipe.id
                      return (
                        <div key={recipe.id} className="rounded-lg border p-4 hover:bg-muted/30 transition">
                          <div className="flex items-start gap-3">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1">
                                <p className="text-sm font-medium">{recipe.name}</p>
                                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                                  {recipe.category}
                                </span>
                              </div>
                              <p className="text-xs text-muted-foreground mb-2">{recipe.description}</p>
                              <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                                <span className="flex items-center gap-1">
                                  <Zap className="size-3" /> {triggerLabel}
                                </span>
                                <span className="flex items-center gap-1">
                                  <Mail className="size-3" /> {emailSteps} email{emailSteps !== 1 ? 's' : ''}
                                </span>
                                <span className="flex items-center gap-1">
                                  <GitBranch className="size-3" /> {recipe.steps.length} step{recipe.steps.length !== 1 ? 's' : ''}
                                </span>
                              </div>
                            </div>
                            <Button type="button" variant="outline" size="sm" onClick={() => installRecipe(recipe.id)}
                              disabled={isInstalling} className="shrink-0">
                              {isInstalling
                                ? <Loader2 className="size-3 animate-spin mr-1" />
                                : <Download className="size-3 mr-1" />}
                              Install
                            </Button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ── CREATE VIEW ──
  if (view === 'create') {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <Button type="button" variant="ghost" size="sm" onClick={() => setView('list')}>
            <ChevronRight className="size-3.5 rotate-180" />
          </Button>
          <h1 className="text-lg font-semibold">{selectedId ? 'Edit Sequence' : 'New Sequence'}</h1>
        </div>

        <div className="space-y-6">
          {/* Basic Info */}
          <div className="rounded-lg border bg-card p-5 space-y-4">
            <h3 className="text-sm font-semibold">Details</h3>
            <div className="grid gap-3">
              <div>
                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Sequence Name</label>
                <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Welcome Series" className="h-9 text-sm" autoFocus />
              </div>
              <div>
                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Description (optional)</label>
                <Input value={description} onChange={e => setDescription(e.target.value)} placeholder="What does this sequence do?" className="h-9 text-sm" />
              </div>
              <div>
                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Trigger</label>
                <select value={triggerType} onChange={e => { setTriggerType(e.target.value); setTriggerConfig({}) }}
                  className="w-full h-9 rounded-md border bg-card px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring">
                  {TRIGGER_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
              <TriggerSubOptions triggerType={triggerType} config={triggerConfig} onChange={setTriggerConfig} />
            </div>
          </div>

          {/* Steps */}
          <div className="rounded-lg border bg-card p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold">Steps</h3>
              <Button type="button" variant="outline" size="sm" onClick={addStep}>
                <Plus className="size-3 mr-1" /> Add Step
              </Button>
            </div>

            <div className="space-y-3">
              {steps.map((step, idx) => {
                const StepIcon = STEP_TYPES.find(t => t.value === step.stepType)?.icon || Mail
                return (
                  <div key={idx} className="rounded-lg border p-4">
                    <div className="flex items-center gap-3 mb-3">
                      <div className="flex items-center justify-center size-7 rounded-full bg-muted text-xs font-semibold">
                        {idx + 1}
                      </div>
                      <select value={step.stepType} onChange={e => updateStep(idx, { stepType: e.target.value })}
                        className="h-8 rounded-md border bg-card px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring">
                        {STEP_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                      <div className="flex-1" />
                      {step.stepType === 'email' && (
                        <Button type="button" variant="outline" size="sm" onClick={() => setAiDraftIdx(aiDraftIdx === idx ? null : idx)} disabled={aiStepDrafting} className="h-7 text-[10px] px-2">
                          {aiStepDrafting && aiDraftIdx === idx ? <Loader2 className="size-3 animate-spin mr-1" /> : <Sparkles className="size-3 mr-1" />} AI Draft
                        </Button>
                      )}
                      {steps.length > 1 && (
                        <IconButton type="button" variant="ghost" size="sm" onClick={() => removeStep(idx)} aria-label="Remove step">
                          <X className="size-3.5 text-muted-foreground" />
                        </IconButton>
                      )}
                    </div>

                    {/* AI Draft prompt */}
                    {aiDraftIdx === idx && step.stepType === 'email' && (
                      <div className="rounded-md border bg-muted/30 p-3 ml-10 mb-2 space-y-2">
                        <p className="text-[11px] text-muted-foreground">Describe what this email should say (optional):</p>
                        <textarea value={aiStepPrompt} onChange={e => setAiStepPrompt(e.target.value)}
                          placeholder="e.g. Follow up on our initial conversation, ask if they have any questions"
                          className="w-full rounded-md border bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring h-16" autoFocus />
                        <div className="flex gap-2">
                          <Button type="button" size="sm" onClick={() => aiDraftStep(idx)} disabled={aiStepDrafting} className="h-7 text-xs">
                            {aiStepDrafting ? <><Loader2 className="size-3 animate-spin mr-1" /> Generating...</> : <><Sparkles className="size-3 mr-1" /> Generate</>}
                          </Button>
                          <Button type="button" variant="outline" size="sm" onClick={() => { setAiDraftIdx(null); setAiStepPrompt('') }} className="h-7 text-xs">Cancel</Button>
                        </div>
                      </div>
                    )}

                    {/* Email config */}
                    {step.stepType === 'email' && (
                      <div className="grid gap-2 pl-10">
                        <Input value={step.config.subject || ''} onChange={e => updateStep(idx, { config: { ...step.config, subject: e.target.value } })}
                          placeholder="Subject line" className="h-8 text-sm" />
                        <textarea value={step.config.bodyHtml || ''} onChange={e => updateStep(idx, { config: { ...step.config, bodyHtml: e.target.value } })}
                          placeholder="Email body... Use {{firstName}} for personalization."
                          className="w-full rounded-md border bg-card px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring h-24" />
                        <p className="text-[10px] text-muted-foreground">Variables: {'{{firstName}}'}, {'{{name}}'}, {'{{email}}'}</p>
                      </div>
                    )}

                    {/* Wait config */}
                    {step.stepType === 'wait' && (
                      <div className="flex items-center gap-2 pl-10">
                        <span className="text-sm text-muted-foreground">Wait</span>
                        <Input type="number" min="1" value={step.config.delay || 1}
                          onChange={e => updateStep(idx, { config: { ...step.config, delay: parseInt(e.target.value) || 1 } })}
                          className="h-8 text-sm w-20" />
                        <select value={step.config.unit || 'days'}
                          onChange={e => updateStep(idx, { config: { ...step.config, unit: e.target.value } })}
                          className="h-8 rounded-md border bg-card px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring">
                          <option value="hours">hours</option>
                          <option value="days">days</option>
                        </select>
                      </div>
                    )}

                    {/* Condition config */}
                    {step.stepType === 'condition' && (
                      <div className="flex items-center gap-2 pl-10 flex-wrap">
                        <span className="text-sm text-muted-foreground">If contact</span>
                        <select value={step.config.operator || 'has'}
                          onChange={e => updateStep(idx, { config: { ...step.config, operator: e.target.value } })}
                          className="h-8 rounded-md border bg-card px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring">
                          <option value="has">has tag</option>
                          <option value="not_has">does not have tag</option>
                        </select>
                        <Input value={step.config.value || ''} onChange={e => updateStep(idx, { config: { ...step.config, value: e.target.value } })}
                          placeholder="tag name" className="h-8 text-sm w-40" />
                        <span className="text-[10px] text-muted-foreground">Contacts without this tag will be skipped to the next step.</span>
                      </div>
                    )}

                    {/* SMS config */}
                    {step.stepType === 'sms' && (
                      <div className="grid gap-2 pl-10">
                        <textarea value={step.config.message || ''} onChange={e => updateStep(idx, { config: { ...step.config, message: e.target.value } })}
                          placeholder="SMS message..."
                          className="w-full rounded-md border bg-card px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring h-16" />
                        <p className="text-[10px] text-muted-foreground">{(step.config.message || '').length}/160 characters</p>
                      </div>
                    )}

                    {/* Branch config */}
                    {step.stepType === 'branch' && (
                      <div className="grid gap-2 pl-10">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm text-muted-foreground">If contact</span>
                          <select value={step.branchConfig?.condition?.field || 'tag'}
                            onChange={e => updateStep(idx, { branchConfig: { ...step.branchConfig, condition: { ...step.branchConfig?.condition, field: e.target.value } } })}
                            className="h-8 rounded-md border bg-card px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring">
                            <option value="tag">has tag</option>
                            <option value="opened_previous">opened previous email</option>
                            <option value="clicked_previous">clicked previous email</option>
                          </select>
                          {step.branchConfig?.condition?.field === 'tag' && (
                            <>
                              <select value={step.branchConfig?.condition?.operator || 'has'}
                                onChange={e => updateStep(idx, { branchConfig: { ...step.branchConfig, condition: { ...step.branchConfig?.condition, operator: e.target.value } } })}
                                className="h-8 rounded-md border bg-card px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring">
                                <option value="has">has</option>
                                <option value="not_has">does not have</option>
                              </select>
                              <Input value={step.branchConfig?.condition?.value || ''}
                                onChange={e => updateStep(idx, { branchConfig: { ...step.branchConfig, condition: { ...step.branchConfig?.condition, value: e.target.value } } })}
                                placeholder="tag name" className="h-8 text-sm w-40" />
                            </>
                          )}
                        </div>
                        <div className="flex items-center gap-3 flex-wrap">
                          <span className="text-sm text-muted-foreground">If yes, go to step #</span>
                          <Input type="number" min="1" value={step.branchConfig?.trueStepOrder || ''}
                            onChange={e => updateStep(idx, { branchConfig: { ...step.branchConfig, trueStepOrder: parseInt(e.target.value) || null } })}
                            className="h-8 text-sm w-20" />
                          <span className="text-sm text-muted-foreground">If no, go to step #</span>
                          <Input type="number" min="1" value={step.branchConfig?.falseStepOrder || ''}
                            onChange={e => updateStep(idx, { branchConfig: { ...step.branchConfig, falseStepOrder: parseInt(e.target.value) || null } })}
                            className="h-8 text-sm w-20" />
                        </div>
                      </div>
                    )}

                    {/* Goal config */}
                    {step.stepType === 'goal' && (
                      <div className="grid gap-2 pl-10">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm text-muted-foreground">End sequence when</span>
                          <select value={step.goalConfig?.type || 'tag_added'}
                            onChange={e => updateStep(idx, { goalConfig: { ...step.goalConfig, type: e.target.value } })}
                            className="h-8 rounded-md border bg-card px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring">
                            <option value="tag_added">Tag added</option>
                            <option value="deal_won">Deal won</option>
                            <option value="invoice_paid">Invoice paid</option>
                          </select>
                          {step.goalConfig?.type === 'tag_added' && (
                            <Input value={step.goalConfig?.value || ''}
                              onChange={e => updateStep(idx, { goalConfig: { ...step.goalConfig, value: e.target.value } })}
                              placeholder="tag name" className="h-8 text-sm w-40" />
                          )}
                        </div>
                        <p className="text-[10px] text-muted-foreground">Sequence will end automatically when this goal is met for the enrolled contact.</p>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setView('list')}>Cancel</Button>
            <Button type="button" onClick={createSequence} disabled={saving || !name.trim() || steps.length === 0}>
              {saving ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : <GitBranch className="size-3.5 mr-1.5" />}
              {selectedId ? 'Save Changes' : 'Create Sequence'}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // ── DETAIL VIEW ──
  if (view === 'detail' && selectedSequence) {
    const seq = selectedSequence
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <Button type="button" variant="ghost" size="sm" onClick={() => { setView('list'); setSelectedId(null); setSelectedSequence(null) }}>
            <ChevronRight className="size-3.5 rotate-180" />
          </Button>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold">{seq.name}</h1>
              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${statusColors[seq.status] || ''}`}>
                {seq.status}
              </span>
            </div>
            {seq.description && <p className="text-xs text-muted-foreground mt-0.5">{seq.description}</p>}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={async () => {
              // Auto-pause active sequences before editing
              if (seq.status === 'active') {
                await updateStatus(seq.id, 'paused')
              }
              // Load sequence into edit form
              setName(seq.name)
              setDescription(seq.description || '')
              setTriggerType(seq.trigger_type || 'manual')
              setTriggerConfig(typeof seq.trigger_config === 'string' ? JSON.parse(seq.trigger_config) : (seq.trigger_config || {}))
              const seqSteps = seq.steps || []
              setSteps(seqSteps.map((s: any) => ({
                stepOrder: s.step_order || s.stepOrder || 1,
                stepType: s.step_type || s.stepType || 'email',
                config: typeof s.config === 'string' ? JSON.parse(s.config) : (s.config || {}),
              })))
              setSelectedId(seq.id)
              setView('create')
            }}>
              <Pencil className="size-3 mr-1" /> Edit
            </Button>
            {seq.status === 'draft' && (
              <Button type="button" size="sm" onClick={() => updateStatus(seq.id, 'active')}>
                <Play className="size-3 mr-1" /> Activate
              </Button>
            )}
            <Button type="button" variant="outline" size="sm" onClick={() => { setShowEnroll(true) }}>
              <UserPlus className="size-3 mr-1" /> Enroll Contact
            </Button>
            {seq.status === 'active' && (
              <>
                <Button type="button" variant="outline" size="sm" onClick={() => updateStatus(seq.id, 'paused')}>
                  <Pause className="size-3 mr-1" /> Pause
                </Button>
              </>
            )}
            {seq.status === 'paused' && (
              <Button type="button" size="sm" onClick={() => updateStatus(seq.id, 'active')}>
                <Play className="size-3 mr-1" /> Resume
              </Button>
            )}
          </div>
        </div>

        {/* Trigger */}
        <div className="rounded-lg border bg-card p-4 mb-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wider font-medium mb-1">Trigger</p>
          <p className="text-sm font-medium">{TRIGGER_TYPES.find(t => t.value === seq.trigger_type)?.label || seq.trigger_type}</p>
          {seq.trigger_config && Object.keys(seq.trigger_config).length > 0 && (
            <p className="text-xs text-muted-foreground mt-0.5">
              {Object.entries(seq.trigger_config).map(([k, v]) => `${k}: ${v}`).join(', ')}
            </p>
          )}
        </div>

        {/* Steps */}
        <div className="rounded-lg border bg-card p-4 mb-6">
          <p className="text-xs text-muted-foreground uppercase tracking-wider font-medium mb-3">
            Steps ({seq.steps?.length || 0})
          </p>
          <div className="space-y-2">
            {(seq.steps || []).map((step: any, idx: number) => {
              const StepIcon = STEP_TYPES.find(t => t.value === step.step_type)?.icon || Mail
              const config = typeof step.config === 'string' ? JSON.parse(step.config) : step.config
              return (
                <div key={step.id || idx} className="flex items-start gap-3 py-2">
                  <div className="flex items-center justify-center size-6 rounded-full bg-muted text-[10px] font-semibold shrink-0 mt-0.5">
                    {idx + 1}
                  </div>
                  <StepIcon className="size-4 text-muted-foreground shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {step.step_type === 'email' && `Email: ${config.subject || '(no subject)'}`}
                      {step.step_type === 'wait' && `Wait ${config.delay} ${config.unit}`}
                      {step.step_type === 'condition' && `If contact ${config.operator === 'has' ? 'has' : 'does not have'} tag "${config.value}"`}
                      {step.step_type === 'sms' && `SMS: ${(config.message || '').substring(0, 60)}${(config.message || '').length > 60 ? '...' : ''}`}
                      {step.step_type === 'branch' && (() => {
                        const bc = step.branch_config ? (typeof step.branch_config === 'string' ? JSON.parse(step.branch_config) : step.branch_config) : {}
                        const cond = bc.condition || {}
                        const fieldLabel = cond.field === 'tag' ? `${cond.operator === 'not_has' ? 'does not have' : 'has'} tag "${cond.value}"` : cond.field === 'opened_previous' ? 'opened previous email' : cond.field === 'clicked_previous' ? 'clicked previous email' : cond.field
                        return `Branch: If ${fieldLabel} → step ${bc.trueStepOrder || '?'}, else → step ${bc.falseStepOrder || '?'}`
                      })()}
                      {step.step_type === 'goal' && (() => {
                        const gc = step.goal_config ? (typeof step.goal_config === 'string' ? JSON.parse(step.goal_config) : step.goal_config) : {}
                        const typeLabel = gc.type === 'tag_added' ? `tag "${gc.value}" added` : gc.type === 'deal_won' ? 'deal won' : gc.type === 'invoice_paid' ? 'invoice paid' : gc.type
                        return `Goal: End when ${typeLabel}`
                      })()}
                    </p>
                    {step.step_type === 'email' && config.bodyHtml && (
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                        {config.bodyHtml.replace(/<[^>]+>/g, '').substring(0, 100)}
                      </p>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Enroll Modal */}
        {showEnroll && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setShowEnroll(false)}>
            <div className="bg-card rounded-lg border shadow-lg p-5 w-[420px]" onClick={e => e.stopPropagation()}>
              <h3 className="text-sm font-semibold mb-1">Enroll Contacts</h3>
              <p className="text-xs text-muted-foreground mb-3">Select one or more contacts to enroll in this sequence.</p>
              <Input
                value={enrollSearch}
                onChange={e => setEnrollSearch(e.target.value)}
                onFocus={() => {
                  if (!enrollContactListLoaded) {
                    setEnrollContactListLoaded(true)
                    setEnrollContactListLoading(true)
                    fetch('/api/email/contacts?limit=200', { credentials: 'include' })
                      .then(r => r.json())
                      .then(d => { if (d.ok) setEnrollContactList(d.data || []) })
                      .catch(() => {})
                      .finally(() => setEnrollContactListLoading(false))
                  }
                }}
                placeholder="Search by name or email..."
                className="h-9 text-sm mb-2"
                autoFocus
              />
              {enrollSelectedIds.size > 0 && (
                <p className="text-xs text-emerald-600 font-medium mb-2">{enrollSelectedIds.size} contact{enrollSelectedIds.size > 1 ? 's' : ''} selected</p>
              )}
              <div className="max-h-56 overflow-y-auto rounded border mb-3">
                {enrollContactListLoading ? (
                  <div className="p-3 text-center text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin inline mr-1" /> Loading contacts...</div>
                ) : enrollContactList.length === 0 ? (
                  <div className="p-3 text-center text-xs text-muted-foreground">No contacts found</div>
                ) : (
                  enrollContactList
                    .filter(c => {
                      if (!enrollSearch) return true
                      const q = enrollSearch.toLowerCase()
                      return (c.display_name || '').toLowerCase().includes(q) || (c.primary_email || '').toLowerCase().includes(q)
                    })
                    .map(c => {
                      const isSelected = enrollSelectedIds.has(c.id)
                      return (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => {
                            setEnrollSelectedIds(prev => {
                              const next = new Set(prev)
                              if (next.has(c.id)) next.delete(c.id)
                              else next.add(c.id)
                              return next
                            })
                          }}
                          className={`w-full text-left px-3 py-2 text-sm hover:bg-muted/50 border-b last:border-b-0 transition flex items-center gap-2 ${isSelected ? 'bg-muted' : ''}`}
                        >
                          <div className={`size-4 rounded border flex items-center justify-center shrink-0 ${isSelected ? 'bg-foreground border-foreground' : 'border-muted-foreground/30'}`}>
                            {isSelected && <svg className="size-3 text-background" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>}
                          </div>
                          <div className="min-w-0">
                            <p className="font-medium text-xs truncate">{c.display_name || 'Unnamed'}</p>
                            {c.primary_email && <p className="text-[11px] text-muted-foreground truncate">{c.primary_email}</p>}
                          </div>
                        </button>
                      )
                    })
                )}
              </div>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => { setShowEnroll(false); setEnrollSearch(''); setEnrollSelectedIds(new Set()) }}>Cancel</Button>
                <Button type="button" size="sm" onClick={enrollContacts} disabled={enrolling || enrollSelectedIds.size === 0}>
                  {enrolling ? <Loader2 className="size-3 animate-spin mr-1" /> : <UserPlus className="size-3 mr-1" />}
                  Enroll {enrollSelectedIds.size > 0 ? `(${enrollSelectedIds.size})` : ''}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Enrollments */}
        <div className="rounded-lg border bg-card">
          <div className="flex items-center justify-between px-4 py-3 border-b">
            <p className="text-xs text-muted-foreground uppercase tracking-wider font-medium">
              <Users className="size-3.5 inline mr-1" /> Enrollments ({enrollments.length})
            </p>
          </div>
          {enrollments.length === 0 ? (
            <div className="p-8 text-center">
              <p className="text-sm text-muted-foreground">No contacts enrolled yet.</p>
            </div>
          ) : (
            <div className="divide-y">
              {enrollments.map(enr => (
                <div key={enr.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{enr.display_name || 'Unknown'}</p>
                    <p className="text-xs text-muted-foreground">{enr.primary_email || ''}</p>
                  </div>
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${statusColors[enr.status] || 'bg-muted text-muted-foreground'}`}>
                    {enr.status}
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    Step {enr.current_step_order}
                  </span>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {new Date(enr.enrolled_at).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  return <div className="p-6 text-sm text-muted-foreground">Loading...</div>
}
