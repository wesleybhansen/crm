import type { Knex } from 'knex'
import { isDealClosedWon } from '@open-mercato/core/modules/customers/lib/dealClosed'
import { decryptRowFields, CONTACT_ENTITY_KEY, DEAL_ENTITY_KEY } from '@open-mercato/shared/lib/encryption/decryptRows'
import { isEncryptedEnvelope } from '@open-mercato/shared/lib/encryption/envelopeFormat'
import { UNDECRYPTABLE_DISPLAY_TEXT } from '@open-mercato/shared/lib/encryption/tenantDataEncryptionService'

/*
 * Cross-app event outbox: a closed deal, delivered to the marketing app (AMS).
 *
 *   customers.deal.closed  ->  subscribers/deal-closed-ams.ts  ->  enqueueDealClosed
 *   (one row per deal)     ->  drainOutboundEvents  ->  POST {AMS}/api/internal/events/deal-closed
 *
 * Contract: Software Strategy/deal-closed-contract.md (AMS copy:
 * docs/crm-deal-closed-event.md in blog-ops).
 *   Authorization: Bearer NOLI_INTERNAL_SERVICE_SECRET
 *   { eventId, noliUserId, crmOrganizationId, dealId, title, closedAt,
 *     side?: 'listing'|'buyer'|'both', propertyAddress?, city?, amount?,
 *     client?: { name?, email } }
 *
 * Delivery is at-least-once with a stable eventId (deal-closed:<dealId>, the
 * same on every retry), so AMS dedupes on it. The row holds ids only: the
 * payload is built and decrypted at send time, so no plaintext of an
 * encrypted field ever sits in this table. A 2xx (accepted, duplicate or
 * skipped) or 409 is delivered; a 400 is malformed and fails without a retry;
 * anything else retries with exponential backoff (1 min doubling to 6 h) until
 * OUTBOUND_MAX_ATTEMPTS, then the row is 'failed'. A deal that is gone or
 * reopened, an org with no Noli owner, or an owner without the AMS
 * entitlement is 'skipped' and never sent.
 *
 * `client` (the buyer, for AMS's past-client list) goes only on a buyer or
 * both-sides deal with a property address, and only when the contact has not
 * opted out of email here: no global unsubscribe (email_unsubscribes) and no
 * category opt-out (email_preferences). AMS cannot see CRM opt-outs, so an
 * unreadable opt-out list leaves it out.
 *
 * A 404 (AMS endpoint not live yet), 401 (secret being fixed), 429 and 5xx
 * all retry with the same eventId: nothing is dropped for a condition that
 * can clear on its own.
 *
 * Journey case: realtors default to the Customer Journey board, where a closing
 * is a CONTACT moving into a closed/won stage, with no deal row. That move
 * (customers.person.stage_changed -> subscribers/journey-closed-ams.ts) sends
 * the same AMS event with eventId = dealId = journey-closed:<contactId>:<stage
 * key> (journeyClosedEventId), title = the contact's name, and side / address /
 * city from the contact's custom fields. `client` is that contact, under the
 * same opt-out rules. Outbox row: event_type 'journey.closed', subject_id =
 * the contact id, so one journey closing per contact is recorded.
 *
 * Relative imports only: subscribers can be bundled into workers.
 */

export const DEAL_CLOSED_EVENT_TYPE = 'deal.closed'
export const JOURNEY_CLOSED_EVENT_TYPE = 'journey.closed'
export const DEAL_CLOSED_TARGET = 'ams'
export const DEAL_CLOSED_PATH = '/api/internal/events/deal-closed'
export const DEFAULT_AMS_BASE_URL = 'https://ams.noliai.com'
export const OUTBOUND_MAX_ATTEMPTS = 12

const OUTBOX_TABLE = 'integrations_api_outbound_events'
const BASE_BACKOFF_MS = 60_000
const MAX_BACKOFF_MS = 6 * 60 * 60_000
const SEND_LEASE_MS = 5 * 60_000
const REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_DRAIN_LIMIT = 25

export type DealSide = 'listing' | 'buyer' | 'both'

export type DealClosedPayload = {
  eventId: string
  noliUserId: string
  crmOrganizationId: string
  dealId: string
  title: string
  closedAt: string
  side?: DealSide
  propertyAddress?: string
  city?: string
  amount?: number
  client?: DealClient
}

export type DealClient = { name?: string; email: string }

export type OutboundFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; redirect?: 'manual'; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number }>

export type LoadedDeal = {
  id: string
  title: string | null
  status: string | null
  pipelineStage: string | null
  valueAmount: number | null
  custom: Record<string, unknown>
  client?: DealClient | null
}

export type OwnerResolution = { noliUserId: string | null; linked: boolean }

export type OutboundRow = {
  id: string
  organization_id: string
  tenant_id: string
  event_type: string
  subject_id: string
  event_id: string
  occurred_at: Date | string
  status: string
  attempts: number
  next_attempt_at: Date | string
}

export type OutboundDeps = {
  fetchImpl?: OutboundFetch
  now?: () => Date
  secret?: () => string | null
  baseUrl?: () => string
  resolveOwner?: (knex: Knex, organizationId: string, tenantId: string) => Promise<OwnerResolution>
  hasAmsEntitlement?: (noliUserId: string) => Promise<boolean>
  loadDeal?: (knex: Knex, row: OutboundRow, em: unknown) => Promise<LoadedDeal | null>
  loadJourneyContact?: (knex: Knex, row: OutboundRow, em: unknown) => Promise<LoadedDeal | null>
}

export type DrainResult = { claimed: number; delivered: number; retried: number; skipped: number; failed: number }

type Outcome = 'delivered' | 'retried' | 'skipped' | 'failed'

/** One closing per deal, so one id per deal: the same on every retry. */
export function dealClosedEventId(dealId: string): string {
  return `deal-closed:${dealId}`
}

/** A journey stage name as a stable id segment: "Closed Won" -> "closed-won". */
export function journeyStageKey(stage: string | null | undefined): string {
  const key = String(stage ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
  return key || 'closed'
}

/**
 * The stable id of a journey-board closing (a contact moved into a closed/won
 * stage): the AMS eventId AND its dealId, the same on every retry.
 */
export function journeyClosedEventId(contactId: string, stage: string | null | undefined): string {
  return `journey-closed:${contactId}:${journeyStageKey(stage)}`
}

/** Delay before the next try after `attempts` tries: 1 min, doubling, capped at 6 h. */
export function nextBackoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1))
}

function internalSecret(): string | null {
  const secret = (process.env.NOLI_INTERNAL_SERVICE_SECRET ?? '').trim()
  return secret.length > 0 ? secret : null
}

function amsBaseUrl(): string {
  const configured = (process.env.AMS_INTERNAL_URL ?? '').trim()
  return (configured || DEFAULT_AMS_BASE_URL).replace(/\/+$/, '')
}

/**
 * Record a closed deal for delivery. Idempotent: a second call for the same
 * deal (a retried event, a replayed queue job, a reopen-and-close) inserts
 * nothing. Fast by design; it runs inline with the deal update.
 */
export async function enqueueDealClosed(
  knex: Knex,
  input: { organizationId: string; tenantId: string; dealId: string; closedAt: Date },
  now: Date = new Date(),
): Promise<{ inserted: boolean }> {
  const rows = await knex(OUTBOX_TABLE)
    .insert({
      organization_id: input.organizationId,
      tenant_id: input.tenantId,
      event_type: DEAL_CLOSED_EVENT_TYPE,
      subject_id: input.dealId,
      event_id: dealClosedEventId(input.dealId),
      target: DEAL_CLOSED_TARGET,
      occurred_at: input.closedAt,
      status: 'pending',
      attempts: 0,
      next_attempt_at: now,
      created_at: now,
      updated_at: now,
    })
    .onConflict(['organization_id', 'event_type', 'subject_id'])
    .ignore()
    .returning('id')
  return { inserted: Array.isArray(rows) && rows.length > 0 }
}

export type PersonStageChangedPayload = {
  id?: string
  organizationId?: string | null
  tenantId?: string | null
  stage?: string | null
  previousStage?: string | null
  changedAt?: string
}

/**
 * True when a customers.person.stage_changed is a journey closing worth one
 * AMS event: into a closed/won stage from a stage that was not one. Lost
 * stages, moves out of a closed stage and moves between two closed stages
 * are not.
 */
export function isJourneyClosing(payload: PersonStageChangedPayload): boolean {
  const stage = typeof payload?.stage === 'string' ? payload.stage.trim() : ''
  if (!stage) return false
  if (!isDealClosedWon({ status: null, pipelineStage: stage })) return false
  return !isDealClosedWon({ status: null, pipelineStage: payload.previousStage ?? null })
}

/**
 * Record a journey-board closing for delivery. Idempotent per contact: moving
 * the same contact back out and into a closed stage records nothing new.
 */
export async function enqueueJourneyClosed(
  knex: Knex,
  input: { organizationId: string; tenantId: string; contactId: string; stage: string; closedAt: Date },
  now: Date = new Date(),
): Promise<{ inserted: boolean }> {
  const rows = await knex(OUTBOX_TABLE)
    .insert({
      organization_id: input.organizationId,
      tenant_id: input.tenantId,
      event_type: JOURNEY_CLOSED_EVENT_TYPE,
      subject_id: input.contactId,
      event_id: journeyClosedEventId(input.contactId, input.stage),
      target: DEAL_CLOSED_TARGET,
      occurred_at: input.closedAt,
      status: 'pending',
      attempts: 0,
      next_attempt_at: now,
      created_at: now,
      updated_at: now,
    })
    .onConflict(['organization_id', 'event_type', 'subject_id'])
    .ignore()
    .returning('id')
  return { inserted: Array.isArray(rows) && rows.length > 0 }
}

function cleanText(value: unknown, max = 300): string | null {
  if (typeof value !== 'string') return null
  const text: string = value.replace(/\s+/g, ' ').trim()
  const unreadable = isEncryptedEnvelope(value) || text === UNDECRYPTABLE_DISPLAY_TEXT
  if (!text || unreadable) return null
  return text.slice(0, max)
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/^cf_/, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

const ADDRESS_KEYS = ['property_address', 'listing_address', 'street_address', 'address', 'property']
const CITY_KEYS = ['property_city', 'city']
const SIDE_KEYS = ['side', 'deal_side', 'transaction_side', 'representation', 'client_side', 'represented_side']

function pickCustom(custom: Record<string, unknown>, keys: string[]): unknown {
  const byKey = new Map<string, unknown>()
  for (const [key, value] of Object.entries(custom)) byKey.set(normalizeKey(key), Array.isArray(value) ? value[0] : value)
  for (const key of keys) {
    if (byKey.has(key)) return byKey.get(key)
  }
  return undefined
}

export function normalizeDealSide(value: unknown): DealSide | null {
  const text = cleanText(value)?.toLowerCase()
  if (!text) return null
  if (/\b(both|dual|double)\b/.test(text)) return 'both'
  const listing = /\b(list|listing|seller|sell|selling|sale)\b/.test(text)
  const buyer = /\b(buy|buyer|buying|purchase|purchaser)\b/.test(text)
  if (listing && buyer) return 'both'
  if (listing) return 'listing'
  if (buyer) return 'buyer'
  return null
}

/** Where and which side, from the deal's custom fields when the org keeps them. */
export function extractDealLocation(custom: Record<string, unknown>): { side?: DealSide; propertyAddress?: string; city?: string } {
  const out: { side?: DealSide; propertyAddress?: string; city?: string } = {}
  const side = normalizeDealSide(pickCustom(custom, SIDE_KEYS))
  if (side) out.side = side
  const address = cleanText(pickCustom(custom, ADDRESS_KEYS))
  if (address) out.propertyAddress = address
  const city = cleanText(pickCustom(custom, CITY_KEYS), 120)
  if (city) out.city = city
  return out
}

export function buildDealClosedPayload(row: OutboundRow, deal: LoadedDeal, noliUserId: string): DealClosedPayload {
  const payload: DealClosedPayload = {
    eventId: row.event_id,
    noliUserId,
    crmOrganizationId: row.organization_id,
    // A journey closing has no deal row: its stable event id is its deal id.
    dealId: row.event_type === JOURNEY_CLOSED_EVENT_TYPE ? row.event_id : row.subject_id,
    title: cleanText(deal.title) ?? 'Closed deal',
    closedAt: new Date(row.occurred_at).toISOString(),
    ...extractDealLocation(deal.custom),
  }
  if (typeof deal.valueAmount === 'number' && Number.isFinite(deal.valueAmount) && deal.valueAmount > 0) {
    payload.amount = deal.valueAmount
  }
  const email = deal.client?.email?.trim()
  if (email && email.includes('@') && (payload.side === 'buyer' || payload.side === 'both') && payload.propertyAddress) {
    const name = cleanText(deal.client?.name, 200)
    payload.client = name ? { name, email } : { email }
  }
  return payload
}

/**
 * A contact as the `client`, unless they opted out of email here. Any doubt
 * (no readable address, an unreadable opt-out list) returns null: AMS would
 * mail them a yearly home value update. `contact` holds the stored (possibly
 * encrypted) primary_email and display_name; they are decrypted here.
 */
async function contactAsClient(
  knex: Knex,
  row: OutboundRow,
  em: unknown,
  contact: { id: string; primary_email?: unknown; display_name?: unknown },
): Promise<DealClient | null> {
  const storedEmail = typeof contact.primary_email === 'string' ? contact.primary_email : ''
  const readable = { primary_email: contact.primary_email, display_name: contact.display_name }
  await decryptRowFields(em ?? null, CONTACT_ENTITY_KEY, [readable], ['primary_email', 'display_name'], row.tenant_id, row.organization_id)
  const email = cleanText(readable.primary_email, 320)?.toLowerCase()
  if (!email || !email.includes('@')) return null
  const optOut = await knex('email_unsubscribes')
    .where('organization_id', row.organization_id)
    .where(function (this: Knex.QueryBuilder) {
      this.where('contact_id', contact.id).orWhereIn('email', Array.from(new Set([email, storedEmail].filter(Boolean))))
    })
    .first('id')
  if (optOut) return null
  const categoryOptOut = await knex('email_preferences')
    .where('organization_id', row.organization_id)
    .where('contact_id', contact.id)
    .where('opted_in', false)
    .whereNull('deleted_at')
    .first('id')
  if (categoryOptOut) return null
  const name = cleanText(readable.display_name, 200)
  return name ? { name, email } : { email }
}

/** The deal's first linked contact as the buyer, unless they opted out of email here. */
async function loadDealClient(knex: Knex, row: OutboundRow, em: unknown): Promise<DealClient | null> {
  const contact = await knex('customer_deal_people as cdp')
    .join('customer_entities as ce', 'ce.id', 'cdp.person_entity_id')
    .where('cdp.deal_id', row.subject_id)
    .where('ce.organization_id', row.organization_id)
    .whereNull('ce.deleted_at')
    .orderBy('cdp.created_at', 'asc')
    .first('ce.id as id', 'ce.primary_email as primary_email', 'ce.display_name as display_name')
  if (!contact) return null
  return contactAsClient(knex, row, em, contact)
}

async function requestEm(em: unknown): Promise<unknown> {
  if (em) return em
  const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
  return (await createRequestContainer()).resolve('em')
}

/**
 * A journey-board closing: the contact (subject_id) as the deal. Title is the
 * contact's name; side, address and city come from the contact's custom
 * fields (entity-level and person-profile fields, profile winning); the
 * contact is the client under the same opt-out rules. The current
 * lifecycle_stage stands in for the deal stage, so a contact moved back out
 * of the closed stage before delivery is skipped like a reopened deal.
 */
export async function defaultLoadJourneyContact(knex: Knex, row: OutboundRow, em: unknown): Promise<LoadedDeal | null> {
  const contact = await knex('customer_entities')
    .where('id', row.subject_id)
    .where('organization_id', row.organization_id)
    .where('tenant_id', row.tenant_id)
    .whereNull('deleted_at')
    .first('id', 'display_name', 'primary_email', 'lifecycle_stage')
  if (!contact) return null
  const titleRow = { display_name: contact.display_name }
  try {
    await decryptRowFields(em ?? null, CONTACT_ENTITY_KEY, [titleRow], ['display_name'], row.tenant_id, row.organization_id)
  } catch {
    titleRow.display_name = null
  }
  let custom: Record<string, unknown> = {}
  try {
    const manager = await requestEm(em)
    const { loadCustomFieldSnapshot } = await import('@open-mercato/shared/lib/commands/customFieldSnapshots')
    const entityCustom = await loadCustomFieldSnapshot(manager as never, {
      entityId: 'customers:customer_entity',
      recordId: row.subject_id,
      tenantId: row.tenant_id,
      organizationId: row.organization_id,
    })
    const profile = await knex('customer_people')
      .where('entity_id', row.subject_id)
      .where('organization_id', row.organization_id)
      .where('tenant_id', row.tenant_id)
      .first('id')
      .catch(() => null)
    const profileCustom = profile?.id
      ? await loadCustomFieldSnapshot(manager as never, {
        entityId: 'customers:customer_person_profile',
        recordId: String(profile.id),
        tenantId: row.tenant_id,
        organizationId: row.organization_id,
      })
      : {}
    custom = { ...entityCustom, ...profileCustom }
  } catch {
    custom = {}
  }
  let client: DealClient | null = null
  const side = extractDealLocation(custom).side
  if (side === 'buyer' || side === 'both') {
    try {
      client = await contactAsClient(knex, row, em, contact)
    } catch {
      client = null
    }
  }
  return {
    id: String(contact.id),
    title: cleanText(titleRow.display_name),
    status: null,
    pipelineStage: contact.lifecycle_stage ?? null,
    valueAmount: null,
    custom,
    client,
  }
}

async function defaultResolveOwner(knex: Knex, organizationId: string, tenantId: string): Promise<OwnerResolution> {
  const { findOrgOwnerUserId, findUserByClerkId } = await import('@open-mercato/shared/lib/noli/core-client')
  const org = await knex('organizations').where('id', organizationId).first('noli_org_id')
  const noliOrgId = typeof org?.noli_org_id === 'string' && org.noli_org_id ? org.noli_org_id : null
  if (noliOrgId) {
    const owner = await findOrgOwnerUserId(noliOrgId)
    if (owner) return { noliUserId: owner, linked: true }
  }
  const users = await knex('users')
    .where('organization_id', organizationId)
    .where('tenant_id', tenantId)
    .whereNull('deleted_at')
    .whereNotNull('clerk_user_id')
    .orderBy('created_at', 'asc')
    .limit(5)
    .select('clerk_user_id')
  for (const user of users as Array<{ clerk_user_id: string }>) {
    const noliUser = await findUserByClerkId(user.clerk_user_id)
    if (noliUser?.id) return { noliUserId: noliUser.id, linked: true }
  }
  return { noliUserId: null, linked: Boolean(noliOrgId) || users.length > 0 }
}

async function defaultHasAmsEntitlement(noliUserId: string): Promise<boolean> {
  const { isEntitled } = await import('@open-mercato/shared/lib/noli/core-client')
  return isEntitled(noliUserId, 'ams')
}

async function defaultLoadDeal(knex: Knex, row: OutboundRow, em: unknown): Promise<LoadedDeal | null> {
  const deal = await knex('customer_deals')
    .where('id', row.subject_id)
    .where('organization_id', row.organization_id)
    .where('tenant_id', row.tenant_id)
    .whereNull('deleted_at')
    .first('id', 'title', 'status', 'pipeline_stage', 'value_amount')
  if (!deal) return null
  try {
    await decryptRowFields(em ?? null, DEAL_ENTITY_KEY, [deal], ['title'], row.tenant_id, row.organization_id)
  } catch {
    deal.title = null
  }
  let custom: Record<string, unknown> = {}
  try {
    let manager = em
    if (!manager) {
      const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
      manager = (await createRequestContainer()).resolve('em')
    }
    const { loadCustomFieldSnapshot } = await import('@open-mercato/shared/lib/commands/customFieldSnapshots')
    custom = await loadCustomFieldSnapshot(manager as never, {
      entityId: 'customers:customer_deal',
      recordId: row.subject_id,
      tenantId: row.tenant_id,
      organizationId: row.organization_id,
    })
  } catch {
    custom = {}
  }
  let client: DealClient | null = null
  const side = extractDealLocation(custom).side
  if (side === 'buyer' || side === 'both') {
    try {
      client = await loadDealClient(knex, row, em)
    } catch {
      client = null
    }
  }
  const amount = deal.value_amount == null ? null : Number(deal.value_amount)
  return {
    id: String(deal.id),
    title: cleanText(deal.title),
    status: deal.status ?? null,
    pipelineStage: deal.pipeline_stage ?? null,
    valueAmount: amount != null && Number.isFinite(amount) ? amount : null,
    custom,
    client,
  }
}

async function finish(knex: Knex, row: OutboundRow, now: Date, patch: Record<string, unknown>): Promise<void> {
  await knex(OUTBOX_TABLE)
    .where('id', row.id)
    .where('organization_id', row.organization_id)
    .update({ ...patch, updated_at: now })
}

async function retryLater(knex: Knex, row: OutboundRow, attempts: number, now: Date, error: string, statusCode: number | null): Promise<Outcome> {
  if (attempts >= OUTBOUND_MAX_ATTEMPTS) {
    await finish(knex, row, now, { status: 'failed', last_error: error.slice(0, 500), last_status_code: statusCode })
    console.error('[outbound-events] giving up', { id: row.id, eventType: row.event_type, attempts, error })
    return 'failed'
  }
  await finish(knex, row, now, {
    status: 'pending',
    next_attempt_at: new Date(now.getTime() + nextBackoffMs(attempts)),
    last_error: error.slice(0, 500),
    last_status_code: statusCode,
  })
  return 'retried'
}

async function deliverDealClosed(knex: Knex, row: OutboundRow, attempts: number, em: unknown, deps: Required<OutboundDeps>): Promise<Outcome> {
  const now = deps.now()
  const secret = deps.secret()
  const baseUrl = deps.baseUrl()
  if (!secret || !baseUrl) return retryLater(knex, row, attempts, now, 'unconfigured: NOLI_INTERNAL_SERVICE_SECRET or AMS_INTERNAL_URL missing', null)

  const journey = row.event_type === JOURNEY_CLOSED_EVENT_TYPE
  let deal: LoadedDeal | null
  try {
    deal = journey ? await deps.loadJourneyContact(knex, row, em) : await deps.loadDeal(knex, row, em)
  } catch (err) {
    return retryLater(knex, row, attempts, now, `load deal: ${err instanceof Error ? err.message : String(err)}`, null)
  }
  if (!deal) {
    await finish(knex, row, now, { status: 'skipped', last_error: journey ? 'contact_missing' : 'deal_missing' })
    return 'skipped'
  }
  if (!isDealClosedWon({ status: deal.status, pipelineStage: deal.pipelineStage })) {
    await finish(knex, row, now, { status: 'skipped', last_error: journey ? 'journey_not_closed' : 'deal_not_closed' })
    return 'skipped'
  }

  let owner: OwnerResolution
  try {
    owner = await deps.resolveOwner(knex, row.organization_id, row.tenant_id)
  } catch (err) {
    return retryLater(knex, row, attempts, now, `resolve owner: ${err instanceof Error ? err.message : String(err)}`, null)
  }
  if (!owner.noliUserId) {
    if (!owner.linked) {
      await finish(knex, row, now, { status: 'skipped', last_error: 'no_noli_user' })
      return 'skipped'
    }
    return retryLater(knex, row, attempts, now, 'owner not resolvable yet', null)
  }

  try {
    if ((await deps.hasAmsEntitlement(owner.noliUserId)) === false) {
      await finish(knex, row, now, { status: 'skipped', last_error: 'no_ams_entitlement' })
      return 'skipped'
    }
  } catch {
    // Entitlement unknown: send anyway, AMS ignores an org without the app.
  }

  const payload = buildDealClosedPayload(row, deal, owner.noliUserId)
  let status: number
  try {
    const response = await deps.fetchImpl(`${baseUrl}${DEAL_CLOSED_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': payload.eventId,
        'User-Agent': 'Noli-CRM-Events/1',
      },
      body: JSON.stringify(payload),
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    status = response.status
    if (response.ok || response.status === 409) {
      await finish(knex, row, deps.now(), { status: 'delivered', delivered_at: deps.now(), last_status_code: status, last_error: null })
      return 'delivered'
    }
    if (response.status === 400) {
      await finish(knex, row, deps.now(), { status: 'failed', last_status_code: status, last_error: 'AMS rejected the payload as malformed (400)' })
      console.error('[outbound-events] AMS rejected a deal-closed payload', { id: row.id })
      return 'failed'
    }
  } catch (err) {
    return retryLater(knex, row, attempts, deps.now(), `transport: ${err instanceof Error ? err.message : String(err)}`, null)
  }
  return retryLater(knex, row, attempts, deps.now(), `AMS responded ${status}`, status)
}

function withDefaults(deps: OutboundDeps | undefined): Required<OutboundDeps> {
  return {
    fetchImpl: deps?.fetchImpl ?? ((url, init) => fetch(url, init)),
    now: deps?.now ?? (() => new Date()),
    secret: deps?.secret ?? internalSecret,
    baseUrl: deps?.baseUrl ?? amsBaseUrl,
    resolveOwner: deps?.resolveOwner ?? defaultResolveOwner,
    hasAmsEntitlement: deps?.hasAmsEntitlement ?? defaultHasAmsEntitlement,
    loadDeal: deps?.loadDeal ?? defaultLoadDeal,
    loadJourneyContact: deps?.loadJourneyContact ?? defaultLoadJourneyContact,
  }
}

/**
 * Send what is due. Each row is claimed with one guarded update (status +
 * next_attempt_at), so overlapping drains (the subscriber's immediate try and
 * the cron) never send a row twice at the same time; a claim that crashes is
 * picked up again once its lease (next_attempt_at) passes. Never throws.
 */
export async function drainOutboundEvents(
  knex: Knex,
  opts: { limit?: number; organizationId?: string | null; em?: unknown; deps?: OutboundDeps } = {},
): Promise<DrainResult> {
  const deps = withDefaults(opts.deps)
  const result: DrainResult = { claimed: 0, delivered: 0, retried: 0, skipped: 0, failed: 0 }
  let due: OutboundRow[] = []
  try {
    let query = knex(OUTBOX_TABLE)
      .whereIn('event_type', [DEAL_CLOSED_EVENT_TYPE, JOURNEY_CLOSED_EVENT_TYPE])
      .whereIn('status', ['pending', 'sending'])
      .where('next_attempt_at', '<=', deps.now())
      .orderBy('next_attempt_at', 'asc')
      .limit(Math.max(1, Math.min(100, opts.limit ?? DEFAULT_DRAIN_LIMIT)))
    if (opts.organizationId) query = query.where('organization_id', opts.organizationId)
    due = (await query.select('*')) as OutboundRow[]
  } catch (err) {
    console.error('[outbound-events] could not read the outbox', err)
    return result
  }

  for (const row of due) {
    try {
      const now = deps.now()
      const claimed = await knex(OUTBOX_TABLE)
        .where('id', row.id)
        .where('organization_id', row.organization_id)
        .whereIn('status', ['pending', 'sending'])
        .where('next_attempt_at', '<=', now)
        .update({
          status: 'sending',
          attempts: knex.raw('attempts + 1'),
          next_attempt_at: new Date(now.getTime() + SEND_LEASE_MS),
          updated_at: now,
        })
      if (!claimed) continue
      result.claimed++
      const outcome = await deliverDealClosed(knex, row, Number(row.attempts || 0) + 1, opts.em, deps)
      result[outcome]++
    } catch (err) {
      console.error('[outbound-events] delivery error', { id: row.id, err })
    }
  }
  return result
}
