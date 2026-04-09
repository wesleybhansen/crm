'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Switch } from '@open-mercato/ui/primitives/switch'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import {
  Plus, Zap, Trash2, Mail, Tag, ArrowRight, CheckSquare, GitBranch,
  Globe, MessageSquare, X, Loader2, MoreHorizontal, Search, Copy,
  Clock, Play, Pause, AlertTriangle, Users, FileText, Calendar,
  ShoppingCart, GraduationCap, ArrowUpRight, Sparkles, Bell,
  LayoutGrid, Filter, History, Info, Wand2, ChevronUp, ChevronDown, Timer,
  CalendarClock, RotateCcw, Briefcase, Heart, Star, Phone, Gift, RefreshCw,
  MessageCircle, Send, Bot, FlaskConical, CheckCircle2, XCircle,
  SkipForward, ChevronRight,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StepItem = {
  type: 'action' | 'delay'
  actionType?: string
  actionConfig?: Record<string, any>
  delayMinutes?: number
}

type AutomationRule = {
  id: string
  name: string
  description: string | null
  trigger_type: string
  trigger_config: Record<string, any>
  action_type: string
  action_config: Record<string, any>
  steps: StepItem[] | null
  conditions: Array<{ field: string; operator: string; value?: any }> | null
  status: string
  template_id: string | null
  is_active: boolean
  created_at: string
  updated_at: string
  execution_count: number
  last_executed_at: string | null
}

type Template = {
  id: string
  name: string
  category: string
  icon: string
  description: string
  popular?: boolean
  trigger: { type: string; config?: Record<string, any> }
  conditions?: Array<{ field: string; operator: string; value?: any }>
  actions: Array<{ type: string; config: Record<string, any> }>
}

type StatusFilter = 'all' | 'active' | 'paused' | 'error'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TRIGGER_TYPE_GROUPS = [
  {
    label: 'Contacts',
    items: [
      { id: 'contact_created', label: 'Contact Created', icon: Users },
      { id: 'contact_updated', label: 'Contact Updated', icon: Users },
      { id: 'company_created', label: 'Company Created', icon: Users },
    ],
  },
  {
    label: 'Tags',
    items: [
      { id: 'tag_added', label: 'Tag Added', icon: Tag },
      { id: 'tag_removed', label: 'Tag Removed', icon: Tag },
    ],
  },
  {
    label: 'Deals',
    items: [
      { id: 'deal_created', label: 'Deal Created', icon: ArrowUpRight },
      { id: 'deal_won', label: 'Deal Won', icon: ArrowUpRight },
      { id: 'deal_lost', label: 'Deal Lost', icon: AlertTriangle },
      { id: 'stage_change', label: 'Pipeline Stage Changed', icon: ArrowRight },
    ],
  },
  {
    label: 'Payments',
    items: [
      { id: 'invoice_paid', label: 'Invoice Paid', icon: ShoppingCart },
      { id: 'invoice_overdue', label: 'Invoice Overdue', icon: AlertTriangle },
    ],
  },
  {
    label: 'Scheduled',
    items: [
      { id: 'schedule', label: 'Scheduled Trigger', icon: CalendarClock },
    ],
  },
  {
    label: 'Other',
    items: [
      { id: 'form_submitted', label: 'Form Submitted', icon: FileText },
      { id: 'booking_created', label: 'Booking Created', icon: Calendar },
      { id: 'course_enrolled', label: 'Course Enrolled', icon: GraduationCap },
    ],
  },
] as const

const TRIGGER_TYPES = TRIGGER_TYPE_GROUPS.flatMap(group => group.items)

const ACTION_TYPES = [
  { id: 'send_email', label: 'Send Email', icon: Mail },
  { id: 'send_sms', label: 'Send SMS', icon: MessageSquare },
  { id: 'add_tag', label: 'Add Tag', icon: Tag },
  { id: 'remove_tag', label: 'Remove Tag', icon: Tag },
  { id: 'move_to_stage', label: 'Move to Stage', icon: ArrowRight },
  { id: 'create_task', label: 'Create Task', icon: CheckSquare },
  { id: 'add_to_list', label: 'Add to Mailing List', icon: Users },
  { id: 'enroll_in_sequence', label: 'Enroll in Sequence', icon: GitBranch },
  { id: 'webhook', label: 'Webhook', icon: Globe },
] as const

const CONDITION_FIELDS = [
  { id: 'source', label: 'Source' },
  { id: 'lifecycle_stage', label: 'Lifecycle Stage' },
  { id: 'primary_email', label: 'Email' },
  { id: 'display_name', label: 'Name' },
] as const

const CONDITION_OPERATORS = [
  { id: 'equals', label: 'equals' },
  { id: 'not_equals', label: 'does not equal' },
  { id: 'contains', label: 'contains' },
  { id: 'not_contains', label: 'does not contain' },
  { id: 'starts_with', label: 'starts with' },
  { id: 'is_set', label: 'is set' },
  { id: 'is_not_set', label: 'is not set' },
] as const

const TEMPLATE_CATEGORIES = [
  { id: 'all', label: 'All Templates' },
  { id: 'sales', label: 'Sales' },
  { id: 'marketing', label: 'Marketing' },
  { id: 'customer_success', label: 'Customer Success' },
  { id: 'operations', label: 'Operations' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'solopreneur', label: 'Small Business' },
] as const

const CATEGORY_ICONS: Record<string, typeof Zap> = {
  sales: ArrowUpRight,
  marketing: Sparkles,
  customer_success: Users,
  operations: GitBranch,
  notifications: Bell,
  solopreneur: Briefcase,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function triggerLabel(type: string): string {
  return TRIGGER_TYPES.find(t => t.id === type)?.label ?? type
}

function actionLabel(type: string): string {
  return ACTION_TYPES.find(a => a.id === type)?.label ?? type
}

function relativeTime(dateStr: string | null): string {
  if (!dateStr) return 'Never'
  const diff = Date.now() - new Date(dateStr).getTime()
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(dateStr).toLocaleDateString()
}

function formatDelay(minutes: number): string {
  if (minutes < 60) return `${minutes}m`
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`
  if (minutes < 10080) return `${Math.round(minutes / 1440)}d`
  return `${Math.round(minutes / 10080)}w`
}

function formatDelayLong(minutes: number): string {
  if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''}`
  const hours = Math.round(minutes / 60)
  if (minutes < 1440) return `${hours} hour${hours !== 1 ? 's' : ''}`
  const days = Math.round(minutes / 1440)
  if (minutes < 10080) return `${days} day${days !== 1 ? 's' : ''}`
  const weeks = Math.round(minutes / 10080)
  return `${weeks} week${weeks !== 1 ? 's' : ''}`
}

function parseSteps(rule: AutomationRule): StepItem[] {
  if (rule.steps) {
    const parsed = typeof rule.steps === 'string' ? JSON.parse(rule.steps as unknown as string) : rule.steps
    if (Array.isArray(parsed) && parsed.length > 0) return parsed
  }
  // Legacy single-action: convert to single step
  return [{ type: 'action', actionType: rule.action_type, actionConfig: typeof rule.action_config === 'string' ? JSON.parse(rule.action_config) : (rule.action_config ?? {}) }]
}

function actionSummary(rule: AutomationRule): string {
  const config = typeof rule.action_config === 'string'
    ? JSON.parse(rule.action_config)
    : (rule.action_config ?? {})
  switch (rule.action_type) {
    case 'send_email': return config.subject ?? 'No subject'
    case 'send_sms': return config.message ?? ''
    case 'add_tag': case 'remove_tag': return config.tagName ?? ''
    case 'move_to_stage': return config.stage ?? ''
    case 'create_task': return config.title ?? config.taskTitle ?? ''
    case 'enroll_in_sequence': return config.sequenceName ?? ''
    case 'webhook': return config.url ?? ''
    case 'add_to_list': return 'Mailing list'
    default: return ''
  }
}

function conditionSummary(conditions: AutomationRule['conditions']): string | null {
  if (!conditions || conditions.length === 0) return null
  const first = conditions[0]
  const fieldLabel = CONDITION_FIELDS.find(f => f.id === first.field)?.label ?? first.field
  const opLabel = CONDITION_OPERATORS.find(o => o.id === first.operator)?.label ?? first.operator
  const valueDisplay = first.value != null ? `"${first.value}"` : ''
  const suffix = conditions.length > 1 ? ` +${conditions.length - 1} more` : ''
  return `${fieldLabel} ${opLabel} ${valueDisplay}${suffix}`
}

function statusColor(status: string): string {
  switch (status) {
    case 'active': return 'bg-emerald-500'
    case 'paused': return 'bg-amber-400'
    case 'error': return 'bg-red-500'
    default: return 'bg-slate-400'
  }
}

function statusBadgeClasses(status: string): string {
  switch (status) {
    case 'active': return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
    case 'paused': return 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
    case 'error': return 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400'
    default: return 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
  }
}

// ---------------------------------------------------------------------------
// InfoTip
// ---------------------------------------------------------------------------

function InfoTip({ text }: { text: string }) {
  return (
    <span className="group relative ml-1 inline-flex">
      <Info className="size-3.5 text-muted-foreground/50 cursor-help" />
      <span className="pointer-events-none absolute bottom-full right-0 mb-1.5 w-52 rounded-md bg-foreground px-2.5 py-1.5 text-[10px] leading-tight text-background opacity-0 shadow-lg transition group-hover:opacity-100 z-50">
        {text}
      </span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Pill({ variant, children }: { variant: 'trigger' | 'action' | 'condition' | 'value'; children: React.ReactNode }) {
  const classes: Record<string, string> = {
    trigger: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
    action: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
    condition: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
    value: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
  }
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${classes[variant]}`}>
      {children}
    </span>
  )
}

function KebabMenu({ onEdit, onDuplicate, onHistory, onTest, onDelete }: {
  onEdit: () => void
  onDuplicate: () => void
  onHistory: () => void
  onTest: () => void
  onDelete: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClick(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <IconButton
        type="button"
        variant="ghost"
        size="sm"
        onClick={(event) => { event.stopPropagation(); setOpen(prev => !prev) }}
        aria-label="More actions"
      >
        <MoreHorizontal className="size-4" />
      </IconButton>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-44 rounded-lg border bg-card shadow-lg py-1">
          <Button type="button" variant="ghost" size="sm" className="w-full justify-start rounded-none h-8 px-3 text-xs"
            onClick={(event) => { event.stopPropagation(); setOpen(false); onEdit() }}>
            <FileText className="size-3.5 mr-2" /> Edit
          </Button>
          <Button type="button" variant="ghost" size="sm" className="w-full justify-start rounded-none h-8 px-3 text-xs"
            onClick={(event) => { event.stopPropagation(); setOpen(false); onDuplicate() }}>
            <Copy className="size-3.5 mr-2" /> Duplicate
          </Button>
          <Button type="button" variant="ghost" size="sm" className="w-full justify-start rounded-none h-8 px-3 text-xs"
            onClick={(event) => { event.stopPropagation(); setOpen(false); onHistory() }}>
            <History className="size-3.5 mr-2" /> View History
          </Button>
          <Button type="button" variant="ghost" size="sm" className="w-full justify-start rounded-none h-8 px-3 text-xs"
            onClick={(event) => { event.stopPropagation(); setOpen(false); onTest() }}>
            <FlaskConical className="size-3.5 mr-2" /> Test
          </Button>
          <div className="my-1 border-t" />
          <Button type="button" variant="ghost" size="sm" className="w-full justify-start rounded-none h-8 px-3 text-xs text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20"
            onClick={(event) => { event.stopPropagation(); setOpen(false); onDelete() }}>
            <Trash2 className="size-3.5 mr-2" /> Delete
          </Button>
        </div>
      )}
    </div>
  )
}

function LogEntry({ log }: { log: any }) {
  const [expanded, setExpanded] = useState(false)

  const triggerData = typeof log.trigger_data === 'string'
    ? (() => { try { return JSON.parse(log.trigger_data) } catch { return {} } })()
    : (log.trigger_data || {})
  const actionResult = typeof log.action_result === 'string'
    ? (() => { try { return JSON.parse(log.action_result) } catch { return {} } })()
    : (log.action_result || {})
  const isTest = triggerData?._testExecution

  const status = isTest ? 'test' : (log.status || 'executed')
  const contactLabel = triggerData?.contactName || triggerData?.contactEmail || triggerData?.contact_name || triggerData?.contact_email || null
  const durationMs = log.duration_ms ?? (log.ended_at && log.started_at
    ? new Date(log.ended_at).getTime() - new Date(log.started_at).getTime()
    : null)

  const statusIconMap: Record<string, React.ReactNode> = {
    test: <FlaskConical className="size-3 text-blue-500" />,
    executed: <CheckCircle2 className="size-3 text-emerald-500" />,
    success: <CheckCircle2 className="size-3 text-emerald-500" />,
    skipped: <SkipForward className="size-3 text-amber-500" />,
    failed: <XCircle className="size-3 text-red-500" />,
    error: <XCircle className="size-3 text-red-500" />,
  }
  const statusIcon = statusIconMap[status] || <CheckCircle2 className="size-3 text-muted-foreground" />

  const borderColorMap: Record<string, string> = {
    test: 'border-l-blue-400',
    executed: 'border-l-emerald-400',
    success: 'border-l-emerald-400',
    skipped: 'border-l-amber-400',
    failed: 'border-l-red-400',
    error: 'border-l-red-400',
  }
  const borderColor = borderColorMap[status] || 'border-l-muted-foreground'

  const errorMessage = actionResult?.error || actionResult?.message || log.error_message || null
  const stepsExecuted = actionResult?.stepsExecuted ?? actionResult?.steps_executed ?? null
  const conditionsPassed = actionResult?.conditionsPassed ?? actionResult?.conditions_passed ?? null
  const conditionsTotal = actionResult?.conditionsTotal ?? actionResult?.conditions_total ?? null
  const resultSummary = actionResult?.summary || actionResult?.result || null

  return (
    <div className={`border-l-2 ${borderColor} rounded-r`}>
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted/30 transition-colors rounded-r"
        onClick={() => setExpanded(!expanded)}
      >
        {statusIcon}
        <span className="text-muted-foreground">{relativeTime(log.executed_at || log.created_at)}</span>
        {contactLabel && (
          <>
            <span className="text-muted-foreground/50">&middot;</span>
            <span className="truncate max-w-[160px]">{contactLabel}</span>
          </>
        )}
        {durationMs != null && (
          <>
            <span className="text-muted-foreground/50">&middot;</span>
            <span className="text-muted-foreground">{durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`}</span>
          </>
        )}
        {isTest && (
          <span className="ml-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
            Test
          </span>
        )}
        <span className="flex-1" />
        <ChevronDown className={`size-3 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>

      {expanded && (
        <div className="px-3 pb-2 pl-8 space-y-1 text-xs text-muted-foreground">
          {log.trigger_type && (
            <div><span className="font-medium text-foreground/70">Trigger:</span> {log.trigger_type.replace(/_/g, ' ')}</div>
          )}
          {contactLabel && triggerData?.contactEmail && triggerData?.contactEmail !== contactLabel && (
            <div><span className="font-medium text-foreground/70">Contact:</span> {triggerData.contactEmail}</div>
          )}
          {conditionsPassed != null && conditionsTotal != null && (
            <div><span className="font-medium text-foreground/70">Conditions:</span> {conditionsPassed === conditionsTotal ? 'All passed' : `${conditionsPassed} passed`} ({conditionsPassed}/{conditionsTotal})</div>
          )}
          {stepsExecuted != null && (
            <div><span className="font-medium text-foreground/70">Steps:</span> {stepsExecuted} executed</div>
          )}
          {resultSummary && (
            <div><span className="font-medium text-foreground/70">Result:</span> {resultSummary}</div>
          )}
          {errorMessage && status !== 'executed' && status !== 'success' && (
            <div className="text-red-500"><span className="font-medium">Error:</span> {errorMessage}</div>
          )}
        </div>
      )}
    </div>
  )
}

function SentenceCard({
  rule,
  onEdit,
  onToggle,
  onDuplicate,
  onDelete,
  onRunNow,
  onTest,
  onToggleHistory,
  historyExpanded,
  historyLoading: histLoading,
  historyLogs: histLogs,
}: {
  rule: AutomationRule
  onEdit: () => void
  onToggle: () => void
  onDuplicate: () => void
  onDelete: () => void
  onRunNow?: () => void
  onTest: () => void
  onToggleHistory: () => void
  historyExpanded: boolean
  historyLoading: boolean
  historyLogs: Array<any> | undefined
}) {
  const condText = conditionSummary(rule.conditions)
  const steps = parseSteps(rule)
  const isMultiStep = steps.length > 1

  return (
    <div
      onClick={onEdit}
      className="group rounded-lg border bg-card hover:border-primary/30 hover:shadow-sm transition-all cursor-pointer"
    >
      {/* Sentence line */}
      <div className="px-4 pt-3.5 pb-2">
        <div className="flex items-start gap-2">
          <span className={`mt-1.5 shrink-0 size-2 rounded-full ${statusColor(rule.status)}`} />
          <div className="flex flex-wrap items-center gap-1.5 text-sm leading-relaxed min-w-0">
            <span className="text-muted-foreground font-medium">When</span>
            <Pill variant="trigger">{triggerLabel(rule.trigger_type)}</Pill>
            {rule.trigger_type === 'schedule' && (() => {
              const tc = typeof rule.trigger_config === 'string' ? JSON.parse(rule.trigger_config) : (rule.trigger_config || {})
              const scheduleLabels: Record<string, string> = { invoice_overdue: 'Overdue Invoices', stale_deals: 'Stale Deals', inactive_contacts: 'Inactive Contacts', daily_summary: 'Daily Summary' }
              return <Pill variant="value">{scheduleLabels[tc.scheduleType] || tc.scheduleType || 'Manual'}</Pill>
            })()}
            {condText && (
              <>
                <span className="text-muted-foreground font-medium">if</span>
                <Pill variant="condition">{condText}</Pill>
              </>
            )}
            <span className="text-muted-foreground font-medium">then</span>
            {isMultiStep ? (
              steps.map((step, idx) => (
                <span key={idx} className="inline-flex items-center gap-1.5">
                  {idx > 0 && <ArrowRight className="size-3 text-muted-foreground/50" />}
                  {step.type === 'delay' ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300">
                      <Timer className="size-3" /> {formatDelay(step.delayMinutes || 60)}
                    </span>
                  ) : (
                    <Pill variant="action">{actionLabel(step.actionType || '')}</Pill>
                  )}
                </span>
              ))
            ) : (
              <>
                <Pill variant="action">{actionLabel(rule.action_type)}</Pill>
                {actionSummary(rule) && (
                  <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                    &ldquo;{actionSummary(rule)}&rdquo;
                  </span>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Meta line */}
      <div className="px-4 pb-3 flex items-center gap-3 text-xs text-muted-foreground pl-8">
        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider ${statusBadgeClasses(rule.status)}`}>
          {rule.status === 'active' && <Play className="size-2.5" />}
          {rule.status === 'paused' && <Pause className="size-2.5" />}
          {rule.status === 'error' && <AlertTriangle className="size-2.5" />}
          {rule.status}
        </span>
        <button
          type="button"
          className="flex items-center gap-1 hover:text-foreground transition-colors rounded px-1 -mx-1 hover:bg-muted/50"
          onClick={(event) => { event.stopPropagation(); onToggleHistory() }}
        >
          <Zap className="size-3" /> {rule.execution_count} run{rule.execution_count !== 1 ? 's' : ''}
          <ChevronDown className={`size-3 transition-transform ${historyExpanded ? 'rotate-180' : ''}`} />
        </button>
        {rule.last_executed_at && (
          <span className="flex items-center gap-1">
            <Clock className="size-3" /> Last: {relativeTime(rule.last_executed_at)}
          </span>
        )}
        <div className="flex-1" />
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(event) => event.stopPropagation()}>
          {rule.trigger_type === 'schedule' && onRunNow && (
            <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[10px] font-medium" onClick={onRunNow}>
              <RotateCcw className="size-3 mr-1" /> Run Now
            </Button>
          )}
          <KebabMenu
            onEdit={onEdit}
            onDuplicate={onDuplicate}
            onHistory={onToggleHistory}
            onTest={onTest}
            onDelete={onDelete}
          />
          <Switch
            checked={rule.status === 'active'}
            onCheckedChange={() => onToggle()}
            className="scale-75"
          />
        </div>
      </div>

      {/* Inline execution history */}
      {historyExpanded && (
        <div className="border-t px-4 py-3 bg-muted/20" onClick={(event) => event.stopPropagation()}>
          {histLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
              <Loader2 className="size-3 animate-spin" /> Loading history...
            </div>
          ) : !histLogs?.length ? (
            <p className="text-xs text-muted-foreground py-2">No executions yet</p>
          ) : (
            <div className="space-y-1">
              {histLogs.map((log: any) => (
                <LogEntry key={log.id} log={log} />
              ))}
              {histLogs.length >= 10 && (
                <button
                  type="button"
                  className="flex items-center gap-1 text-xs text-primary hover:underline pt-1"
                  onClick={onToggleHistory}
                >
                  View all <ChevronRight className="size-3" />
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Trigger / Action config field renderers
// ---------------------------------------------------------------------------

function useFetchOptions(endpoint: string | null) {
  const [options, setOptions] = useState<Array<{ id: string; name: string }>>([])
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    if (!endpoint || loaded) return
    setLoaded(true)
    fetch(endpoint, { credentials: 'include' }).then(r => r.json())
      .then(d => {
        if (endpoint.includes('business-profile')) {
          const ps = d.data?.pipeline_stages
          const parsed = typeof ps === 'string' ? JSON.parse(ps) : (ps || [])
          const fallback = ['New Lead', 'Contacted', 'Qualified', 'Proposal', 'Won', 'Lost']
          const stages = parsed.length > 0 ? parsed : fallback
          setOptions(stages.map((s: any) => ({ id: s.name || s, name: s.name || s })))
        } else {
          const items = d.data || d.items || []
          setOptions(items.map((i: any) => ({ id: i.id || i.slug, name: i.name || i.title || i.label || i.display_name || i.id })))
        }
      }).catch(() => {})
  }, [endpoint, loaded])
  return options
}

function TriggerConfigFields({ triggerType, config, onChange }: {
  triggerType: string
  config: Record<string, any>
  onChange: (config: Record<string, any>) => void
}) {
  const update = (key: string, value: any) => onChange({ ...config, [key]: value })
  const tags = useFetchOptions((triggerType === 'tag_added' || triggerType === 'tag_removed') ? '/api/crm-contact-tags' : null)
  const forms = useFetchOptions(triggerType === 'form_submitted' ? '/api/forms?pageSize=50' : null)
  const stages = useFetchOptions(triggerType === 'stage_change' ? '/api/business-profile' : null)

  switch (triggerType) {
    case 'contact_created':
    case 'contact_updated':
    case 'company_created':
      return (
        <div>
          <label className="text-[11px] font-medium text-muted-foreground block mb-1">Source filter (optional)<InfoTip text="Only trigger when the contact comes from this source (e.g., 'website', 'referral')" /></label>
          <select value={config.source ?? ''} onChange={event => update('source', event.target.value)}
            className="w-full h-9 rounded-md border bg-background px-3 text-sm">
            <option value="">Any source</option>
            <option value="website">Website</option>
            <option value="landing_page">Landing Page</option>
            <option value="form">Form</option>
            <option value="referral">Referral</option>
            <option value="manual">Manual</option>
            <option value="import">Import</option>
          </select>
        </div>
      )
    case 'tag_added': case 'tag_removed':
      return (
        <div>
          <label className="text-[11px] font-medium text-muted-foreground block mb-1">Tag<InfoTip text="Which tag triggers this automation" /></label>
          <select value={config.tagSlug ?? ''} onChange={event => update('tagSlug', event.target.value)}
            className="w-full h-9 rounded-md border bg-background px-3 text-sm">
            <option value="">Any tag</option>
            {tags.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
      )
    case 'form_submitted':
      return (
        <div>
          <label className="text-[11px] font-medium text-muted-foreground block mb-1">Form (optional)</label>
          <select value={config.formId ?? ''} onChange={event => update('formId', event.target.value)}
            className="w-full h-9 rounded-md border bg-background px-3 text-sm">
            <option value="">Any form</option>
            {forms.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </div>
      )
    case 'deal_created': case 'deal_won': case 'deal_lost':
      return null
    case 'invoice_overdue':
      return (
        <div>
          <label className="text-[11px] font-medium text-muted-foreground block mb-1">Days overdue (optional)<InfoTip text="Trigger after this many days past due date. Leave empty for any overdue invoice." /></label>
          <Input type="number" value={config.daysOverdue ?? ''} onChange={event => update('daysOverdue', event.target.value ? parseInt(event.target.value) : undefined)}
            placeholder="e.g. 7" className="h-9 text-sm w-24" />
        </div>
      )
    case 'stage_change':
      return (
        <div>
          <label className="text-[11px] font-medium text-muted-foreground block mb-1">To stage</label>
          <select value={config.toStage ?? ''} onChange={event => update('toStage', event.target.value)}
            className="w-full h-9 rounded-md border bg-background px-3 text-sm">
            <option value="">Any stage</option>
            {stages.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      )
    case 'schedule':
      return (
        <div className="space-y-3">
          <div>
            <label className="text-[11px] font-medium text-muted-foreground block mb-1">Schedule type<InfoTip text="What kind of records to check for on each run" /></label>
            <select value={config.scheduleType ?? 'daily_summary'} onChange={event => update('scheduleType', event.target.value)}
              className="w-full h-9 rounded-md border bg-background px-3 text-sm">
              <option value="invoice_overdue">Overdue Invoices</option>
              <option value="stale_deals">Stale Deals</option>
              <option value="inactive_contacts">Inactive Contacts</option>
              <option value="daily_summary">Daily Summary / Digest</option>
            </select>
          </div>
          {config.scheduleType === 'invoice_overdue' && (
            <div>
              <label className="text-[11px] font-medium text-muted-foreground block mb-1">Days overdue<InfoTip text="Number of days past the due date to trigger" /></label>
              <Input type="number" value={config.daysOverdue ?? 7} onChange={event => update('daysOverdue', parseInt(event.target.value) || 1)}
                placeholder="7" className="h-9 text-sm w-24" />
            </div>
          )}
          {config.scheduleType === 'stale_deals' && (
            <div>
              <label className="text-[11px] font-medium text-muted-foreground block mb-1">Stale after (days)<InfoTip text="Days since last update to consider a deal stale" /></label>
              <Input type="number" value={config.staleDays ?? 7} onChange={event => update('staleDays', parseInt(event.target.value) || 1)}
                placeholder="7" className="h-9 text-sm w-24" />
            </div>
          )}
          {config.scheduleType === 'inactive_contacts' && (
            <div>
              <label className="text-[11px] font-medium text-muted-foreground block mb-1">Inactive for (days)<InfoTip text="Days since last activity to consider a contact inactive" /></label>
              <Input type="number" value={config.inactiveDays ?? 30} onChange={event => update('inactiveDays', parseInt(event.target.value) || 1)}
                placeholder="30" className="h-9 text-sm w-24" />
            </div>
          )}
          <div>
            <label className="text-[11px] font-medium text-muted-foreground block mb-1">Check interval<InfoTip text="How often this automation checks for matching records. Runs when you visit this page or on a schedule." /></label>
            <select value={config.intervalMinutes ?? 1440} onChange={event => update('intervalMinutes', parseInt(event.target.value))}
              className="w-full h-9 rounded-md border bg-background px-3 text-sm">
              <option value={60}>Every hour</option>
              <option value={120}>Every 2 hours</option>
              <option value={360}>Every 6 hours</option>
              <option value={720}>Every 12 hours</option>
              <option value={1440}>Daily</option>
              <option value={10080}>Weekly</option>
            </select>
          </div>
        </div>
      )
    default:
      return null
  }
}

function TagPickerActionField({ config, onChange }: { config: Record<string, any>; onChange: (c: Record<string, any>) => void }) {
  const tags = useFetchOptions('/api/crm-contact-tags')
  return (
    <div>
      <label className="text-[11px] font-medium text-muted-foreground block mb-1">Tag</label>
      <select value={config.tagName ?? ''} onChange={e => onChange({ ...config, tagName: e.target.value })}
        className="w-full h-9 rounded-md border bg-background px-3 text-sm">
        <option value="">Select a tag...</option>
        {tags.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
      </select>
      <p className="text-[10px] text-muted-foreground mt-1">Or type a new tag name to create it</p>
      <Input value={config.tagName ?? ''} onChange={e => onChange({ ...config, tagName: e.target.value })}
        placeholder="Or type a new tag name" className="h-8 text-xs mt-1" />
    </div>
  )
}

function StagePickerActionField({ config, onChange }: { config: Record<string, any>; onChange: (c: Record<string, any>) => void }) {
  const [stages, setStages] = useState<string[]>([])
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    if (loaded) return
    setLoaded(true)
    fetch('/api/customers/business-profile', { credentials: 'include' }).then(r => r.json())
      .then(d => {
        const ps = d.data?.pipeline_stages
        const parsed = typeof ps === 'string' ? JSON.parse(ps) : (ps || [])
        const names = parsed.map((s: any) => s.name || s).filter(Boolean)
        setStages(names.length > 0 ? names : ['New Lead', 'Contacted', 'Qualified', 'Proposal', 'Won', 'Lost'])
      }).catch(() => setStages(['New Lead', 'Contacted', 'Qualified', 'Proposal', 'Won', 'Lost']))
  }, [loaded])
  return (
    <div>
      <label className="text-[11px] font-medium text-muted-foreground block mb-1">Stage</label>
      <select value={config.stage ?? ''} onChange={e => onChange({ ...config, stage: e.target.value })}
        className="w-full h-9 rounded-md border bg-background px-3 text-sm">
        <option value="">Select a stage...</option>
        {stages.map(s => <option key={s} value={s}>{s}</option>)}
      </select>
    </div>
  )
}

function SequencePickerField({ config, onChange }: { config: Record<string, any>; onChange: (c: Record<string, any>) => void }) {
  const [sequences, setSequences] = useState<Array<{ id: string; name: string }>>([])
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    if (loaded) return
    setLoaded(true)
    fetch('/api/sequences', { credentials: 'include' }).then(r => r.json())
      .then(d => {
        const items = d.data || d.items || []
        setSequences(items.map((s: any) => ({ id: s.id, name: s.name })))
      }).catch(() => {})
  }, [loaded])
  return (
    <div>
      <label className="text-[11px] font-medium text-muted-foreground block mb-1">Sequence</label>
      <select value={config.sequenceId ?? ''} onChange={e => {
        const seq = sequences.find(s => s.id === e.target.value)
        onChange({ ...config, sequenceId: e.target.value || undefined, sequenceName: seq?.name || '' })
      }} className="w-full h-9 rounded-md border bg-background px-3 text-sm">
        <option value="">Select a sequence...</option>
        {sequences.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </div>
  )
}

function ActionConfigFields({ actionType, config, onChange }: {
  actionType: string
  config: Record<string, any>
  onChange: (config: Record<string, any>) => void
}) {
  const update = (key: string, value: any) => onChange({ ...config, [key]: value })

  switch (actionType) {
    case 'send_email':
      return (
        <div className="space-y-3">
          <div>
            <label className="text-[11px] font-medium text-muted-foreground block mb-1">Subject<InfoTip text="The subject line of the automated email. Use {{firstName}} for personalization." /></label>
            <Input value={config.subject ?? ''} onChange={event => update('subject', event.target.value)}
              placeholder="Email subject (supports {{firstName}})" className="h-9 text-sm" />
          </div>
          <div>
            <label className="text-[11px] font-medium text-muted-foreground block mb-1">Body<InfoTip text="The email body. Use {{firstName}}, {{email}}, {{company}} for dynamic content." /></label>
            <Textarea value={config.bodyHtml ?? ''} onChange={event => update('bodyHtml', event.target.value)}
              placeholder="Email body HTML" className="text-sm min-h-[80px]" />
          </div>
          <div>
            <label className="text-[11px] font-medium text-muted-foreground block mb-1">From email (optional)</label>
            <Input value={config.fromEmail ?? ''} onChange={event => update('fromEmail', event.target.value)}
              placeholder="Uses default sender if empty" className="h-9 text-sm" />
          </div>
        </div>
      )
    case 'send_sms':
      return (
        <div>
          <label className="text-[11px] font-medium text-muted-foreground block mb-1">Message</label>
          <Textarea value={config.message ?? ''} onChange={event => update('message', event.target.value)}
            placeholder="SMS message" className="text-sm min-h-[60px]" />
        </div>
      )
    case 'add_tag': case 'remove_tag':
      return <TagPickerActionField config={config} onChange={onChange} />
    case 'move_to_stage':
      return <StagePickerActionField config={config} onChange={onChange} />
    case 'create_task':
      return (
        <div className="space-y-3">
          <div>
            <label className="text-[11px] font-medium text-muted-foreground block mb-1">Task title<InfoTip text="The title for the auto-created task" /></label>
            <Input value={config.title ?? ''} onChange={event => update('title', event.target.value)}
              placeholder="Follow up with contact" className="h-9 text-sm" />
          </div>
          <div>
            <label className="text-[11px] font-medium text-muted-foreground block mb-1">Due in (days, optional)<InfoTip text="Number of days from trigger to set the task due date" /></label>
            <Input type="number" value={config.dueDays ?? ''} onChange={event => update('dueDays', event.target.value ? parseInt(event.target.value) : undefined)}
              placeholder="3" className="h-9 text-sm w-24" />
          </div>
        </div>
      )
    case 'enroll_in_sequence':
      return <SequencePickerField config={config} onChange={onChange} />
    case 'webhook':
      return (
        <div className="space-y-3">
          <div>
            <label className="text-[11px] font-medium text-muted-foreground block mb-1">URL<InfoTip text="The external URL to send event data to via HTTP POST" /></label>
            <Input value={config.url ?? ''} onChange={event => update('url', event.target.value)}
              placeholder="https://example.com/webhook" className="h-9 text-sm" />
          </div>
          <div>
            <label className="text-[11px] font-medium text-muted-foreground block mb-1">Method</label>
            <select value={config.method ?? 'POST'} onChange={event => update('method', event.target.value)}
              className="w-full h-9 rounded-md border bg-background px-3 text-sm">
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
              <option value="GET">GET</option>
            </select>
          </div>
        </div>
      )
    case 'add_to_list':
      return <AddToListConfig config={config} onChange={onChange} />
    default:
      return null
  }
}

function AddToListConfig({ config, onChange }: { config: Record<string, any>; onChange: (c: Record<string, any>) => void }) {
  const [lists, setLists] = useState<Array<{ id: string; name: string }>>([])
  useEffect(() => {
    fetch('/api/email-lists', { credentials: 'include' }).then(r => r.json())
      .then(d => { if (d.ok) setLists((d.data || []).map((l: any) => ({ id: l.id, name: l.name }))) }).catch(() => {})
  }, [])
  return (
    <div>
      <label className="text-[11px] font-medium text-muted-foreground block mb-1">Mailing List</label>
      <select value={config.listId ?? ''} onChange={e => onChange({ ...config, listId: e.target.value })}
        className="w-full h-9 rounded-md border bg-background px-3 text-sm">
        <option value="">Select a list...</option>
        {lists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
      </select>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ConditionEditor
// ---------------------------------------------------------------------------

function ConditionEditor({ conditions, onChange }: {
  conditions: Array<{ field: string; operator: string; value?: any }>
  onChange: (conditions: Array<{ field: string; operator: string; value?: any }>) => void
}) {
  const addCondition = () => {
    onChange([...conditions, { field: 'source', operator: 'equals', value: '' }])
  }

  const updateCondition = (index: number, updates: Partial<{ field: string; operator: string; value?: any }>) => {
    const next = conditions.map((condition, idx) => idx === index ? { ...condition, ...updates } : condition)
    onChange(next)
  }

  const removeCondition = (index: number) => {
    onChange(conditions.filter((_, idx) => idx !== index))
  }

  const needsValue = (operator: string) => operator !== 'is_set' && operator !== 'is_not_set'

  return (
    <div className="space-y-2">
      {conditions.map((condition, index) => (
        <div key={index} className="flex items-center gap-2">
          <div className="flex-1 relative">
            {index === 0 && <label className="text-[10px] text-muted-foreground mb-0.5 flex items-center">Field<InfoTip text="The contact or deal field to check" /></label>}
            <select value={condition.field} onChange={event => updateCondition(index, { field: event.target.value })}
              className="h-8 rounded-md border bg-background px-2 text-xs w-full">
              {CONDITION_FIELDS.map(field => <option key={field.id} value={field.id}>{field.label}</option>)}
            </select>
          </div>
          <div className="flex-1 relative">
            {index === 0 && <label className="text-[10px] text-muted-foreground mb-0.5 flex items-center">Operator<InfoTip text="How to compare the field value" /></label>}
            <select value={condition.operator} onChange={event => updateCondition(index, { operator: event.target.value })}
              className="h-8 rounded-md border bg-background px-2 text-xs w-full">
              {CONDITION_OPERATORS.map(op => <option key={op.id} value={op.id}>{op.label}</option>)}
            </select>
          </div>
          {needsValue(condition.operator) && (
            <div className="flex-1 relative">
              {index === 0 && <label className="text-[10px] text-muted-foreground mb-0.5 flex items-center">Value<InfoTip text="The value to compare against" /></label>}
              <Input value={condition.value ?? ''} onChange={event => updateCondition(index, { value: event.target.value })}
                placeholder="Value" className="h-8 text-xs" />
            </div>
          )}
          <IconButton type="button" variant="ghost" size="xs" onClick={() => removeCondition(index)} aria-label="Remove condition">
            <X className="size-3" />
          </IconButton>
        </div>
      ))}
      <Button type="button" variant="ghost" size="sm" onClick={addCondition} className="text-xs h-7">
        <Plus className="size-3 mr-1" /> Add condition
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// SlideOver Panel
// ---------------------------------------------------------------------------

function DelayEditor({ minutes, onChange }: { minutes: number; onChange: (minutes: number) => void }) {
  const units = [
    { id: 'minutes', label: 'Minutes', factor: 1 },
    { id: 'hours', label: 'Hours', factor: 60 },
    { id: 'days', label: 'Days', factor: 1440 },
    { id: 'weeks', label: 'Weeks', factor: 10080 },
  ]

  // Determine the best unit to display
  let selectedUnit = 'minutes'
  let displayValue = minutes
  if (minutes >= 10080 && minutes % 10080 === 0) { selectedUnit = 'weeks'; displayValue = minutes / 10080 }
  else if (minutes >= 1440 && minutes % 1440 === 0) { selectedUnit = 'days'; displayValue = minutes / 1440 }
  else if (minutes >= 60 && minutes % 60 === 0) { selectedUnit = 'hours'; displayValue = minutes / 60 }

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground shrink-0">Wait for</span>
      <Input
        type="number"
        min={1}
        value={displayValue}
        onChange={event => {
          const val = parseInt(event.target.value) || 1
          const unit = units.find(u => u.id === selectedUnit)!
          onChange(val * unit.factor)
        }}
        className="h-8 text-xs w-20"
      />
      <select
        value={selectedUnit}
        onChange={event => {
          const newUnit = units.find(u => u.id === event.target.value)!
          const oldUnit = units.find(u => u.id === selectedUnit)!
          const rawVal = minutes / oldUnit.factor
          onChange(Math.max(1, Math.round(rawVal)) * newUnit.factor)
        }}
        className="h-8 rounded-md border bg-background px-2 text-xs"
      >
        {units.map(u => <option key={u.id} value={u.id}>{u.label}</option>)}
      </select>
    </div>
  )
}

function StepEditor({ steps, onChange }: { steps: StepItem[]; onChange: (steps: StepItem[]) => void }) {
  const updateStep = (index: number, updates: Partial<StepItem>) => {
    const next = steps.map((step, idx) => idx === index ? { ...step, ...updates } : step)
    onChange(next)
  }

  const removeStep = (index: number) => {
    onChange(steps.filter((_, idx) => idx !== index))
  }

  const moveStep = (index: number, direction: 'up' | 'down') => {
    const target = direction === 'up' ? index - 1 : index + 1
    if (target < 0 || target >= steps.length) return
    const next = [...steps]
    const temp = next[index]
    next[index] = next[target]
    next[target] = temp
    onChange(next)
  }

  const addActionStep = () => {
    onChange([...steps, { type: 'action', actionType: 'send_email', actionConfig: {} }])
  }

  const addDelayStep = () => {
    onChange([...steps, { type: 'delay', delayMinutes: 1440 }])
  }

  const [expandedStep, setExpandedStep] = useState<number | null>(null)

  // Auto-expand new steps
  useEffect(() => {
    if (steps.length > 0) {
      const lastStep = steps[steps.length - 1]
      if (lastStep.type === 'action' && (!lastStep.actionConfig || Object.keys(lastStep.actionConfig).length === 0)) {
        setExpandedStep(steps.length - 1)
      }
    }
  }, [steps.length])

  let actionNumber = 0

  return (
    <div className="space-y-2">
      {steps.map((step, index) => {
        if (step.type === 'action') actionNumber++
        const currentActionNumber = actionNumber

        return (
          <div key={index} className="rounded-lg border bg-muted/20">
            {step.type === 'delay' ? (
              <div className="flex items-center gap-2 px-3 py-2.5">
                <Timer className="size-3.5 text-orange-500 shrink-0" />
                <DelayEditor
                  minutes={step.delayMinutes || 60}
                  onChange={(minutes) => updateStep(index, { delayMinutes: minutes })}
                />
                <div className="flex-1" />
                <div className="flex items-center gap-0.5">
                  <IconButton type="button" variant="ghost" size="xs" onClick={() => moveStep(index, 'up')} disabled={index === 0} aria-label="Move up">
                    <ChevronUp className="size-3" />
                  </IconButton>
                  <IconButton type="button" variant="ghost" size="xs" onClick={() => moveStep(index, 'down')} disabled={index === steps.length - 1} aria-label="Move down">
                    <ChevronDown className="size-3" />
                  </IconButton>
                  <IconButton type="button" variant="ghost" size="xs" onClick={() => removeStep(index)} aria-label="Remove step">
                    <X className="size-3" />
                  </IconButton>
                </div>
              </div>
            ) : (
              <>
                <div
                  className="flex items-center gap-2 px-3 py-2.5 cursor-pointer"
                  onClick={() => setExpandedStep(expandedStep === index ? null : index)}
                >
                  <span className="text-xs font-semibold text-muted-foreground shrink-0 w-5">{currentActionNumber}.</span>
                  <Pill variant="action">{actionLabel(step.actionType || '')}</Pill>
                  {step.actionConfig?.subject && (
                    <span className="text-xs text-muted-foreground truncate max-w-[160px]">&ldquo;{step.actionConfig.subject}&rdquo;</span>
                  )}
                  {step.actionConfig?.tagName && (
                    <span className="text-xs text-muted-foreground truncate max-w-[160px]">&ldquo;{step.actionConfig.tagName}&rdquo;</span>
                  )}
                  {step.actionConfig?.title && (
                    <span className="text-xs text-muted-foreground truncate max-w-[160px]">&ldquo;{step.actionConfig.title}&rdquo;</span>
                  )}
                  <div className="flex-1" />
                  <div className="flex items-center gap-0.5" onClick={event => event.stopPropagation()}>
                    <IconButton type="button" variant="ghost" size="xs" onClick={() => moveStep(index, 'up')} disabled={index === 0} aria-label="Move up">
                      <ChevronUp className="size-3" />
                    </IconButton>
                    <IconButton type="button" variant="ghost" size="xs" onClick={() => moveStep(index, 'down')} disabled={index === steps.length - 1} aria-label="Move down">
                      <ChevronDown className="size-3" />
                    </IconButton>
                    <IconButton type="button" variant="ghost" size="xs" onClick={() => removeStep(index)} aria-label="Remove step">
                      <X className="size-3" />
                    </IconButton>
                  </div>
                </div>
                {expandedStep === index && (
                  <div className="px-3 pb-3 pt-1 border-t space-y-3">
                    <select
                      value={step.actionType || 'send_email'}
                      onChange={event => updateStep(index, { actionType: event.target.value, actionConfig: {} })}
                      className="w-full h-9 rounded-md border bg-background px-3 text-sm"
                    >
                      {ACTION_TYPES.map(action => <option key={action.id} value={action.id}>{action.label}</option>)}
                    </select>
                    <ActionConfigFields
                      actionType={step.actionType || 'send_email'}
                      config={step.actionConfig || {}}
                      onChange={(config) => updateStep(index, { actionConfig: config })}
                    />
                  </div>
                )}
              </>
            )}
          </div>
        )
      })}

      <div className="flex items-center gap-2 pt-1">
        <Button type="button" variant="outline" size="sm" onClick={addActionStep} className="text-xs h-7">
          <Plus className="size-3 mr-1" /> Add Step
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={addDelayStep} className="text-xs h-7">
          <Timer className="size-3 mr-1" /> Add Delay
        </Button>
      </div>
    </div>
  )
}

function SlideOver({
  open,
  rule,
  onClose,
  onSave,
  saving,
  rules,
}: {
  open: boolean
  rule: Partial<AutomationRule> | null
  onClose: () => void
  onSave: (data: {
    name: string
    description: string
    triggerType: string
    triggerConfig: Record<string, any>
    steps: StepItem[]
    conditions: Array<{ field: string; operator: string; value?: any }>
    status: string
  }) => void
  saving: boolean
  rules: AutomationRule[]
}) {
  const isEdit = rule?.id != null
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [selectedTrigger, setSelectedTrigger] = useState('contact_created')
  const [triggerConfig, setTriggerConfig] = useState<Record<string, any>>({})
  const [steps, setSteps] = useState<StepItem[]>([{ type: 'action', actionType: 'send_email', actionConfig: {} }])
  const [conditions, setConditions] = useState<Array<{ field: string; operator: string; value?: any }>>([])
  const [status, setStatus] = useState<'active' | 'paused'>('active')
  const [showSlideOverChat, setShowSlideOverChat] = useState(false)

  useEffect(() => {
    if (!open) return
    if (rule) {
      setName(rule.name ?? '')
      setDescription(rule.description ?? '')
      setSelectedTrigger(rule.trigger_type ?? 'contact_created')
      setTriggerConfig(typeof rule.trigger_config === 'string' ? JSON.parse(rule.trigger_config) : (rule.trigger_config ?? {}))

      // Load steps: from the steps field, or convert legacy single-action
      const ruleSteps = rule.steps
        ? (typeof rule.steps === 'string' ? JSON.parse(rule.steps as unknown as string) : rule.steps)
        : null
      if (Array.isArray(ruleSteps) && ruleSteps.length > 0) {
        setSteps(ruleSteps)
      } else {
        setSteps([{
          type: 'action',
          actionType: rule.action_type ?? 'send_email',
          actionConfig: typeof rule.action_config === 'string' ? JSON.parse(rule.action_config) : (rule.action_config ?? {}),
        }])
      }

      setConditions(rule.conditions ?? [])
      setStatus((rule.status as 'active' | 'paused') ?? 'active')
    } else {
      setName('')
      setDescription('')
      setSelectedTrigger('contact_created')
      setTriggerConfig({})
      setSteps([{ type: 'action', actionType: 'send_email', actionConfig: {} }])
      setConditions([])
      setStatus('active')
    }
    setShowSlideOverChat(false)
  }, [open, rule])

  // Cmd/Ctrl+Enter to save, Escape to close
  useEffect(() => {
    if (!open) return
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') { onClose(); return }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        handleSave()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  })

  function handleSave() {
    if (!name.trim()) {
      alert('Please enter a name for this automation')
      return
    }
    if (steps.filter(s => s.type === 'action').length === 0) {
      alert('Please add at least one action step')
      return
    }
    onSave({
      name: name.trim(),
      description: description.trim(),
      triggerType: selectedTrigger,
      triggerConfig,
      steps,
      conditions,
      status,
    })
  }

  if (!open) return null

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px]" onClick={onClose} />

      {/* Panel */}
      <div className="fixed top-0 right-0 z-50 h-full w-full max-w-[520px] bg-card border-l shadow-2xl flex flex-col animate-in slide-in-from-right duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
          <h2 className="text-base font-semibold">{isEdit ? 'Edit Automation' : 'New Automation'}</h2>
          <IconButton type="button" variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </IconButton>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {/* Name */}
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1.5">Name<InfoTip text="Give your automation a descriptive name so you can find it later" /></label>
            <Input value={name} onChange={event => setName(event.target.value)}
              placeholder="e.g. Welcome new VIP contacts" className="h-9 text-sm" autoFocus />
          </div>

          {/* Description */}
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1.5">Description (optional)<InfoTip text="Optional notes about what this automation does and why" /></label>
            <Textarea value={description} onChange={event => setDescription(event.target.value)}
              placeholder="What does this automation do?" className="text-sm min-h-[60px]" />
          </div>

          {/* Trigger */}
          <div className="space-y-3">
            <label className="text-xs font-semibold block">When this happens...<InfoTip text="The event that starts this automation. Choose what should trigger the action." /></label>
            <select value={selectedTrigger} onChange={event => { setSelectedTrigger(event.target.value); setTriggerConfig({}) }}
              className="w-full h-9 rounded-md border bg-background px-3 text-sm">
              {TRIGGER_TYPE_GROUPS.map(group => (
                <optgroup key={group.label} label={group.label}>
                  {group.items.map(trigger => <option key={trigger.id} value={trigger.id}>{trigger.label}</option>)}
                </optgroup>
              ))}
            </select>
            <TriggerConfigFields triggerType={selectedTrigger} config={triggerConfig} onChange={setTriggerConfig} />
          </div>

          {/* Conditions */}
          <div className="space-y-3">
            <label className="text-xs font-semibold block">Only if... <span className="font-normal text-muted-foreground">(optional)</span><InfoTip text="Add filters to control when the automation runs. All conditions must be true." /></label>
            <ConditionEditor conditions={conditions} onChange={setConditions} />
          </div>

          {/* Steps */}
          <div className="space-y-3">
            <label className="text-xs font-semibold block">Steps<InfoTip text="Define the sequence of actions and delays. Actions execute immediately; delays pause before the next step." /></label>
            <StepEditor steps={steps} onChange={setSteps} />
          </div>

          {/* Status */}
          <div className="flex items-center justify-between py-3 border-t">
            <div>
              <label className="text-xs font-semibold block">Status<InfoTip text="Active automations run immediately. Pause to temporarily disable without deleting." /></label>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {status === 'active' ? 'Automation will run immediately' : 'Automation is paused'}
              </p>
            </div>
            <Switch checked={status === 'active'} onCheckedChange={(checked) => setStatus(checked ? 'active' : 'paused')} />
          </div>
        </div>

        {/* Inline AI Chat */}
        <InlineMiniChat
          open={showSlideOverChat}
          onToggle={() => setShowSlideOverChat(prev => !prev)}
          rules={rules}
          currentRule={{
            ...rule,
            name,
            trigger_type: selectedTrigger,
            action_type: steps.find(s => s.type === 'action')?.actionType,
            status,
            steps,
            conditions,
          } as Partial<AutomationRule>}
        />

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t shrink-0">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="button" size="sm" onClick={handleSave} disabled={saving || !name.trim()}>
            {saving && <Loader2 className="size-3 animate-spin mr-1.5" />}
            {isEdit ? 'Save Changes' : 'Create Automation'}
          </Button>
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Template Gallery Modal
// ---------------------------------------------------------------------------

function TemplateGallery({
  open,
  templates,
  loading,
  onClose,
  onUseTemplate,
  onStartFromScratch,
}: {
  open: boolean
  templates: Template[]
  loading: boolean
  onClose: () => void
  onUseTemplate: (template: Template) => void
  onStartFromScratch: () => void
}) {
  const [selectedCategory, setSelectedCategory] = useState('all')
  const [search, setSearch] = useState('')

  useEffect(() => {
    if (open) { setSelectedCategory('all'); setSearch('') }
  }, [open])

  useEffect(() => {
    if (!open) return
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  })

  const filtered = useMemo(() => {
    return templates.filter(template => {
      if (selectedCategory !== 'all' && template.category.toLowerCase().replace(/\s+/g, '_') !== selectedCategory) return false
      if (search && !template.name.toLowerCase().includes(search.toLowerCase()) &&
        !template.description.toLowerCase().includes(search.toLowerCase())) return false
      return true
    })
  }, [templates, selectedCategory, search])

  const popular = useMemo(() => templates.filter(t => t.popular).slice(0, 6), [templates])

  const iconMap: Record<string, typeof Zap> = {
    mail: Mail, tag: Tag, zap: Zap, users: Users, arrow_right: ArrowRight,
    check_square: CheckSquare, git_branch: GitBranch, globe: Globe,
    message_square: MessageSquare, sparkles: Sparkles, bell: Bell,
    shopping_cart: ShoppingCart, graduation_cap: GraduationCap,
    calendar: Calendar, file_text: FileText, arrow_up_right: ArrowUpRight,
    heart: Heart, Heart: Heart, star: Star, Star: Star, phone: Phone, Phone: Phone,
    gift: Gift, Gift: Gift, refresh_cw: RefreshCw, RefreshCw: RefreshCw,
    briefcase: Briefcase, Briefcase: Briefcase, CheckSquare: CheckSquare,
    Zap: Zap, MessageSquare: MessageSquare, FileText: FileText, Calendar: Calendar,
    Users: Users, Tag: Tag, GraduationCap: GraduationCap, ClipboardCheck: CheckSquare,
  }

  function resolveIcon(iconName: string) {
    return iconMap[iconName] ?? Zap
  }

  const categoryColors: Record<string, string> = {
    sales: 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400',
    marketing: 'bg-purple-100 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400',
    customer_success: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400',
    operations: 'bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400',
    notifications: 'bg-rose-100 text-rose-600 dark:bg-rose-900/30 dark:text-rose-400',
    solopreneur: 'bg-teal-100 text-teal-600 dark:bg-teal-900/30 dark:text-teal-400',
  }

  if (!open) return null

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-4 sm:inset-8 md:inset-12 lg:inset-16 z-50 bg-card rounded-xl border shadow-2xl flex overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* Sidebar */}
        <div className="w-52 shrink-0 border-r bg-muted/30 p-4 flex flex-col">
          <h2 className="text-sm font-semibold mb-4">Templates</h2>
          <nav className="space-y-0.5 flex-1">
            {TEMPLATE_CATEGORIES.map(category => {
              const CategoryIcon = CATEGORY_ICONS[category.id]
              return (
                <Button
                  key={category.id}
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={`w-full justify-start h-8 text-xs ${selectedCategory === category.id ? 'bg-accent/10 text-accent font-semibold' : 'text-muted-foreground'}`}
                  onClick={() => setSelectedCategory(category.id)}
                >
                  {CategoryIcon ? <CategoryIcon className="size-3.5 mr-2" /> : <LayoutGrid className="size-3.5 mr-2" />}
                  {category.label}
                </Button>
              )
            })}
          </nav>
          <Button type="button" variant="ghost" size="sm" className="w-full justify-start text-xs text-muted-foreground mt-4"
            onClick={() => { onClose(); onStartFromScratch() }}>
            <Plus className="size-3.5 mr-2" /> Start from scratch
          </Button>
        </div>

        {/* Main area */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-center gap-3 px-6 py-4 border-b shrink-0">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <Input value={search} onChange={event => setSearch(event.target.value)}
                placeholder="Search templates..." className="h-9 pl-9 text-sm" />
            </div>
            <div className="flex-1" />
            <IconButton type="button" variant="ghost" size="sm" onClick={onClose} aria-label="Close">
              <X className="size-4" />
            </IconButton>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-6">
            {loading ? (
              <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin mr-2" /> Loading templates...
              </div>
            ) : (
              <div className="space-y-8">
                {/* Recommended section */}
                {selectedCategory === 'all' && !search && popular.length > 0 && (
                  <div>
                    <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
                      <Sparkles className="size-3" /> Recommended
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {popular.map(template => {
                        const Icon = resolveIcon(template.icon)
                        const colorClass = categoryColors[template.category] ?? 'bg-slate-100 text-slate-600'
                        return (
                          <div key={template.id}
                            className="rounded-lg border p-4 hover:border-primary/30 hover:shadow-sm transition-all group flex gap-3">
                            <div className={`size-10 rounded-lg flex items-center justify-center shrink-0 ${colorClass}`}>
                              <Icon className="size-5" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium leading-tight">{template.name}</p>
                              <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{template.description}</p>
                            </div>
                            <Button type="button" variant="outline" size="sm"
                              className="shrink-0 self-center opacity-0 group-hover:opacity-100 transition-opacity h-7 text-xs"
                              onClick={() => onUseTemplate(template)}>
                              Use
                            </Button>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* All templates */}
                <div>
                  {selectedCategory === 'all' && !search && popular.length > 0 && (
                    <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                      All Templates
                    </h3>
                  )}
                  {filtered.length === 0 ? (
                    <div className="py-12 text-center">
                      <Search className="size-6 mx-auto mb-2 text-muted-foreground/30" />
                      <p className="text-sm text-muted-foreground">No templates found</p>
                      <p className="text-xs text-muted-foreground mt-1">Try a different search or category</p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {filtered.map(template => {
                        const Icon = resolveIcon(template.icon)
                        const colorClass = categoryColors[template.category] ?? 'bg-slate-100 text-slate-600'
                        return (
                          <div key={template.id}
                            className="rounded-lg border p-4 hover:border-primary/30 hover:shadow-sm transition-all group flex gap-3">
                            <div className={`size-10 rounded-lg flex items-center justify-center shrink-0 ${colorClass}`}>
                              <Icon className="size-5" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium leading-tight">{template.name}</p>
                              <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{template.description}</p>
                            </div>
                            <Button type="button" variant="outline" size="sm"
                              className="shrink-0 self-center opacity-0 group-hover:opacity-100 transition-opacity h-7 text-xs"
                              onClick={() => onUseTemplate(template)}>
                              Use
                            </Button>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// AI Help Chat Types & Helpers
// ---------------------------------------------------------------------------

type ChatMessage = { role: 'user' | 'assistant'; content: string }

type ChatContext = {
  currentRule?: Record<string, any>
  existingRules?: Array<{ name: string; trigger_type: string; action_type: string; status: string }>
}

function getStarterPrompts(hasRules: boolean, inSlideOver: boolean): string[] {
  if (inSlideOver) {
    return [
      'Is this trigger right for what I\'m trying to do?',
      'What conditions should I add?',
      'How do I test this automation?',
    ]
  }
  if (!hasRules) {
    return [
      'What automations should I set up first?',
      'Walk me through creating my first automation',
      'What\'s the difference between triggers and actions?',
    ]
  }
  return [
    'How do I add a delay between steps?',
    'Why isn\'t my automation running?',
    'How do I use conditions to filter?',
  ]
}

async function sendChatMessage(
  message: string,
  history: ChatMessage[],
  context?: ChatContext,
): Promise<string> {
  const response = await fetch('/api/automation-rules/ai-chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ message, history, context }),
  })
  const result = await response.json()
  if (result.ok && result.data?.message) return result.data.message
  throw new Error(result.error || 'Failed to get response')
}

// ---------------------------------------------------------------------------
// Help Chat Panel (slides in from right)
// ---------------------------------------------------------------------------

function HelpChatPanel({
  open,
  onClose,
  rules,
}: {
  open: boolean
  onClose: () => void
  rules: AutomationRule[]
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const context: ChatContext = useMemo(() => ({
    existingRules: rules.map(r => ({
      name: r.name,
      trigger_type: r.trigger_type,
      action_type: r.action_type,
      status: r.status,
    })),
  }), [rules])

  const starters = useMemo(() => getStarterPrompts(rules.length > 0, false), [rules.length])

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus()
  }, [open])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, loading])

  async function handleSend(text?: string) {
    const msg = (text ?? input).trim()
    if (!msg || loading) return
    setInput('')
    const userMsg: ChatMessage = { role: 'user', content: msg }
    setMessages(prev => [...prev, userMsg])
    setLoading(true)
    try {
      const reply = await sendChatMessage(msg, [...messages, userMsg], context)
      setMessages(prev => [...prev, { role: 'assistant', content: reply }])
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Sorry, I couldn\'t get a response. Please try again.' }])
    }
    setLoading(false)
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      handleSend()
    }
  }

  if (!open) return null

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <div className="fixed top-0 right-0 z-50 h-full w-[340px] bg-card border-l shadow-2xl flex flex-col animate-in slide-in-from-right duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
          <div className="flex items-center gap-2">
            <div className="size-7 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
              <Bot className="size-3.5 text-blue-600 dark:text-blue-400" />
            </div>
            <span className="text-sm font-semibold">Automation Assistant</span>
          </div>
          <IconButton type="button" variant="ghost" size="sm" onClick={onClose} aria-label="Close chat">
            <X className="size-4" />
          </IconButton>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
          {messages.length === 0 && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">Suggested questions:</p>
              {starters.map(prompt => (
                <button
                  key={prompt}
                  type="button"
                  className="block w-full text-left text-xs text-muted-foreground hover:text-foreground transition-colors px-3 py-2 rounded-lg border border hover:border-solid hover:bg-muted/50"
                  onClick={() => handleSend(prompt)}
                >
                  {prompt}
                </button>
              ))}
            </div>
          )}

          {messages.map((msg, idx) => (
            <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[85%] rounded-xl px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap ${
                  msg.role === 'user'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-foreground'
                }`}
              >
                {msg.content}
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex justify-start">
              <div className="bg-muted rounded-xl px-3 py-2.5 flex items-center gap-2">
                <div className="flex items-center gap-1">
                  <span className="size-1.5 rounded-full bg-accent/70 animate-pulse" style={{ animationDelay: '0ms', animationDuration: '1s' }} />
                  <span className="size-1.5 rounded-full bg-accent/70 animate-pulse" style={{ animationDelay: '200ms', animationDuration: '1s' }} />
                  <span className="size-1.5 rounded-full bg-accent/70 animate-pulse" style={{ animationDelay: '400ms', animationDuration: '1s' }} />
                </div>
                <span className="text-[10px] text-muted-foreground">Thinking...</span>
              </div>
            </div>
          )}
        </div>

        {/* Input */}
        <div className="px-4 py-3 border-t shrink-0">
          <div className="flex items-end gap-2">
            <Textarea
              ref={inputRef}
              value={input}
              onChange={event => setInput(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type your question..."
              className="text-xs min-h-[36px] max-h-[100px] resize-none flex-1"
              rows={1}
            />
            <IconButton
              type="button"
              size="sm"
              onClick={() => handleSend()}
              disabled={!input.trim() || loading}
              aria-label="Send message"
            >
              <Send className="size-3.5" />
            </IconButton>
          </div>
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Inline Mini Chat (inside slide-over)
// ---------------------------------------------------------------------------

function InlineMiniChat({
  open,
  onToggle,
  rules,
  currentRule,
}: {
  open: boolean
  onToggle: () => void
  rules: AutomationRule[]
  currentRule?: Partial<AutomationRule> | null
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const context: ChatContext = useMemo(() => ({
    currentRule: currentRule ? {
      name: currentRule.name,
      trigger_type: currentRule.trigger_type,
      action_type: currentRule.action_type,
      status: currentRule.status,
      steps: currentRule.steps,
      conditions: currentRule.conditions,
    } : undefined,
    existingRules: rules.map(r => ({
      name: r.name,
      trigger_type: r.trigger_type,
      action_type: r.action_type,
      status: r.status,
    })),
  }), [currentRule, rules])

  const starters = useMemo(() => getStarterPrompts(rules.length > 0, true), [rules.length])

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus()
  }, [open])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, loading])

  // Reset messages when the mini-chat is closed
  useEffect(() => {
    if (!open) { setMessages([]); setInput('') }
  }, [open])

  async function handleSend(text?: string) {
    const msg = (text ?? input).trim()
    if (!msg || loading) return
    setInput('')
    const userMsg: ChatMessage = { role: 'user', content: msg }
    setMessages(prev => [...prev, userMsg])
    setLoading(true)
    try {
      const reply = await sendChatMessage(msg, [...messages, userMsg], context)
      setMessages(prev => [...prev, { role: 'assistant', content: reply }])
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Sorry, I couldn\'t get a response. Please try again.' }])
    }
    setLoading(false)
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="border-t">
      {/* Toggle button */}
      <button
        type="button"
        className="w-full flex items-center gap-2 px-6 py-3 text-xs text-muted-foreground hover:text-foreground transition-colors hover:bg-muted/30"
        onClick={onToggle}
      >
        <MessageCircle className="size-3.5" />
        <span>Ask AI for help with this automation</span>
        {open ? <ChevronDown className="size-3 ml-auto" /> : <ChevronUp className="size-3 ml-auto" />}
      </button>

      {/* Expandable chat area */}
      {open && (
        <div className="border-t">
          {/* Messages */}
          <div ref={scrollRef} className="h-[200px] overflow-y-auto px-4 py-3 space-y-2">
            {messages.length === 0 && (
              <div className="space-y-1.5">
                {starters.map(prompt => (
                  <button
                    key={prompt}
                    type="button"
                    className="block w-full text-left text-[11px] text-muted-foreground hover:text-foreground transition-colors px-2.5 py-1.5 rounded-md border border hover:border-solid hover:bg-muted/50"
                    onClick={() => handleSend(prompt)}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            )}

            {messages.map((msg, idx) => (
              <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[85%] rounded-lg px-2.5 py-1.5 text-[11px] leading-relaxed whitespace-pre-wrap ${
                    msg.role === 'user'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-foreground'
                  }`}
                >
                  {msg.content}
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex justify-start">
                <div className="bg-muted rounded-lg px-2.5 py-1.5 flex items-center gap-1.5">
                  <div className="flex items-center gap-0.5">
                    <span className="size-1 rounded-full bg-accent/70 animate-pulse" style={{ animationDelay: '0ms', animationDuration: '1s' }} />
                    <span className="size-1 rounded-full bg-accent/70 animate-pulse" style={{ animationDelay: '200ms', animationDuration: '1s' }} />
                    <span className="size-1 rounded-full bg-accent/70 animate-pulse" style={{ animationDelay: '400ms', animationDuration: '1s' }} />
                  </div>
                  <span className="text-[10px] text-muted-foreground">Thinking...</span>
                </div>
              </div>
            )}
          </div>

          {/* Input */}
          <div className="px-4 py-2 border-t">
            <div className="flex items-end gap-1.5">
              <Textarea
                ref={inputRef}
                value={input}
                onChange={event => setInput(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask about this automation..."
                className="text-[11px] min-h-[32px] max-h-[60px] resize-none flex-1"
                rows={1}
              />
              <IconButton
                type="button"
                size="sm"
                onClick={() => handleSend()}
                disabled={!input.trim() || loading}
                aria-label="Send"
              >
                <Send className="size-3" />
              </IconButton>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function AutomationsV2Page() {
  const [rules, setRules] = useState<AutomationRule[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [showTemplateGallery, setShowTemplateGallery] = useState(false)
  const [templates, setTemplates] = useState<Template[]>([])
  const [templatesLoading, setTemplatesLoading] = useState(false)

  // Slide-over state
  const [slideOverOpen, setSlideOverOpen] = useState(false)
  const [editingRule, setEditingRule] = useState<Partial<AutomationRule> | null>(null)
  const [saving, setSaving] = useState(false)

  // Delete confirmation
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // AI Wizard state
  const [showAiWizard, setShowAiWizard] = useState(false)
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiGenerating, setAiGenerating] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [aiPreview, setAiPreview] = useState<any>(null)

  // Help chat state
  const [showHelpChat, setShowHelpChat] = useState(false)

  // Test modal state
  const [testingRuleId, setTestingRuleId] = useState<string | null>(null)
  const [testContactSearch, setTestContactSearch] = useState('')
  const [testContactResults, setTestContactResults] = useState<Array<{ id: string; display_name: string; primary_email: string | null }>>([])
  const [testSelectedContact, setTestSelectedContact] = useState<{ id: string; display_name: string; primary_email: string | null } | null>(null)
  const [testDryRun, setTestDryRun] = useState(true)
  const [testRunning, setTestRunning] = useState(false)
  const [testResults, setTestResults] = useState<any | null>(null)
  const [testContactDropdownOpen, setTestContactDropdownOpen] = useState(false)
  const testSearchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Inline execution history state
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null)
  const [historyLogs, setHistoryLogs] = useState<Record<string, Array<any>>>({})
  const [historyLoading, setHistoryLoading] = useState<string | null>(null)

  // Close test contact dropdown on outside click
  useEffect(() => {
    if (!testContactDropdownOpen) return
    function handleClick(e: MouseEvent) {
      if (!(e.target as HTMLElement).closest('[data-test-contact-picker]')) {
        setTestContactDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [testContactDropdownOpen])

  const loadRules = useCallback(() => {
    setLoading(true)
    fetch('/api/automation-rules', { credentials: 'include' })
      .then(response => response.json())
      .then(data => { if (data.ok) setRules(data.data?.items ?? data.data ?? []) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const loadTemplates = useCallback(() => {
    setTemplatesLoading(true)
    fetch('/api/automation-rules/templates', { credentials: 'include' })
      .then(response => response.json())
      .then(data => {
        if (data.ok && data.data) {
          const all: Template[] = []
          if (Array.isArray(data.data.categories)) {
            for (const cat of data.data.categories) {
              if (Array.isArray(cat.templates)) all.push(...cat.templates)
            }
          }
          setTemplates(all)
        }
      })
      .catch(() => {})
      .finally(() => setTemplatesLoading(false))
  }, [])

  useEffect(() => { loadRules() }, [loadRules])

  const loadHistory = useCallback(async (ruleId: string) => {
    setHistoryLoading(ruleId)
    try {
      const res = await fetch(`/api/automation-rules/${ruleId}/logs?limit=10`, { credentials: 'include' })
      const data = await res.json()
      if (data.ok) {
        setHistoryLogs(prev => ({ ...prev, [ruleId]: data.data || [] }))
      }
    } catch { /* ignore */ }
    setHistoryLoading(null)
  }, [])

  const toggleHistory = useCallback((ruleId: string) => {
    if (expandedHistoryId === ruleId) {
      setExpandedHistoryId(null)
    } else {
      setExpandedHistoryId(ruleId)
      if (!historyLogs[ruleId]) loadHistory(ruleId)
    }
  }, [expandedHistoryId, historyLogs, loadHistory])

  // Run scheduled automations in the background on page load
  useEffect(() => {
    fetch('/api/automation-rules/run-scheduled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({}),
    }).catch(() => {})
  }, [])

  // Status counts
  const counts = useMemo(() => {
    const all = rules.length
    const active = rules.filter(r => r.status === 'active').length
    const paused = rules.filter(r => r.status === 'paused').length
    const error = rules.filter(r => r.status === 'error').length
    return { all, active, paused, error }
  }, [rules])

  // Filtered rules
  const filteredRules = useMemo(() => {
    return rules.filter(rule => {
      if (statusFilter !== 'all' && rule.status !== statusFilter) return false
      if (searchQuery) {
        const query = searchQuery.toLowerCase()
        const matchesName = rule.name.toLowerCase().includes(query)
        const matchesTrigger = triggerLabel(rule.trigger_type).toLowerCase().includes(query)
        const matchesAction = actionLabel(rule.action_type).toLowerCase().includes(query)
        if (!matchesName && !matchesTrigger && !matchesAction) return false
      }
      return true
    })
  }, [rules, statusFilter, searchQuery])

  // Handlers
  function openCreate() {
    setEditingRule(null)
    setSlideOverOpen(true)
  }

  function openEdit(rule: AutomationRule) {
    setEditingRule(rule)
    setSlideOverOpen(true)
  }

  function openTemplateGallery() {
    if (templates.length === 0) loadTemplates()
    setShowTemplateGallery(true)
  }

  async function handleSave(data: {
    name: string; description: string; triggerType: string; triggerConfig: Record<string, any>
    steps: StepItem[]
    conditions: Array<{ field: string; operator: string; value?: any }>; status: string
  }) {
    setSaving(true)
    try {
      const isEdit = editingRule?.id != null
      const url = isEdit ? `/api/automation-rules?id=${editingRule!.id}` : '/api/automation-rules'
      const method = isEdit ? 'PUT' : 'POST'

      // Backward compat: if single action step with no delays, save as legacy format
      const actionSteps = data.steps.filter(s => s.type === 'action')
      const hasDelays = data.steps.some(s => s.type === 'delay')
      const isMultiStep = data.steps.length > 1 || hasDelays

      const firstAction = actionSteps[0]

      const bodyPayload: Record<string, any> = {
        name: data.name,
        description: data.description || null,
        triggerType: data.triggerType,
        triggerConfig: data.triggerConfig,
        actionType: firstAction?.actionType || 'send_email',
        actionConfig: firstAction?.actionConfig || {},
        conditions: data.conditions.length > 0 ? data.conditions : null,
        status: data.status,
      }

      if (isMultiStep) {
        bodyPayload.steps = data.steps
      } else {
        bodyPayload.steps = null // Clear steps if reverting to single action
      }

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(bodyPayload),
      })
      const result = await response.json()
      if (result.ok) {
        setSlideOverOpen(false)
        setEditingRule(null)
        loadRules()
      } else {
        alert(`Failed to save: ${result.error || 'Unknown error'}`)
      }
    } catch (err) {
      alert(`Error saving automation: ${err instanceof Error ? err.message : String(err)}`)
    }
    setSaving(false)
  }

  async function handleToggle(rule: AutomationRule) {
    const newStatus = rule.status === 'active' ? 'paused' : 'active'
    try {
      await fetch(`/api/automation-rules?id=${rule.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status: newStatus }),
      })
      loadRules()
    } catch {}
  }

  async function handleDuplicate(rule: AutomationRule) {
    try {
      const triggerConfig = typeof rule.trigger_config === 'string' ? JSON.parse(rule.trigger_config) : rule.trigger_config
      const actionConfig = typeof rule.action_config === 'string' ? JSON.parse(rule.action_config) : rule.action_config
      const ruleSteps = rule.steps
        ? (typeof rule.steps === 'string' ? JSON.parse(rule.steps as unknown as string) : rule.steps)
        : null
      await fetch('/api/automation-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: `${rule.name} (copy)`,
          description: rule.description,
          triggerType: rule.trigger_type,
          triggerConfig,
          actionType: rule.action_type,
          actionConfig,
          steps: ruleSteps,
          conditions: rule.conditions,
          status: 'paused',
        }),
      })
      loadRules()
    } catch {}
  }

  async function handleRunNow(ruleId: string) {
    try {
      const response = await fetch('/api/automation-rules/run-scheduled', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ ruleId }),
      })
      const result = await response.json()
      if (result.ok) {
        const ruleResult = result.data?.results?.[0]
        if (ruleResult) {
          alert(`Scheduled automation ran: ${ruleResult.targetsFound} target(s) found, ${ruleResult.executed} executed`)
        }
        loadRules()
      }
    } catch {
      alert('Failed to run scheduled automation')
    }
  }

  async function handleDelete(ruleId: string) {
    setDeletingId(ruleId)
  }

  async function confirmDelete() {
    if (!deletingId) return
    try {
      await fetch(`/api/automation-rules?id=${deletingId}`, { method: 'DELETE', credentials: 'include' })
      loadRules()
    } catch {}
    setDeletingId(null)
  }

  function openTestModal(ruleId: string) {
    setTestingRuleId(ruleId)
    setTestContactSearch('')
    setTestContactResults([])
    setTestSelectedContact(null)
    setTestDryRun(true)
    setTestRunning(false)
    setTestResults(null)
    setTestContactDropdownOpen(false)
  }

  function closeTestModal() {
    setTestingRuleId(null)
    setTestResults(null)
    setTestSelectedContact(null)
    setTestContactSearch('')
    setTestContactResults([])
    setTestContactDropdownOpen(false)
  }

  function handleTestContactSearch(query: string) {
    setTestContactSearch(query)
    setTestContactDropdownOpen(true)
    if (testSearchTimeout.current) clearTimeout(testSearchTimeout.current)
    testSearchTimeout.current = setTimeout(() => {
      const q = query.trim()
      fetch(`/api/customers/people?search=${encodeURIComponent(q)}&pageSize=10`, { credentials: 'include' })
        .then(response => response.json())
        .then(data => {
          let items: any[] = []
          if (Array.isArray(data.data?.items)) items = data.data.items
          else if (Array.isArray(data.data)) items = data.data
          else if (Array.isArray(data.items)) items = data.items
          else if (Array.isArray(data)) items = data
          setTestContactResults(items.map((item: any) => ({
            id: item.id,
            display_name: item.display_name || item.displayName || item.name || 'Unknown',
            primary_email: item.primary_email || item.primaryEmail || item.email || null,
          })))
        })
        .catch(() => {})
    }, 300)
  }

  function selectTestContact(contact: { id: string; display_name: string; primary_email: string | null }) {
    setTestSelectedContact(contact)
    setTestContactSearch('')
    setTestContactDropdownOpen(false)
    setTestResults(null)
  }

  function selectTestEmail(email: string) {
    setTestSelectedContact({ id: `email:${email}`, display_name: email, primary_email: email })
    setTestContactSearch('')
    setTestContactDropdownOpen(false)
    setTestResults(null)
  }

  async function runTest() {
    if (!testingRuleId || !testSelectedContact) return
    setTestRunning(true)
    setTestResults(null)
    try {
      const response = await fetch('/api/automation-rules/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          ruleId: testingRuleId,
          contactId: testSelectedContact.id.startsWith('email:') ? null : testSelectedContact.id,
          email: testSelectedContact.primary_email,
          dryRun: testDryRun,
        }),
      })
      const result = await response.json()
      if (result.ok) {
        setTestResults(result.data)
      } else {
        setTestResults({ error: result.error || 'Test failed' })
      }
    } catch {
      setTestResults({ error: 'Failed to connect to test endpoint' })
    }
    setTestRunning(false)
  }

  function handleUseTemplate(template: Template) {
    setShowTemplateGallery(false)
    // Convert template actions to steps
    const templateSteps: StepItem[] = template.actions.map(action => {
      if (action.type === 'wait') {
        return { type: 'delay' as const, delayMinutes: action.config?.duration || action.config?.delay || 1440 }
      }
      const actionTypeMap: Record<string, string> = {
        send_email: 'send_email', create_task: 'create_task', call_webhook: 'webhook',
        call_api: 'webhook', update_entity: 'move_to_stage', emit_event: 'webhook',
        execute_function: 'webhook', add_tag: 'add_tag', remove_tag: 'remove_tag',
        move_to_stage: 'move_to_stage', enroll_in_sequence: 'enroll_in_sequence',
      }
      return { type: 'action' as const, actionType: actionTypeMap[action.type] || 'webhook', actionConfig: action.config ?? {} }
    })

    // Map schedule templates to the schedule trigger type with proper config
    const isScheduleTemplate = template.trigger.type === 'schedule'
    const scheduleTypeMap: Record<string, { scheduleType: string; [key: string]: any }> = {
      'sales-stale-deal-alert': { scheduleType: 'stale_deals', staleDays: 14, intervalMinutes: 10080 },
      'sales-quote-expiry-reminder': { scheduleType: 'daily_summary', intervalMinutes: 1440 },
      'sales-invoice-overdue': { scheduleType: 'invoice_overdue', daysOverdue: 7, intervalMinutes: 1440 },
      'marketing-re-engagement': { scheduleType: 'inactive_contacts', inactiveDays: 60, intervalMinutes: 10080 },
      'cs-quarterly-checkin': { scheduleType: 'daily_summary', intervalMinutes: 10080 },
      'cs-renewal-reminder-60d': { scheduleType: 'daily_summary', intervalMinutes: 1440 },
      'cs-churn-risk-alert': { scheduleType: 'inactive_contacts', inactiveDays: 30, intervalMinutes: 10080 },
      'cs-onboarding-completion': { scheduleType: 'inactive_contacts', inactiveDays: 14, intervalMinutes: 1440 },
      'cs-anniversary-email': { scheduleType: 'daily_summary', intervalMinutes: 1440 },
      'ops-daily-pipeline-summary': { scheduleType: 'daily_summary', intervalMinutes: 1440 },
      'ops-weekly-activity-report': { scheduleType: 'daily_summary', intervalMinutes: 10080 },
      'notify-escalation-sla-breach': { scheduleType: 'daily_summary', intervalMinutes: 120 },
      'notify-daily-task-digest': { scheduleType: 'daily_summary', intervalMinutes: 1440 },
    }

    // Map template trigger types to our automation rule trigger types
    const triggerTypeMap: Record<string, string> = {
      'customers.person.created': 'contact_created',
      'customers.person.updated': 'contact_updated',
      'customers.company.created': 'company_created',
      'customers.deal.created': 'deal_created',
      'customers.deal.updated': 'stage_change',
      'customers.activity.created': 'form_submitted',
      'customers.activity.updated': 'form_submitted',
      'customers.comment.created': 'contact_updated',
      'sales.order.created': 'invoice_paid',
      'sales.order.updated': 'invoice_paid',
      'sales.payment.created': 'invoice_paid',
      'sales.quote.created': 'invoice_paid',
      'sales.shipment.created': 'booking_created',
      'sales.shipment.updated': 'booking_created',
      'sales.return.created': 'booking_created',
      'catalog.product.updated': 'form_submitted',
    }

    let triggerType: string
    let triggerConfig: Record<string, any>

    if (isScheduleTemplate) {
      triggerType = 'schedule'
      triggerConfig = { ...(template.trigger.config ?? {}), ...(scheduleTypeMap[template.id] || { scheduleType: 'daily_summary', intervalMinutes: 1440 }) }
    } else {
      // Check for deal_won/deal_lost special cases
      const rawType = template.trigger.type
      if (rawType === 'customers.deal.updated' && template.trigger.config?.stage === 'won') {
        triggerType = 'deal_won'
      } else if (rawType === 'customers.deal.updated' && template.trigger.config?.stage === 'lost') {
        triggerType = 'deal_lost'
      } else {
        triggerType = triggerTypeMap[rawType] || rawType
      }
      triggerConfig = template.trigger.config ?? {}
    }

    setEditingRule({
      name: template.name,
      description: template.description,
      trigger_type: triggerType,
      trigger_config: triggerConfig,
      action_type: templateSteps.find(s => s.type === 'action')?.actionType ?? 'send_email',
      action_config: templateSteps.find(s => s.type === 'action')?.actionConfig ?? {},
      steps: templateSteps.length > 1 ? templateSteps : null,
      conditions: template.conditions ?? null,
      template_id: template.id,
      status: 'active',
    } as Partial<AutomationRule>)
    setSlideOverOpen(true)
  }

  async function handleAiGenerate() {
    if (!aiPrompt.trim()) return
    setAiGenerating(true)
    setAiError(null)
    setAiPreview(null)
    try {
      const response = await fetch('/api/automation-rules/ai-generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ prompt: aiPrompt.trim() }),
      })
      const result = await response.json()
      if (result.ok && result.data) {
        setAiPreview(result.data)
      } else {
        setAiError(result.error || 'Failed to generate automation')
      }
    } catch {
      setAiError('Failed to connect to AI service')
    }
    setAiGenerating(false)
  }

  function acceptAiPreview() {
    if (!aiPreview) return
    const generated = aiPreview

    const aiSteps: StepItem[] | null = Array.isArray(generated.steps) && generated.steps.length > 0
      ? generated.steps
      : null
    const firstAction = aiSteps?.find((s: StepItem) => s.type === 'action')

    setEditingRule({
      name: generated.name ?? '',
      description: generated.description ?? '',
      trigger_type: generated.triggerType ?? 'contact_created',
      trigger_config: generated.triggerConfig ?? {},
      action_type: firstAction?.actionType ?? generated.actionType ?? 'send_email',
      action_config: firstAction?.actionConfig ?? generated.actionConfig ?? {},
      steps: aiSteps,
      conditions: generated.conditions?.length ? generated.conditions : null,
      status: 'active',
    } as Partial<AutomationRule>)
    setSlideOverOpen(true)
    setShowAiWizard(false)
    setAiPrompt('')
    setAiPreview(null)
  }

  const statusTabs: Array<{ key: StatusFilter; label: string }> = [
    { key: 'all', label: 'All' },
    { key: 'active', label: 'Active' },
    { key: 'paused', label: 'Paused' },
    { key: 'error', label: 'Error' },
  ]

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-semibold">Automations</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Automate repetitive tasks with trigger-based rules
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setShowHelpChat(true)}>
            <MessageCircle className="size-3.5 mr-1.5" /> Need Help?
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setShowAiWizard(true)}>
            <Wand2 className="size-3.5 mr-1.5" /> AI Create
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={openTemplateGallery}>
            <LayoutGrid className="size-3.5 mr-1.5" /> Templates
          </Button>
          <Button type="button" size="sm" onClick={openCreate}>
            <Plus className="size-3.5 mr-1.5" /> New Automation
          </Button>
        </div>
      </div>

      {/* Status tabs */}
      <div className="flex items-center gap-1 mb-4 border-b">
        {statusTabs.map(tab => (
          <Button
            key={tab.key}
            type="button"
            variant="ghost"
            size="sm"
            className={`h-auto rounded-none border-b-2 px-3 py-2 hover:bg-transparent text-xs font-medium ${
              statusFilter === tab.key
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground'
            }`}
            onClick={() => setStatusFilter(tab.key)}
          >
            {tab.label}{' '}
            <span className={`ml-1 text-[10px] px-1.5 py-0.5 rounded-full ${
              statusFilter === tab.key ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
            }`}>
              {counts[tab.key]}
            </span>
          </Button>
        ))}
      </div>

      {/* Search */}
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
        <Input
          value={searchQuery}
          onChange={event => setSearchQuery(event.target.value)}
          placeholder="Search automations..."
          className="h-9 pl-9 text-sm"
        />
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin mr-2" /> Loading automations...
        </div>
      ) : rules.length === 0 ? (
        /* Empty state - no automations at all */
        <div className="rounded-xl border p-16 text-center">
          <div className="size-14 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
            <Zap className="size-7 text-primary" />
          </div>
          <h3 className="text-base font-semibold mb-1">Automate your repetitive tasks</h3>
          <p className="text-sm text-muted-foreground max-w-sm mx-auto mb-6">
            Save time by letting automations handle routine work like sending emails, tagging contacts, and creating tasks.
          </p>
          <div className="flex items-center justify-center gap-3">
            <Button type="button" size="sm" onClick={openTemplateGallery}>
              <LayoutGrid className="size-3.5 mr-1.5" /> Browse Templates
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={openCreate}>
              <Plus className="size-3.5 mr-1.5" /> Create from Scratch
            </Button>
          </div>
        </div>
      ) : filteredRules.length === 0 ? (
        /* Empty state - no results for current filter */
        <div className="rounded-lg border p-12 text-center">
          <Filter className="size-6 mx-auto mb-2 text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">No automations match your filter</p>
          <p className="text-xs text-muted-foreground mt-1">Try a different status or search term</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filteredRules.map(rule => (
            <SentenceCard
              key={rule.id}
              rule={rule}
              onEdit={() => openEdit(rule)}
              onToggle={() => handleToggle(rule)}
              onDuplicate={() => handleDuplicate(rule)}
              onDelete={() => handleDelete(rule.id)}
              onRunNow={rule.trigger_type === 'schedule' ? () => handleRunNow(rule.id) : undefined}
              onTest={() => openTestModal(rule.id)}
              onToggleHistory={() => toggleHistory(rule.id)}
              historyExpanded={expandedHistoryId === rule.id}
              historyLoading={historyLoading === rule.id}
              historyLogs={historyLogs[rule.id]}
            />
          ))}
        </div>
      )}

      {/* Delete confirmation dialog */}
      {deletingId && (
        <>
          <div className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px]" onClick={() => setDeletingId(null)} />
          <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-sm bg-card rounded-xl border shadow-2xl p-6 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-start gap-3 mb-4">
              <div className="size-10 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center shrink-0">
                <Trash2 className="size-5 text-red-600 dark:text-red-400" />
              </div>
              <div>
                <h3 className="text-sm font-semibold">Delete automation?</h3>
                <p className="text-xs text-muted-foreground mt-1">
                  This will permanently delete this automation rule and all its execution history. This action cannot be undone.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setDeletingId(null)}>Cancel</Button>
              <Button type="button" variant="destructive" size="sm" onClick={confirmDelete}>
                <Trash2 className="size-3 mr-1.5" /> Delete
              </Button>
            </div>
          </div>
        </>
      )}

      {/* Template Gallery */}
      <TemplateGallery
        open={showTemplateGallery}
        templates={templates}
        loading={templatesLoading}
        onClose={() => setShowTemplateGallery(false)}
        onUseTemplate={handleUseTemplate}
        onStartFromScratch={openCreate}
      />

      {/* Create/Edit Slide-Over */}
      <SlideOver
        open={slideOverOpen}
        rule={editingRule}
        onClose={() => { setSlideOverOpen(false); setEditingRule(null) }}
        onSave={handleSave}
        saving={saving}
        rules={rules}
      />

      {/* AI Wizard Modal */}
      {showAiWizard && (
        <>
          <div className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px]" onClick={() => { if (!aiGenerating) { setShowAiWizard(false); setAiError(null) } }} />
          <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md bg-card rounded-xl border shadow-2xl animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between px-6 pt-5 pb-0">
              <div className="flex items-center gap-2">
                <div className="size-8 rounded-lg bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center">
                  <Wand2 className="size-4 text-purple-600 dark:text-purple-400" />
                </div>
                <h3 className="text-sm font-semibold">AI Automation Builder</h3>
              </div>
              <IconButton type="button" variant="ghost" size="sm" onClick={() => { if (!aiGenerating) { setShowAiWizard(false); setAiError(null) } }} aria-label="Close">
                <X className="size-4" />
              </IconButton>
            </div>

            <div className="px-6 py-4 space-y-4">
              {/* Preview mode */}
              {aiPreview ? (
                <>
                  <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
                    <div>
                      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Name</p>
                      <p className="text-sm font-medium">{aiPreview.name}</p>
                    </div>
                    {aiPreview.description && (
                      <div>
                        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Description</p>
                        <p className="text-xs text-muted-foreground">{aiPreview.description}</p>
                      </div>
                    )}
                    <div>
                      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Trigger</p>
                      <p className="text-xs">{aiPreview.triggerType?.replace(/_/g, ' ')}</p>
                    </div>
                    <div>
                      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Steps</p>
                      <div className="space-y-1.5">
                        {(aiPreview.steps || []).map((step: any, i: number) => (
                          <div key={i} className="flex items-center gap-2 text-xs">
                            <span className="size-5 rounded-full bg-accent/10 text-accent flex items-center justify-center text-[10px] font-bold shrink-0">{i + 1}</span>
                            {step.type === 'delay' ? (
                              <span className="text-muted-foreground">Wait {step.delayMinutes >= 1440 ? `${Math.round(step.delayMinutes / 1440)} day${Math.round(step.delayMinutes / 1440) !== 1 ? 's' : ''}` : step.delayMinutes >= 60 ? `${Math.round(step.delayMinutes / 60)} hour${Math.round(step.delayMinutes / 60) !== 1 ? 's' : ''}` : `${step.delayMinutes} min`}</span>
                            ) : (
                              <span><strong>{step.actionType?.replace(/_/g, ' ')}</strong>{step.actionConfig?.subject ? `: "${step.actionConfig.subject}"` : step.actionConfig?.title ? `: "${step.actionConfig.title}"` : step.actionConfig?.tagName ? `: ${step.actionConfig.tagName}` : ''}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button type="button" size="sm" className="flex-1" onClick={acceptAiPreview}>
                      Use This Automation
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => { setAiPreview(null) }}>
                      Regenerate
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">
                    Describe what you want to automate in plain English:
                  </p>
                  <Textarea
                    value={aiPrompt}
                    onChange={event => setAiPrompt(event.target.value)}
                    placeholder="When a new contact is created from a form submission, send them a welcome email and create a follow-up task"
                    className="text-sm min-h-[80px] resize-none"
                    autoFocus
                    disabled={aiGenerating}
                    onKeyDown={event => {
                      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                        event.preventDefault()
                        handleAiGenerate()
                      }
                    }}
                  />

                  {aiError && (
                    <div className="flex items-center gap-2 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-md px-3 py-2">
                      <AlertTriangle className="size-3.5 shrink-0" />
                      {aiError}
                    </div>
                  )}

                  <Button
                    type="button"
                    size="sm"
                    className="w-full"
                    onClick={handleAiGenerate}
                    disabled={aiGenerating || !aiPrompt.trim()}
                  >
                    {aiGenerating ? (
                      <><Loader2 className="size-3.5 animate-spin mr-1.5" /> Generating...</>
                    ) : (
                      <><Wand2 className="size-3.5 mr-1.5" /> Generate Automation</>
                    )}
                  </Button>

                  <div className="border-t pt-3">
                    <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">Examples</p>
                    <div className="space-y-1.5">
                      {[
                        'Send a welcome email when a new contact is created, then wait 3 days and create a follow-up task',
                        'When a deal is won, send a congratulations email, wait 1 week, then send a check-in email',
                        'Add a VIP tag when an invoice is paid, then send a thank you email',
                        'Notify the team via webhook when a high-value deal changes stage',
                      ].map(example => (
                        <button
                          key={example}
                          type="button"
                          className="block w-full text-left text-xs text-muted-foreground hover:text-foreground transition-colors px-2.5 py-1.5 rounded-md hover:bg-muted/50"
                          onClick={() => setAiPrompt(example)}
                          disabled={aiGenerating}
                        >
                          &ldquo;{example}&rdquo;
                    </button>
                  ))}
                </div>
              </div>
              </>
              )}
            </div>
          </div>
        </>
      )}

      {/* Test Automation Modal */}
      {testingRuleId && (() => {
        const testingRule = rules.find(r => r.id === testingRuleId)
        if (!testingRule) return null
        return (
          <>
            <div className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px]" onClick={() => { if (!testRunning) closeTestModal() }} />
            <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-lg bg-card rounded-xl border shadow-2xl animate-in fade-in zoom-in-95 duration-150 max-h-[85vh] flex flex-col">
              {/* Header */}
              <div className="flex items-center justify-between px-6 pt-5 pb-3 border-b shrink-0">
                <div className="flex items-center gap-2.5">
                  <div className="size-8 rounded-lg bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center">
                    <FlaskConical className="size-4 text-violet-600 dark:text-violet-400" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold">Test Automation</h3>
                    <p className="text-xs text-muted-foreground truncate max-w-[280px]">{testingRule.name}</p>
                  </div>
                </div>
                <IconButton type="button" variant="ghost" size="sm" onClick={() => { if (!testRunning) closeTestModal() }} aria-label="Close">
                  <X className="size-4" />
                </IconButton>
              </div>

              {/* Scrollable content */}
              <div className="overflow-y-auto flex-1 px-6 py-4 space-y-4">
                {/* Paused warning */}
                {testingRule.status === 'paused' && (
                  <div className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded-lg px-3 py-2">
                    <AlertTriangle className="size-3.5 shrink-0" />
                    This automation is paused. Testing will still evaluate conditions and preview steps.
                  </div>
                )}

                {/* Contact or email input */}
                <div>
                  <label className="text-[11px] font-medium text-muted-foreground block mb-1.5">Test with a contact or email</label>

                  {testSelectedContact ? (
                    <div className="flex items-center gap-2 h-9 rounded-lg border bg-card px-3">
                      <div className="size-5 rounded-full bg-accent/10 flex items-center justify-center text-[9px] font-semibold text-accent shrink-0">
                        {testSelectedContact.display_name?.[0]?.toUpperCase() || '@'}
                      </div>
                      <span className="text-sm flex-1 truncate">
                        {testSelectedContact.display_name}
                        {testSelectedContact.primary_email && testSelectedContact.display_name !== testSelectedContact.primary_email
                          ? ` (${testSelectedContact.primary_email})` : ''}
                      </span>
                      <button type="button" onClick={() => { setTestSelectedContact(null); setTestContactSearch(''); setTestResults(null) }}
                        className="text-muted-foreground hover:text-foreground shrink-0">
                        <X className="size-3.5" />
                      </button>
                    </div>
                  ) : (
                    <div className="relative" data-test-contact-picker>
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                      <Input
                        value={testContactSearch}
                        onChange={event => handleTestContactSearch(event.target.value)}
                        onFocus={() => { handleTestContactSearch(testContactSearch); setTestContactDropdownOpen(true) }}
                        onKeyDown={event => {
                          if (event.key === 'Enter' && testContactSearch.includes('@')) {
                            event.preventDefault()
                            selectTestEmail(testContactSearch.trim())
                          }
                        }}
                        placeholder="Search contacts or type an email..."
                        className="h-9 pl-9 text-sm"
                        autoFocus
                      />
                      {testContactDropdownOpen && (
                        <div className="absolute left-0 right-0 top-full mt-1 z-50 rounded-lg border bg-card shadow-lg max-h-48 overflow-y-auto py-1">
                          {testContactResults.map(contact => (
                            <button
                              key={contact.id}
                              type="button"
                              className="w-full text-left px-3 py-2 hover:bg-muted/50 transition-colors flex items-center gap-2"
                              onClick={() => selectTestContact(contact)}
                            >
                              <div className="size-6 rounded-full bg-accent/10 flex items-center justify-center text-[10px] font-semibold text-accent shrink-0">
                                {contact.display_name?.[0]?.toUpperCase() || '?'}
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="text-sm font-medium truncate">{contact.display_name}</div>
                                {contact.primary_email && <div className="text-xs text-muted-foreground truncate">{contact.primary_email}</div>}
                              </div>
                            </button>
                          ))}
                          {testContactSearch.includes('@') && (
                            <button
                              type="button"
                              className="w-full text-left px-3 py-2 hover:bg-muted/50 transition-colors flex items-center gap-2 border-t"
                              onClick={() => selectTestEmail(testContactSearch.trim())}
                            >
                              <Mail className="size-4 text-muted-foreground" />
                              <span className="text-sm">Test with <strong>{testContactSearch.trim()}</strong></span>
                            </button>
                          )}
                          {testContactResults.length === 0 && !testContactSearch.includes('@') && testContactSearch.trim() && (
                            <div className="px-3 py-3 text-center text-xs text-muted-foreground">
                              No contacts found. Type a full email to test without a contact.
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Mode selection */}
                <div>
                  <label className="text-[11px] font-medium text-muted-foreground block mb-2">Mode</label>
                  <div className="space-y-1.5">
                    <label className="flex items-start gap-2.5 cursor-pointer rounded-lg border px-3 py-2.5 transition-colors hover:bg-muted/30"
                      style={testDryRun ? { borderColor: 'hsl(var(--primary) / 0.5)', backgroundColor: 'hsl(var(--primary) / 0.04)' } : {}}>
                      <input
                        type="radio"
                        name="testMode"
                        checked={testDryRun}
                        onChange={() => setTestDryRun(true)}
                        className="mt-0.5 accent-[hsl(var(--primary))]"
                      />
                      <div>
                        <div className="text-xs font-medium">Dry Run</div>
                        <div className="text-[11px] text-muted-foreground">Show what would happen without executing</div>
                      </div>
                    </label>
                    <label className="flex items-start gap-2.5 cursor-pointer rounded-lg border px-3 py-2.5 transition-colors hover:bg-muted/30"
                      style={!testDryRun ? { borderColor: 'hsl(var(--primary) / 0.5)', backgroundColor: 'hsl(var(--primary) / 0.04)' } : {}}>
                      <input
                        type="radio"
                        name="testMode"
                        checked={!testDryRun}
                        onChange={() => setTestDryRun(false)}
                        className="mt-0.5 accent-[hsl(var(--primary))]"
                      />
                      <div>
                        <div className="text-xs font-medium">Execute</div>
                        <div className="text-[11px] text-muted-foreground">Actually run the automation against this contact</div>
                      </div>
                    </label>
                  </div>
                </div>

                {/* Run button */}
                <Button
                  type="button"
                  size="sm"
                  className="w-full"
                  onClick={runTest}
                  disabled={testRunning || !testSelectedContact}
                >
                  {testRunning ? (
                    <><Loader2 className="size-3.5 animate-spin mr-1.5" /> Running Test...</>
                  ) : (
                    <><FlaskConical className="size-3.5 mr-1.5" /> Run Test</>
                  )}
                </Button>

                {/* Results */}
                {testResults && !testResults.error && (
                  <div className="border-t pt-4 space-y-3">
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Results</h4>

                    {/* Contact info */}
                    <div className="rounded-lg bg-muted/30 px-3 py-2.5 text-xs space-y-1">
                      <div className="flex items-center gap-2">
                        <Users className="size-3.5 text-muted-foreground" />
                        <span className="font-medium">{testResults.contact.name}</span>
                        {testResults.contact.email && (
                          <span className="text-muted-foreground">({testResults.contact.email})</span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-muted-foreground pl-5">
                        {testResults.contact.source && <span>Source: {testResults.contact.source}</span>}
                        {testResults.contact.stage && <span>Stage: {testResults.contact.stage}</span>}
                      </div>
                    </div>

                    {/* Conditions */}
                    {testResults.conditions.items.length > 0 && (
                      <div>
                        <h5 className="text-[11px] font-medium text-muted-foreground mb-1.5">Conditions</h5>
                        <div className="space-y-1">
                          {testResults.conditions.items.map((condition: any, idx: number) => (
                            <div key={idx} className={`flex items-start gap-2 text-xs rounded-md px-2.5 py-1.5 ${
                              condition.passes
                                ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-300'
                                : 'bg-red-50 text-red-800 dark:bg-red-900/20 dark:text-red-300'
                            }`}>
                              {condition.passes
                                ? <CheckCircle2 className="size-3.5 shrink-0 mt-0.5 text-emerald-500" />
                                : <XCircle className="size-3.5 shrink-0 mt-0.5 text-red-500" />
                              }
                              <span>
                                <span className="font-medium">{condition.field}</span> {condition.operator} {condition.value != null ? `"${condition.value}"` : ''}
                                <span className="opacity-70"> (actual: {condition.actual != null ? `"${condition.actual}"` : 'empty'})</span>
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Steps */}
                    <div>
                      <h5 className="text-[11px] font-medium text-muted-foreground mb-1.5">Steps</h5>
                      <div className="space-y-1">
                        {testResults.steps.map((step: any) => (
                          <div key={step.index} className={`flex items-start gap-2 text-xs rounded-md px-2.5 py-1.5 ${
                            step.type === 'delay'
                              ? 'bg-slate-50 text-slate-600 dark:bg-slate-800/50 dark:text-slate-400'
                              : step.wouldExecute
                                ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-300'
                                : 'bg-red-50 text-red-800 dark:bg-red-900/20 dark:text-red-300'
                          }`}>
                            {step.type === 'delay' ? (
                              <Timer className="size-3.5 shrink-0 mt-0.5 text-slate-400" />
                            ) : step.wouldExecute ? (
                              <CheckCircle2 className="size-3.5 shrink-0 mt-0.5 text-emerald-500" />
                            ) : (
                              <XCircle className="size-3.5 shrink-0 mt-0.5 text-red-500" />
                            )}
                            <span>
                              <span className="font-medium">{step.index + 1}.</span> {step.description}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Summary */}
                    <div className={`rounded-lg px-3 py-2.5 text-xs font-medium ${
                      testResults.conditions.allPass
                        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300'
                        : 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300'
                    }`}>
                      {testResults.conditions.allPass ? (
                        <span className="flex items-center gap-2">
                          <CheckCircle2 className="size-3.5" />
                          {testResults.summary}
                        </span>
                      ) : (
                        <span className="flex items-center gap-2">
                          <XCircle className="size-3.5" />
                          {testResults.summary}
                        </span>
                      )}
                    </div>

                    {/* Execution result (non-dry-run) */}
                    {testResults.executionResults && (
                      <div className={`rounded-lg px-3 py-2.5 text-xs ${
                        testResults.executionResults.executed
                          ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300'
                          : 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300'
                      }`}>
                        {testResults.executionResults.message}
                      </div>
                    )}
                  </div>
                )}

                {/* Error state */}
                {testResults?.error && (
                  <div className="flex items-center gap-2 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2.5">
                    <AlertTriangle className="size-3.5 shrink-0" />
                    {testResults.error}
                  </div>
                )}
              </div>
            </div>
          </>
        )
      })()}

      {/* Help Chat Panel */}
      <HelpChatPanel
        open={showHelpChat}
        onClose={() => setShowHelpChat(false)}
        rules={rules}
      />
    </div>
  )
}
