import type { Knex } from 'knex'
import { encryptRowForRawWrite } from '@open-mercato/shared/lib/encryption/rawWrite'
import { decryptRowFields } from '@open-mercato/shared/lib/encryption/decryptRows'
import { isEncryptedEnvelope } from '@open-mercato/shared/lib/encryption/aes'
import { contactLookupHasher } from '@open-mercato/shared/lib/encryption/lookupKey'
import { UNDECRYPTABLE_DISPLAY_TEXT } from '@open-mercato/shared/lib/encryption/tenantDataEncryptionService'

/**
 * Event registrations (event_attendees) are encrypted like contacts
 * (2026-09-25 review, M11): attendee_name and attendee_email are encrypted on
 * write with the registration's own tenant/org, and duplicates / check-ins
 * match on attendee_email_hash (per-tenant keyed, lookupKey.ts). Rows written
 * before this (plaintext, no hash) still match on the value.
 *
 * Package imports only (no `@/`): reachable from worker bundles.
 */
export const EVENT_ATTENDEE_ENTITY = 'customers:event_attendee'
export const EVENT_ATTENDEE_FIELDS = ['attendee_name', 'attendee_email'] as const

export function normalizeAttendeeEmail(email: unknown): string {
  return String(email ?? '').trim().toLowerCase()
}

/** Encrypt a row about to be inserted/updated (fills attendee_email_hash). */
export async function encryptAttendeeRow<T extends Record<string, unknown>>(row: T, tenantId: string, organizationId: string): Promise<T> {
  return encryptRowForRawWrite(EVENT_ATTENDEE_ENTITY, row, tenantId, organizationId)
}

/** Restrict an event_attendees query to one email. Scope the query to the event (and so the tenant). */
export async function whereAttendeeEmail<T extends Knex.QueryBuilder>(qb: T, email: unknown, tenantId: string): Promise<T> {
  const normalized = normalizeAttendeeEmail(email)
  if (!normalized) return qb.whereRaw('false') as T
  const hashes = (await contactLookupHasher(tenantId)).candidates(normalized)
  return qb.where(function (this: Knex.QueryBuilder) {
    this.whereIn('attendee_email_hash', hashes).orWhere(function (this: Knex.QueryBuilder) {
      this.whereNull('attendee_email_hash').whereRaw('lower(attendee_email) = ?', [normalized])
    })
  }) as T
}

/** Decrypt rows for display (a row that cannot be opened shows the placeholder). */
export async function decryptAttendees<T extends Record<string, any>>(rows: T[], tenantId: string | null | undefined, organizationId: string | null | undefined): Promise<T[]> {
  return decryptRowFields(null, EVENT_ATTENDEE_ENTITY, rows, EVENT_ATTENDEE_FIELDS, tenantId, organizationId)
}

/**
 * Decrypt rows for an outbound send. A row whose email or name did not open
 * is dropped (never mailed to ciphertext or the placeholder); the count of
 * dropped rows is returned so the caller can report it.
 */
export async function decryptAttendeesForSend<T extends Record<string, any>>(
  rows: T[],
  tenantId: string | null | undefined,
  organizationId: string | null | undefined,
): Promise<{ rows: T[]; unreadable: number }> {
  const opened = await decryptAttendees(rows.map((r) => ({ ...r })), tenantId, organizationId)
  const bad = (v: unknown) => typeof v !== 'string' || !v || v === UNDECRYPTABLE_DISPLAY_TEXT || isEncryptedEnvelope(v)
  const ok = opened.filter((r) => !bad(r.attendee_email) && !(typeof r.attendee_name === 'string' && (r.attendee_name === UNDECRYPTABLE_DISPLAY_TEXT || isEncryptedEnvelope(r.attendee_name))))
  return { rows: ok as T[], unreadable: opened.length - ok.length }
}
