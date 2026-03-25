'use client'

import { useState, useEffect } from 'react'
import { Users, DollarSign, FileText, Eye, Plus, Send, TrendingUp, AlertCircle, CheckCircle2, ArrowRight } from 'lucide-react'
import { Button } from '@open-mercato/ui/primitives/button'

interface ActionItem {
  type: string
  title: string
  description: string
  href: string
  priority: number
}

interface DashboardData {
  actionItems: ActionItem[]
  stats: {
    contacts: { total: number; last7Days: number }
    deals: { open: number; pipelineValue: number; wonThisWeek: number }
    landingPages: { published: number; views: number; submissions: number }
  }
  recentActivity: Array<{ type: string; text: string; time: string }>
}

const actionIcons: Record<string, any> = {
  deal: DollarSign,
  lead: Users,
  contact: Users,
  'getting-started': CheckCircle2,
}

export default function SimpleDashboard() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [greeting, setGreeting] = useState('')

  useEffect(() => {
    const hour = new Date().getHours()
    setGreeting(hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening')

    fetch('/api/ai/action-items', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.ok) setData(d.data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  const stats = data?.stats
  const convRate = stats?.landingPages?.views
    ? ((stats.landingPages.submissions / stats.landingPages.views) * 100).toFixed(1)
    : '0'

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-xl font-semibold">{greeting}</h1>
        <p className="text-sm text-muted-foreground mt-1">Here's what needs your attention.</p>
      </div>

      {/* Action Items */}
      {data?.actionItems && data.actionItems.length > 0 && (
        <div className="mb-8">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Action Items</h2>
          <div className="space-y-2">
            {data.actionItems.map((item, i) => {
              const Icon = actionIcons[item.type] || AlertCircle
              return (
                <a key={i} href={item.href}
                  className="flex items-start gap-3 px-4 py-3 rounded-lg border hover:bg-muted/50 transition group">
                  <div className="w-8 h-8 rounded-full bg-accent/10 flex items-center justify-center shrink-0 mt-0.5">
                    <Icon className="size-4 text-accent" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium group-hover:text-accent transition">{item.title}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{item.description}</p>
                  </div>
                  <ArrowRight className="size-4 text-muted-foreground/40 group-hover:text-accent shrink-0 mt-1 transition" />
                </a>
              )
            })}
          </div>
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard
          icon={Users}
          label="Contacts"
          value={stats?.contacts?.total ?? 0}
          change={stats?.contacts?.last7Days ? `+${stats.contacts.last7Days} this week` : undefined}
          href="/backend/customers/people"
        />
        <StatCard
          icon={DollarSign}
          label="Pipeline Value"
          value={`$${(stats?.deals?.pipelineValue ?? 0).toLocaleString()}`}
          change={stats?.deals?.open ? `${stats.deals.open} open deals` : undefined}
          href="/backend/customers/deals/pipeline"
        />
        <StatCard
          icon={Eye}
          label="Page Views"
          value={stats?.landingPages?.views ?? 0}
          change={stats?.landingPages?.published ? `${stats.landingPages.published} published` : undefined}
          href="/backend/landing-pages"
        />
        <StatCard
          icon={TrendingUp}
          label="Conversion"
          value={`${convRate}%`}
          change={stats?.landingPages?.submissions ? `${stats.landingPages.submissions} leads` : undefined}
          href="/backend/landing-pages"
        />
      </div>

      {/* Quick Actions */}
      <div className="mb-8">
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Quick Actions</h2>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => window.location.href = '/backend/customers/people'}>
            <Plus className="size-3.5 mr-1.5" /> Add Contact
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => window.location.href = '/backend/landing-pages/create'}>
            <FileText className="size-3.5 mr-1.5" /> Create Page
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => window.location.href = '/backend/customers/deals/pipeline'}>
            <DollarSign className="size-3.5 mr-1.5" /> New Deal
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => window.location.href = '/backend/email'}>
            <Send className="size-3.5 mr-1.5" /> Send Email
          </Button>
        </div>
      </div>

      {/* Recent Activity */}
      {data?.recentActivity && data.recentActivity.length > 0 && (
        <div>
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Recent Activity</h2>
          <div className="space-y-1">
            {data.recentActivity.map((item, i) => (
              <div key={i} className="flex items-center gap-3 px-3 py-2 text-sm">
                <div className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                <span className="flex-1 text-muted-foreground">{item.text}</span>
                <span className="text-xs text-muted-foreground/60 shrink-0">
                  {formatRelativeTime(item.time)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {!loading && (!data?.actionItems?.length && !data?.recentActivity?.length) && (
        <div className="text-center py-12">
          <CheckCircle2 className="size-10 mx-auto mb-3 text-muted-foreground/30" />
          <p className="text-sm font-medium">You're all caught up!</p>
          <p className="text-xs text-muted-foreground mt-1">No action items right now. Create a landing page or add a contact to get started.</p>
        </div>
      )}
    </div>
  )
}

function StatCard({ icon: Icon, label, value, change, href }: {
  icon: any; label: string; value: string | number; change?: string; href: string
}) {
  return (
    <a href={href} className="rounded-lg border bg-card p-4 hover:border-accent/30 transition group">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-muted-foreground font-medium">{label}</span>
        <Icon className="size-4 text-muted-foreground/40 group-hover:text-accent transition" />
      </div>
      <p className="text-2xl font-bold tabular-nums">{value}</p>
      {change && <p className="text-xs text-muted-foreground mt-1">{change}</p>}
    </a>
  )
}

function formatRelativeTime(time: string): string {
  const diff = Date.now() - new Date(time).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
