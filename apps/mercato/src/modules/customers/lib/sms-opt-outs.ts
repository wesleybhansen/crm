import { randomUUID } from 'crypto'
import type { Knex } from 'knex'
import { decryptRowFields, CONTACT_ENTITY_KEY } from '@open-mercato/shared/lib/encryption/decryptRows'
import { isEncryptedEnvelope } from '@open-mercato/shared/lib/encryption/envelopeFormat'

/*
 * Text-message opt-outs, per business (sms_opt_outs).
 *
 * Businesses text from their OWN Twilio numbers: the automation "Send SMS"
 * action, the sequence SMS step, Customer Service replies (including the
 * "Answer routine requests" mode) and texts typed in the inbox. When a person
 * replies STOP (or another standard opt-out word) to one of those numbers,
 * Twilio's webhook tells us, and we record it here for THAT business and that
 * phone number (E.164). A later START / UNSTOP / YES clears it. A Twilio send
 * error 21610 ("the recipient unsubscribed") is recorded the same way.
 *
 * Every business-initiated send checks this store first and refuses with a
 * plain reason (never retried); a human typing a text sees the same refusal.
 *
 * Separate from email_unsubscribes on purpose: someone who stops texts still
 * gets email, and the reverse. Every query is scoped to the organization AND
 * tenant, so one business's opt-outs never touch another's.
 *
 * An opt-out row stays after the person opts back in (opted_in_at is set), so
 * the business keeps a record of when consent was withdrawn and restored. A
 * row with opted_in_at NULL is an active opt-out.
 *
 * Relative imports and packages only: reachable from worker-bundled
 * automation subscribers (sequences/lib/automation-sms.ts).
 */

export type SmsOptOutScope = { organizationId: string; tenantId: string }

export type SmsOptOut = {
  phoneNumber: string
  optedOutAt: Date
  /** 'reply' (they texted a stop word) or 'carrier' (Twilio error 21610). */
  source: string
  keyword: string | null
}

export const SMS_OPT_OUTS_TABLE = 'sms_opt_outs'
/** The code a refused send carries (API responses, send results). */
export const SMS_OPTED_OUT_CODE = 'sms_opted_out'
/** Twilio: "Attempt to send to unsubscribed recipient". */
export const TWILIO_UNSUBSCRIBED_ERROR_CODE = 21610

/** A sequence stopped at a text step (shown on the enrollment). */
export const SMS_OPTED_OUT_STOP_REASON =
  'Stopped: this person opted out of your texts, so this sequence sends them nothing more.'
/** The opt-out list could not be read, so nothing was sent. */
export const SMS_OPT_OUT_CHECK_FAILED_REASON =
  'Not sent: the text opt-out list could not be checked. It is tried again shortly.'

/*
 * Twilio's default opt-out words (STOP, STOPALL, UNSUBSCRIBE, CANCEL, END,
 * QUIT, plus OPTOUT and REVOKE, added for the 2025 FCC consent rules) and
 * opt-in words. Matched on the whole message, case-insensitively, ignoring
 * surrounding spaces and punctuation ("Stop." counts, "stop by at 5" does
 * not). Twilio's OptOutType parameter, when present, decides on its own.
 */
const OPT_OUT_WORDS = new Set(['STOP', 'STOPALL', 'STOP ALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'OPT OUT', 'REVOKE'])
const OPT_IN_WORDS = new Set(['START', 'UNSTOP', 'YES'])

export type SmsKeyword = { kind: 'opt_out' | 'opt_in'; keyword: string }

function keywordOf(body: unknown): string {
  if (typeof body !== 'string') return ''
  return body
    .trim()
    .toUpperCase()
    .replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g, '')
    .replace(/[\s-]+/g, ' ')
    .slice(0, 40)
}

/**
 * Is this inbound text an opt-out or opt-in? `optOutType` is Twilio's
 * OptOutType webhook parameter (STOP / START / HELP) when Advanced Opt-Out is
 * on; otherwise the message body is matched against the standard words.
 */
export function classifySmsKeyword(body: unknown, optOutType?: unknown): SmsKeyword | null {
  const word = keywordOf(body)
  const type = typeof optOutType === 'string' ? optOutType.trim().toUpperCase() : ''
  if (type === 'STOP') return { kind: 'opt_out', keyword: word || 'STOP' }
  if (type === 'START') return { kind: 'opt_in', keyword: word || 'START' }
  if (OPT_OUT_WORDS.has(word)) return { kind: 'opt_out', keyword: word }
  if (OPT_IN_WORDS.has(word)) return { kind: 'opt_in', keyword: word }
  return null
}

/** E.164 (+ and 8 to 15 digits); US 10- and 11-digit numbers get +1. Null otherwise. */
export function normalizeSmsNumber(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let n = value.replace(/[\s\-().]/g, '')
  if (!n || isEncryptedEnvelope(value)) return null
  if (/^\d{10}$/.test(n)) n = `+1${n}`
  else if (/^1\d{10}$/.test(n)) n = `+${n}`
  else if (!n.startsWith('+')) n = `+${n}`
  return /^\+\d{8,15}$/.test(n) ? n : null
}

/** Did Twilio refuse the send because the recipient unsubscribed (error 21610)? */
export function isTwilioUnsubscribedError(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false
  return Number((data as { code?: unknown }).code) === TWILIO_UNSUBSCRIBED_ERROR_CODE
}

function requireScope(scope: SmsOptOutScope, fn: string): void {
  if (!scope?.organizationId || !scope?.tenantId) throw new Error(`${fn}: organizationId and tenantId are required`)
}

function numbersOf(phones: unknown[]): string[] {
  const out = new Set<string>()
  for (const p of phones) {
    const n = normalizeSmsNumber(p)
    if (n) out.add(n)
  }
  return Array.from(out)
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value))
}

/** "Sep 26, 2026" (UTC), for the plain reasons and the UI. */
export function formatOptOutDate(value: Date | string): string {
  const d = toDate(value)
  if (Number.isNaN(d.getTime())) return 'an earlier date'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

/** The reason a send was refused, in plain words. */
export function smsOptedOutReason(optOut: Pick<SmsOptOut, 'optedOutAt' | 'source' | 'keyword'>): string {
  const on = formatOptOutDate(optOut.optedOutAt)
  if (optOut.source === 'carrier') {
    return `Not sent: this number opted out of your texts (Twilio reported it on ${on}). They can text START to your number to opt back in.`
  }
  const word = optOut.keyword && optOut.keyword.length <= 12 ? optOut.keyword : 'STOP'
  return `Not sent: this person opted out of your texts on ${on} (they replied ${word}). They can text START to your number to opt back in.`
}

/**
 * The active opt-out for any of these numbers in this business, or null.
 * Throws when the store cannot be read: callers fail closed (nothing is sent).
 */
export async function findSmsOptOut(knex: Knex, scope: SmsOptOutScope, phones: unknown[]): Promise<SmsOptOut | null> {
  requireScope(scope, 'findSmsOptOut')
  const numbers = numbersOf(phones)
  if (!numbers.length) return null
  const row = await knex(SMS_OPT_OUTS_TABLE)
    .where('organization_id', scope.organizationId)
    .where('tenant_id', scope.tenantId)
    .whereIn('phone_number', numbers)
    .whereNull('opted_in_at')
    .orderBy('opted_out_at', 'desc')
    .first('phone_number', 'opted_out_at', 'source', 'keyword')
  if (!row) return null
  return {
    phoneNumber: String(row.phone_number),
    optedOutAt: toDate(row.opted_out_at),
    source: typeof row.source === 'string' ? row.source : 'reply',
    keyword: typeof row.keyword === 'string' ? row.keyword : null,
  }
}

/** Active opt-outs for a list of numbers (queues and thread lists), keyed by E.164 number. */
export async function findSmsOptOutsByNumber(
  knex: Knex,
  scope: SmsOptOutScope,
  phones: unknown[],
): Promise<Map<string, SmsOptOut>> {
  requireScope(scope, 'findSmsOptOutsByNumber')
  const numbers = numbersOf(phones)
  const out = new Map<string, SmsOptOut>()
  if (!numbers.length) return out
  const rows = await knex(SMS_OPT_OUTS_TABLE)
    .where('organization_id', scope.organizationId)
    .where('tenant_id', scope.tenantId)
    .whereIn('phone_number', numbers)
    .whereNull('opted_in_at')
    .select('phone_number', 'opted_out_at', 'source', 'keyword')
  for (const row of rows) {
    out.set(String(row.phone_number), {
      phoneNumber: String(row.phone_number),
      optedOutAt: toDate(row.opted_out_at),
      source: typeof row.source === 'string' ? row.source : 'reply',
      keyword: typeof row.keyword === 'string' ? row.keyword : null,
    })
  }
  return out
}

/**
 * The active opt-out for a contact's mobile number (decrypted), or null. The
 * opt-out belongs to the number: a contact whose number changed is not
 * blocked by the old one.
 */
export async function findContactSmsOptOut(
  knex: Knex,
  scope: SmsOptOutScope,
  contactId: string,
): Promise<{ optOut: SmsOptOut | null; phone: string | null }> {
  requireScope(scope, 'findContactSmsOptOut')
  const contact = await knex('customer_entities')
    .where('id', contactId)
    .where('organization_id', scope.organizationId)
    .where('tenant_id', scope.tenantId)
    .whereNull('deleted_at')
    .first('id', 'primary_phone')
  if (!contact) return { optOut: null, phone: null }
  await decryptRowFields(null, CONTACT_ENTITY_KEY, [contact], ['primary_phone'], scope.tenantId, scope.organizationId)
  const phone = normalizeSmsNumber(contact.primary_phone)
  if (!phone) return { optOut: null, phone: null }
  return { optOut: await findSmsOptOut(knex, scope, [phone]), phone }
}

/**
 * Record an opt-out for this number in this business. An active opt-out keeps
 * its original date; one the person had cleared is re-opened with the new
 * date. Returns true when the state changed (a new or re-opened opt-out).
 */
export async function recordSmsOptOut(
  knex: Knex,
  scope: SmsOptOutScope,
  input: { phone: unknown; contactId?: string | null; source: 'reply' | 'carrier'; keyword?: string | null; at?: Date },
): Promise<boolean> {
  requireScope(scope, 'recordSmsOptOut')
  const phone = normalizeSmsNumber(input.phone)
  if (!phone) return false
  const at = input.at ?? new Date()
  const keyword = input.keyword ? String(input.keyword).slice(0, 40) : null
  const existing = await knex(SMS_OPT_OUTS_TABLE)
    .where('organization_id', scope.organizationId)
    .where('tenant_id', scope.tenantId)
    .where('phone_number', phone)
    .first('id', 'opted_in_at', 'contact_id')
  if (existing) {
    if (existing.opted_in_at == null) return false
    await knex(SMS_OPT_OUTS_TABLE)
      .where('id', existing.id)
      .where('organization_id', scope.organizationId)
      .where('tenant_id', scope.tenantId)
      .update({
        opted_out_at: at,
        opted_in_at: null,
        source: input.source,
        keyword,
        contact_id: input.contactId || existing.contact_id || null,
        updated_at: at,
      })
    return true
  }
  const inserted = await knex(SMS_OPT_OUTS_TABLE)
    .insert({
      id: randomUUID(),
      tenant_id: scope.tenantId,
      organization_id: scope.organizationId,
      phone_number: phone,
      contact_id: input.contactId || null,
      source: input.source,
      keyword,
      opted_out_at: at,
      opted_in_at: null,
      created_at: at,
      updated_at: at,
    })
    .onConflict(['organization_id', 'tenant_id', 'phone_number'])
    .ignore()
    .returning(['id'])
  return Array.isArray(inserted) ? inserted.length > 0 : Boolean(inserted)
}

/** Clear an active opt-out (the person texted START, UNSTOP or YES). Returns true when one was cleared. */
export async function clearSmsOptOut(
  knex: Knex,
  scope: SmsOptOutScope,
  input: { phone: unknown; at?: Date },
): Promise<boolean> {
  requireScope(scope, 'clearSmsOptOut')
  const phone = normalizeSmsNumber(input.phone)
  if (!phone) return false
  const at = input.at ?? new Date()
  const changed = await knex(SMS_OPT_OUTS_TABLE)
    .where('organization_id', scope.organizationId)
    .where('tenant_id', scope.tenantId)
    .where('phone_number', phone)
    .whereNull('opted_in_at')
    .update({ opted_in_at: at, updated_at: at })
  return Number(changed) > 0
}

/** JSON shape for API responses and the UI. */
export function smsOptOutJson(optOut: SmsOptOut | null | undefined): { optedOutAt: string; source: string; keyword: string | null } | null {
  if (!optOut) return null
  return { optedOutAt: optOut.optedOutAt.toISOString(), source: optOut.source, keyword: optOut.keyword }
}
