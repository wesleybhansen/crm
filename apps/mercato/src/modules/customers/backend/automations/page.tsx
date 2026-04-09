'use client'

import { useState, useEffect } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Plus, Zap, Trash2, Mail, CheckSquare, UserCog, Bell, X, Loader2, ClipboardList } from 'lucide-react'

type Automation = {
  id: string; trigger_stage: string; action_type: string
  action_config: any; is_active: boolean; created_at: string
}

const actionTypes = [
  { id: 'send_email', label: 'Send Email', icon: Mail, description: 'Send an automated email to the contact' },
  { id: 'send_survey', label: 'Send Survey', icon: ClipboardList, description: 'Email a survey link to the contact' },
  { id: 'create_task', label: 'Create Task', icon: CheckSquare, description: 'Create a follow-up task' },
  { id: 'update_contact', label: 'Update Contact', icon: UserCog, description: 'Change contact lifecycle stage or status' },
  { id: 'notify', label: 'Log Activity', icon: Bell, description: 'Log an activity note on the contact' },
]

export default function AutomationsPage() {
  const [automations, setAutomations] = useState<Automation[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [triggerStage, setTriggerStage] = useState('')
  const [actionType, setActionType] = useState('send_email')
  const [creating, setCreating] = useState(false)
  const [pipelineStages, setPipelineStages] = useState<string[]>([])
  const [customStage, setCustomStage] = useState('')

  // Action config fields
  const [emailSubject, setEmailSubject] = useState('')
  const [emailBody, setEmailBody] = useState('')
  const [taskTitle, setTaskTitle] = useState('')
  const [taskDueDays, setTaskDueDays] = useState('3')
  const [contactField, setContactField] = useState('lifecycle_stage')
  const [contactValue, setContactValue] = useState('customer')
  const [notifyMessage, setNotifyMessage] = useState('')
  const [surveyId, setSurveyId] = useState('')
  const [surveyMessage, setSurveyMessage] = useState('')
  const [availableSurveys, setAvailableSurveys] = useState<Array<{ id: string; title: string }>>([])
  const [surveysLoaded, setSurveysLoaded] = useState(false)

  useEffect(() => {
    loadAutomations()
    // Load pipeline stages from the database
    fetch('/api/customers/pipeline-stages', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        let stages: string[] = []
        const items = Array.isArray(d.data) ? d.data : d.data?.items || d.items || []
        if (items.length > 0) {
          stages = items.map((s: any) => s.name || s.title || s.label).filter(Boolean)
        }
        if (stages.length === 0) {
          // Fallback — check business profile for custom stages
          fetch('/api/customers/business-profile', { credentials: 'include' })
            .then(r => r.json())
            .then(bp => {
              if (bp.ok && bp.data?.pipeline_stages) {
                const ps = typeof bp.data.pipeline_stages === 'string' ? JSON.parse(bp.data.pipeline_stages) : bp.data.pipeline_stages
                stages = ps.map((s: any) => s.name || s).filter(Boolean)
              }
              if (stages.length === 0) stages = ['New Lead', 'Contacted', 'Qualified', 'Proposal', 'Won', 'Lost']
              setPipelineStages(stages)
              if (!triggerStage && stages.length > 0) setTriggerStage(stages[stages.length - 2] || stages[0])
            })
            .catch(() => { setPipelineStages(['New Lead', 'Contacted', 'Qualified', 'Proposal', 'Won', 'Lost']); setTriggerStage('Won') })
        } else {
          setPipelineStages(stages)
          if (!triggerStage && stages.length > 0) setTriggerStage(stages[stages.length - 2] || stages[0])
        }
      })
      .catch(() => { setPipelineStages(['New Lead', 'Contacted', 'Qualified', 'Proposal', 'Won', 'Lost']); setTriggerStage('Won') })
  }, [])

  function loadAutomations() {
    fetch('/api/automations', { credentials: 'include' })
      .then(r => r.json()).then(d => { if (d.ok) setAutomations(d.data || []); setLoading(false) }).catch(() => setLoading(false))
  }

  async function createAutomation() {
    let actionConfig: any = {}
    switch (actionType) {
      case 'send_email': actionConfig = { subject: emailSubject, body: emailBody }; break
      case 'send_survey': actionConfig = { surveyId, message: surveyMessage }; break
      case 'create_task': actionConfig = { taskTitle, dueDays: parseInt(taskDueDays) || 3 }; break
      case 'update_contact': actionConfig = { field: contactField, value: contactValue }; break
      case 'notify': actionConfig = { message: notifyMessage }; break
    }

    setCreating(true)
    try {
      const res = await fetch('/api/automations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ triggerStage, actionType, actionConfig }),
      })
      if ((await res.json()).ok) { setShowCreate(false); loadAutomations() }
    } catch {}
    setCreating(false)
  }

  async function deleteAutomation(id: string) {
    if (!confirm('Delete this automation?')) return
    await fetch(`/api/automations?id=${id}`, { method: 'DELETE', credentials: 'include' })
    loadAutomations()
  }

  const actionIcons: Record<string, any> = { send_email: Mail, send_survey: ClipboardList, create_task: CheckSquare, update_contact: UserCog, notify: Bell }
  const actionLabels: Record<string, string> = { send_email: 'Send Email', send_survey: 'Send Survey', create_task: 'Create Task', update_contact: 'Update Contact', notify: 'Log Activity' }

  // Load surveys when send_survey is selected
  if (actionType === 'send_survey' && !surveysLoaded) {
    setSurveysLoaded(true)
    fetch('/api/surveys', { credentials: 'include' }).then(r => r.json()).then(d => {
      if (d.ok) setAvailableSurveys((d.data || []).filter((s: any) => s.is_active).map((s: any) => ({ id: s.id, title: s.title })))
    }).catch(() => {})
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-semibold">Automations</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Trigger actions when deals move between pipeline stages</p>
        </div>
        <Button type="button" size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="size-3.5 mr-1.5" /> New Automation
        </Button>
      </div>

      {/* Create Automation */}
      {showCreate && (
        <div className="rounded-lg border bg-card p-5 mb-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold flex items-center gap-2"><Zap className="size-4 text-accent" /> New Automation</h3>
            <IconButton type="button" variant="ghost" size="sm" onClick={() => setShowCreate(false)} aria-label="Close"><X className="size-4" /></IconButton>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">When deal moves to</label>
              <select value={triggerStage} onChange={e => {
                  if (e.target.value === '__custom__') { setTriggerStage(''); setCustomStage('') }
                  else setTriggerStage(e.target.value)
                }}
                className="w-full h-9 rounded-md border bg-card px-3 text-sm">
                {pipelineStages.map(s => <option key={s} value={s}>{s}</option>)}
                <option value="__custom__">Custom stage...</option>
              </select>
              {triggerStage === '' && (
                <Input value={customStage} onChange={e => { setCustomStage(e.target.value); setTriggerStage(e.target.value) }}
                  placeholder="Type your stage name" className="h-9 text-sm mt-1" autoFocus />
              )}
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Then</label>
              <select value={actionType} onChange={e => setActionType(e.target.value)}
                className="w-full h-9 rounded-md border bg-card px-3 text-sm">
                {actionTypes.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
            </div>
          </div>

          {/* Action-specific config */}
          {actionType === 'send_email' && (
            <div className="space-y-3 pt-2 border-t">
              <Input value={emailSubject} onChange={e => setEmailSubject(e.target.value)} placeholder="Email subject" className="h-9 text-sm" />
              <textarea value={emailBody} onChange={e => setEmailBody(e.target.value)} placeholder="Email body (HTML supported)"
                className="w-full rounded-md border bg-card px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring h-20" />
            </div>
          )}
          {actionType === 'send_survey' && (
            <div className="space-y-3 pt-2 border-t">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Select Survey</label>
                <select value={surveyId} onChange={e => setSurveyId(e.target.value)}
                  className="w-full h-9 rounded-lg border bg-background px-3 text-sm">
                  <option value="">Choose a survey...</option>
                  {availableSurveys.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Email Message (optional)</label>
                <Input value={surveyMessage} onChange={e => setSurveyMessage(e.target.value)}
                  placeholder="We'd love to hear your thoughts..." className="h-9 text-sm" />
              </div>
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
          {actionType === 'update_contact' && (
            <div className="grid grid-cols-2 gap-3 pt-2 border-t">
              <div>
                <label className="text-[11px] font-medium text-muted-foreground block mb-1">Field</label>
                <select value={contactField} onChange={e => setContactField(e.target.value)}
                  className="w-full h-9 rounded-md border bg-card px-3 text-sm">
                  <option value="lifecycle_stage">Lifecycle Stage</option>
                  <option value="status">Status</option>
                </select>
              </div>
              <div>
                <label className="text-[11px] font-medium text-muted-foreground block mb-1">New Value</label>
                <Input value={contactValue} onChange={e => setContactValue(e.target.value)} placeholder="e.g. customer" className="h-9 text-sm" />
              </div>
            </div>
          )}
          {actionType === 'notify' && (
            <div className="pt-2 border-t">
              <Input value={notifyMessage} onChange={e => setNotifyMessage(e.target.value)} placeholder="Activity message to log" className="h-9 text-sm" />
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t">
            <Button type="button" variant="outline" size="sm" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button type="button" size="sm" onClick={createAutomation} disabled={creating}>
              {creating ? <Loader2 className="size-3 animate-spin mr-1" /> : <Zap className="size-3 mr-1" />} Create
            </Button>
          </div>
        </div>
      )}

      {/* Automations List */}
      {loading ? <div className="text-sm text-muted-foreground">Loading...</div> :
      automations.length === 0 ? (
        <div className="rounded-lg border p-12 text-center">
          <Zap className="size-8 mx-auto mb-3 text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">No automations yet.</p>
          <p className="text-xs text-muted-foreground mt-1">Create one to trigger actions when deals move between stages.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {automations.map(a => {
            const Icon = actionIcons[a.action_type] || Zap
            const config = typeof a.action_config === 'string' ? JSON.parse(a.action_config) : a.action_config
            let configSummary = ''
            if (a.action_type === 'send_email') configSummary = config.subject || 'No subject'
            else if (a.action_type === 'create_task') configSummary = config.taskTitle || `Task due in ${config.dueDays || 3} days`
            else if (a.action_type === 'update_contact') configSummary = `Set ${config.field} to "${config.value}"`
            else if (a.action_type === 'notify') configSummary = config.message || 'Activity logged'

            return (
              <div key={a.id} className="flex items-center gap-3 rounded-lg border px-4 py-3 group">
                <div className="w-8 h-8 rounded-md bg-accent/10 flex items-center justify-center shrink-0">
                  <Zap className="size-4 text-accent" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">
                    When deal moves to <span className="text-accent font-semibold">{a.trigger_stage}</span>
                  </p>
                  <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                    <Icon className="size-3" /> {actionLabels[a.action_type]}: {configSummary}
                  </p>
                </div>
                <IconButton type="button" variant="ghost" size="sm" onClick={() => deleteAutomation(a.id)}
                  className="opacity-0 group-hover:opacity-100 transition" aria-label="Delete">
                  <Trash2 className="size-3.5" />
                </IconButton>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
