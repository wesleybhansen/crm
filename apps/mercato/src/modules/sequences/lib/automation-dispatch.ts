import { randomUUID } from 'crypto'
import type { Knex } from 'knex'
import { decryptRowFields, DEAL_ENTITY_KEY } from '@open-mercato/shared/lib/encryption/decryptRows'
import { isEncryptedEnvelope } from '@open-mercato/shared/lib/encryption/envelopeFormat'
import { UNDECRYPTABLE_DISPLAY_TEXT } from '@open-mercato/shared/lib/encryption/tenantDataEncryptionService'
import { executeAutomationRules } from './automation-execute'
import { checkSequenceTriggers } from '../services/sequence-triggers'

/*
 * Runs automation rules (automation_rules) and trigger-based sequences for the
 * CRM's business events. Until 2026-09-28 nothing dispatched deal won, deal
 * stage change, invoice paid or booking created, so rules and recipes on those
 * triggers (a review request at closing, a thank-you when an invoice is paid)
 * never ran. The subscribers in ../subscribers/automation-*.ts turn each event
 * into one dispatch here.
 *
 * Once per event: every dispatch first claims its event key in
 * automation_trigger_dispatches (unique per org + trigger + key). A replayed
 * or duplicated event finds the key taken and runs nothing, so a configured
 * rule fires once per business event. At most once: a claim whose rules then
 * fail is not retried, because a second review-request email is worse than
 * none.
 *
 * Relative imports only: subscribers are bundled into the queue workers.
 */

export type AutomationTriggerType = 'deal_won' | 'stage_change' | 'invoice_paid' | 'booking_created'
export type SequenceTriggerType = 'deal_stage_changed' | 'invoice_paid' | 'booking_created'

export type AutomationDispatchInput = {
  organizationId: string
  tenantId: string
  triggerType: AutomationTriggerType
  eventKey: string
  context: Record<string, unknown> & { contactId?: string | null }
  sequenceTrigger?: { type: SequenceTriggerType; stage?: string | null } | null
}

export type AutomationDispatchDeps = {
  executeRules?: (knex: Knex, orgId: string, tenantId: string, triggerType: string, context: Record<string, unknown>) => Promise<unknown>
  checkSequences?: (knex: Knex, orgId: string, tenantId: string, triggerType: string, context: { contactId: string; stage?: string }) => Promise<unknown>
  now?: () => Date
}

const LEDGER_TABLE = 'automation_trigger_dispatches'

/** Claim an event for dispatch. True for the first claim, false for every repeat. */
export async function claimAutomationDispatch(
  knex: Knex,
  input: Pick<AutomationDispatchInput, 'organizationId' | 'tenantId' | 'triggerType' | 'eventKey'>,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await knex(LEDGER_TABLE)
    .insert({
      id: randomUUID(),
      organization_id: input.organizationId,
      tenant_id: input.tenantId,
      trigger_type: input.triggerType,
      event_key: input.eventKey.slice(0, 500),
      created_at: now,
    })
    .onConflict(['organization_id', 'trigger_type', 'event_key'])
    .ignore()
    .returning('id')
  return Array.isArray(rows) && rows.length > 0
}

export async function dispatchAutomationTrigger(
  knex: Knex,
  input: AutomationDispatchInput,
  deps: AutomationDispatchDeps = {},
): Promise<{ dispatched: boolean }> {
  const claimed = await claimAutomationDispatch(knex, input, deps.now ? deps.now() : new Date())
  if (!claimed) return { dispatched: false }
  const executeRules = deps.executeRules ?? (executeAutomationRules as NonNullable<AutomationDispatchDeps['executeRules']>)
  const checkSequences = deps.checkSequences ?? (checkSequenceTriggers as NonNullable<AutomationDispatchDeps['checkSequences']>)
  const context = { ...input.context, triggerType: input.triggerType }
  await executeRules(knex, input.organizationId, input.tenantId, input.triggerType, context)
  const contactId = typeof input.context.contactId === 'string' && input.context.contactId ? input.context.contactId : null
  if (input.sequenceTrigger && contactId) {
    await checkSequences(knex, input.organizationId, input.tenantId, input.sequenceTrigger.type, {
      contactId,
      ...(input.sequenceTrigger.stage ? { stage: input.sequenceTrigger.stage } : {}),
    })
  }
  return { dispatched: true }
}

/** Minute-wide key part for events that carry no timestamp of their own. */
export function eventTimeKey(value: unknown, now: Date = new Date()): string {
  if (typeof value === 'string' && value && Number.isFinite(new Date(value).getTime())) return new Date(value).toISOString()
  return now.toISOString().slice(0, 16)
}

function readable(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  if (isEncryptedEnvelope(value) || value === UNDECRYPTABLE_DISPLAY_TEXT) return null
  return value
}

/** A deal's automation context: its first linked person, pipeline and readable title. */
export async function loadDealContext(
  knex: Knex,
  scope: { organizationId: string; tenantId: string },
  dealId: string,
): Promise<{ dealId: string; contactId: string | null; pipelineId: string | null; status: string | null; pipelineStage: string | null; reference: string | null; amount: number | null } | null> {
  const deal = await knex('customer_deals')
    .where('id', dealId)
    .where('organization_id', scope.organizationId)
    .where('tenant_id', scope.tenantId)
    .whereNull('deleted_at')
    .first('id', 'title', 'pipeline_id', 'pipeline_stage', 'status', 'value_amount')
  if (!deal) return null
  try {
    await decryptRowFields(null, DEAL_ENTITY_KEY, [deal], ['title'], scope.tenantId, scope.organizationId)
  } catch {
    deal.title = null
  }
  const person = await knex('customer_deal_people as cdp')
    .join('customer_entities as ce', 'ce.id', 'cdp.person_entity_id')
    .where('cdp.deal_id', dealId)
    .where('ce.organization_id', scope.organizationId)
    .whereNull('ce.deleted_at')
    .orderBy('cdp.created_at', 'asc')
    .first('cdp.person_entity_id as contact_id')
  const amount = deal.value_amount == null ? null : Number(deal.value_amount)
  return {
    dealId,
    contactId: person?.contact_id ?? null,
    pipelineId: deal.pipeline_id ?? null,
    status: deal.status ?? null,
    pipelineStage: deal.pipeline_stage ?? null,
    reference: readable(deal.title),
    amount: amount != null && Number.isFinite(amount) ? amount : null,
  }
}

export async function loadInvoiceContext(
  knex: Knex,
  scope: { organizationId: string; tenantId: string },
  invoiceId: string,
): Promise<{ invoiceId: string; contactId: string | null; reference: string | null; amount: number | null } | null> {
  const invoice = await knex('invoices')
    .where('id', invoiceId)
    .where('organization_id', scope.organizationId)
    .first('id', 'contact_id', 'invoice_number', 'total')
  if (!invoice) return null
  const amount = invoice.total == null ? null : Number(invoice.total)
  return {
    invoiceId,
    contactId: invoice.contact_id ?? null,
    reference: invoice.invoice_number ? String(invoice.invoice_number) : null,
    amount: amount != null && Number.isFinite(amount) ? amount : null,
  }
}

export async function loadBookingContext(
  knex: Knex,
  scope: { organizationId: string; tenantId: string },
  bookingId: string,
): Promise<{ bookingId: string; contactId: string | null; bookingPageId: string | null; startTime: string | null } | null> {
  const booking = await knex('bookings')
    .where('id', bookingId)
    .where('organization_id', scope.organizationId)
    .first('id', 'contact_id', 'booking_page_id', 'start_time')
  if (!booking) return null
  return {
    bookingId,
    contactId: booking.contact_id ?? null,
    bookingPageId: booking.booking_page_id ?? null,
    startTime: booking.start_time ? new Date(booking.start_time).toISOString() : null,
  }
}
