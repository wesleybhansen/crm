'use client'

import { useState, useEffect } from 'react'
import {
  Users, DollarSign, FileText, Eye, Plus, Send, TrendingUp, TrendingDown,
  AlertCircle, CheckCircle2, ArrowRight, BarChart3, Flame, AlertTriangle,
  Mail, HeartCrack, Clock, Zap, BookOpen, CalendarPlus, UserPlus,
  ArrowUpRight, Target, Activity, X,
} from 'lucide-react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Badge } from '@open-mercato/ui/primitives/badge'

interface ActionItem { type: string; title: string; description: string; href: string; priority: number }
interface DashboardData {
  actionItems: ActionItem[]
  stats: {
    contacts: { total: number; last7Days: number }
    deals: { open: number; pipelineValue: number; wonThisWeek: number }
    landingPages: { published: number; views: number; submissions: number }
    inbox?: { unread: number; last7Days: number }
  }
  recentActivity: Array<{ type: string; text: string; time: string }>
  personaName?: string
}

const actionIcons: Record<string, any> = {
  deal: DollarSign, lead: Users, contact: Users, task: CheckCircle2,
  'getting-started': Zap, form: FileText, email: Mail,
}

export default function SimpleDashboard() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [greeting, setGreeting] = useState('')
  const [hasProfile, setHasProfile] = useState(true)
  const [dismissedItems, setDismissedItems] = useState<Set<string>>(() => {
    try {
      const cookie = document.cookie.split('; ').find(c => c.startsWith('crm_dismissed_actions='))
      if (cookie) return new Set(JSON.parse(decodeURIComponent(cookie.split('=')[1])))
    } catch {}
    return new Set()
  })

  useEffect(() => {
    fetch('/api/customers/business-profile', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (d.ok && d.data === null) { window.location.href = '/backend/welcome'; return }
        if (d.ok && d.data && d.data.onboarding_complete === false) { window.location.href = '/backend/welcome'; return }
        setHasProfile(true)
      })
      .catch(() => {})

    const hour = new Date().getHours()
    setGreeting(hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening')

    fetch('/api/ai/action-items', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.ok) setData(d.data); setLoading(false) })
      .catch(() => setLoading(false))

    // Background: trigger email intelligence sync if overdue (>12 hours)
    fetch('/api/email/intelligence-settings', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (!d.ok || !d.data?.is_enabled) return
        const lastSync = d.data.last_sync_at ? new Date(d.data.last_sync_at).getTime() : 0
        const twelveHoursAgo = Date.now() - 12 * 60 * 60 * 1000
        if (lastSync < twelveHoursAgo) {
          fetch('/api/email-intelligence/sync', { method: 'POST', credentials: 'include' }).catch(() => {})
        }
      })
      .catch(() => {})

    // Background: process any due reminders
    fetch('/api/reminders/check', { method: 'POST', credentials: 'include' }).catch(() => {})
  }, [])

  const stats = data?.stats
  const totalContacts = stats?.contacts?.total ?? 0
  const pipelineValue = stats?.deals?.pipelineValue ?? 0
  const openDeals = stats?.deals?.open ?? 0
  const pageViews = stats?.landingPages?.views ?? 0
  const submissions = stats?.landingPages?.submissions ?? 0
  const convRate = pageViews > 0 ? ((submissions / pageViews) * 100).toFixed(1) : '0'
  const weeklyContacts = stats?.contacts?.last7Days ?? 0
  const unreadInbox = stats?.inbox?.unread ?? 0
  const weeklyInbox = stats?.inbox?.last7Days ?? 0
  const isNewUser = totalContacts === 0 && openDeals === 0

  if (loading) {
    return (
      <div className="p-3 sm:p-6 max-w-5xl mx-auto">
        <div className="animate-pulse space-y-6">
          <div className="h-8 bg-muted rounded-lg w-48" />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => <div key={i} className="h-28 bg-muted rounded-xl" />)}
          </div>
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => <div key={i} className="h-16 bg-muted rounded-xl" />)}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="p-3 sm:p-6 max-w-5xl mx-auto">
      {/* Header + Quick Actions */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{greeting}</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {isNewUser ? "Let's get your CRM set up." : "Here's what needs your attention today."}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {[
            { icon: UserPlus, label: 'Add Contact', href: '/backend/contacts' },
            { icon: FileText, label: 'Create Page', href: '/backend/landing-pages/create' },
            { icon: DollarSign, label: 'New Deal', href: '/backend/customers/deals/pipeline' },
            { icon: Send, label: 'Send Email', href: '/backend/email' },
            { icon: BookOpen, label: 'Create Course', href: '/backend/courses' },
            { icon: CalendarPlus, label: 'New Booking', href: '/backend/calendar' },
            { icon: BarChart3, label: 'Reports', href: '/backend/reports' },
          ].map(a => (
            <Button key={a.label} type="button" variant="outline" size="sm" onClick={() => window.location.href = a.href}>
              <a.icon className="size-3.5 mr-1.5" /> {a.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Needs Attention */}
      <NeedsAttention />

      {/* Action Items */}
      {data?.actionItems && data.actionItems.filter(item => !dismissedItems.has(`${item.type}:${item.title}`)).length > 0 && (
        <div className="mb-8">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Action Items</h2>
          <div className="space-y-2">
            {data.actionItems.slice(0, 5).map((item, i) => {
              if (dismissedItems.has(`${item.type}:${item.title}`)) return null
              const Icon = actionIcons[item.type] || AlertCircle
              return (
                <div key={i} className="flex items-center gap-3 px-4 py-3 rounded-xl border hover:bg-muted/50 hover:border-accent/20 transition group">
                  <a href={item.href} className="flex items-center gap-3 flex-1 min-w-0">
                    <div className="size-9 rounded-lg bg-accent/10 flex items-center justify-center shrink-0">
                      <Icon className="size-4 text-accent" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium group-hover:text-accent transition">{item.title}</p>
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">{item.description}</p>
                    </div>
                  </a>
                  <button type="button" onClick={() => {
                    const key = `${item.type}:${item.title}`
                    setDismissedItems(prev => {
                      const next = new Set([...prev, key])
                      document.cookie = `crm_dismissed_actions=${encodeURIComponent(JSON.stringify([...next]))}; path=/; max-age=${60 * 60 * 24 * 7}`
                      return next
                    })
                  }}
                    className="p-1.5 text-muted-foreground/30 hover:text-muted-foreground transition shrink-0" title="Dismiss">
                    <X className="size-3.5" />
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard icon={Mail} label="Inbox" value={unreadInbox > 0 ? `${unreadInbox} unread` : '0 unread'}
          change={weeklyInbox > 0 ? `${weeklyInbox} received this week` : undefined}
          trend={unreadInbox > 0 ? 'up' : undefined}
          href="/backend/inbox" />
        <StatCard icon={Users} label="Contacts" value={totalContacts.toLocaleString()}
          change={weeklyContacts > 0 ? `+${weeklyContacts} this week` : undefined}
          trend={weeklyContacts > 0 ? 'up' : undefined}
          href="/backend/contacts" />
        <StatCard icon={Target} label="Pipeline" value={`$${pipelineValue.toLocaleString()}`}
          change={openDeals > 0 ? `${openDeals} open deal${openDeals !== 1 ? 's' : ''}` : undefined}
          href="/backend/customers/deals/pipeline" />
        <StatCard icon={Activity} label="Conversion" value={`${convRate}%`}
          change={submissions > 0 ? `${submissions} leads from ${pageViews} views` : undefined}
          trend={submissions > 0 ? 'up' : undefined}
          href="/backend/reports" />
      </div>

      {/* Two-column layout for leads + activity */}
      <div className="grid lg:grid-cols-2 gap-6 mb-8">
        <HottestLeads />
        <RecentActivitySection activity={data?.recentActivity || []} />
      </div>

      {/* Relationship Decay */}
      <RelationshipDecay />

      {/* Empty state */}
      {!isNewUser && !data?.actionItems?.length && !data?.recentActivity?.length && (
        <div className="text-center py-16 mt-8">
          <div className="size-14 rounded-2xl bg-emerald-100 dark:bg-emerald-900/20 flex items-center justify-center mx-auto mb-4">
            <CheckCircle2 className="size-7 text-emerald-600" />
          </div>
          <p className="text-sm font-semibold">You're all caught up!</p>
          <p className="text-xs text-muted-foreground mt-1">No action items right now. Check back later.</p>
        </div>
      )}
    </div>
  )
}

function StatCard({ icon: Icon, label, value, change, trend, href }: {
  icon: any; label: string; value: string; change?: string; trend?: 'up' | 'down'; href: string
}) {
  return (
    <a href={href} className="rounded-xl border bg-card p-4 hover:border-accent/30 hover:shadow-sm transition group">
      <div className="flex items-center justify-between mb-3">
        <div className="size-9 rounded-lg bg-accent/8 flex items-center justify-center">
          <Icon className="size-4 text-accent" />
        </div>
        <ArrowUpRight className="size-3.5 text-muted-foreground/30 group-hover:text-accent transition" />
      </div>
      <p className="text-2xl font-bold tabular-nums tracking-tight">{value}</p>
      <div className="flex items-center gap-1 mt-1">
        <span className="text-xs text-muted-foreground">{label}</span>
        {change && trend === 'up' && <TrendingUp className="size-3 text-emerald-500" />}
      </div>
      {change && <p className="text-[11px] text-muted-foreground/70 mt-0.5">{change}</p>}
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
            className={`flex items-center gap-3 px-4 py-3 rounded-xl border ${
              alert.type === 'urgent'
                ? 'border-red-200 bg-red-50/50 dark:border-red-900/50 dark:bg-red-900/10'
                : 'border-amber-200 bg-amber-50/50 dark:border-amber-900/50 dark:bg-amber-900/10'
            }`}>
            <Mail className={`size-4 shrink-0 ${alert.type === 'urgent' ? 'text-red-500' : 'text-amber-500'}`} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{alert.title}</p>
              <p className="text-xs text-muted-foreground">{alert.description}</p>
            </div>
            <Badge variant="secondary" className={`text-[10px] shrink-0 ${
              alert.type === 'urgent'
                ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
            }`}>{alert.type}</Badge>
            <a href="/backend/inbox" className="text-xs text-accent hover:underline shrink-0 font-medium">View</a>
          </div>
        ))}
      </div>
    </div>
  )
}

function HottestLeads() {
  const [leads, setLeads] = useState<Array<{ id: string; display_name: string; primary_email: string; score: number }>>([])

  useEffect(() => {
    fetch('/api/customers/engagement?view=hottest', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.ok && d.data?.length) setLeads(d.data.slice(0, 5)) })
      .catch(() => {})
  }, [])

  if (leads.length === 0) return (
    <div>
      <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
        <Flame className="size-3.5 text-orange-500" /> Hottest Leads
      </h2>
      <div className="rounded-xl border p-6 text-center">
        <Flame className="size-6 mx-auto text-muted-foreground/20 mb-2" />
        <p className="text-xs text-muted-foreground">No hot leads yet. Engagement scores build as contacts interact with your content.</p>
      </div>
    </div>
  )

  const maxScore = Math.max(...leads.map(l => l.score), 1)

  return (
    <div>
      <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
        <Flame className="size-3.5 text-orange-500" /> Hottest Leads
      </h2>
      <div className="rounded-xl border divide-y">
        {leads.map(lead => (
          <a key={lead.id} href="/backend/contacts"
            className="flex items-center gap-3 px-4 py-3 hover:bg-muted/30 transition">
            <div className="size-8 rounded-full bg-accent/10 flex items-center justify-center text-xs font-bold text-accent shrink-0">
              {(lead.display_name || '?')[0].toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{lead.display_name}</p>
              <p className="text-xs text-muted-foreground truncate">{lead.primary_email}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
                <div className="h-full bg-orange-400 rounded-full" style={{ width: `${(lead.score / maxScore) * 100}%` }} />
              </div>
              <span className="text-xs font-semibold tabular-nums text-orange-600 dark:text-orange-400 w-6 text-right">{lead.score}</span>
            </div>
          </a>
        ))}
      </div>
    </div>
  )
}

function RecentActivitySection({ activity }: { activity: Array<{ type: string; text: string; time: string }> }) {
  if (activity.length === 0) return (
    <div>
      <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
        <Activity className="size-3.5" /> Recent Activity
      </h2>
      <div className="rounded-xl border p-6 text-center">
        <Activity className="size-6 mx-auto text-muted-foreground/20 mb-2" />
        <p className="text-xs text-muted-foreground">No recent activity. Activity will appear here as you use the CRM.</p>
      </div>
    </div>
  )

  return (
    <div>
      <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
        <Activity className="size-3.5" /> Recent Activity
      </h2>
      <div className="rounded-xl border divide-y">
        {activity.slice(0, 5).map((item, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3">
            <div className="size-2 rounded-full bg-accent shrink-0" />
            <span className="flex-1 text-sm text-muted-foreground truncate">{item.text}</span>
            <span className="text-[11px] text-muted-foreground/50 shrink-0 tabular-nums">{formatRelativeTime(item.time)}</span>
          </div>
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

  useEffect(() => {
    fetch('/api/ai/relationship-decay', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.ok && d.data?.length) setAlerts(d.data) })
      .catch(() => {})
  }, [])

  if (alerts.length === 0) return null

  return (
    <div>
      <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
        <HeartCrack className="size-3.5 text-amber-500" /> Fading Relationships
      </h2>
      <div className="rounded-xl border divide-y">
        {alerts.slice(0, 5).map(alert => (
          <div key={alert.contactId} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/30 transition">
            <div className={`size-2 rounded-full shrink-0 ${alert.severity === 'red' ? 'bg-red-500' : 'bg-amber-400'}`} />
            <div className="size-8 rounded-full bg-muted flex items-center justify-center text-xs font-bold text-muted-foreground shrink-0">
              {(alert.displayName || '?')[0].toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{alert.displayName}</p>
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Clock className="size-3" />
                {alert.currentGapDays}d since last contact · avg every {alert.avgFrequencyDays}d
              </p>
            </div>
            <Badge variant="secondary" className={`text-[10px] shrink-0 ${
              alert.severity === 'red'
                ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
            }`}>{alert.severity === 'red' ? 'Fading' : 'Cooling'}</Badge>
            <a href={`/backend/email?compose=true&to=${encodeURIComponent(alert.email)}&subject=${encodeURIComponent('Checking in')}&contactId=${alert.contactId}&name=${encodeURIComponent(alert.displayName || '')}`}
              className="text-xs text-accent hover:underline shrink-0 font-medium">Follow up</a>
          </div>
        ))}
      </div>
      {alerts.length > 5 && (
        <p className="text-xs text-muted-foreground mt-2 text-center">+{alerts.length - 5} more need attention</p>
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
