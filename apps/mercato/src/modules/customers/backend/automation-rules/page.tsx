'use client'

import { useState, useEffect, useCallback } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import {
  Plus, Zap, Trash2, Mail, Tag, ArrowRight, CheckSquare, GitBranch,
  Globe, MessageSquare, X, Loader2, ChevronDown, ChevronRight, Power, PowerOff,
} from 'lucide-react'

type Rule = {
  id: string
  name: string
  trigger_type: string
  trigger_config: any
  action_type: string
  action_config: any
  is_active: boolean
  execution_count: number
  created_at: string
}

type LogEntry = {
  id: string
  rule_id: string
  contact_id: string | null
  trigger_data: any
  action_result: any
  status: string
  created_at: string
}

const TRIGGER_TYPES = [
  { id: 'contact_created', label: 'Contact Created', description: 'When a new contact is added' },
  { id: 'tag_added', label: 'Tag Added', description: 'When a tag is assigned to a contact' },
  { id: 'tag_removed', label: 'Tag Removed', description: 'When a tag is removed from a contact' },
  { id: 'invoice_paid', label: 'Invoice Paid', description: 'When an invoice is marked as paid' },
  { id: 'form_submitted', label: 'Form Submitted', description: 'When a landing page form is submitted' },
  { id: 'booking_created', label: 'Booking Created', description: 'When a new booking is made' },
  { id: 'deal_won', label: 'Deal Won', description: 'When a deal is marked as won' },
  { id: 'deal_lost', label: 'Deal Lost', description: 'When a deal is marked as lost' },
  { id: 'course_enrolled', label: 'Course Enrolled', description: 'When someone enrolls in a course' },
  { id: 'schedule', label: 'Scheduled Trigger', description: 'Runs on a recurring schedule' },
]

const ACTION_TYPES = [
  { id: 'send_email', label: 'Send Email', icon: Mail },
  { id: 'send_sms', label: 'Send SMS', icon: MessageSquare },
  { id: 'add_tag', label: 'Add Tag', icon: Tag },
  { id: 'remove_tag', label: 'Remove Tag', icon: Tag },
  { id: 'move_to_stage', label: 'Move to Stage', icon: ArrowRight },
  { id: 'create_task', label: 'Create Task', icon: CheckSquare },
  { id: 'enroll_in_sequence', label: 'Enroll in Sequence', icon: GitBranch },
  { id: 'webhook', label: 'Webhook', icon: Globe },
]

export default function AutomationRulesPage() {
  const [rules, setRules] = useState<Rule[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [creating, setCreating] = useState(false)
  const [expandedRule, setExpandedRule] = useState<string | null>(null)
  const [logs, setLogs] = useState<Record<string, LogEntry[]>>({})
  const [logsLoading, setLogsLoading] = useState<string | null>(null)

  // Form state
  const [name, setName] = useState('')
  const [triggerType, setTriggerType] = useState('contact_created')
  const [actionType, setActionType] = useState('send_email')

  // Trigger config
  const [triggerTagSlug, setTriggerTagSlug] = useState('')
  const [triggerFormId, setTriggerFormId] = useState('')
  const [triggerSource, setTriggerSource] = useState('')

  // Action config
  const [emailSubject, setEmailSubject] = useState('')
  const [emailBody, setEmailBody] = useState('')
  const [emailFrom, setEmailFrom] = useState('')
  const [smsMessage, setSmsMessage] = useState('')
  const [tagName, setTagName] = useState('')
  const [stage, setStage] = useState('')
  const [taskTitle, setTaskTitle] = useState('')
  const [taskDueDays, setTaskDueDays] = useState('3')
  const [sequenceId, setSequenceId] = useState('')
  const [webhookUrl, setWebhookUrl] = useState('')

  // Available sequences for dropdown
  const [sequences, setSequences] = useState<Array<{ id: string; name: string }>>([])

  const loadRules = useCallback(() => {
    fetch('/api/sequences/automation-rules', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.ok) setRules(d.data || []) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    loadRules()
    fetch('/api/sequences', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (d.ok) setSequences((d.data?.items || d.data || []).map((s: any) => ({ id: s.id, name: s.name })))
      })
      .catch(() => {})
  }, [loadRules])

  function resetForm() {
    setName(''); setTriggerType('contact_created'); setActionType('send_email')
    setTriggerTagSlug(''); setTriggerFormId(''); setTriggerSource('')
    setEmailSubject(''); setEmailBody(''); setEmailFrom('')
    setSmsMessage(''); setTagName(''); setStage('')
    setTaskTitle(''); setTaskDueDays('3'); setSequenceId(''); setWebhookUrl('')
  }

  async function createRule() {
    if (!name.trim()) return

    const triggerConfig: Record<string, any> = {}
    if ((triggerType === 'tag_added' || triggerType === 'tag_removed') && triggerTagSlug) triggerConfig.tagSlug = triggerTagSlug
    if (triggerType === 'form_submitted' && triggerFormId) triggerConfig.formId = triggerFormId
    if (triggerType === 'contact_created' && triggerSource) triggerConfig.source = triggerSource

    let actionConfig: Record<string, any> = {}
    switch (actionType) {
      case 'send_email': actionConfig = { subject: emailSubject, bodyHtml: emailBody, fromEmail: emailFrom }; break
      case 'send_sms': actionConfig = { message: smsMessage }; break
      case 'add_tag': case 'remove_tag': actionConfig = { tagName }; break
      case 'move_to_stage': actionConfig = { stage }; break
      case 'create_task': actionConfig = { taskTitle, dueDays: parseInt(taskDueDays) || 3 }; break
      case 'enroll_in_sequence': actionConfig = { sequenceId }; break
      case 'webhook': actionConfig = { url: webhookUrl }; break
    }

    setCreating(true)
    try {
      const res = await fetch('/api/sequences/automation-rules', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ name, triggerType, triggerConfig, actionType, actionConfig }),
      })
      const d = await res.json()
      if (d.ok) { setShowCreate(false); resetForm(); loadRules() }
    } catch {}
    setCreating(false)
  }

  async function toggleRule(rule: Rule) {
    await fetch(`/api/sequences/automation-rules?id=${rule.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ isActive: !rule.is_active }),
    })
    loadRules()
  }

  async function deleteRule(id: string) {
    if (!confirm('Delete this automation rule and its logs?')) return
    await fetch(`/api/sequences/automation-rules?id=${id}`, { method: 'DELETE', credentials: 'include' })
    loadRules()
  }

  async function loadLogs(ruleId: string) {
    if (expandedRule === ruleId) { setExpandedRule(null); return }
    setExpandedRule(ruleId)
    if (logs[ruleId]) return
    setLogsLoading(ruleId)
    try {
      const res = await fetch(`/api/sequences/automation-rules/${ruleId}/logs`, { credentials: 'include' })
      const d = await res.json()
      if (d.ok) setLogs(prev => ({ ...prev, [ruleId]: (d.data || []).slice(0, 5) }))
    } catch {}
    setLogsLoading(null)
  }

  const triggerLabel = (type: string) => TRIGGER_TYPES.find(t => t.id === type)?.label || type
  const actionLabel = (type: string) => ACTION_TYPES.find(a => a.id === type)?.label || type
  const ActionIcon = (type: string) => ACTION_TYPES.find(a => a.id === type)?.icon || Zap

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-semibold">Automation Rules</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            When [trigger] happens, then [action] runs automatically
          </p>
        </div>
        <Button type="button" size="sm" onClick={() => { resetForm(); setShowCreate(true) }}>
          <Plus className="size-3.5 mr-1.5" /> New Rule
        </Button>
      </div>

      {/* Create Form */}
      {showCreate && (
        <div className="rounded-lg border bg-card p-5 mb-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Zap className="size-4 text-accent" /> New Automation Rule
            </h3>
            <IconButton type="button" variant="ghost" size="sm" onClick={() => setShowCreate(false)} aria-label="Close">
              <X className="size-4" />
            </IconButton>
          </div>

          <Input value={name} onChange={e => setName(e.target.value)} placeholder="Rule name (e.g. Welcome new leads)" className="h-9 text-sm" />

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">When</label>
              <select value={triggerType} onChange={e => setTriggerType(e.target.value)}
                className="w-full h-9 rounded-md border bg-card px-3 text-sm">
                {TRIGGER_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
              <p className="text-[10px] text-muted-foreground mt-1">
                {TRIGGER_TYPES.find(t => t.id === triggerType)?.description}
              </p>
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Then</label>
              <select value={actionType} onChange={e => setActionType(e.target.value)}
                className="w-full h-9 rounded-md border bg-card px-3 text-sm">
                {ACTION_TYPES.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
            </div>
          </div>

          {/* Trigger config */}
          {(triggerType === 'tag_added' || triggerType === 'tag_removed') && (
            <div className="pt-2 border-t">
              <label className="text-[11px] font-medium text-muted-foreground block mb-1">Tag slug (optional filter)</label>
              <Input value={triggerTagSlug} onChange={e => setTriggerTagSlug(e.target.value)} placeholder="e.g. vip (leave empty for any tag)" className="h-9 text-sm" />
            </div>
          )}
          {triggerType === 'form_submitted' && (
            <div className="pt-2 border-t">
              <label className="text-[11px] font-medium text-muted-foreground block mb-1">Form ID (optional filter)</label>
              <Input value={triggerFormId} onChange={e => setTriggerFormId(e.target.value)} placeholder="Leave empty for any form" className="h-9 text-sm" />
            </div>
          )}
          {triggerType === 'contact_created' && (
            <div className="pt-2 border-t">
              <label className="text-[11px] font-medium text-muted-foreground block mb-1">Source (optional filter)</label>
              <Input value={triggerSource} onChange={e => setTriggerSource(e.target.value)} placeholder="e.g. landing_page (leave empty for any)" className="h-9 text-sm" />
            </div>
          )}

          {/* Action config */}
          {actionType === 'send_email' && (
            <div className="space-y-3 pt-2 border-t">
              <Input value={emailFrom} onChange={e => setEmailFrom(e.target.value)} placeholder="From email (optional, uses default)" className="h-9 text-sm" />
              <Input value={emailSubject} onChange={e => setEmailSubject(e.target.value)} placeholder="Subject (supports {{firstName}})" className="h-9 text-sm" />
              <textarea value={emailBody} onChange={e => setEmailBody(e.target.value)}
                placeholder="Email body HTML (supports {{firstName}})"
                className="w-full rounded-md border bg-card px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring h-20" />
            </div>
          )}
          {actionType === 'send_sms' && (
            <div className="pt-2 border-t">
              <Input value={smsMessage} onChange={e => setSmsMessage(e.target.value)} placeholder="SMS message" className="h-9 text-sm" />
            </div>
          )}
          {(actionType === 'add_tag' || actionType === 'remove_tag') && (
            <div className="pt-2 border-t">
              <Input value={tagName} onChange={e => setTagName(e.target.value)} placeholder="Tag name" className="h-9 text-sm" />
            </div>
          )}
          {actionType === 'move_to_stage' && (
            <div className="pt-2 border-t">
              <label className="text-[11px] font-medium text-muted-foreground block mb-1">Lifecycle stage</label>
              <select value={stage} onChange={e => setStage(e.target.value)}
                className="w-full h-9 rounded-md border bg-card px-3 text-sm">
                <option value="">Select stage...</option>
                <option value="prospect">Prospect</option>
                <option value="lead">Lead</option>
                <option value="opportunity">Opportunity</option>
                <option value="customer">Customer</option>
                <option value="churned">Churned</option>
              </select>
            </div>
          )}
          {actionType === 'create_task' && (
            <div className="space-y-3 pt-2 border-t">
              <Input value={taskTitle} onChange={e => setTaskTitle(e.target.value)} placeholder="Task title" className="h-9 text-sm" />
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Due in</span>
                <Input type="number" value={taskDueDays} onChange={e => setTaskDueDays(e.target.value)} className="w-16 h-9 text-sm" />
                <span className="text-xs text-muted-foreground">days</span>
              </div>
            </div>
          )}
          {actionType === 'enroll_in_sequence' && (
            <div className="pt-2 border-t">
              <label className="text-[11px] font-medium text-muted-foreground block mb-1">Sequence</label>
              <select value={sequenceId} onChange={e => setSequenceId(e.target.value)}
                className="w-full h-9 rounded-md border bg-card px-3 text-sm">
                <option value="">Select sequence...</option>
                {sequences.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}
          {actionType === 'webhook' && (
            <div className="pt-2 border-t">
              <Input value={webhookUrl} onChange={e => setWebhookUrl(e.target.value)} placeholder="https://example.com/webhook" className="h-9 text-sm" />
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t">
            <Button type="button" variant="outline" size="sm" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button type="button" size="sm" onClick={createRule} disabled={creating || !name.trim()}>
              {creating ? <Loader2 className="size-3 animate-spin mr-1" /> : <Zap className="size-3 mr-1" />} Create Rule
            </Button>
          </div>
        </div>
      )}

      {/* Rules List */}
      {loading ? (
        <div className="text-sm text-muted-foreground flex items-center gap-2">
          <Loader2 className="size-4 animate-spin" /> Loading rules...
        </div>
      ) : rules.length === 0 ? (
        <div className="rounded-lg border p-12 text-center">
          <Zap className="size-8 mx-auto mb-3 text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">No automation rules yet.</p>
          <p className="text-xs text-muted-foreground mt-1">
            Create rules to automate actions when events happen in your CRM.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {rules.map(rule => {
            const Icon = ActionIcon(rule.action_type)
            const isExpanded = expandedRule === rule.id
            const ruleLogs = logs[rule.id] || []
            const triggerConfig = typeof rule.trigger_config === 'string' ? JSON.parse(rule.trigger_config) : (rule.trigger_config || {})
            const actionConfig = typeof rule.action_config === 'string' ? JSON.parse(rule.action_config) : (rule.action_config || {})

            let triggerDetail = ''
            if (triggerConfig.tagSlug) triggerDetail = ` (tag: ${triggerConfig.tagSlug})`
            if (triggerConfig.source) triggerDetail = ` (source: ${triggerConfig.source})`

            let actionDetail = ''
            if (rule.action_type === 'send_email') actionDetail = actionConfig.subject || 'No subject'
            else if (rule.action_type === 'add_tag' || rule.action_type === 'remove_tag') actionDetail = actionConfig.tagName || ''
            else if (rule.action_type === 'move_to_stage') actionDetail = actionConfig.stage || ''
            else if (rule.action_type === 'create_task') actionDetail = actionConfig.taskTitle || `Due in ${actionConfig.dueDays || 3} days`
            else if (rule.action_type === 'webhook') actionDetail = actionConfig.url || ''
            else if (rule.action_type === 'enroll_in_sequence') actionDetail = 'Sequence enrollment'
            else if (rule.action_type === 'send_sms') actionDetail = actionConfig.message || ''

            return (
              <div key={rule.id} className="rounded-lg border">
                <div className="flex items-center gap-3 px-4 py-3 group">
                  <button type="button" onClick={() => loadLogs(rule.id)} className="shrink-0">
                    {isExpanded ? <ChevronDown className="size-3.5 text-muted-foreground" /> : <ChevronRight className="size-3.5 text-muted-foreground" />}
                  </button>
                  <div className="w-8 h-8 rounded-md bg-accent/10 flex items-center justify-center shrink-0">
                    <Zap className={`size-4 ${rule.is_active ? 'text-accent' : 'text-muted-foreground'}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-medium ${!rule.is_active ? 'text-muted-foreground' : ''}`}>
                      {rule.name}
                    </p>
                    <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                      {triggerLabel(rule.trigger_type)}{triggerDetail}
                      <ArrowRight className="size-3" />
                      <Icon className="size-3" /> {actionLabel(rule.action_type)}
                      {actionDetail ? `: ${actionDetail}` : ''}
                    </p>
                  </div>
                  <span className="text-[10px] text-muted-foreground tabular-nums">
                    {rule.execution_count} run{rule.execution_count !== 1 ? 's' : ''}
                  </span>
                  <IconButton type="button" variant="ghost" size="sm"
                    onClick={() => toggleRule(rule)} aria-label={rule.is_active ? 'Disable' : 'Enable'}
                    className="opacity-0 group-hover:opacity-100 transition">
                    {rule.is_active ? <Power className="size-3.5 text-green-500" /> : <PowerOff className="size-3.5 text-muted-foreground" />}
                  </IconButton>
                  <IconButton type="button" variant="ghost" size="sm"
                    onClick={() => deleteRule(rule.id)} aria-label="Delete"
                    className="opacity-0 group-hover:opacity-100 transition">
                    <Trash2 className="size-3.5" />
                  </IconButton>
                </div>

                {/* Execution logs */}
                {isExpanded && (
                  <div className="border-t px-4 py-3 bg-muted/30">
                    <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2">Recent Executions</p>
                    {logsLoading === rule.id ? (
                      <div className="text-xs text-muted-foreground flex items-center gap-1">
                        <Loader2 className="size-3 animate-spin" /> Loading...
                      </div>
                    ) : ruleLogs.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No executions yet.</p>
                    ) : (
                      <div className="space-y-1.5">
                        {ruleLogs.map(log => {
                          const result = typeof log.action_result === 'string' ? JSON.parse(log.action_result) : (log.action_result || {})
                          return (
                            <div key={log.id} className="flex items-center gap-2 text-xs">
                              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${log.status === 'executed' ? 'bg-green-500' : 'bg-red-500'}`} />
                              <span className="text-muted-foreground tabular-nums">
                                {new Date(log.created_at).toLocaleDateString()} {new Date(log.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </span>
                              <span className="truncate">
                                {result.detail || log.status}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
