'use client'

import { useState, useEffect } from 'react'
import { Users, DollarSign, FileText, Eye, Plus, Send, TrendingUp, AlertCircle, CheckCircle2, ArrowRight, BarChart3, Flame, AlertTriangle, Mail, HeartCrack, Clock } from 'lucide-react'
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
    // Check onboarding status from database — only redirect if profile exists but onboarding not complete
    fetch('/api/business-profile', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        // Only redirect if we got a valid response AND the profile exists AND onboarding is explicitly not complete
        if (d.ok && d.data === null) {
          // No business profile at all — first time user, redirect to onboarding
          window.location.href = '/backend/welcome'
          return
        }
        // If profile exists, check onboarding_complete — but don't redirect on API errors
        if (d.ok && d.data && d.data.onboarding_complete === false) {
          window.location.href = '/backend/welcome'
          return
        }
      })
      .catch(() => {
        // On error, stay on dashboard — don't redirect
      })

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

      {/* Needs Attention (Sentiment Alerts) */}
      <NeedsAttention />

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
          <Button type="button" variant="outline" size="sm" onClick={() => window.location.href = '/backend/reports'}>
            <BarChart3 className="size-3.5 mr-1.5" /> Reports
          </Button>
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

      {/* Hottest Leads */}
      <HottestLeads />

      {/* Relationship Decay */}
      <RelationshipDecay />

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

function NeedsAttention() {
  const [alerts, setAlerts] = useState<Array<{ id: string; type: string; title: string; description: string; contactId: string; timestamp: string }>>([])

  useEffect(() => {
    fetch('/api/ai/needs-attention', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.ok && d.data?.length) setAlerts(d.data) })
      .catch(() => {})
  }, [])

  if (alerts.length === 0) return null

  return (
    <div className="mb-8">
      <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
        <AlertTriangle className="size-3.5 text-amber-500" /> Needs Attention
      </h2>
      <div className="space-y-2">
        {alerts.map(alert => (
          <div key={alert.id}
            className={`flex items-center gap-3 px-4 py-3 rounded-lg border ${
              alert.type === 'urgent'
                ? 'border-red-200 bg-red-50 dark:border-red-900/50 dark:bg-red-900/10'
                : 'border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-900/10'
            }`}>
            <Mail className={`size-4 shrink-0 ${
              alert.type === 'urgent' ? 'text-red-500' : 'text-amber-500'
            }`} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{alert.title}</p>
              <p className="text-xs text-muted-foreground">{alert.description}</p>
            </div>
            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
              alert.type === 'urgent'
                ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
            }`}>{alert.type}</span>
            <a href="/backend/inbox" className="text-xs text-accent hover:underline shrink-0">View</a>
          </div>
        ))}
      </div>
    </div>
  )
}

function HottestLeads() {
  const [leads, setLeads] = useState<Array<{ id: string; display_name: string; primary_email: string; score: number }>>([])

  useEffect(() => {
    fetch('/api/engagement?view=hottest', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.ok && d.data?.length) setLeads(d.data.slice(0, 5)) })
      .catch(() => {})
  }, [])

  if (leads.length === 0) return null

  return (
    <div>
      <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
        <Flame className="size-3.5" /> Hottest Leads
      </h2>
      <div className="rounded-lg border divide-y">
        {leads.map(lead => (
          <a key={lead.id} href={`/backend/contacts`}
            className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/30 transition">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{lead.display_name}</p>
              <p className="text-xs text-muted-foreground truncate">{lead.primary_email}</p>
            </div>
            <span className="text-sm font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">{lead.score}</span>
          </a>
        ))}
      </div>
    </div>
  )
}

function RelationshipDecay() {
  const [alerts, setAlerts] = useState<Array<{
    contactId: string; displayName: string; email: string; score: number
    lastActivity: string; avgFrequencyDays: number; currentGapDays: number; severity: 'yellow' | 'red'
  }>>([])
  const [draftingId, setDraftingId] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/ai/relationship-decay', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.ok && d.data?.length) setAlerts(d.data) })
      .catch(() => {})
  }, [])

  if (alerts.length === 0) return null

  function handleDraftFollowUp(alert: typeof alerts[0]) {
    setDraftingId(alert.contactId)
    // Open email compose with contact pre-filled
    const subject = encodeURIComponent(`Checking in`)
    const to = encodeURIComponent(alert.email)
    window.location.href = `/backend/email?compose=true&to=${to}&subject=${subject}&contactId=${alert.contactId}`
  }

  return (
    <div className="mt-8">
      <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
        <HeartCrack className="size-3.5 text-amber-500" /> Fading Relationships
      </h2>
      <div className="rounded-lg border divide-y">
        {alerts.slice(0, 5).map(alert => (
          <div key={alert.contactId}
            className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/30 transition">
            <div className={`w-2 h-2 rounded-full shrink-0 ${
              alert.severity === 'red' ? 'bg-red-500' : 'bg-amber-400'
            }`} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{alert.displayName}</p>
              <p className="text-xs text-muted-foreground truncate flex items-center gap-1.5">
                <Clock className="size-3 inline" />
                {alert.currentGapDays}d since last contact
                <span className="text-muted-foreground/50">|</span>
                avg: every {alert.avgFrequencyDays}d
              </p>
            </div>
            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 ${
              alert.severity === 'red'
                ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
            }`}>
              {alert.severity === 'red' ? 'Fading' : 'Cooling'}
            </span>
            <button
              type="button"
              onClick={() => handleDraftFollowUp(alert)}
              disabled={draftingId === alert.contactId}
              className="text-xs text-accent hover:underline shrink-0 disabled:opacity-50"
            >
              {draftingId === alert.contactId ? 'Opening...' : 'Follow up'}
            </button>
          </div>
        ))}
      </div>
      {alerts.length > 5 && (
        <p className="text-xs text-muted-foreground mt-2 text-center">
          +{alerts.length - 5} more contacts need attention
        </p>
      )}
    </div>
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
