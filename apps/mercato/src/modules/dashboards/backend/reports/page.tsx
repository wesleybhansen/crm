'use client'

import { useState, useEffect } from 'react'
import { DollarSign, Users, TrendingUp, FileText, Calendar, BarChart3, Target, ArrowUpRight, Loader2 } from 'lucide-react'

interface ReportData {
  pipelineByStage: Array<{ stage: string; count: string; value: string }>
  dealOutcomes: { won: number; lost: number; revenue: number }
  contactsBySource: Array<{ source: string; count: string }>
  contactsOverTime: Array<{ day: string; count: string }>
  landingPagePerf: Array<{ title: string; view_count: number; submission_count: number }>
  paymentRevenue: { total: number; thisMonth: number; lastMonth: number }
  bookingStats: { upcoming: number; thisMonth: number }
  forecast?: Array<{ bucket: string; deals: number; totalValue: number; weightedValue: number }>
  winLossBySource?: Array<{ source: string; won: number; lost: number; winRate: number; wonValue: number }>
  salesVelocity?: { avgDaysToWin: number | null; sampled: number }
}

function forecastLabel(bucket: string): string {
  if (bucket === 'unscheduled') return 'No close date'
  if (bucket === 'overdue') return 'Past due'
  const [y, m] = bucket.split('-').map(Number)
  if (!y || !m) return bucket
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

export default function ReportsPage() {
  const [data, setData] = useState<ReportData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/reports', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.ok) setData(d.data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  if (loading) return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="animate-pulse space-y-6">
        <div className="h-8 bg-muted rounded-lg w-32" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">{[...Array(4)].map((_, i) => <div key={i} className="h-28 bg-muted rounded-xl" />)}</div>
        <div className="grid lg:grid-cols-2 gap-6">{[...Array(4)].map((_, i) => <div key={i} className="h-48 bg-muted rounded-xl" />)}</div>
      </div>
    </div>
  )

  if (!data) return <div className="p-6 text-sm text-muted-foreground">Failed to load reports.</div>

  const maxPipelineCount = Math.max(...data.pipelineByStage.map(s => Number(s.count)), 1)
  const maxSourceCount = Math.max(...data.contactsBySource.map(s => Number(s.count)), 1)
  const totalContacts30d = data.contactsOverTime.reduce((s, d) => s + Number(d.count), 0)
  const winRate = data.dealOutcomes.won + data.dealOutcomes.lost > 0
    ? Math.round((data.dealOutcomes.won / (data.dealOutcomes.won + data.dealOutcomes.lost)) * 100) : 0
  const revenueChange = data.paymentRevenue.lastMonth > 0
    ? Math.round(((data.paymentRevenue.thisMonth - data.paymentRevenue.lastMonth) / data.paymentRevenue.lastMonth) * 100) : null

  // Daily new-contact series over the last 30 days, bucketed client-side from
  // the already-fetched contactsOverTime rows (zero-filled for missing days).
  const contactsDaily = (() => {
    const out = new Array(30).fill(0)
    const today = new Date(); today.setHours(0, 0, 0, 0)
    for (const r of data.contactsOverTime) {
      const t = new Date(r.day).getTime()
      if (Number.isNaN(t)) continue
      const diff = Math.floor((today.getTime() - t) / 86400000)
      if (diff >= 0 && diff < 30) out[29 - diff] += Number(r.count) || 0
    }
    return out
  })()

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Reports</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Last 30 days</p>
        </div>
      </div>

      {/* Top KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <KpiCard icon={DollarSign} label="Revenue" value={`$${data.dealOutcomes.revenue.toLocaleString()}`}
          sub={`${data.dealOutcomes.won} deal${data.dealOutcomes.won !== 1 ? 's' : ''} closed`} accent="emerald" />
        <KpiCard icon={DollarSign} label="Payments" value={`$${data.paymentRevenue.thisMonth.toLocaleString()}`}
          sub={revenueChange !== null ? `${revenueChange >= 0 ? '+' : ''}${revenueChange}% vs last month` : 'First month tracking'}
          accent="amber" />
        <KpiCard icon={Users} label="New Contacts" value={String(totalContacts30d)}
          sub={`${data.contactsBySource.length} source${data.contactsBySource.length !== 1 ? 's' : ''}`} accent="blue" series={contactsDaily} />
        <KpiCard icon={Calendar} label="Bookings" value={String(data.bookingStats.thisMonth)}
          sub={`${data.bookingStats.upcoming} upcoming`} accent="purple" />
      </div>

      {/* Revenue Forecast — weighted pipeline by expected-close month */}
      {(data.forecast?.length || 0) > 0 && (
        <div className="rounded-xl border p-5 bg-card mb-6">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <BarChart3 className="size-4 text-[#7c3aed] dark:text-[#a78bfa]" /> Revenue Forecast
            </h2>
            {data.salesVelocity?.avgDaysToWin != null && (
              <span className="text-xs text-muted-foreground">
                Avg time to win: <span className="font-medium text-foreground">{data.salesVelocity.avgDaysToWin} days</span> (last {data.salesVelocity.sampled} won)
              </span>
            )}
          </div>
          <div className="flex items-center justify-between text-[10px] text-muted-foreground uppercase tracking-wider mb-2 px-1">
            <span>Expected close</span>
            <div className="flex gap-6"><span>Deals</span><span className="w-20 text-right">Pipeline</span><span className="w-20 text-right">Weighted</span></div>
          </div>
          <div className="space-y-1">
            {data.forecast!.map((f, i) => (
              <div key={i} className="flex items-center justify-between py-2 px-1 rounded-lg hover:bg-muted/30 transition">
                <span className={`text-xs font-medium ${f.bucket === 'overdue' ? 'text-[#b45309] dark:text-[#fbbf24]' : ''}`}>{forecastLabel(f.bucket)}</span>
                <div className="flex gap-6 text-xs tabular-nums shrink-0">
                  <span className="text-muted-foreground w-10 text-right">{f.deals}</span>
                  <span className="text-muted-foreground w-20 text-right">${Math.round(f.totalValue).toLocaleString()}</span>
                  <span className="font-semibold w-20 text-right">${Math.round(f.weightedValue).toLocaleString()}</span>
                </div>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground/70 mt-3">Weighted = deal value x win probability (deals without a probability count at 50%). Set close dates and probabilities on deals to sharpen this.</p>
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Pipeline by Stage */}
        <div className="rounded-xl border p-5 bg-card">
          <h2 className="text-sm font-semibold mb-4 flex items-center gap-2">
            <Target className="size-4 text-[#1d4ed8] dark:text-[#60a5fa]" /> Pipeline by Stage
          </h2>
          {data.pipelineByStage.length === 0 ? (
            <EmptySection text="No deals yet" />
          ) : (
            <div className="space-y-3">
              {data.pipelineByStage.map((stage, i) => (
                <div key={i}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-medium">{stage.stage || 'Unassigned'}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">{stage.count} · ${Number(stage.value || 0).toLocaleString()}</span>
                  </div>
                  <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
                    <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${(Number(stage.count) / maxPipelineCount) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Contacts by Source */}
        <div className="rounded-xl border p-5 bg-card">
          <h2 className="text-sm font-semibold mb-4 flex items-center gap-2">
            <Users className="size-4 text-[#047857] dark:text-[#34d399]" /> Contacts by Source
          </h2>
          {data.contactsBySource.length === 0 ? (
            <EmptySection text="No contacts yet" />
          ) : (
            <div className="space-y-3">
              {data.contactsBySource.map((source, i) => (
                <div key={i}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-medium capitalize">{source.source.replace(/_/g, ' ')}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">{source.count}</span>
                  </div>
                  <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
                    <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${(Number(source.count) / maxSourceCount) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Deal Outcomes */}
        <div className="rounded-xl border p-5 bg-card">
          <h2 className="text-sm font-semibold mb-4 flex items-center gap-2">
            <TrendingUp className="size-4 text-[#b45309] dark:text-[#fbbf24]" /> Deal Outcomes
          </h2>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div className="rounded-xl bg-[rgba(16,185,129,.06)] dark:bg-[rgba(16,185,129,.08)] border border-[rgba(16,185,129,.22)] dark:border-[rgba(16,185,129,.26)] p-4">
              <p className="text-2xl font-bold text-[#047857] dark:text-[#34d399]">{data.dealOutcomes.won}</p>
              <p className="text-xs text-muted-foreground mt-0.5">Won</p>
            </div>
            <div className="rounded-xl bg-[rgba(239,68,68,.06)] dark:bg-[rgba(239,68,68,.08)] border border-[rgba(239,68,68,.20)] dark:border-[rgba(239,68,68,.26)] p-4">
              <p className="text-2xl font-bold text-[#b91c1c] dark:text-[#f87171]">{data.dealOutcomes.lost}</p>
              <p className="text-xs text-muted-foreground mt-0.5">Lost</p>
            </div>
            <div className="rounded-xl bg-muted/50 p-4">
              <p className="text-2xl font-bold">{winRate}%</p>
              <p className="text-xs text-muted-foreground mt-0.5">Win Rate</p>
            </div>
          </div>
        </div>

        {/* Win/Loss by Source — where good deals actually come from */}
        {(data.winLossBySource?.length || 0) > 0 && (
          <div className="rounded-xl border p-5 bg-card">
            <h2 className="text-sm font-semibold mb-4 flex items-center gap-2">
              <ArrowUpRight className="size-4 text-[#047857] dark:text-[#34d399]" /> Win Rate by Source <span className="font-normal text-muted-foreground">(90 days)</span>
            </h2>
            <div className="flex items-center justify-between text-[10px] text-muted-foreground uppercase tracking-wider mb-2 px-1">
              <span>Source</span>
              <div className="flex gap-5"><span>W</span><span>L</span><span className="w-12 text-right">Rate</span><span className="w-16 text-right">Won $</span></div>
            </div>
            <div className="space-y-1">
              {data.winLossBySource!.map((s, i) => (
                <div key={i} className="flex items-center justify-between py-2 px-1 rounded-lg hover:bg-muted/30 transition">
                  <span className="text-xs font-medium capitalize truncate flex-1 mr-3">{s.source.replace(/_/g, ' ')}</span>
                  <div className="flex gap-5 text-xs tabular-nums shrink-0">
                    <span className="text-[#047857] dark:text-[#34d399] w-4 text-right">{s.won}</span>
                    <span className="text-[#b91c1c] dark:text-[#f87171] w-4 text-right">{s.lost}</span>
                    <span className="font-semibold w-12 text-right">{s.winRate}%</span>
                    <span className="text-muted-foreground w-16 text-right">${Math.round(s.wonValue).toLocaleString()}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Landing Page Performance */}
        <div className="rounded-xl border p-5 bg-card">
          <h2 className="text-sm font-semibold mb-4 flex items-center gap-2">
            <FileText className="size-4 text-[#7c3aed] dark:text-[#a78bfa]" /> Landing Pages
          </h2>
          {data.landingPagePerf.length === 0 ? (
            <EmptySection text="No published pages" />
          ) : (
            <div>
              <div className="flex items-center justify-between text-[10px] text-muted-foreground uppercase tracking-wider mb-2 px-1">
                <span>Page</span>
                <div className="flex gap-6"><span>Views</span><span>Leads</span><span>Conv</span></div>
              </div>
              <div className="space-y-1">
                {data.landingPagePerf.map((page, i) => {
                  const conv = page.view_count > 0 ? ((page.submission_count / page.view_count) * 100).toFixed(1) : '0'
                  return (
                    <div key={i} className="flex items-center justify-between py-2 px-1 rounded-lg hover:bg-muted/30 transition">
                      <span className="text-xs font-medium truncate flex-1 mr-4">{page.title}</span>
                      <div className="flex gap-6 text-xs tabular-nums shrink-0">
                        <span className="text-muted-foreground w-10 text-right">{page.view_count}</span>
                        <span className="text-muted-foreground w-10 text-right">{page.submission_count}</span>
                        <span className="font-medium w-10 text-right">{conv}%</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

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

function KpiCard({ icon: Icon, label, value, sub, accent, series }: {
  icon: any; label: string; value: string; sub: string; accent?: string; series?: number[]
}) {
  const accentColor = accent === 'emerald' ? 'bg-[rgba(16,185,129,.10)] text-[#047857] dark:bg-[rgba(16,185,129,.14)] dark:text-[#34d399]'
    : accent === 'blue' ? 'bg-[rgba(37,99,235,.08)] text-[#1d4ed8] dark:bg-[rgba(59,130,246,.15)] dark:text-[#93c5fd]'
    : accent === 'purple' ? 'bg-[rgba(124,58,237,.09)] text-[#6d28d9] dark:bg-[rgba(139,92,246,.16)] dark:text-[#c4b5fd]'
    : accent === 'amber' ? 'bg-[rgba(217,119,6,.10)] text-[#b45309] dark:bg-[rgba(245,158,11,.13)] dark:text-[#fbbf24]'
    : 'bg-accent/8 text-accent'
  const sparkColor = accent === 'emerald' ? 'text-[#047857] dark:text-[#34d399]'
    : accent === 'blue' ? 'text-[#1d4ed8] dark:text-[#60a5fa]'
    : accent === 'purple' ? 'text-[#7c3aed] dark:text-[#a78bfa]'
    : accent === 'amber' ? 'text-[#b45309] dark:text-[#fbbf24]'
    : 'text-accent'

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between mb-3">
        <div className={`size-9 rounded-lg flex items-center justify-center ${accentColor}`}>
          <Icon className="size-4" />
        </div>
        {series && series.length > 0 && <Sparkline data={series} className={`${sparkColor} opacity-90`} />}
      </div>
      <p className="text-2xl font-bold tabular-nums tracking-tight">{value}</p>
      <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
      <p className="text-[11px] text-muted-foreground/70 mt-0.5">{sub}</p>
    </div>
  )
}

function EmptySection({ text }: { text: string }) {
  return <p className="text-xs text-muted-foreground text-center py-6">{text}</p>
}
