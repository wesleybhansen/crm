'use client'

import * as React from 'react'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@open-mercato/ui/primitives/dialog'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'

type EntityType = 'deal' | 'person'
type ActionType = 'set_stage' | 'advance_one' | 'set_lifecycle'

type FilterField = {
  key: string
  label: string
  type: 'multi-select-form' | 'multi-select-gateway' | 'multi-select-sequence' | 'number' | 'boolean'
  required?: boolean
}

type Trigger = {
  key: string
  eventId: string
  label: string
  description: string
  supportedEntities: EntityType[]
  filters: FilterField[]
}

type Rule = {
  id: string
  name: string
  triggerKey: string
  filters: Record<string, any>
  targetEntity: EntityType
  targetPipelineId: string | null
  targetStageId: string | null
  targetLifecycleStage: string | null
  targetAction: ActionType
  allowBackward: boolean
  isActive: boolean
  createdAt: string
  updatedAt: string
}

type Run = {
  id: string
  ruleId: string
  triggerEventId: string
  triggerEventKey: string
  entityType: EntityType
  entityId: string
  fromStage: string | null
  toStage: string | null
  outcome: 'applied' | 'skipped_backward' | 'skipped_idempotent' | 'skipped_filter' | 'failed'
  error: string | null
  ranAt: string
}

type Pipeline = { id: string; name: string; isDefault: boolean }
type PipelineStage = { id: string; pipelineId: string; label: string; order: number }

type EditDialogState =
  | { mode: 'create'; triggerKey: string }
  | { mode: 'edit'; rule: Rule }
  | null

const OUTCOME_LABEL: Record<Run['outcome'], string> = {
  applied: 'Applied',
  skipped_backward: 'Skipped (would move backward)',
  skipped_idempotent: 'Skipped (already ran)',
  skipped_filter: 'Skipped (filter mismatch)',
  failed: 'Failed',
}

const OUTCOME_COLOR: Record<Run['outcome'], string> = {
  applied: 'text-emerald-700 bg-emerald-50',
  skipped_backward: 'text-amber-700 bg-amber-50',
  skipped_idempotent: 'text-slate-600 bg-slate-100',
  skipped_filter: 'text-slate-600 bg-slate-100',
  failed: 'text-red-700 bg-red-50',
}

export default function PipelineAutomationPage() {
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const [triggers, setTriggers] = React.useState<Trigger[]>([])
  const [rules, setRules] = React.useState<Rule[]>([])
  const [runs, setRuns] = React.useState<Run[]>([])
  const [pipelines, setPipelines] = React.useState<Pipeline[]>([])
  const [stages, setStages] = React.useState<PipelineStage[]>([])
  const [loading, setLoading] = React.useState(true)
  const [dialog, setDialog] = React.useState<EditDialogState>(null)

  const refresh = React.useCallback(async () => {
    setLoading(true)
    try {
      const [trigRes, rulesRes, runsRes] = await Promise.all([
        apiCall<{ items: Trigger[] }>('/api/pipeline-automation/triggers'),
        apiCall<{ items: Rule[] }>('/api/pipeline-automation/rules'),
        apiCall<{ items: Run[] }>('/api/pipeline-automation/runs?page_size=50'),
      ])
      if (trigRes.ok && trigRes.result) setTriggers(trigRes.result.items)
      if (rulesRes.ok && rulesRes.result) setRules(rulesRes.result.items)
      if (runsRes.ok && runsRes.result) setRuns(runsRes.result.items)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadPipelines = React.useCallback(async () => {
    try {
      const pRes = await apiCall<{ items: Pipeline[] }>('/api/pipelines')
      if (pRes.ok && pRes.result) setPipelines(pRes.result.items)
      const sRes = await apiCall<{ items: PipelineStage[] }>('/api/pipeline-stages')
      if (sRes.ok && sRes.result) setStages(sRes.result.items)
    } catch {}
  }, [])

  React.useEffect(() => {
    void refresh()
    void loadPipelines()
  }, [refresh, loadPipelines])

  const handleToggleActive = async (rule: Rule) => {
    const next = !rule.isActive
    setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, isActive: next } : r)))
    const res = await apiCall('/api/pipeline-automation/rules', {
      method: 'PUT',
      body: JSON.stringify({ id: rule.id, isActive: next }),
    })
    if (!res.ok) {
      setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, isActive: rule.isActive } : r)))
      flash('Failed to update rule', 'error')
    } else {
      flash(`Rule ${next ? 'enabled' : 'disabled'}`, 'success')
    }
  }

  const handleDelete = async (rule: Rule) => {
    const ok = await confirm({
      title: 'Delete rule?',
      text: `"${rule.name}" will stop firing immediately.`,
      confirmText: 'Delete',
      variant: 'destructive',
    })
    if (!ok) return
    const res = await apiCall(`/api/pipeline-automation/rules?id=${rule.id}`, { method: 'DELETE' })
    if (res.ok) {
      flash('Rule deleted', 'success')
      void refresh()
    } else {
      flash('Failed to delete rule', 'error')
    }
  }

  const triggerByKey = React.useMemo(() => {
    const map = new Map<string, Trigger>()
    for (const t of triggers) map.set(t.key, t)
    return map
  }, [triggers])

  return (
    <Page>
      <PageBody>
        {ConfirmDialogElement}
        <div className="space-y-6">
          <header className="flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-semibold text-slate-900">Pipeline automation</h1>
              <p className="mt-1 text-sm text-slate-600">
                Move contacts and deals through pipeline stages automatically when triggers fire.
              </p>
            </div>
          </header>

          {loading ? (
            <div className="flex justify-center py-16"><Spinner /></div>
          ) : (
            <>
              <section className="space-y-4">
                <h2 className="text-lg font-medium text-slate-900">Active rules</h2>
                {rules.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">
                    No rules yet. Add one below to start advancing contacts and deals automatically.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {rules.map((rule) => {
                      const trigger = triggerByKey.get(rule.triggerKey)
                      return (
                        <div key={rule.id} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                          <div className="flex items-center justify-between gap-4">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <h3 className="font-medium text-slate-900">{rule.name}</h3>
                                {!rule.isActive && (
                                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">Inactive</span>
                                )}
                              </div>
                              <p className="mt-1 text-sm text-slate-600">
                                {trigger?.label ?? rule.triggerKey} → {rule.targetEntity === 'person'
                                  ? `Set lifecycle to "${rule.targetLifecycleStage}"`
                                  : rule.targetAction === 'advance_one'
                                  ? 'Advance deal by one stage'
                                  : `Move deal to selected stage`}
                              </p>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
                                <input
                                  type="checkbox"
                                  checked={rule.isActive}
                                  onChange={() => void handleToggleActive(rule)}
                                  className="h-4 w-4"
                                />
                                <span className="text-slate-700">Active</span>
                              </label>
                              <Button variant="outline" size="sm" onClick={() => setDialog({ mode: 'edit', rule })}>Edit</Button>
                              <Button variant="ghost" size="sm" onClick={() => void handleDelete(rule)}>Delete</Button>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                <div className="flex flex-wrap gap-2 pt-2">
                  {triggers.map((t) => (
                    <Button
                      key={t.key}
                      variant="outline"
                      size="sm"
                      onClick={() => setDialog({ mode: 'create', triggerKey: t.key })}
                    >
                      + Add rule for "{t.label}"
                    </Button>
                  ))}
                </div>
              </section>

              <section className="space-y-3">
                <h2 className="text-lg font-medium text-slate-900">Recent activity</h2>
                {runs.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">
                    No automations have run yet. Submit a form, capture a payment, or complete a sequence to see your rules in action.
                  </div>
                ) : (
                  <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
                    <table className="min-w-full divide-y divide-slate-200 text-sm">
                      <thead className="bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
                        <tr>
                          <th className="px-3 py-2">When</th>
                          <th className="px-3 py-2">Trigger</th>
                          <th className="px-3 py-2">Entity</th>
                          <th className="px-3 py-2">From → To</th>
                          <th className="px-3 py-2">Outcome</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {runs.map((run) => (
                          <tr key={run.id}>
                            <td className="whitespace-nowrap px-3 py-2 text-slate-600">
                              {new Date(run.ranAt).toLocaleString()}
                            </td>
                            <td className="px-3 py-2 text-slate-700">{run.triggerEventKey}</td>
                            <td className="px-3 py-2 text-slate-700">
                              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">{run.entityType}</span>{' '}
                              <span className="font-mono text-xs text-slate-500">{run.entityId.slice(0, 8)}…</span>
                            </td>
                            <td className="px-3 py-2 text-slate-600">
                              {run.fromStage ?? '—'} → {run.toStage ?? '—'}
                            </td>
                            <td className="px-3 py-2">
                              <span className={`rounded px-1.5 py-0.5 text-xs ${OUTCOME_COLOR[run.outcome]}`}>
                                {OUTCOME_LABEL[run.outcome]}
                              </span>
                              {run.error ? <div className="mt-0.5 text-xs text-red-600">{run.error}</div> : null}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          )}
        </div>

        <RuleEditorDialog
          state={dialog}
          triggers={triggers}
          pipelines={pipelines}
          stages={stages}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null)
            void refresh()
          }}
        />
      </PageBody>
    </Page>
  )
}

function RuleEditorDialog(props: {
  state: EditDialogState
  triggers: Trigger[]
  pipelines: Pipeline[]
  stages: PipelineStage[]
  onClose: () => void
  onSaved: () => void
}) {
  const { state, triggers, pipelines, stages, onClose, onSaved } = props
  const triggerKey = state?.mode === 'create' ? state.triggerKey : state?.rule.triggerKey
  const trigger = React.useMemo(() => triggers.find((t) => t.key === triggerKey), [triggers, triggerKey])

  const initial: Partial<Rule> = state?.mode === 'edit'
    ? state.rule
    : trigger
    ? {
        name: `${trigger.label} → set stage`,
        triggerKey: trigger.key,
        filters: {},
        targetEntity: trigger.supportedEntities[0],
        targetAction: trigger.supportedEntities[0] === 'person' ? 'set_lifecycle' : 'advance_one',
        targetLifecycleStage: trigger.supportedEntities[0] === 'person' ? 'Lead' : null,
        targetPipelineId: null,
        targetStageId: null,
        allowBackward: false,
        isActive: true,
      }
    : {}

  const [form, setForm] = React.useState<Partial<Rule>>(initial)
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (state) setForm(initial)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.mode, triggerKey])

  if (!state || !trigger) return null

  const isEdit = state.mode === 'edit'
  const targetPipeline = pipelines.find((p) => p.id === form.targetPipelineId)
  const stageOptions = stages.filter((s) => !form.targetPipelineId || s.pipelineId === form.targetPipelineId)

  const handleSave = async () => {
    setSaving(true)
    try {
      const body: any = {
        name: form.name,
        triggerKey: trigger.key,
        filters: form.filters ?? {},
        targetEntity: form.targetEntity,
        targetAction: form.targetAction,
        targetPipelineId: form.targetPipelineId ?? null,
        targetStageId: form.targetStageId ?? null,
        targetLifecycleStage: form.targetLifecycleStage ?? null,
        allowBackward: form.allowBackward ?? false,
        isActive: form.isActive ?? true,
      }
      let res
      if (isEdit) {
        body.id = (state as { rule: Rule }).rule.id
        res = await apiCall('/api/pipeline-automation/rules', { method: 'PUT', body: JSON.stringify(body) })
      } else {
        res = await apiCall('/api/pipeline-automation/rules', { method: 'POST', body: JSON.stringify(body) })
      }
      if (res.ok) {
        flash(`Rule ${isEdit ? 'updated' : 'created'}`, 'success')
        onSaved()
      } else {
        const errMsg = (res as any).result?.error || 'Failed to save rule'
        flash(errMsg, 'error')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={!!state} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit rule' : `New ${trigger.label} rule`}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <label className="block text-xs font-medium uppercase tracking-wider text-slate-500">Name</label>
            <Input
              value={form.name ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Form submission → Lead"
            />
          </div>

          <div>
            <label className="block text-xs font-medium uppercase tracking-wider text-slate-500">Target</label>
            <select
              className="mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm"
              value={form.targetEntity}
              onChange={(e) => {
                const ent = e.target.value as EntityType
                setForm((f) => ({
                  ...f,
                  targetEntity: ent,
                  targetAction: ent === 'person' ? 'set_lifecycle' : 'advance_one',
                  targetLifecycleStage: ent === 'person' ? (f.targetLifecycleStage ?? 'Lead') : null,
                  targetPipelineId: ent === 'deal' ? f.targetPipelineId ?? null : null,
                  targetStageId: ent === 'deal' ? f.targetStageId ?? null : null,
                }))
              }}
            >
              {trigger.supportedEntities.map((ent) => (
                <option key={ent} value={ent}>
                  {ent === 'person' ? 'Contact (lifecycle stage)' : 'Deal (pipeline stage)'}
                </option>
              ))}
            </select>
          </div>

          {form.targetEntity === 'person' && (
            <div>
              <label className="block text-xs font-medium uppercase tracking-wider text-slate-500">Set lifecycle stage to</label>
              <Input
                value={form.targetLifecycleStage ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, targetLifecycleStage: e.target.value }))}
                placeholder="e.g. Lead"
              />
              <p className="mt-1 text-xs text-slate-500">Free-text — common values: Subscriber, Lead, MQL, SQL, Opportunity, Customer.</p>
            </div>
          )}

          {form.targetEntity === 'deal' && (
            <>
              <div>
                <label className="block text-xs font-medium uppercase tracking-wider text-slate-500">Action</label>
                <select
                  className="mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm"
                  value={form.targetAction}
                  onChange={(e) => setForm((f) => ({ ...f, targetAction: e.target.value as ActionType }))}
                >
                  <option value="advance_one">Advance by one stage</option>
                  <option value="set_stage">Move to a specific stage</option>
                </select>
              </div>
              {form.targetAction === 'set_stage' && (
                <>
                  <div>
                    <label className="block text-xs font-medium uppercase tracking-wider text-slate-500">Pipeline</label>
                    <select
                      className="mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm"
                      value={form.targetPipelineId ?? ''}
                      onChange={(e) => setForm((f) => ({ ...f, targetPipelineId: e.target.value || null, targetStageId: null }))}
                    >
                      <option value="">— Select pipeline —</option>
                      {pipelines.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}{p.isDefault ? ' (default)' : ''}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium uppercase tracking-wider text-slate-500">Stage</label>
                    <select
                      className="mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm"
                      value={form.targetStageId ?? ''}
                      onChange={(e) => setForm((f) => ({ ...f, targetStageId: e.target.value || null }))}
                      disabled={!form.targetPipelineId}
                    >
                      <option value="">— Select stage —</option>
                      {stageOptions.map((s) => (
                        <option key={s.id} value={s.id}>{s.label}</option>
                      ))}
                    </select>
                  </div>
                </>
              )}
            </>
          )}

          {trigger.filters.length > 0 && (
            <div>
              <label className="block text-xs font-medium uppercase tracking-wider text-slate-500">Filters</label>
              <div className="mt-1 space-y-2">
                {trigger.filters.map((f) => (
                  <FilterInput
                    key={f.key}
                    field={f}
                    value={(form.filters ?? {})[f.key]}
                    onChange={(v) => setForm((prev) => ({ ...prev, filters: { ...(prev.filters ?? {}), [f.key]: v } }))}
                  />
                ))}
              </div>
            </div>
          )}

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.allowBackward ?? false}
              onChange={(e) => setForm((f) => ({ ...f, allowBackward: e.target.checked }))}
            />
            <span>Allow this rule to move entities backward in stage order</span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || !form.name}>{saving ? 'Saving…' : (isEdit ? 'Save' : 'Create')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function FilterInput(props: { field: FilterField; value: any; onChange: (v: any) => void }) {
  const { field, value, onChange } = props
  if (field.type === 'boolean') {
    return (
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
        <span>{field.label}</span>
      </label>
    )
  }
  if (field.type === 'number') {
    return (
      <div>
        <label className="block text-xs text-slate-500">{field.label}</label>
        <Input
          type="number"
          value={value ?? ''}
          onChange={(e) => {
            const v = e.target.value
            onChange(v === '' ? undefined : Number(v))
          }}
        />
      </div>
    )
  }
  // multi-select-* — Phase 1 ships as comma-separated UUIDs textarea; the
  // dedicated pickers (forms / gateways / sequences) come in a follow-up
  // pass. See SPEC-064 Phase 2.
  return (
    <div>
      <label className="block text-xs text-slate-500">{field.label}</label>
      <Input
        value={Array.isArray(value) ? value.join(',') : ''}
        placeholder="comma-separated IDs (leave blank for any)"
        onChange={(e) => {
          const list = e.target.value.split(',').map((s) => s.trim()).filter(Boolean)
          onChange(list.length > 0 ? list : undefined)
        }}
      />
    </div>
  )
}
