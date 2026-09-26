import { randomUUID } from 'crypto'
import type { Knex } from 'knex'
import { decryptRowFields, DEAL_ENTITY_KEY } from '@open-mercato/shared/lib/encryption/decryptRows'
import { isEncryptedEnvelope } from '@open-mercato/shared/lib/encryption/envelopeFormat'
import { UNDECRYPTABLE_DISPLAY_TEXT } from '@open-mercato/shared/lib/encryption/tenantDataEncryptionService'
import { executeAutomationRules } from './automation-execute'
import { checkSequenceTriggers } from '../services/sequence-triggers'
import { isContactUnsubscribed } from '../../email/lib/unsubscribes'

/*
 * Runs automation rules (automation_rules) and trigger-based sequences for the
 * CRM's business events. Until 2026-09-28 nothing dispatched deal won, deal
 * stage change, invoice paid or booking created, so rules and recipes on those
 * triggers (a review request at closing, a thank-you when an invoice is paid)
 * never ran. The subscribers in ../subscribers/automation-*.ts turn each event
 * into one dispatch here. Since 2026-09-30 the same path also runs deal
 * created, deal lost, contact updated and company created (subscribers),
 * course enrolled (the enrollment routes call dispatchCourseEnrolled) and
 * invoice overdue (./invoice-overdue.ts, from the scheduled-automations cron).
 * Since 2026-09-26 the sequence triggers "Event registration" and "Product
 * purchased" run too (dispatchEventRegistered, dispatchProductPurchased):
 * the event registration routes and the purchase paths call them once per
 * real registration or purchase, and neither enrolls a contact who has
 * unsubscribed from the business's email.
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

export type AutomationTriggerType =
  | 'deal_won'
  | 'deal_lost'
  | 'deal_created'
  | 'stage_change'
  | 'invoice_paid'
  | 'invoice_overdue'
  | 'booking_created'
  | 'contact_created'
  | 'contact_updated'
  | 'company_created'
  | 'course_enrolled'
  | 'event_registered'
  | 'product_purchased'
export type SequenceTriggerType =
  | 'deal_stage_changed'
  | 'deal_won'
  | 'invoice_paid'
  | 'booking_created'
  | 'contact_created'
  | 'course_enrolled'
  | 'event_registered'
  | 'product_purchased'

export type AutomationDispatchInput = {
  organizationId: string
  tenantId: string
  triggerType: AutomationTriggerType
  eventKey: string
  context: Record<string, unknown> & { contactId?: string | null }
  sequenceTrigger?: {
    type: SequenceTriggerType
    stage?: string | null
    bookingPageId?: string | null
    source?: string | null
    courseId?: string | null
    eventId?: string | null
    productId?: string | null
    /** Enroll no contact in email_unsubscribes for this organization. */
    skipUnsubscribed?: boolean
    /** Addresses the event carried (the registration or checkout email), checked with the contact's own. */
    emails?: Array<string | null | undefined>
  } | null
}

type SequenceContext = {
  contactId: string
  stage?: string
  bookingPageId?: string
  source?: string
  courseId?: string
  eventId?: string
  productId?: string
}

export type AutomationDispatchDeps = {
  executeRules?: (knex: Knex, orgId: string, tenantId: string, triggerType: string, context: Record<string, unknown>) => Promise<unknown>
  checkSequences?: (knex: Knex, orgId: string, tenantId: string, triggerType: string, context: SequenceContext) => Promise<unknown>
  now?: () => Date
}

export type AutomationDispatchResult = { dispatched: boolean; sequencesSkipped?: 'unsubscribed' }

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

/**
 * Whether anything in this organization listens for the trigger: an active
 * rule, or an active sequence on the matching sequence trigger. Contact
 * saves and new deals are frequent, so an organization with no rule for them
 * writes no ledger row at all.
 */
async function hasListeners(knex: Knex, input: AutomationDispatchInput): Promise<boolean> {
  const rule = await knex('automation_rules')
    .where('organization_id', input.organizationId)
    .where('tenant_id', input.tenantId)
    .where('trigger_type', input.triggerType)
    .where('is_active', true)
    .first('id')
  if (rule) return true
  if (!input.sequenceTrigger) return false
  const sequence = await knex('sequences')
    .where('organization_id', input.organizationId)
    .where('tenant_id', input.tenantId)
    .where('trigger_type', input.sequenceTrigger.type)
    .where('status', 'active')
    .whereNull('deleted_at')
    .first('id')
  return !!sequence
}

export async function dispatchAutomationTrigger(
  knex: Knex,
  input: AutomationDispatchInput,
  deps: AutomationDispatchDeps = {},
): Promise<AutomationDispatchResult> {
  if (!(await hasListeners(knex, input))) return { dispatched: false }
  const claimed = await claimAutomationDispatch(knex, input, deps.now ? deps.now() : new Date())
  if (!claimed) return { dispatched: false }
  const executeRules = deps.executeRules ?? (executeAutomationRules as NonNullable<AutomationDispatchDeps['executeRules']>)
  const checkSequences = deps.checkSequences ?? (checkSequenceTriggers as NonNullable<AutomationDispatchDeps['checkSequences']>)
  const context = { ...input.context, triggerType: input.triggerType }
  await executeRules(knex, input.organizationId, input.tenantId, input.triggerType, context)
  const contactId = typeof input.context.contactId === 'string' && input.context.contactId ? input.context.contactId : null
  if (input.sequenceTrigger && contactId) {
    const { stage, bookingPageId, source, courseId, eventId, productId } = input.sequenceTrigger
    if (input.sequenceTrigger.skipUnsubscribed) {
      const scope = { organizationId: input.organizationId, tenantId: input.tenantId }
      if (await isContactUnsubscribed(knex, scope, contactId, input.sequenceTrigger.emails ?? [])) {
        return { dispatched: true, sequencesSkipped: 'unsubscribed' }
      }
    }
    await checkSequences(knex, input.organizationId, input.tenantId, input.sequenceTrigger.type, {
      contactId,
      ...(stage ? { stage } : {}),
      ...(bookingPageId ? { bookingPageId } : {}),
      ...(source ? { source } : {}),
      ...(courseId ? { courseId } : {}),
      ...(eventId ? { eventId } : {}),
      ...(productId ? { productId } : {}),
    })
  }
  return { dispatched: true }
}

/**
 * A new contact: run `contact_created` rules and contact-created sequences,
 * once per contact whatever the path. Manual adds, the people API and inbox
 * actions arrive through the customers.person.created subscriber; the import,
 * form and landing page routes (which write contacts without that event) call
 * this directly. Both claim the same key, so no contact is welcomed twice.
 */
export async function dispatchContactCreated(
  knex: Knex,
  input: { organizationId: string; tenantId: string; contactId: string; source?: string | null; context?: Record<string, unknown> },
  deps: AutomationDispatchDeps = {},
): Promise<{ dispatched: boolean }> {
  const source = typeof input.source === 'string' && input.source ? input.source : null
  return dispatchAutomationTrigger(knex, {
    organizationId: input.organizationId,
    tenantId: input.tenantId,
    triggerType: 'contact_created',
    eventKey: `contact:${input.contactId}`,
    context: { ...(input.context ?? {}), contactId: input.contactId, source },
    sequenceTrigger: { type: 'contact_created', source },
  }, deps)
}

/**
 * A course enrollment: run `course_enrolled` rules and course-enrollment
 * sequences, once per enrollment. Free enrollments (courses enrollments
 * route) and paid ones (Stripe checkout: a course, a funnel product or a
 * product bundle) all call this after the enrollment row is written.
 */
export async function dispatchCourseEnrolled(
  knex: Knex,
  input: {
    organizationId: string
    tenantId: string
    enrollmentId: string
    courseId: string
    contactId?: string | null
    courseTitle?: string | null
    paid?: boolean
  },
  deps: AutomationDispatchDeps = {},
): Promise<{ dispatched: boolean }> {
  const title = readable(input.courseTitle ?? null)
  return dispatchAutomationTrigger(knex, {
    organizationId: input.organizationId,
    tenantId: input.tenantId,
    triggerType: 'course_enrolled',
    eventKey: `enrollment:${input.enrollmentId}`,
    context: {
      enrollmentId: input.enrollmentId,
      courseId: input.courseId,
      contactId: input.contactId ?? null,
      reference: title,
      paid: input.paid === true,
    },
    sequenceTrigger: { type: 'course_enrolled', courseId: input.courseId },
  }, deps)
}

/**
 * One registration for an event: "Event registration" sequences (optionally
 * for one event), once per registration. A free registration, a paid one
 * (Stripe checkout) and a walk-in signed in at the event kiosk each write
 * their own event_attendees row, and the row id is the key, so a replayed
 * request or a second webhook delivery never enrolls anyone twice. A
 * contact who unsubscribed from the business's email is not enrolled.
 */
export async function dispatchEventRegistered(
  knex: Knex,
  input: {
    organizationId: string
    tenantId: string
    attendeeId: string
    eventId: string
    contactId: string
    email?: string | null
    eventTitle?: string | null
    paid?: boolean
  },
  deps: AutomationDispatchDeps = {},
): Promise<AutomationDispatchResult> {
  return dispatchAutomationTrigger(knex, {
    organizationId: input.organizationId,
    tenantId: input.tenantId,
    triggerType: 'event_registered',
    eventKey: `event_attendee:${input.attendeeId}`,
    context: {
      attendeeId: input.attendeeId,
      eventId: input.eventId,
      contactId: input.contactId,
      reference: readable(input.eventTitle ?? null),
      paid: input.paid === true,
    },
    sequenceTrigger: { type: 'event_registered', eventId: input.eventId, skipUnsubscribed: true, emails: [input.email] },
  }, deps)
}

/**
 * One purchase of one product: "Product purchased" sequences (optionally for
 * one product), once per purchase. `purchaseKey` names the purchase in our
 * own records: `checkout:<Stripe checkout session>` for a product checkout
 * (the webhook records each session once) and `funnel_order:<order id>` for a
 * funnel checkout, order bump or one-click upsell, so the webhook and the
 * upsell route can both report an order and it still counts once. A contact
 * who unsubscribed from the business's email is not enrolled.
 */
export async function dispatchProductPurchased(
  knex: Knex,
  input: {
    organizationId: string
    tenantId: string
    purchaseKey: string
    productId: string
    contactId: string
    email?: string | null
    productName?: string | null
    amount?: number | null
  },
  deps: AutomationDispatchDeps = {},
): Promise<AutomationDispatchResult> {
  const amount = input.amount != null && Number.isFinite(Number(input.amount)) ? Number(input.amount) : null
  return dispatchAutomationTrigger(knex, {
    organizationId: input.organizationId,
    tenantId: input.tenantId,
    triggerType: 'product_purchased',
    eventKey: `purchase:${input.purchaseKey}:product:${input.productId}`,
    context: {
      productId: input.productId,
      contactId: input.contactId,
      reference: readable(input.productName ?? null),
      amount,
    },
    sequenceTrigger: { type: 'product_purchased', productId: input.productId, skipUnsubscribed: true, emails: [input.email] },
  }, deps)
}

/**
 * One win of a deal. A deal won, reopened and won again is two wins, each
 * with its own closedAt (stamped once by emitDealClosedIfTransitioned), so
 * the key names the occurrence: both deliveries of one event (in process,
 * then from the queue) and every retry share it, a later win does not. An
 * event without a usable closedAt falls back to the old once-per-deal key.
 */
export function dealWonEventKey(dealId: string, closedAt: unknown): string {
  const at = typeof closedAt === 'string' && closedAt ? new Date(closedAt) : null
  return at && Number.isFinite(at.getTime()) ? `deal:${dealId}:won:${at.toISOString()}` : `deal:${dealId}`
}

/** One loss of a deal, keyed the same way on the event's lostAt. */
export function dealLostEventKey(dealId: string, lostAt: unknown): string {
  const at = typeof lostAt === 'string' && lostAt ? new Date(lostAt) : null
  return at && Number.isFinite(at.getTime()) ? `deal:${dealId}:lost:${at.toISOString()}` : `deal:${dealId}:lost`
}

/**
 * The contact or company behind a customers.person.* / customers.company.*
 * event. The commands emit the PROFILE id (customer_people.id or
 * customer_companies.id), not the entity id; older emitters used the entity
 * id, so both are accepted.
 */
async function loadEntityEventContext(
  knex: Knex,
  scope: { organizationId: string; tenantId: string },
  kind: 'person' | 'company',
  profileOrEntityId: string,
): Promise<{ entityId: string; source: string | null; updatedAt: string | null } | null> {
  const profile = await knex(kind === 'person' ? 'customer_people' : 'customer_companies')
    .where('id', profileOrEntityId)
    .where('organization_id', scope.organizationId)
    .where('tenant_id', scope.tenantId)
    .first('entity_id')
  const entityId = profile?.entity_id ?? profileOrEntityId
  const entity = await knex('customer_entities')
    .where('id', entityId)
    .where('organization_id', scope.organizationId)
    .where('tenant_id', scope.tenantId)
    .whereNull('deleted_at')
    .first('id', 'kind', 'source', 'updated_at')
  if (!entity) return null
  if (entity.kind && entity.kind !== kind) return null
  const updated = entity.updated_at ? new Date(entity.updated_at) : null
  return {
    entityId: entity.id,
    source: typeof entity.source === 'string' && entity.source ? entity.source : null,
    updatedAt: updated && Number.isFinite(updated.getTime()) ? updated.toISOString() : null,
  }
}

/** The person behind a customers.person.created / customers.person.updated event. */
export async function loadCreatedPersonContext(
  knex: Knex,
  scope: { organizationId: string; tenantId: string },
  personOrEntityId: string,
): Promise<{ contactId: string; source: string | null; updatedAt: string | null } | null> {
  const found = await loadEntityEventContext(knex, scope, 'person', personOrEntityId)
  return found ? { contactId: found.entityId, source: found.source, updatedAt: found.updatedAt } : null
}

/** The company behind a customers.company.created event. */
export async function loadCompanyEventContext(
  knex: Knex,
  scope: { organizationId: string; tenantId: string },
  companyOrEntityId: string,
): Promise<{ companyId: string; source: string | null } | null> {
  const found = await loadEntityEventContext(knex, scope, 'company', companyOrEntityId)
  return found ? { companyId: found.entityId, source: found.source } : null
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
    .where('tenant_id', scope.tenantId)
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
    .where('tenant_id', scope.tenantId)
    .first('id', 'contact_id', 'booking_page_id', 'start_time')
  if (!booking) return null
  return {
    bookingId,
    contactId: booking.contact_id ?? null,
    bookingPageId: booking.booking_page_id ?? null,
    startTime: booking.start_time ? new Date(booking.start_time).toISOString() : null,
  }
}
