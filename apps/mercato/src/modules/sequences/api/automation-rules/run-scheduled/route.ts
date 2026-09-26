// Auth is checked in the handler: a signed-in user (their own organization) or
// the box cron's service token (every tenant). Nothing else gets through.
export const metadata = { POST: { requireAuth: false } }

import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { sendEmailByPurpose } from '@/modules/email/lib/email-router'
import { UNSUBSCRIBED_CODE } from '@/modules/email/lib/unsubscribes'
import { processScheduledSteps } from '@/modules/sequences/lib/automation-execute'
import { dispatchOverdueInvoices, overdueRuleScopes, type OverdueScanResult } from '@/modules/sequences/lib/invoice-overdue'
import { sendAutomationWebhook } from '@/modules/sequences/lib/automation-webhook'
import {
  decryptRowFields,
  decryptAliasedRowFields,
  CONTACT_ENTITY_KEY,
  DEAL_ENTITY_KEY,
} from '@open-mercato/shared/lib/encryption/decryptRows'
import { isEncryptedEnvelope } from '@open-mercato/shared/lib/encryption/envelopeFormat'
import { UNDECRYPTABLE_DISPLAY_TEXT } from '@open-mercato/shared/lib/encryption/tenantDataEncryptionService'

/** Deal titles and contact names are encrypted at rest; `reference` becomes a
 *  task title and a log line, so decrypt it and never let ciphertext through. */
async function decryptReferences(
  rows: Array<Record<string, any>>,
  entityKey: string,
  aliases: Record<string, string>,
  fallback: string,
  tenantId: string,
  orgId: string,
): Promise<Array<Record<string, any>>> {
  await decryptAliasedRowFields(null, entityKey, rows, aliases, tenantId, orgId)
  for (const row of rows) {
    for (const alias of Object.keys(aliases)) {
      if (isEncryptedEnvelope(row[alias]) || row[alias] === UNDECRYPTABLE_DISPLAY_TEXT) {
        row[alias] = alias === 'reference' ? fallback : null
      }
    }
  }
  return rows
}
import {
  buildSenderContext,
  htmlifyIfPlainText,
  recordReviewRequest,
  requiresReviewUrl,
  substituteTemplateVars,
} from '@/modules/sequences/lib/template-vars'

/**
 * Run Scheduled Automations
 *
 * Finds all active automation rules with trigger_type = 'schedule',
 * checks if they are due to run based on their trigger_config,
 * queries for matching records, and executes the automation steps
 * for each matching record.
 */

// ---------------------------------------------------------------------------
// Schedule Query — fetch target records by schedule type
// ---------------------------------------------------------------------------

async function getScheduleTargets(
  knex: any,
  orgId: string,
  tenantId: string,
  config: Record<string, any>,
): Promise<Array<Record<string, any>>> {
  const scheduleType = config.scheduleType || 'manual'

  switch (scheduleType) {
    case 'invoice_overdue': {
      const days = config.daysOverdue || 1
      return knex('invoices')
        .where('organization_id', orgId)
        .where('status', 'sent')
        .whereRaw("due_date < NOW() - make_interval(days => ?)", [days])
        .select('id', 'invoice_number as reference', 'contact_id', 'total', 'due_date')
        .limit(100)
    }

    case 'stale_deals': {
      const days = config.staleDays || 7
      const deals = await knex('customer_deals')
        .where('organization_id', orgId)
        .where('status', 'open')
        .whereRaw("updated_at < NOW() - make_interval(days => ?)", [days])
        .select('id', 'title as reference', 'value_amount', 'updated_at')
        .limit(100)
      return decryptReferences(deals, DEAL_ENTITY_KEY, { reference: 'title' }, 'Deal', tenantId, orgId)
    }

    case 'inactive_contacts': {
      const days = config.inactiveDays || 30
      const contacts = await knex('customer_entities')
        .where('organization_id', orgId)
        .whereNull('deleted_at')
        .whereRaw("updated_at < NOW() - make_interval(days => ?)", [days])
        .select('id', 'display_name as reference', 'primary_email', 'updated_at')
        .limit(100)
      return decryptReferences(
        contacts, CONTACT_ENTITY_KEY, { reference: 'display_name', primary_email: 'primary_email' }, 'Contact', tenantId, orgId,
      )
    }

    case 'daily_summary': {
      // Return a single virtual record to trigger the automation once
      return [{ id: 'summary', type: 'daily_summary', reference: 'Daily Summary', date: new Date().toISOString().slice(0, 10) }]
    }

    default:
      // Generic trigger — run once with a virtual record
      return [{ id: 'trigger', type: scheduleType || 'manual', reference: scheduleType || 'Manual Trigger' }]
  }
}

// ---------------------------------------------------------------------------
// Check if a rule is due to run
// ---------------------------------------------------------------------------

function isScheduleDue(triggerConfig: Record<string, any>): boolean {
  const lastRun = triggerConfig.lastRun ? new Date(triggerConfig.lastRun).getTime() : 0
  const now = Date.now()

  // Simple interval-based check: default to running at most once per hour
  const intervalMinutes = triggerConfig.intervalMinutes || 60
  const intervalMs = intervalMinutes * 60 * 1000

  return (now - lastRun) >= intervalMs
}

// ---------------------------------------------------------------------------
// Execute a single action step (reuse logic from execute.ts)
// ---------------------------------------------------------------------------

async function executeScheduledAction(
  knex: any,
  orgId: string,
  tenantId: string,
  actionType: string,
  actionConfig: Record<string, any>,
  context: Record<string, any>,
): Promise<{ success: boolean; skipped?: boolean; detail?: string }> {
  switch (actionType) {
    case 'send_email': {
      if (!context.contactId) return { success: false, detail: 'No contactId in context' }
      const contact = await knex('customer_entities').where('id', context.contactId).where('organization_id', orgId).where('tenant_id', tenantId).first()
      // Raw knex skips the decrypting subscriber, so this scheduled automation
      // addressed its email to ciphertext and greeted the person by it.
      if (contact) {
        await decryptRowFields(null, CONTACT_ENTITY_KEY, [contact], ['primary_email', 'display_name'], tenantId, orgId)
      }
      if (!contact?.primary_email) return { success: false, detail: 'Contact has no email' }

      const firstName = (contact.display_name || '').split(' ')[0] || 'there'
      const rawSubject = actionConfig.subject || 'Scheduled notification'
      const rawBody = actionConfig.bodyHtml || actionConfig.body || '<p>Hello {{firstName}},</p>'

      const senderCtx = await buildSenderContext(knex, orgId)
      const isReviewRequest = requiresReviewUrl(rawSubject, rawBody)
      if (isReviewRequest && !senderCtx.review_url) {
        // A review request without a link is pointless — skip instead of sending
        // an email with a hole in it. The caller logs this to automation_rule_logs.
        return { success: false, detail: 'Skipped review request: no review link configured. Add your Google, Facebook or Yelp review link on the Reputation page (Settings), then this automation will send.' }
      }

      const varCtx = {
        contact: { first_name: firstName, full_name: contact.display_name || null, email: contact.primary_email },
        sender: senderCtx,
        reference: (context.reference as string | undefined) || null,
      }
      const subject = substituteTemplateVars(rawSubject, varCtx)
      const bodyHtml = substituteTemplateVars(htmlifyIfPlainText(rawBody), { ...varCtx, html: true })

      const logReviewSend = async () => {
        if (isReviewRequest && context.contactId) {
          await recordReviewRequest(knex, {
            organizationId: orgId,
            tenantId,
            contactId: context.contactId,
            ruleId: (context.ruleId as string | undefined) || null,
          })
        }
      }

      // Send via the org's own connection/ESP only (no platform sender).
      const sendRes = await sendEmailByPurpose(knex, orgId, tenantId, 'automations', {
        to: contact.primary_email, subject, htmlBody: bodyHtml, contactId: context.contactId,
        fromName: actionConfig.fromName,
      })
      if (sendRes.ok) {
        await logReviewSend()
        return { success: true, detail: `Email sent via ${sendRes.sentVia}` }
      }
      // The router's unsubscribe gate refused it: a skip with the plain reason.
      if (sendRes.code === UNSUBSCRIBED_CODE) return { success: false, skipped: true, detail: sendRes.error }

      // Not sent. This used to write a 'queued' row nothing ever sends and
      // report success; record the real failure instead (the caller logs it to
      // the rule's run history, and the router noted it on the contact).
      return { success: false, detail: `Email failed: ${sendRes.error || 'Send failed'}` }
    }

    case 'create_task': {
      const dueDays = actionConfig.dueDays ? parseInt(actionConfig.dueDays) : 3
      const title = (actionConfig.taskTitle || actionConfig.title || `Scheduled task: ${context.reference || 'follow up'}`)
        .replace(/\{\{reference\}\}/g, context.reference || '')
      await knex('tasks').insert({
        id: require('crypto').randomUUID(),
        tenant_id: tenantId, organization_id: orgId,
        title, description: actionConfig.taskDescription || null,
        contact_id: context.contactId || null,
        deal_id: context.dealId || null,
        due_date: new Date(Date.now() + dueDays * 24 * 60 * 60 * 1000),
        is_done: false, created_at: new Date(), updated_at: new Date(),
      })
      return { success: true, detail: `Task created: ${title}` }
    }

    case 'add_tag': {
      if (!context.contactId || !actionConfig.tagName) return { success: false, detail: 'contactId and tagName required' }
      const slug = actionConfig.tagName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
      let tag = await knex('customer_tags').where('organization_id', orgId).where('slug', slug).first()
      if (!tag) {
        const tagId = require('crypto').randomUUID()
        const colors = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#06B6D4', '#F97316']
        await knex('customer_tags').insert({
          id: tagId, tenant_id: tenantId, organization_id: orgId,
          label: actionConfig.tagName.trim(), slug, color: colors[Math.floor(Math.random() * colors.length)],
          created_at: new Date(), updated_at: new Date(),
        })
        tag = { id: tagId }
      }
      const existing = await knex('customer_tag_assignments').where('entity_id', context.contactId).where('tag_id', tag.id).first()
      if (!existing) {
        await knex('customer_tag_assignments').insert({
          id: require('crypto').randomUUID(), tenant_id: tenantId, organization_id: orgId,
          entity_id: context.contactId, tag_id: tag.id, created_at: new Date(),
        })
      }
      return { success: true, detail: `Tag "${actionConfig.tagName}" added` }
    }

    case 'webhook': {
      // Signed like every automation webhook (lib/automation-webhook.ts).
      return sendAutomationWebhook(knex, { organizationId: orgId, tenantId }, {
        url: actionConfig.url,
        headers: actionConfig.headers,
        event: 'scheduled_automation',
        data: context,
      })
    }

    default:
      return { success: true, detail: `Action "${actionType}" logged (no handler for scheduled context)` }
  }
}

/**
 * Which real records a scheduled target stands for. Only a contact target is
 * a contact; an overdue invoice carries its contact; a stale deal is a deal;
 * the daily-summary and generic targets are placeholders ('summary',
 * 'trigger') and must never reach a uuid column as a contact id.
 */
export function scheduleTargetIds(scheduleType: unknown, target: Record<string, any>): { contactId: string | null; dealId?: string; invoiceId?: string } {
  switch (scheduleType) {
    case 'inactive_contacts':
      return { contactId: target.id ?? null }
    case 'invoice_overdue':
      return { contactId: target.contact_id ?? null, invoiceId: target.id }
    case 'stale_deals':
      return { contactId: null, dealId: target.id }
    default:
      return { contactId: null }
  }
}

// ---------------------------------------------------------------------------
// Run one organization's scheduled rules
// ---------------------------------------------------------------------------

type RuleRunResult = {
  ruleId: string
  ruleName: string
  targetsFound: number
  executed: number
  skipped: boolean
  error?: string
}

/**
 * Claim a rule's run by moving its lastRun forward in ONE guarded update,
 * matched on the lastRun this run read. The box cron and the Automations page
 * (which runs this on load) can arrive together; only the claim winner runs,
 * so nobody gets a scheduled email twice. The claim happens before the steps
 * run: a run that fails part-way waits for its next interval, it is not
 * repeated at once.
 */
async function claimRuleRun(knex: any, rule: Record<string, any>, triggerConfig: Record<string, any>, now: Date): Promise<boolean> {
  const previous = typeof triggerConfig.lastRun === 'string' ? triggerConfig.lastRun : null
  let query = knex('automation_rules')
    .where('id', rule.id)
    .where('organization_id', rule.organization_id)
  query = previous
    ? query.whereRaw("trigger_config->>'lastRun' = ?", [previous])
    : query.whereRaw("trigger_config->>'lastRun' is null")
  const updated = await query.update({
    trigger_config: JSON.stringify({ ...triggerConfig, lastRun: now.toISOString() }),
    updated_at: now,
  })
  return Number(updated) > 0
}

export async function runScheduledRulesForOrg(
  knex: any,
  scope: { organizationId: string; tenantId: string },
  opts: { forceRuleId?: string | null; dryRun?: boolean; now?: Date } = {},
): Promise<{ rulesChecked: number; results: RuleRunResult[] }> {
  const { organizationId: orgId, tenantId } = scope
  const now = opts.now ?? new Date()
  let query = knex('automation_rules')
    .where('organization_id', orgId)
    .where('tenant_id', tenantId)
    .where('trigger_type', 'schedule')
    .where('is_active', true)
  if (opts.forceRuleId) query = query.where('id', opts.forceRuleId)
  const rules = await query

  const results: RuleRunResult[] = []
  for (const rule of rules) {
    const triggerConfig = typeof rule.trigger_config === 'string'
      ? JSON.parse(rule.trigger_config)
      : (rule.trigger_config || {})

    // Check if this rule is due to run (skip check when force-running a specific rule)
    if (!opts.forceRuleId && !isScheduleDue(triggerConfig)) {
      results.push({ ruleId: rule.id, ruleName: rule.name, targetsFound: 0, executed: 0, skipped: true })
      continue
    }

    try {
      const targets = await getScheduleTargets(knex, orgId, tenantId, triggerConfig)
      if (opts.dryRun) {
        // Report what would run; send nothing, write nothing, keep lastRun.
        results.push({ ruleId: rule.id, ruleName: rule.name, targetsFound: targets.length, executed: 0, skipped: false })
        continue
      }
      if (!(await claimRuleRun(knex, rule, triggerConfig, now))) {
        results.push({ ruleId: rule.id, ruleName: rule.name, targetsFound: 0, executed: 0, skipped: true })
        continue
      }

      // Parse the rule steps or fall back to single action
      const steps = typeof rule.steps === 'string' ? JSON.parse(rule.steps) : rule.steps
      const actionConfig = typeof rule.action_config === 'string' ? JSON.parse(rule.action_config) : (rule.action_config || {})

      let executedCount = 0

      for (const target of targets) {
        const context: Record<string, any> = {
          ...target,
          ...scheduleTargetIds(triggerConfig.scheduleType, target),
          triggerType: 'schedule',
          scheduleType: triggerConfig.scheduleType,
          reference: target.reference || target.id,
          ruleId: rule.id,
        }

        if (Array.isArray(steps) && steps.length > 0) {
          // Multi-step: execute action steps sequentially (delays are ignored in scheduled runs)
          for (const step of steps) {
            if (step.type === 'action') {
              const stepResult = await executeScheduledAction(
                knex, orgId, tenantId, step.actionType || 'send_email', step.actionConfig || {}, context,
              )
              await knex('automation_rule_logs').insert({
                id: require('crypto').randomUUID(),
                rule_id: rule.id,
                contact_id: context.contactId ?? null,
                trigger_data: JSON.stringify({ scheduleType: triggerConfig.scheduleType, targetId: target.id }),
                action_result: JSON.stringify(stepResult),
                status: stepResult.success ? 'executed' : stepResult.skipped ? 'skipped' : 'failed',
                created_at: new Date(),
              }).catch(() => {})
            }
          }
        } else {
          // Single action
          const stepResult = await executeScheduledAction(
            knex, orgId, tenantId, rule.action_type, actionConfig, context,
          )
          await knex('automation_rule_logs').insert({
            id: require('crypto').randomUUID(),
            rule_id: rule.id,
            contact_id: context.contactId ?? null,
            trigger_data: JSON.stringify({ scheduleType: triggerConfig.scheduleType, targetId: target.id }),
            action_result: JSON.stringify(stepResult),
            status: stepResult.success ? 'executed' : stepResult.skipped ? 'skipped' : 'failed',
            created_at: new Date(),
          }).catch(() => {})
        }

        executedCount++
      }

      results.push({ ruleId: rule.id, ruleName: rule.name, targetsFound: targets.length, executed: executedCount, skipped: false })
    } catch (err) {
      console.error(`[run-scheduled] Error processing rule ${rule.id}:`, err)
      results.push({
        ruleId: rule.id,
        ruleName: rule.name,
        targetsFound: 0,
        executed: 0,
        skipped: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      })
    }
  }

  return { rulesChecked: rules.length, results }
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

/** The box cron's Bearer SEQUENCE_PROCESS_SECRET, compared in constant time. */
function isServiceCall(req: Request): boolean {
  const secret = process.env.SEQUENCE_PROCESS_SECRET
  if (!secret) return false
  const got = Buffer.from(req.headers.get('authorization') ?? '', 'utf8')
  const expected = Buffer.from(`Bearer ${secret}`, 'utf8')
  return got.length === expected.length && crypto.timingSafeEqual(got, expected)
}

export async function POST(req: Request) {
  const service = isServiceCall(req)
  const auth = service ? null : await getAuthFromCookies()
  if (!service && (!auth?.tenantId || !auth?.orgId)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json().catch(() => ({}))

    if (!service) {
      // A signed-in user runs their own organization only (Automations page
      // on load, and Run Now for one rule).
      const forceRuleId = typeof body.ruleId === 'string' ? body.ruleId : null
      const own = { organizationId: auth!.orgId!, tenantId: auth!.tenantId! }
      const data = await runScheduledRulesForOrg(knex, own, { forceRuleId })
      // The page load also resumes this organization's due Wait steps and
      // dispatches its newly overdue invoices, a fallback for when the box
      // cron is late or missing (the claim on each parked row, and the
      // once-per-invoice ledger, keep the two from running anything twice).
      if (!forceRuleId) {
        const extra: { delayedSteps?: unknown; invoiceOverdue?: OverdueScanResult } = {}
        try {
          extra.delayedSteps = await processScheduledSteps(knex, own)
        } catch (err) {
          console.error('[run-scheduled] delayed steps failed', err)
        }
        try {
          extra.invoiceOverdue = await dispatchOverdueInvoices(knex, own)
        } catch (err) {
          console.error('[run-scheduled] overdue invoices failed', err)
        }
        return NextResponse.json({ ok: true, data: { ...data, ...extra } })
      }
      return NextResponse.json({ ok: true, data })
    }

    // Box cron (every 10 minutes): every tenant's organizations with an
    // active scheduled rule, each in its own tenant scope, then the delayed
    // steps of multi-step automations. dryRun reports without sending.
    const dryRun = body.dryRun === true
    const onlyOrg = typeof body.organizationId === 'string' && body.organizationId ? body.organizationId : null
    let scopesQuery = knex('automation_rules')
      .where('trigger_type', 'schedule')
      .where('is_active', true)
      .distinct('organization_id', 'tenant_id')
    if (onlyOrg) scopesQuery = scopesQuery.where('organization_id', onlyOrg)
    const scopes = (await scopesQuery) as Array<{ organization_id: string; tenant_id: string }>

    const organizations: Array<{ organizationId: string; rulesChecked: number; results: RuleRunResult[] }> = []
    for (const scope of scopes) {
      try {
        const data = await runScheduledRulesForOrg(knex, { organizationId: scope.organization_id, tenantId: scope.tenant_id }, { dryRun })
        organizations.push({ organizationId: scope.organization_id, ...data })
      } catch (err) {
        console.error('[run-scheduled] organization failed', { organizationId: scope.organization_id, err })
      }
    }

    // Delayed steps of multi-step automations (a Wait step parks the rest in
    // automation_scheduled_steps). A failure here is reported, not a 500 that
    // hides the scheduled rules that did run.
    let delayedSteps: { processed: number; total: number; dryRun?: boolean; error?: string }
    if (dryRun) {
      delayedSteps = { processed: 0, total: 0, dryRun: true }
    } else {
      try {
        delayedSteps = await processScheduledSteps(knex, onlyOrg ? { organizationId: onlyOrg } : {})
      } catch (err) {
        console.error('[run-scheduled] delayed steps failed', err)
        delayedSteps = { processed: 0, total: 0, error: err instanceof Error ? err.message : 'Failed' }
      }
    }

    // "Invoice Overdue" rules: every organization with an active one, each in
    // its own tenant scope, dispatches the invoices that just went overdue
    // (once per invoice and threshold; dryRun counts without dispatching).
    const invoiceOverdue: Array<{ organizationId: string } & (OverdueScanResult | { error: string })> = []
    try {
      for (const overdueScope of await overdueRuleScopes(knex, onlyOrg)) {
        try {
          invoiceOverdue.push({ organizationId: overdueScope.organizationId, ...(await dispatchOverdueInvoices(knex, overdueScope, { dryRun })) })
        } catch (err) {
          console.error('[run-scheduled] overdue invoices failed', { organizationId: overdueScope.organizationId, err })
          invoiceOverdue.push({ organizationId: overdueScope.organizationId, error: err instanceof Error ? err.message : 'Failed' })
        }
      }
    } catch (err) {
      console.error('[run-scheduled] overdue invoice scopes failed', err)
    }

    const ran = organizations.flatMap((o) => o.results).filter((r) => !r.skipped)
    console.log('[run-scheduled] service run', {
      dryRun,
      organizations: organizations.length,
      rulesRun: ran.length,
      targets: ran.reduce((n, r) => n + r.targetsFound, 0),
      delayedSteps,
      invoiceOverdue: invoiceOverdue.reduce((n, o) => n + ('dispatched' in o ? o.dispatched : 0), 0),
    })
    return NextResponse.json({ ok: true, data: { dryRun, organizations, delayedSteps, invoiceOverdue } })
  } catch (error) {
    console.error('[run-scheduled] POST error', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Automation Rules',
  summary: 'Run scheduled automation triggers',
  methods: {
    POST: { summary: 'Process due scheduled automations and execute their steps against matching records', tags: ['Automation Rules'] },
  },
}
