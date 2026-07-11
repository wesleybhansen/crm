'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import {
  FlaskConical, Loader2, Plus, Trash2, Trophy, BarChart3, Globe, ChevronDown, ChevronUp, Code2, Pause, Play,
} from 'lucide-react'

type Variant = {
  id: string
  name: string
  weight: number
  status: string
  view_count: number
  submission_count: number
  published_html?: string | null
}

type AnalyticsTotals = {
  control: { views: number; submissions: number; conversionRate: number }
  variants: Array<{ id: string; name: string; status: string; views: number; submissions: number; conversionRate: number }>
  all: { views: number; submissions: number; conversionRate: number }
}

type AnalyticsData = {
  provisioned: boolean
  abEnabled: boolean
  totals: AnalyticsTotals
  days: Array<{ day: string; arms: Record<string, { views: number; submissions: number }> }>
  referrers: Array<{ host: string; count: number }>
}

function pct(value: number): string {
  return `${(Number(value) || 0).toFixed(1)}%`
}

/** Tiny inline SVG bar chart for the 30-day series (no chart lib). */
function ThirtyDayChart({ days }: { days: AnalyticsData['days'] }) {
  const width = 360
  const height = 72
  const barGap = 2
  const barWidth = (width - barGap * (days.length - 1)) / Math.max(days.length, 1)
  const totals = days.map((d) => {
    let views = 0
    let submissions = 0
    for (const arm of Object.values(d.arms)) {
      views += arm.views
      submissions += arm.submissions
    }
    return { day: d.day, views, submissions }
  })
  const maxViews = Math.max(1, ...totals.map((t) => t.views))
  return (
    <svg viewBox={`0 0 ${width} ${height + 14}`} className="w-full" role="img" aria-label="Views and submissions, last 30 days">
      {totals.map((t, i) => {
        const x = i * (barWidth + barGap)
        const vh = Math.round((t.views / maxViews) * height)
        const sh = Math.round((t.submissions / maxViews) * height)
        return (
          <g key={t.day}>
            <title>{`${t.day}: ${t.views} views, ${t.submissions} submissions`}</title>
            <rect x={x} y={height - vh} width={barWidth} height={Math.max(vh, t.views > 0 ? 2 : 0)} rx={1} className="fill-blue-200 dark:fill-blue-900" />
            <rect x={x} y={height - sh} width={barWidth} height={Math.max(sh, t.submissions > 0 ? 2 : 0)} rx={1} className="fill-blue-600 dark:fill-blue-400" />
          </g>
        )
      })}
      <text x={0} y={height + 11} className="fill-current text-muted-foreground" fontSize={8}>{totals[0]?.day ?? ''}</text>
      <text x={width} y={height + 11} textAnchor="end" className="fill-current text-muted-foreground" fontSize={8}>{totals[totals.length - 1]?.day ?? ''}</text>
    </svg>
  )
}

export default function AbTestPanel({ pageId }: { pageId: string }) {
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [abEnabled, setAbEnabled] = useState(false)
  const [control, setControl] = useState({ viewCount: 0, submissionCount: 0 })
  const [variants, setVariants] = useState<Variant[]>([])
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null)
  const [newVariantName, setNewVariantName] = useState('')
  const [htmlEditorFor, setHtmlEditorFor] = useState<string | null>(null)
  const [htmlDraft, setHtmlDraft] = useState('')
  const [customDomain, setCustomDomain] = useState('')
  const [domainSaved, setDomainSaved] = useState(false)
  const [showAnalytics, setShowAnalytics] = useState(true)

  const reload = useCallback(async () => {
    try {
      const [variantsRes, analyticsRes, pageRes] = await Promise.all([
        fetch(`/api/landing_pages/pages/${pageId}/variants`, { credentials: 'include' }).then((r) => r.json()),
        fetch(`/api/landing_pages/pages/${pageId}/analytics`, { credentials: 'include' }).then((r) => r.json()),
        fetch(`/api/landing_pages/pages/${pageId}`, { credentials: 'include' }).then((r) => r.json()),
      ])
      if (variantsRes.ok) {
        setAbEnabled(!!variantsRes.data.abEnabled)
        setControl(variantsRes.data.control || { viewCount: 0, submissionCount: 0 })
        setVariants(variantsRes.data.variants || [])
      }
      if (analyticsRes.ok) setAnalytics(analyticsRes.data)
      if (pageRes.ok) setCustomDomain(pageRes.data.custom_domain || '')
      setError(null)
    } catch {
      setError('Failed to load A/B test data')
    }
    setLoading(false)
  }, [pageId])

  useEffect(() => {
    reload()
  }, [reload])

  async function callVariants(method: string, body: Record<string, any>): Promise<boolean> {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/landing_pages/pages/${pageId}/variants`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!data.ok) {
        setError(data.error || 'Request failed')
        setBusy(false)
        return false
      }
      await reload()
      setBusy(false)
      return true
    } catch {
      setError('Request failed')
      setBusy(false)
      return false
    }
  }

  async function toggleAb() {
    await callVariants('PATCH', { abEnabled: !abEnabled })
  }

  async function createVariant() {
    const name = newVariantName.trim()
    if (!name) return
    const ok = await callVariants('POST', { name, weight: 50 })
    if (ok) setNewVariantName('')
  }

  async function updateWeight(variantId: string, weight: number) {
    setVariants((prev) => prev.map((v) => (v.id === variantId ? { ...v, weight } : v)))
  }

  async function commitWeight(variantId: string, weight: number) {
    await callVariants('PATCH', { variantId, weight })
  }

  async function togglePause(variant: Variant) {
    await callVariants('PATCH', { variantId: variant.id, status: variant.status === 'paused' ? 'active' : 'paused' })
  }

  async function promote(variant: Variant) {
    if (!window.confirm(`Promote "${variant.name}"? Its content replaces the main page and the test is switched off.`)) return
    await callVariants('PATCH', { variantId: variant.id, action: 'promote' })
  }

  async function removeVariant(variant: Variant) {
    if (!window.confirm(`Delete variant "${variant.name}"? Its stats are removed with it.`)) return
    await callVariants('DELETE', { variantId: variant.id })
  }

  async function openHtmlEditor(variant: Variant) {
    if (htmlEditorFor === variant.id) {
      setHtmlEditorFor(null)
      return
    }
    setBusy(true)
    try {
      const res = await fetch(`/api/landing_pages/pages/${pageId}/variants?includeHtml=1`, { credentials: 'include' })
      const data = await res.json()
      const full = data.ok ? (data.data.variants || []).find((v: Variant) => v.id === variant.id) : null
      setHtmlDraft(full?.published_html || '')
      setHtmlEditorFor(variant.id)
    } catch {
      setError('Failed to load variant HTML')
    }
    setBusy(false)
  }

  async function saveHtml(variantId: string) {
    const ok = await callVariants('PATCH', { variantId, publishedHtml: htmlDraft })
    if (ok) setHtmlEditorFor(null)
  }

  async function saveDomain() {
    setBusy(true)
    setError(null)
    setDomainSaved(false)
    try {
      const res = await fetch(`/api/landing_pages/pages/${pageId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ customDomain: customDomain.trim() || null }),
      })
      const data = await res.json()
      if (!data.ok) {
        setError(data.error || 'Failed to save domain')
      } else {
        setCustomDomain(data.data?.custom_domain || '')
        setDomainSaved(true)
      }
    } catch {
      setError('Failed to save domain')
    }
    setBusy(false)
  }

  if (loading) {
    return (
      <div className="p-4 text-center text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin mx-auto mb-2" /> Loading...
      </div>
    )
  }

  const activeVariants = variants.filter((v) => v.status === 'active')
  const controlWeight = Math.max(0, 100 - activeVariants.reduce((a, v) => a + (Number(v.weight) || 0), 0))
  const armTotals = analytics?.totals
  const controlRate = control.viewCount > 0 ? (control.submissionCount / control.viewCount) * 100 : 0

  return (
    <div className="divide-y">
      {error && (
        <div className="mx-4 mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>
      )}

      {/* A/B test */}
      <div className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <FlaskConical className="size-3.5 text-muted-foreground" />
          <span className="text-xs font-semibold flex-1">A/B test</span>
          <button
            type="button"
            role="switch"
            aria-checked={abEnabled}
            disabled={busy || variants.length === 0}
            onClick={toggleAb}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${abEnabled ? 'bg-emerald-500' : 'bg-muted-foreground/30'} disabled:opacity-50`}
            title={variants.length === 0 ? 'Create a variant first' : abEnabled ? 'Turn test off' : 'Turn test on'}
          >
            <span className={`inline-block size-4 rounded-full bg-white shadow transition-transform ${abEnabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Visitors are split between the main page and your variants. Each visitor always sees the same version. A variant starts as a copy of the current page: duplicate it, then edit its content.
        </p>

        {/* Control arm */}
        <div className="rounded border bg-muted/20 p-2.5 space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">Main page (control)</span>
            <span className="text-[10px] text-muted-foreground">{controlWeight}% of traffic</span>
          </div>
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
            <span>{control.viewCount} views</span>
            <span>{control.submissionCount} submissions</span>
            <span className="font-medium text-foreground">{pct(controlRate)} conversion</span>
          </div>
        </div>

        {/* Variants */}
        {variants.map((variant) => {
          const stats = armTotals?.variants.find((v) => v.id === variant.id)
          const views = stats?.views ?? Number(variant.view_count) ?? 0
          const submissions = stats?.submissions ?? Number(variant.submission_count) ?? 0
          const cr = stats?.conversionRate ?? (views > 0 ? Math.round((submissions / views) * 1000) / 10 : 0)
          return (
            <div key={variant.id} className="rounded border p-2.5 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium flex-1 truncate">{variant.name}</span>
                <span
                  className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                    variant.status === 'active'
                      ? 'bg-emerald-100 text-emerald-700'
                      : variant.status === 'promoted'
                        ? 'bg-blue-100 text-blue-700'
                        : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {variant.status}
                </span>
              </div>
              <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                <span>{views} views</span>
                <span>{submissions} submissions</span>
                <span className="font-medium text-foreground">{pct(cr)} conversion</span>
              </div>
              {(variant.status === 'active' || variant.status === 'paused') && (
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={Number(variant.weight) || 0}
                    disabled={busy}
                    onChange={(e) => updateWeight(variant.id, Number(e.target.value))}
                    onMouseUp={(e) => commitWeight(variant.id, Number((e.target as HTMLInputElement).value))}
                    onTouchEnd={(e) => commitWeight(variant.id, Number((e.target as HTMLInputElement).value))}
                    className="flex-1 accent-blue-600"
                    aria-label={`Traffic share for ${variant.name}`}
                  />
                  <span className="text-[10px] text-muted-foreground w-14 text-right">{Number(variant.weight) || 0}% traffic</span>
                </div>
              )}
              <div className="flex items-center gap-1.5 flex-wrap">
                {(variant.status === 'active' || variant.status === 'paused') && (
                  <>
                    <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => promote(variant)} className="h-6 text-[10px] px-2">
                      <Trophy className="size-3 mr-1" /> Promote winner
                    </Button>
                    <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => togglePause(variant)} className="h-6 text-[10px] px-2">
                      {variant.status === 'paused' ? <Play className="size-3 mr-1" /> : <Pause className="size-3 mr-1" />}
                      {variant.status === 'paused' ? 'Resume' : 'Pause'}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => openHtmlEditor(variant)} className="h-6 text-[10px] px-2">
                      <Code2 className="size-3 mr-1" /> Edit HTML
                    </Button>
                  </>
                )}
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => removeVariant(variant)} className="h-6 text-[10px] px-2 text-red-600 hover:text-red-700">
                  <Trash2 className="size-3 mr-1" /> Delete
                </Button>
              </div>
              {htmlEditorFor === variant.id && (
                <div className="space-y-1.5">
                  <p className="text-[10px] text-muted-foreground">Advanced: edit this variant's full page HTML directly.</p>
                  <textarea
                    value={htmlDraft}
                    onChange={(e) => setHtmlDraft(e.target.value)}
                    spellCheck={false}
                    className="w-full rounded border bg-background px-2 py-1.5 font-mono text-[10px] h-40 resize-y focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                  <div className="flex gap-1.5">
                    <Button type="button" size="sm" disabled={busy} onClick={() => saveHtml(variant.id)} className="h-6 text-[10px] px-2">Save HTML</Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setHtmlEditorFor(null)} className="h-6 text-[10px] px-2">Cancel</Button>
                  </div>
                </div>
              )}
            </div>
          )
        })}

        {/* Create variant */}
        <div className="flex gap-1.5">
          <Input
            value={newVariantName}
            onChange={(e) => setNewVariantName(e.target.value)}
            placeholder="New variant name, e.g. Headline B"
            className="h-7 text-xs flex-1"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                createVariant()
              }
            }}
          />
          <Button type="button" variant="outline" size="sm" disabled={busy || !newVariantName.trim()} onClick={createVariant} className="h-7 text-xs">
            {busy ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3 mr-1" />} Create
          </Button>
        </div>
        {analytics && !analytics.provisioned && (
          <p className="text-[10px] text-amber-600">Analytics tables are not set up yet. Ask your administrator to apply scripts/sql/landing-ab-analytics.sql.</p>
        )}
      </div>

      {/* Analytics */}
      <div className="p-4 space-y-3">
        <button type="button" className="flex items-center gap-2 w-full" onClick={() => setShowAnalytics(!showAnalytics)}>
          <BarChart3 className="size-3.5 text-muted-foreground" />
          <span className="text-xs font-semibold flex-1 text-left">Analytics (last 30 days)</span>
          {showAnalytics ? <ChevronUp className="size-3 text-muted-foreground" /> : <ChevronDown className="size-3 text-muted-foreground" />}
        </button>
        {showAnalytics && analytics && (
          <>
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded border bg-muted/20 p-2 text-center">
                <div className="text-sm font-semibold">{analytics.totals.all.views}</div>
                <div className="text-[10px] text-muted-foreground">Views</div>
              </div>
              <div className="rounded border bg-muted/20 p-2 text-center">
                <div className="text-sm font-semibold">{analytics.totals.all.submissions}</div>
                <div className="text-[10px] text-muted-foreground">Submissions</div>
              </div>
              <div className="rounded border bg-muted/20 p-2 text-center">
                <div className="text-sm font-semibold">{pct(analytics.totals.all.conversionRate)}</div>
                <div className="text-[10px] text-muted-foreground">Conversion</div>
              </div>
            </div>
            <ThirtyDayChart days={analytics.days} />
            <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
              <span className="flex items-center gap-1"><span className="inline-block size-2 rounded-sm bg-blue-200 dark:bg-blue-900" /> Views</span>
              <span className="flex items-center gap-1"><span className="inline-block size-2 rounded-sm bg-blue-600 dark:bg-blue-400" /> Submissions</span>
            </div>
            <div>
              <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Top referrers</div>
              {analytics.referrers.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">No referrer data yet. Direct visits and same-site views are not counted here.</p>
              ) : (
                <ul className="space-y-1">
                  {analytics.referrers.map((r) => (
                    <li key={r.host} className="flex items-center justify-between text-[11px]">
                      <span className="truncate">{r.host}</span>
                      <span className="text-muted-foreground ml-2">{r.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>

      {/* Custom domain */}
      <div className="p-4 space-y-2">
        <div className="flex items-center gap-2">
          <Globe className="size-3.5 text-muted-foreground" />
          <span className="text-xs font-semibold">Custom domain</span>
        </div>
        <div className="flex gap-1.5">
          <Input
            value={customDomain}
            onChange={(e) => {
              setCustomDomain(e.target.value)
              setDomainSaved(false)
            }}
            placeholder="pages.yourbusiness.com"
            className="h-7 text-xs flex-1"
          />
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={saveDomain} className="h-7 text-xs">
            {busy ? <Loader2 className="size-3 animate-spin" /> : 'Save'}
          </Button>
        </div>
        {domainSaved && <p className="text-[10px] text-emerald-600">Domain saved.</p>}
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          To connect your domain, add a CNAME record at your DNS provider pointing this domain at <span className="font-mono">crm.noliai.com</span>. Once DNS is set, this published page is served at your domain's root URL. HTTPS certificates for custom domains are provisioned on our servers and can take some time. Contact support to finish HTTPS setup.
        </p>
      </div>
    </div>
  )
}
