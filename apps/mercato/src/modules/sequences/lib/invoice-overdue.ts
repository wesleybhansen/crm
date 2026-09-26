import type { Knex } from 'knex'
import { dispatchAutomationTrigger, type AutomationDispatchDeps } from './automation-dispatch'
import { overdueThresholdDays } from './automation-trigger-match'

/*
 * "Invoice Overdue" automation trigger. Nothing ever dispatched it: invoices
 * have no overdue event (they stay 'sent' past their due date), so a rule on
 * this trigger never ran. This scan finds invoices that just crossed a rule's
 * threshold and dispatches each one once, through the same exactly-once
 * ledger (automation_trigger_dispatches) as every other trigger.
 *
 * - Overdue means still unpaid ('sent', or a legacy 'overdue' status) with a
 *   due date that has passed. Due dates are calendar dates stored at UTC
 *   midnight, so a day counts as over 12 hours after the next UTC midnight
 *   (early morning in the US): an invoice is never "overdue" on its due day.
 * - A rule's "Days overdue" (empty = 1) is its threshold. The scan dispatches
 *   once per invoice per distinct threshold of the org's active rules; the
 *   trigger matcher runs only the rules with that threshold. Key:
 *   invoice:<id>:due:<due date>:after:<N>d, so moving the due date later lets
 *   the invoice fire again when it is overdue again.
 * - Only invoices that crossed within the last OVERDUE_LOOKBACK_DAYS count.
 *   A missed cron day is still caught, but a rule turned on today (or an old
 *   rule that never fired before this shipped) does not mail every invoice
 *   that went overdue months ago.
 *
 * Runs from the scheduled-automations cron (run-scheduled, every 10 minutes)
 * and when the Automations page loads, one organization at a time, every
 * query scoped to that organization and tenant.
 *
 * Relative imports only (worker-safe, like the rest of the dispatch path).
 */

export const OVERDUE_LOOKBACK_DAYS = 3
const DAY_MS = 24 * 60 * 60 * 1000
const GRACE_MS = 12 * 60 * 60 * 1000
const MAX_INVOICES_PER_THRESHOLD = 500
const UNPAID_STATUSES = ['sent', 'overdue']

export type OverdueScanResult = {
  rules: number
  thresholds: number[]
  candidates: number
  dispatched: number
  dryRun?: boolean
}

function parseConfig(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value !== 'string') return value as Record<string, unknown>
  try {
    return JSON.parse(value) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** The calendar date (YYYY-MM-DD, UTC) an invoice is due, for the event key. */
function dueDay(value: Date): string {
  return value.toISOString().slice(0, 10)
}

export async function dispatchOverdueInvoices(
  knex: Knex,
  scope: { organizationId: string; tenantId: string },
  opts: { now?: Date; dryRun?: boolean; deps?: AutomationDispatchDeps } = {},
): Promise<OverdueScanResult> {
  const now = opts.now ?? new Date()
  const rules = await knex('automation_rules')
    .where('organization_id', scope.organizationId)
    .where('tenant_id', scope.tenantId)
    .where('trigger_type', 'invoice_overdue')
    .where('is_active', true)
    .select('id', 'trigger_config')
  const result: OverdueScanResult = { rules: rules.length, thresholds: [], candidates: 0, dispatched: 0 }
  if (opts.dryRun) result.dryRun = true
  if (!rules.length) return result

  result.thresholds = Array.from(new Set(rules.map((rule: { trigger_config: unknown }) => overdueThresholdDays(parseConfig(rule.trigger_config)))))
    .sort((a, b) => a - b)

  for (const days of result.thresholds) {
    // Crossed the threshold: due + N days + grace <= now, within the lookback.
    const crossedBy = new Date(now.getTime() - days * DAY_MS - GRACE_MS)
    const crossedAfter = new Date(crossedBy.getTime() - OVERDUE_LOOKBACK_DAYS * DAY_MS)
    const invoices = await knex('invoices')
      .where('organization_id', scope.organizationId)
      .where('tenant_id', scope.tenantId)
      .whereIn('status', UNPAID_STATUSES)
      .whereNull('deleted_at')
      .where('due_date', '<=', crossedBy)
      .where('due_date', '>', crossedAfter)
      .orderBy('due_date', 'asc')
      .limit(MAX_INVOICES_PER_THRESHOLD)
      .select('id', 'contact_id', 'invoice_number', 'total', 'due_date')

    for (const invoice of invoices as Array<Record<string, any>>) {
      const due = new Date(invoice.due_date)
      if (!Number.isFinite(due.getTime())) continue
      result.candidates++
      if (opts.dryRun) continue
      const amount = invoice.total == null ? null : Number(invoice.total)
      const outcome = await dispatchAutomationTrigger(knex, {
        ...scope,
        triggerType: 'invoice_overdue',
        eventKey: `invoice:${invoice.id}:due:${dueDay(due)}:after:${days}d`,
        context: {
          invoiceId: invoice.id,
          contactId: invoice.contact_id ?? null,
          reference: invoice.invoice_number ? String(invoice.invoice_number) : null,
          amount: amount != null && Number.isFinite(amount) ? amount : null,
          dueDate: due.toISOString(),
          daysOverdue: Math.max(days, Math.floor((now.getTime() - due.getTime() - GRACE_MS) / DAY_MS)),
          overdueThresholdDays: days,
        },
      }, opts.deps)
      if (outcome.dispatched) result.dispatched++
    }
  }
  return result
}

/** Every organization (with its tenant) that has an active "Invoice Overdue" rule. */
export async function overdueRuleScopes(knex: Knex, onlyOrganizationId?: string | null): Promise<Array<{ organizationId: string; tenantId: string }>> {
  let query = knex('automation_rules')
    .where('trigger_type', 'invoice_overdue')
    .where('is_active', true)
    .distinct('organization_id', 'tenant_id')
  if (onlyOrganizationId) query = query.where('organization_id', onlyOrganizationId)
  const rows = (await query) as Array<{ organization_id: string; tenant_id: string }>
  return rows.map((row) => ({ organizationId: row.organization_id, tenantId: row.tenant_id }))
}
