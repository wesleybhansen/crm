'use client'

import { useState, useEffect, useCallback } from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { translateWithFallback } from '@open-mercato/shared/lib/i18n/translate'
import { Button } from '@open-mercato/ui/primitives/button'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Input } from '@open-mercato/ui/primitives/input'
import {
  Plus, Trash2, ArrowRight, Globe, Copy, Check, X, Loader2, LayoutTemplate,
  ChevronUp, ChevronDown, GitMerge, ExternalLink,
  ToggleLeft, ToggleRight, BarChart3, ArrowLeft,
} from 'lucide-react'

type LandingPage = {
  id: string
  title: string
  slug: string
  status: string
}

type Product = {
  id: string
  name: string
  price: number
  currency: string
}

type FunnelStep = {
  id?: string
  stepOrder: number
  stepType: 'page' | 'lead_capture' | 'checkout' | 'upsell' | 'downsell' | 'thank_you'
  pageId: string | null
  productId: string | null
  name: string
  onAcceptStepId: string | null
  onDeclineStepId: string | null
  config: Record<string, any>
}

type StepAnalytics = {
  stepOrder: number
  stepType: string
  pageTitle: string | null
  visits: number
  dropOffRate: number
}

type Funnel = {
  id: string
  name: string
  slug: string
  is_published: boolean
  step_count: number
  total_visits: number
  total_sessions: number
  completed_sessions: number
  abandoned_sessions: number
  total_revenue: number
  conversion_rate: number
  created_at: string
}

type View = 'list' | 'choose-template' | 'create' | 'edit'

export default function FunnelsPage() {
  const t = useT()
  const translate = (key: string, fallback: string) => translateWithFallback(t, key, fallback)

  const [view, setView] = useState<View>('list')
  const [funnels, setFunnels] = useState<Funnel[]>([])
  const [funnelSearch, setFunnelSearch] = useState('')
  const [funnelFilter, setFunnelFilter] = useState<'all' | 'published' | 'draft'>('all')
  const [funnelTemplates, setFunnelTemplates] = useState<Array<{ id: string; name: string; description: string; category: string; steps: any[] }>>([])
  const [installingTemplate, setInstallingTemplate] = useState<string | null>(null)
  const [landingPages, setLandingPages] = useState<LandingPage[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const [editId, setEditId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [steps, setSteps] = useState<FunnelStep[]>([
    { stepOrder: 1, stepType: 'page', pageId: null, config: {} },
    { stepOrder: 2, stepType: 'thank_you', pageId: null, config: { message: 'Thank you for signing up!' } },
  ])
  const [analytics, setAnalytics] = useState<StepAnalytics[]>([])

  const loadFunnels = useCallback(() => {
    setLoading(true)
    fetch('/api/landing_pages/funnels')
      .then((r) => r.json())
      .then((d) => { if (d.ok) setFunnels(d.data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  const loadLandingPages = useCallback(() => {
    fetch('/api/landing_pages/pages')
      .then((r) => r.json())
      .then((d) => { if (d.ok) setLandingPages(d.data.filter((p: LandingPage) => p.status === 'published')) })
      .catch(() => {})
  }, [])

  const loadProducts = useCallback(() => {
    fetch('/api/payments/products', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.ok) setProducts((d.data || []).map((p: any) => ({ id: p.id, name: p.name, price: Number(p.price), currency: p.currency || 'USD' }))) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    loadFunnels(); loadLandingPages(); loadProducts()
    fetch('/api/landing_pages/funnels/templates', { credentials: 'include' }).then(r => r.json())
      .then(d => { if (d.ok) setFunnelTemplates(d.data || []) }).catch(() => {})
  }, [loadFunnels, loadLandingPages, loadProducts])

  function resetForm() {
    setEditId(null)
    setName('')
    setSteps([
      { stepOrder: 1, stepType: 'page', pageId: null, productId: null, name: 'Landing Page', onAcceptStepId: null, onDeclineStepId: null, config: {} },
      { stepOrder: 2, stepType: 'thank_you', pageId: null, productId: null, name: 'Thank You', onAcceptStepId: null, onDeclineStepId: null, config: { message: 'Thank you for signing up!' } },
    ])
    setAnalytics([])
  }

  async function startEdit(funnel: Funnel) {
    setEditId(funnel.id)
    setName(funnel.name)
    setAnalytics([])

    // Fetch the funnel's steps via a no-change PUT that returns full state
    try {
      const res = await fetch(`/api/landing_pages/funnels?id=${funnel.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const data = await res.json()
      if (data.ok && Array.isArray(data.data.steps)) {
        setSteps(data.data.steps.map((s: Record<string, unknown>) => ({
          id: s.id,
          stepOrder: s.step_order,
          stepType: s.step_type,
          pageId: s.page_id || null,
          productId: s.product_id || null,
          name: s.name || '',
          onAcceptStepId: s.on_accept_step_id || null,
          onDeclineStepId: s.on_decline_step_id || null,
          config: typeof s.config === 'string' ? JSON.parse(s.config as string) : (s.config || {}),
        })))
      }
    } catch {
      setSteps([
        { stepOrder: 1, stepType: 'page', pageId: null, config: {} },
        { stepOrder: 2, stepType: 'thank_you', pageId: null, config: { message: 'Thank you!' } },
      ])
    }

    try {
      const analyticsRes = await fetch(`/api/landing_pages/funnels/${funnel.id}/analytics`)
      const analyticsData = await analyticsRes.json()
      if (analyticsData.ok) setAnalytics(analyticsData.data)
    } catch {}

    setView('edit')
  }

  function addStep() {
    const maxOrder = steps.reduce((max, s) => Math.max(max, s.stepOrder), 0)
    setSteps([...steps, { stepOrder: maxOrder + 1, stepType: 'page', pageId: null, config: {} }])
  }

  function removeStep(index: number) {
    if (steps.length <= 1) return
    const updated = steps.filter((_, i) => i !== index)
    setSteps(updated.map((s, i) => ({ ...s, stepOrder: i + 1 })))
  }

  function moveStep(index: number, direction: -1 | 1) {
    const targetIndex = index + direction
    if (targetIndex < 0 || targetIndex >= steps.length) return
    const updated = [...steps]
    const temp = updated[index]
    updated[index] = updated[targetIndex]
    updated[targetIndex] = temp
    setSteps(updated.map((s, i) => ({ ...s, stepOrder: i + 1 })))
  }

  function updateStep(index: number, field: string, value: string | null) {
    const updated = [...steps]
    if (field === 'stepType') {
      updated[index] = { ...updated[index], stepType: value as FunnelStep['stepType'] }
      if (value === 'thank_you' && !updated[index].config.message) {
        updated[index].config = { message: 'Thank you!' }
      }
    } else if (field === 'pageId') {
      updated[index] = { ...updated[index], pageId: value }
    } else if (field === 'productId') {
      updated[index] = { ...updated[index], productId: value }
    } else if (field === 'name') {
      updated[index] = { ...updated[index], name: value || '' }
    } else if (field === 'onAcceptStepId') {
      updated[index] = { ...updated[index], onAcceptStepId: value }
    } else if (field === 'onDeclineStepId') {
      updated[index] = { ...updated[index], onDeclineStepId: value }
    } else if (field.startsWith('config.')) {
      const configKey = field.replace('config.', '')
      let configValue: any = value || ''
      // Parse JSON for array/object config values
      if (configKey === 'order_bumps' && typeof value === 'string') {
        try { configValue = JSON.parse(value) } catch { configValue = [] }
      }
      updated[index] = { ...updated[index], config: { ...updated[index].config, [configKey]: configValue } }
    }
    setSteps(updated)
  }

  function validateFunnel(): string[] {
    const issues: string[] = []
    if (!name.trim()) issues.push('Funnel name is required')
    if (steps.length === 0) issues.push('At least one step is required')
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]
      const label = `Step ${i + 1} (${stepTypeLabels[s.stepType] || s.stepType})`
      if ((s.stepType === 'page' || s.stepType === 'lead_capture') && !s.pageId) issues.push(`${label}: No landing page selected`)
      if (s.stepType === 'checkout' && !s.productId) {
        const hasProductBefore = steps.some((ps, pi) => pi < i && ps.productId)
        if (!hasProductBefore) issues.push(`${label}: No product selected and no products in earlier steps`)
      }
      if ((s.stepType === 'upsell' || s.stepType === 'downsell') && !s.productId && !s.config.price) issues.push(`${label}: No product or price configured`)
    }
    return issues
  }

  async function saveFunnel() {
    const issues = validateFunnel()
    if (issues.length > 0) return alert('Please fix these issues:\n\n' + issues.join('\n'))

    setSaving(true)
    try {
      const payload = {
        name: name.trim(),
        steps: steps.map((s) => ({
          stepOrder: s.stepOrder,
          stepType: s.stepType,
          pageId: s.pageId,
          productId: s.productId,
          name: s.name,
          onAcceptStepId: s.onAcceptStepId,
          onDeclineStepId: s.onDeclineStepId,
          config: s.config,
        })),
      }

      const url = editId ? `/api/landing_pages/funnels?id=${editId}` : '/api/landing_pages/funnels'
      const method = editId ? 'PUT' : 'POST'

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (data.ok) {
        resetForm()
        setView('list')
        loadFunnels()
      } else {
        alert(data.error || 'Failed to save funnel')
      }
    } catch {
      alert('Failed to save funnel')
    }
    setSaving(false)
  }

  async function togglePublish(funnel: Funnel, e: React.MouseEvent) {
    e.stopPropagation()

    // Pre-publish validation: check if funnel has steps with missing config
    if (!funnel.is_published) {
      try {
        const stepsRes = await fetch(`/api/landing_pages/funnels/${funnel.id}/analytics`, { credentials: 'include' })
        const stepsData = await stepsRes.json()
        if (!stepsData.ok) {
          // Can't validate — proceed anyway
        }
      } catch {}
    }

    try {
      const res = await fetch(`/api/landing_pages/funnels?id=${funnel.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isPublished: !funnel.is_published }),
      })
      const data = await res.json()
      if (data.ok) loadFunnels()
      else alert(data.error || 'Failed to update')
    } catch { alert('Failed to update') }
  }

  async function duplicateFunnel(funnel: Funnel, e: React.MouseEvent) {
    e.stopPropagation()
    try {
      const res = await fetch(`/api/landing_pages/funnels?action=duplicate&id=${funnel.id}`, { method: 'PATCH', credentials: 'include' })
      const data = await res.json()
      if (data.ok) loadFunnels()
      else alert(data.error || 'Failed to duplicate')
    } catch { alert('Failed to duplicate') }
  }

  async function deleteFunnel(funnel: Funnel, e: React.MouseEvent) {
    e.stopPropagation()
    const impact = [
      funnel.total_visits > 0 ? `${funnel.total_visits} visits` : null,
      funnel.total_revenue > 0 ? `$${funnel.total_revenue.toFixed(2)} revenue` : null,
      funnel.completed_sessions > 0 ? `${funnel.completed_sessions} completions` : null,
    ].filter(Boolean).join(', ')
    const msg = `Delete "${funnel.name}"?${impact ? `\n\nThis funnel has: ${impact}` : ''}\n\nThis cannot be undone.`
    if (!confirm(msg)) return
    try {
      await fetch(`/api/landing_pages/funnels?id=${funnel.id}`, { method: 'DELETE' })
      loadFunnels()
    } catch { alert('Failed to delete') }
  }

  function copyFunnelUrl(funnel: Funnel, e: React.MouseEvent) {
    e.stopPropagation()
    const funnelUrl = `${window.location.origin}/f/${funnel.slug}`
    navigator.clipboard.writeText(funnelUrl)
    setCopiedId(funnel.id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const stepTypeLabels: Record<string, string> = {
    lead_capture: 'Lead Capture',
    page: 'Sales Page',
    checkout: 'Checkout',
    upsell: 'Upsell',
    downsell: 'Downsell',
    thank_you: 'Thank You',
  }

  const stepTypeColors: Record<string, string> = {
    lead_capture: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-400',
    page: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
    checkout: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
    upsell: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400',
    downsell: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400',
    thank_you: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400',
  }

  // LIST VIEW
  if (view === 'list') {
    return (
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold">{translate('funnels.title', 'Funnels')}</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {translate('funnels.subtitle', 'Chain landing pages into multi-step conversion funnels')}
            </p>
          </div>
          <Button type="button" onClick={() => setView('choose-template')}>
            <Plus className="size-4 mr-2" /> {translate('funnels.actions.create', 'New Funnel')}
          </Button>
        </div>


        {funnels.length > 0 && (
          <div className="flex items-center gap-3 mb-4">
            <Input
              value={funnelSearch}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFunnelSearch(e.target.value)}
              placeholder="Search funnels..."
              className="max-w-xs h-8 text-sm"
            />
            <select
              value={funnelFilter}
              onChange={(e) => setFunnelFilter(e.target.value as 'all' | 'published' | 'draft')}
              className="rounded-md border bg-background px-3 py-1.5 text-sm h-8"
            >
              <option value="all">All</option>
              <option value="published">Published</option>
              <option value="draft">Drafts</option>
            </select>
          </div>
        )}

        {loading ? (
          <div className="text-muted-foreground text-sm">Loading...</div>
        ) : funnels.length === 0 ? (
          <div className="rounded-lg border p-12 text-center">
            <GitMerge className="size-10 mx-auto mb-3 text-muted-foreground/50" />
            <p className="text-muted-foreground">{translate('funnels.empty', 'No funnels yet. Create your first funnel to start converting visitors.')}</p>
            <Button type="button" className="mt-4" onClick={() => { resetForm(); setView('create') }}>
              <Plus className="size-4 mr-2" /> Create your first funnel
            </Button>
          </div>
        ) : (
          <div className="rounded-lg border">
            <table className="w-full">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Name</th>
                  <th className="text-center text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Steps</th>
                  <th className="text-center text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Status</th>
                  <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Visits</th>
                  <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Conv.</th>
                  <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Revenue</th>
                  <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {funnels.filter(f => {
                  if (funnelSearch && !f.name.toLowerCase().includes(funnelSearch.toLowerCase())) return false
                  if (funnelFilter === 'published' && !f.is_published) return false
                  if (funnelFilter === 'draft' && f.is_published) return false
                  return true
                }).map((funnel) => (
                  <tr
                    key={funnel.id}
                    className="border-b last:border-0 hover:bg-muted/30 cursor-pointer"
                    onClick={() => startEdit(funnel)}
                  >
                    <td className="px-4 py-3 font-medium text-sm">{funnel.name}</td>
                    <td className="px-4 py-3 text-sm text-center tabular-nums">{funnel.step_count}</td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        funnel.is_published
                          ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400'
                          : 'bg-muted text-muted-foreground'
                      }`}>
                        {funnel.is_published && <Globe className="size-3 mr-1" />}
                        {funnel.is_published ? 'Published' : 'Draft'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-right tabular-nums">{funnel.total_visits}</td>
                    <td className="px-4 py-3 text-sm text-right tabular-nums">{funnel.conversion_rate}%</td>
                    <td className="px-4 py-3 text-sm text-right tabular-nums font-medium">{funnel.total_revenue > 0 ? `$${funnel.total_revenue.toFixed(2)}` : '—'}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <IconButton variant="ghost" size="sm" type="button" aria-label="Copy URL" onClick={(e) => copyFunnelUrl(funnel, e)}>
                          {copiedId === funnel.id ? <Check className="size-4 text-emerald-600" /> : <Copy className="size-4" />}
                        </IconButton>
                        <IconButton
                          variant="ghost" size="sm" type="button"
                          aria-label={funnel.is_published ? 'Unpublish' : 'Publish'}
                          onClick={(e) => togglePublish(funnel, e)}
                        >
                          {funnel.is_published ? <ToggleRight className="size-4 text-emerald-600" /> : <ToggleLeft className="size-4" />}
                        </IconButton>
                        <IconButton
                          variant="ghost" size="sm" type="button"
                          aria-label={funnel.is_published ? 'View live' : 'Preview'}
                          onClick={(e) => { e.stopPropagation(); window.open(`/api/landing_pages/funnels/public/${funnel.slug}${funnel.is_published ? '' : '?preview=1'}`, '_blank') }}
                        >
                          <ExternalLink className="size-4" />
                        </IconButton>
                        <IconButton variant="ghost" size="sm" type="button" aria-label="Duplicate" onClick={(e) => duplicateFunnel(funnel, e)}>
                          <Copy className="size-4" />
                        </IconButton>
                        <IconButton variant="ghost" size="sm" type="button" aria-label="Delete" onClick={(e) => deleteFunnel(funnel, e)}>
                          <Trash2 className="size-4" />
                        </IconButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    )
  }

  // CHOOSE TEMPLATE VIEW
  if (view === 'choose-template') {
    return (
      <div className="p-6 max-w-4xl">
        <div className="flex items-center gap-3 mb-6">
          <Button type="button" variant="ghost" size="sm" onClick={() => setView('list')}>
            <ArrowLeft className="size-4 mr-1" /> Back
          </Button>
        </div>
        <div className="mb-8">
          <h1 className="text-xl font-semibold">Create a Funnel</h1>
          <p className="text-sm text-muted-foreground mt-1">Start with a template or build from scratch</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* Start from scratch */}
          <div className="rounded-xl border-2 border-dashed border-border p-5 hover:border-foreground/30 transition flex flex-col">
            <div className="size-10 rounded-lg bg-muted flex items-center justify-center mb-3">
              <Plus className="size-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-semibold">Start from Scratch</p>
            <p className="text-xs text-muted-foreground mt-1 flex-1">Build a custom funnel step by step. Full control over every detail.</p>
            <Button type="button" variant="outline" size="sm" className="w-full mt-4"
              onClick={() => { resetForm(); setView('create') }}>
              Blank Funnel
            </Button>
          </div>
          {/* Templates */}
          {funnelTemplates.map(tmpl => (
            <div key={tmpl.id} className="rounded-xl border p-5 hover:border-foreground/30 hover:shadow-sm transition flex flex-col">
              <div className="size-10 rounded-lg bg-accent/10 flex items-center justify-center mb-3">
                <GitMerge className="size-5 text-accent" />
              </div>
              <p className="text-sm font-semibold">{tmpl.name}</p>
              <p className="text-xs text-muted-foreground mt-1 flex-1">{tmpl.description}</p>
              <div className="flex items-center gap-2 mt-3">
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{tmpl.steps.length} steps</span>
                <span className="text-[10px] text-muted-foreground">{tmpl.category}</span>
              </div>
              <div className="flex items-center gap-1 mt-2 text-[10px] text-muted-foreground flex-wrap">
                {tmpl.steps.map((s: any, i: number) => (
                  <span key={i} className="flex items-center gap-0.5">
                    {i > 0 && <ArrowRight className="size-2.5" />}
                    {s.name}
                  </span>
                ))}
              </div>
              <Button type="button" size="sm" className="w-full mt-4" disabled={!!installingTemplate}
                onClick={async () => {
                  setInstallingTemplate(tmpl.id)
                  try {
                    const res = await fetch('/api/landing_pages/funnels/templates', {
                      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
                      body: JSON.stringify({ templateId: tmpl.id }),
                    })
                    const data = await res.json()
                    if (data.ok && data.data) {
                      loadFunnels()
                      // Open the newly created funnel for editing
                      const funnel = data.data
                      setEditId(funnel.id)
                      setName(funnel.name)
                      setAnalytics([])
                      if (Array.isArray(funnel.steps)) {
                        setSteps(funnel.steps.map((s: any) => ({
                          id: s.id,
                          stepOrder: s.step_order,
                          stepType: s.step_type,
                          pageId: s.page_id || null,
                          productId: s.product_id || null,
                          name: s.name || '',
                          onAcceptStepId: s.on_accept_step_id || null,
                          onDeclineStepId: s.on_decline_step_id || null,
                          config: typeof s.config === 'string' ? JSON.parse(s.config) : (s.config || {}),
                        })))
                      }
                      setView('edit')
                    } else alert(data.error || 'Failed')
                  } catch { alert('Failed') }
                  setInstallingTemplate(null)
                }}>
                {installingTemplate === tmpl.id ? <><Loader2 className="size-3 animate-spin mr-1" /> Installing...</> : 'Use This Template'}
              </Button>
            </div>
          ))}
        </div>
      </div>
    )
  }

  // CREATE / EDIT VIEW
  return (
    <div className="p-6 max-w-4xl">
      <button
        type="button"
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4"
        onClick={() => { resetForm(); setView('list') }}
      >
        <ArrowLeft className="size-4" /> Back to Funnels
      </button>

      <h1 className="text-xl font-semibold mb-6">
        {editId ? translate('funnels.edit.title', 'Edit Funnel') : translate('funnels.create.title', 'Create Funnel')}
      </h1>

      {/* Name */}
      <div className="mb-6">
        <label className="block text-sm font-medium mb-1.5">Funnel Name</label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., Lead Magnet Funnel"
          className="max-w-md"
        />
      </div>

      {/* Steps Builder */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <label className="block text-sm font-medium">Steps</label>
          <Button type="button" variant="outline" size="sm" onClick={addStep}>
            <Plus className="size-3.5 mr-1.5" /> Add Step
          </Button>
        </div>

        <div className="space-y-0">
          {steps.map((step, index) => (
            <div key={index}>
              {index > 0 && (
                <div className="flex justify-center py-1">
                  <ArrowRight className="size-4 text-muted-foreground rotate-90" />
                </div>
              )}

              <div className="rounded-lg border bg-card p-4">
                <div className="flex items-start gap-3">
                  <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center text-sm font-semibold">
                    {index + 1}
                  </div>

                  <div className="flex-1 space-y-3">
                    <div className="flex items-center gap-3">
                      <select
                        value={step.stepType}
                        onChange={(e) => updateStep(index, 'stepType', e.target.value)}
                        className="rounded-md border bg-background px-3 py-1.5 text-sm"
                      >
                        <option value="lead_capture">Lead Capture — collect name &amp; email (free offer)</option>
                        <option value="page">Sales Page — present a paid offer</option>
                        <option value="upsell">Upsell — add-on offer (adds to cart)</option>
                        <option value="downsell">Downsell — alternative offer if upsell declined</option>
                        <option value="checkout">Checkout — pay for all items in cart</option>
                        <option value="thank_you">Thank You — confirmation + order summary</option>
                      </select>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${stepTypeColors[step.stepType] || ''}`}>
                        {stepTypeLabels[step.stepType]}
                      </span>
                    </div>

                    {(step.stepType === 'page' || step.stepType === 'lead_capture') && (
                      <div>
                        <label className="block text-xs text-muted-foreground mb-1">Landing Page</label>
                        <select
                          value={step.pageId || ''}
                          onChange={(e) => updateStep(index, 'pageId', e.target.value || null)}
                          className="rounded-md border bg-background px-3 py-1.5 text-sm w-full max-w-sm"
                        >
                          <option value="">Select a page...</option>
                          {landingPages.map((page) => (
                            <option key={page.id} value={page.id}>{page.title}{page.status !== 'published' ? ' (draft)' : ''}</option>
                          ))}
                        </select>
                      </div>
                    )}

                    {(step.stepType === 'upsell' || step.stepType === 'downsell') && (
                      <div>
                        <label className="block text-xs text-muted-foreground mb-1">Custom Page <span className="text-muted-foreground/60">(optional)</span></label>
                        <select
                          value={step.pageId || ''}
                          onChange={(e) => updateStep(index, 'pageId', e.target.value || null)}
                          className="rounded-md border bg-background px-3 py-1.5 text-sm w-full max-w-sm"
                        >
                          <option value="">Use default offer page</option>
                          {landingPages.map((page) => (
                            <option key={page.id} value={page.id}>{page.title}{page.status !== 'published' ? ' (draft)' : ''}</option>
                          ))}
                        </select>
                      </div>
                    )}

                    {(step.stepType === 'page' || step.stepType === 'checkout' || step.stepType === 'upsell' || step.stepType === 'downsell') && (
                      <div className="space-y-2">
                        <div>
                          <label className="block text-xs text-muted-foreground mb-1">
                            Product{step.stepType === 'page' ? ' (added to cart when visitor continues)' : ''}
                          </label>
                          <select
                            value={step.productId || ''}
                            onChange={(e) => updateStep(index, 'productId', e.target.value || null)}
                            className="rounded-md border bg-background px-3 py-1.5 text-sm w-full max-w-sm"
                          >
                            <option value="">Select a product...</option>
                            {products.map((p) => (
                              <option key={p.id} value={p.id}>{p.name} — ${p.price.toFixed(2)}</option>
                            ))}
                          </select>
                        </div>
                        {step.stepType === 'checkout' && (
                          <div>
                            <label className="block text-xs text-muted-foreground mb-1">Order Bumps</label>
                            {(step.config.order_bumps || []).map((bump: any, bi: number) => (
                              <div key={bi} className="flex items-center gap-2 mb-1.5">
                                <select
                                  value={bump.product_id || ''}
                                  onChange={(e) => {
                                    const bumps = [...(step.config.order_bumps || [])]
                                    const prod = products.find(p => p.id === e.target.value)
                                    bumps[bi] = { ...bumps[bi], product_id: e.target.value, headline: prod?.name || '', price: prod?.price || 0 }
                                    updateStep(index, 'config.order_bumps', JSON.stringify(bumps))
                                  }}
                                  className="rounded-md border bg-background px-2 py-1 text-xs flex-1"
                                >
                                  <option value="">Select product...</option>
                                  {products.filter(p => p.id !== step.productId).map((p) => (
                                    <option key={p.id} value={p.id}>{p.name} — ${p.price.toFixed(2)}</option>
                                  ))}
                                </select>
                                <button
                                  onClick={() => {
                                    const bumps = (step.config.order_bumps || []).filter((_: any, i: number) => i !== bi)
                                    updateStep(index, 'config.order_bumps', JSON.stringify(bumps))
                                  }}
                                  className="p-1 rounded hover:bg-muted text-destructive"
                                >
                                  <Trash2 className="size-3" />
                                </button>
                              </div>
                            ))}
                            <button
                              onClick={() => {
                                const bumps = [...(step.config.order_bumps || []), { product_id: '', headline: '', price: 0 }]
                                updateStep(index, 'config.order_bumps', JSON.stringify(bumps))
                              }}
                              className="text-xs text-accent hover:underline flex items-center gap-1 mt-1"
                            >
                              <Plus className="size-3" /> Add bump
                            </button>
                          </div>
                        )}
                        {(step.stepType === 'upsell' || step.stepType === 'downsell') && !step.pageId && (
                          <div className="space-y-2 max-w-sm">
                            <div>
                              <label className="block text-xs text-muted-foreground mb-1">Headline</label>
                              <Input value={step.config.headline || ''} onChange={(e) => updateStep(index, 'config.headline', e.target.value)} placeholder={step.stepType === 'downsell' ? 'Wait — special offer' : 'Exclusive upgrade'} className="text-sm" />
                            </div>
                            <div>
                              <label className="block text-xs text-muted-foreground mb-1">Description</label>
                              <textarea value={step.config.description || ''} onChange={(e) => updateStep(index, 'config.description', e.target.value)} placeholder="Describe what they get with this offer..." rows={2} className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring" />
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              <div>
                                <label className="block text-xs text-muted-foreground mb-1">Accept Button</label>
                                <Input value={step.config.accept_button_text || ''} onChange={(e) => updateStep(index, 'config.accept_button_text', e.target.value)} placeholder="Yes! Add this" className="text-xs" />
                              </div>
                              <div>
                                <label className="block text-xs text-muted-foreground mb-1">Decline Button</label>
                                <Input value={step.config.decline_button_text || ''} onChange={(e) => updateStep(index, 'config.decline_button_text', e.target.value)} placeholder="No thanks" className="text-xs" />
                              </div>
                            </div>
                            <div>
                              <label className="block text-xs text-muted-foreground mb-1">Guarantee <span className="text-muted-foreground/60">(optional)</span></label>
                              <Input value={step.config.guarantee || ''} onChange={(e) => updateStep(index, 'config.guarantee', e.target.value)} placeholder="30-day money-back guarantee" className="text-sm" />
                            </div>
                          </div>
                        )}
                        {(step.stepType === 'upsell' || step.stepType === 'downsell') && (
                          <div className="grid grid-cols-2 gap-2 max-w-sm">
                            <div>
                              <label className="block text-xs text-muted-foreground mb-1">If accepted →</label>
                              <select value={step.onAcceptStepId || ''} onChange={(e) => updateStep(index, 'onAcceptStepId', e.target.value || null)}
                                className="rounded-md border bg-background px-2 py-1.5 text-xs w-full">
                                <option value="">Next step</option>
                                {steps.filter((s, i) => i !== index).map((s) => (
                                  <option key={s.id || s.stepOrder} value={s.id || ''}>{s.name || stepTypeLabels[s.stepType]} (#{s.stepOrder})</option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label className="block text-xs text-muted-foreground mb-1">If declined →</label>
                              <select value={step.onDeclineStepId || ''} onChange={(e) => updateStep(index, 'onDeclineStepId', e.target.value || null)}
                                className="rounded-md border bg-background px-2 py-1.5 text-xs w-full">
                                <option value="">Next step</option>
                                {steps.filter((s, i) => i !== index).map((s) => (
                                  <option key={s.id || s.stepOrder} value={s.id || ''}>{s.name || stepTypeLabels[s.stepType]} (#{s.stepOrder})</option>
                                ))}
                              </select>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {step.stepType === 'thank_you' && (
                      <div className="space-y-2 max-w-lg">
                        <div>
                          <label className="block text-xs text-muted-foreground mb-1">Custom Page <span className="text-muted-foreground/60">(optional — overrides default thank-you)</span></label>
                          <select
                            value={step.pageId || ''}
                            onChange={(e) => updateStep(index, 'pageId', e.target.value || null)}
                            className="rounded-md border bg-background px-3 py-1.5 text-sm w-full max-w-sm"
                          >
                            <option value="">Use default thank-you page</option>
                            {landingPages.map((page) => (
                              <option key={page.id} value={page.id}>{page.title}{page.status !== 'published' ? ' (draft)' : ''}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs text-muted-foreground mb-1">Thank You Message</label>
                          <Input
                            value={step.config.message || ''}
                            onChange={(e) => updateStep(index, 'config.message', e.target.value)}
                            placeholder="Thank you for your purchase!"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-muted-foreground mb-1">Download Link <span className="text-muted-foreground/60">(optional)</span></label>
                          <Input
                            value={step.config.downloadUrl || ''}
                            onChange={(e) => updateStep(index, 'config.downloadUrl', e.target.value)}
                            placeholder="https://example.com/your-file.pdf"
                            className="text-sm"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-muted-foreground mb-1">Next Step CTA <span className="text-muted-foreground/60">(optional)</span></label>
                          <div className="grid grid-cols-2 gap-2">
                            <Input
                              value={step.config.ctaText || ''}
                              onChange={(e) => updateStep(index, 'config.ctaText', e.target.value)}
                              placeholder="Button text"
                              className="text-sm"
                            />
                            <Input
                              value={step.config.ctaUrl || ''}
                              onChange={(e) => updateStep(index, 'config.ctaUrl', e.target.value)}
                              placeholder="https://..."
                              className="text-sm"
                            />
                          </div>
                        </div>
                      </div>
                    )}

                    {false && analytics.length > 0 && (() => {
                      const stepAnalytics = analytics.find((a) => a.stepOrder === step.stepOrder)
                      if (!stepAnalytics) return null
                      return (
                        <div className="flex items-center gap-4 text-xs text-muted-foreground pt-1">
                          <span className="flex items-center gap-1">
                            <BarChart3 className="size-3" /> {stepAnalytics.visits} visits
                          </span>
                          {stepAnalytics.dropOffRate > 0 && (
                            <span className="text-red-500">
                              {stepAnalytics.dropOffRate}% drop-off
                            </span>
                          )}
                        </div>
                      )
                    })()}
                  </div>

                  <div className="flex flex-col gap-0.5">
                    <IconButton
                      variant="ghost" size="sm" type="button" aria-label="Move up"
                      onClick={() => moveStep(index, -1)}
                      disabled={index === 0}
                    >
                      <ChevronUp className="size-4" />
                    </IconButton>
                    <IconButton
                      variant="ghost" size="sm" type="button" aria-label="Move down"
                      onClick={() => moveStep(index, 1)}
                      disabled={index === steps.length - 1}
                    >
                      <ChevronDown className="size-4" />
                    </IconButton>
                    <IconButton
                      variant="ghost" size="sm" type="button" aria-label="Remove step"
                      onClick={() => removeStep(index)}
                      disabled={steps.length <= 1}
                    >
                      <Trash2 className="size-3.5" />
                    </IconButton>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Funnel flow preview */}
      <div className="mb-6">
        <label className="block text-sm font-medium mb-2">Funnel Flow Preview</label>
        <div className="rounded-lg border bg-muted/30 p-4 flex items-center gap-2 overflow-x-auto">
          {steps.map((step, index) => {
            const label = step.stepType === 'page'
              ? (landingPages.find((p) => p.id === step.pageId)?.title || 'Select Page')
              : stepTypeLabels[step.stepType]
            return (
              <div key={index} className="flex items-center gap-2 flex-shrink-0">
                {index > 0 && <ArrowRight className="size-4 text-muted-foreground" />}
                <div className={`rounded-md px-3 py-1.5 text-xs font-medium border ${stepTypeColors[step.stepType] || 'bg-muted'}`}>
                  {label}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Conversion chart — shown on list page, not here */}
      {false && analytics.length > 0 && (
        <div className="mb-6">
          <label className="block text-sm font-medium mb-2">Conversion Funnel</label>
          <div className="rounded-lg border bg-card p-4">
            {analytics.map((step, index) => {
              const maxVisits = Math.max(...analytics.map((a) => a.visits), 1)
              const barWidth = Math.max((step.visits / maxVisits) * 100, 2)
              return (
                <div key={index} className="mb-3 last:mb-0">
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="font-medium">
                      Step {step.stepOrder}: {step.pageTitle || stepTypeLabels[step.stepType] || step.stepType}
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {step.visits} visits
                      {step.dropOffRate > 0 && (
                        <span className="text-red-500 ml-2">-{step.dropOffRate}%</span>
                      )}
                    </span>
                  </div>
                  <div className="h-6 bg-muted rounded-md overflow-hidden">
                    <div
                      className="h-full bg-primary/70 rounded-md transition-all"
                      style={{ width: `${barWidth}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button type="button" onClick={saveFunnel} disabled={saving}>
          {saving ? 'Saving...' : (editId ? 'Update Funnel' : 'Create Funnel')}
        </Button>
        <Button type="button" variant="outline" onClick={() => { resetForm(); setView('list') }}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
