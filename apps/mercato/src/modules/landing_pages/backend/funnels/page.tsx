'use client'

import { useState, useEffect, useCallback } from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { translateWithFallback } from '@open-mercato/shared/lib/i18n/translate'
import { Button } from '@open-mercato/ui/primitives/button'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Input } from '@open-mercato/ui/primitives/input'
import {
  Plus, Trash2, ArrowRight, Globe, Copy, Check,
  ChevronUp, ChevronDown, GitMerge, ExternalLink,
  ToggleLeft, ToggleRight, BarChart3, ArrowLeft,
} from 'lucide-react'

type LandingPage = {
  id: string
  title: string
  slug: string
  status: string
}

type FunnelStep = {
  id?: string
  stepOrder: number
  stepType: 'page' | 'checkout' | 'thank_you'
  pageId: string | null
  config: Record<string, string>
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
  created_at: string
}

type View = 'list' | 'create' | 'edit'

export default function FunnelsPage() {
  const t = useT()
  const translate = (key: string, fallback: string) => translateWithFallback(t, key, fallback)

  const [view, setView] = useState<View>('list')
  const [funnels, setFunnels] = useState<Funnel[]>([])
  const [landingPages, setLandingPages] = useState<LandingPage[]>([])
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
    fetch('/api/funnels')
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

  useEffect(() => { loadFunnels(); loadLandingPages() }, [loadFunnels, loadLandingPages])

  function resetForm() {
    setEditId(null)
    setName('')
    setSteps([
      { stepOrder: 1, stepType: 'page', pageId: null, config: {} },
      { stepOrder: 2, stepType: 'thank_you', pageId: null, config: { message: 'Thank you for signing up!' } },
    ])
    setAnalytics([])
  }

  async function startEdit(funnel: Funnel) {
    setEditId(funnel.id)
    setName(funnel.name)
    setAnalytics([])

    // Fetch the funnel's steps via a no-change PUT that returns full state
    try {
      const res = await fetch(`/api/funnels?id=${funnel.id}`, {
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
      const analyticsRes = await fetch(`/api/funnels/${funnel.id}/analytics`)
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
    } else if (field.startsWith('config.')) {
      const configKey = field.replace('config.', '')
      updated[index] = { ...updated[index], config: { ...updated[index].config, [configKey]: value || '' } }
    }
    setSteps(updated)
  }

  async function saveFunnel() {
    if (!name.trim()) return alert('Name is required')
    if (steps.length === 0) return alert('At least one step is required')

    setSaving(true)
    try {
      const payload = {
        name: name.trim(),
        steps: steps.map((s) => ({
          stepOrder: s.stepOrder,
          stepType: s.stepType,
          pageId: s.pageId,
          config: s.config,
        })),
      }

      const url = editId ? `/api/funnels?id=${editId}` : '/api/funnels'
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
    try {
      const res = await fetch(`/api/funnels?id=${funnel.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isPublished: !funnel.is_published }),
      })
      const data = await res.json()
      if (data.ok) loadFunnels()
      else alert(data.error || 'Failed to update')
    } catch { alert('Failed to update') }
  }

  async function deleteFunnel(funnel: Funnel, e: React.MouseEvent) {
    e.stopPropagation()
    if (!confirm(`Delete "${funnel.name}"?`)) return
    try {
      await fetch(`/api/funnels?id=${funnel.id}`, { method: 'DELETE' })
      loadFunnels()
    } catch { alert('Failed to delete') }
  }

  function copyFunnelUrl(funnel: Funnel, e: React.MouseEvent) {
    e.stopPropagation()
    const funnelUrl = `${window.location.origin}/api/funnels/public/${funnel.slug}`
    navigator.clipboard.writeText(funnelUrl)
    setCopiedId(funnel.id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const stepTypeLabels: Record<string, string> = {
    page: 'Landing Page',
    checkout: 'Checkout',
    thank_you: 'Thank You',
  }

  const stepTypeColors: Record<string, string> = {
    page: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
    checkout: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
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
          <Button type="button" onClick={() => { resetForm(); setView('create') }}>
            <Plus className="size-4 mr-2" /> {translate('funnels.actions.create', 'New Funnel')}
          </Button>
        </div>

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
                  <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {funnels.map((funnel) => (
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
                        {funnel.is_published && (
                          <IconButton
                            variant="ghost" size="sm" type="button" aria-label="View live"
                            onClick={(e) => { e.stopPropagation(); window.open(`/api/funnels/public/${funnel.slug}`, '_blank') }}
                          >
                            <ExternalLink className="size-4" />
                          </IconButton>
                        )}
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
                        <option value="page">Landing Page</option>
                        <option value="checkout">Checkout (Stripe)</option>
                        <option value="thank_you">Thank You Page</option>
                      </select>

                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${stepTypeColors[step.stepType] || ''}`}>
                        {stepTypeLabels[step.stepType]}
                      </span>
                    </div>

                    {step.stepType === 'page' && (
                      <div>
                        <label className="block text-xs text-muted-foreground mb-1">Landing Page</label>
                        <select
                          value={step.pageId || ''}
                          onChange={(e) => updateStep(index, 'pageId', e.target.value || null)}
                          className="rounded-md border bg-background px-3 py-1.5 text-sm w-full max-w-sm"
                        >
                          <option value="">Select a page...</option>
                          {landingPages.map((page) => (
                            <option key={page.id} value={page.id}>{page.title}</option>
                          ))}
                        </select>
                      </div>
                    )}

                    {step.stepType === 'checkout' && (
                      <div>
                        <label className="block text-xs text-muted-foreground mb-1">Stripe Checkout URL</label>
                        <Input
                          value={step.config.checkoutUrl || ''}
                          onChange={(e) => updateStep(index, 'config.checkoutUrl', e.target.value)}
                          placeholder="https://checkout.stripe.com/..."
                          className="max-w-lg"
                        />
                      </div>
                    )}

                    {step.stepType === 'thank_you' && (
                      <div>
                        <label className="block text-xs text-muted-foreground mb-1">Thank You Message</label>
                        <Input
                          value={step.config.message || ''}
                          onChange={(e) => updateStep(index, 'config.message', e.target.value)}
                          placeholder="Thank you for your purchase!"
                          className="max-w-lg"
                        />
                      </div>
                    )}

                    {analytics.length > 0 && (() => {
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

      {/* Conversion chart */}
      {analytics.length > 0 && (
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
