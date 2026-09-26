import type { Knex } from 'knex'
import { decryptRowFields } from '@open-mercato/shared/lib/encryption/decryptRows'

/* Which mailboxes Customer Service answers, and which addresses it must never
 * treat as a customer or send an alert to.
 *
 * Two rules live here:
 *  1. The ticked mailboxes (customer_service_settings.watched_connection_ids)
 *     are the ONLY mailboxes Customer Service drafts replies for. Nothing
 *     ticked means no mailbox at all. It used to mean "every connected
 *     mailbox", so an owner who ticked nothing (or only set up website chat or
 *     an SMS number) got replies drafted to their personal mail.
 *  2. A flag alert never goes to a mailbox Customer Service reads. An alert
 *     mailed to the support inbox came back on the next fetch as a new
 *     customer message, and the owner may never read that inbox anyway.
 *
 * Relative imports only (worker-safe); the pure helpers carry the rules and
 * are unit-tested, the knex loader at the bottom only gathers their inputs. */

export type WatchedMailbox = { id: string; address: string }

export type MailboxConnection = {
  id: string
  email_address?: string | null
  purpose?: string | null
  is_primary?: boolean | null
}

/** Parse stored or submitted watched mailbox ids (jsonb array, JSON string, or
 * null). Anything that is not a non-empty list of ids is an empty list, which
 * means NO mailbox is watched. Ids are trimmed and de-duplicated. */
export function parseWatchedConnectionIds(raw: unknown): string[] {
  let value: unknown = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return []
    }
  }
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (id && !out.includes(id)) out.push(id)
  }
  return out
}

const ADDRESS_RE = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g

/** Every email address in a header value ("Name <a@b.com>, c@d.com"),
 * lower-cased and de-duplicated. */
export function extractEmailAddresses(header: unknown): string[] {
  if (typeof header !== 'string' || !header) return []
  return Array.from(new Set((header.match(ADDRESS_RE) || []).map((a) => a.toLowerCase())))
}

/** Which watched mailbox an inbound message arrived on, or null when it did
 * not arrive on one. Matches the ingesting connection (email_messages.account_id)
 * first, then an exact recipient address in To. Exact, not substring:
 * "support@acme.com" must not match "notsupport@acme.com". */
export function matchWatchedMailbox(
  inbound: { account_id?: unknown; to_address?: unknown },
  watched: WatchedMailbox[],
): WatchedMailbox | null {
  if (watched.length === 0) return null
  const accountId = typeof inbound.account_id === 'string' ? inbound.account_id : null
  if (accountId) {
    const byConnection = watched.find((w) => w.id === accountId)
    if (byConnection) return byConnection
  }
  const recipients = new Set(extractEmailAddresses(inbound.to_address))
  return watched.find((w) => recipients.has(w.address.toLowerCase())) ?? null
}

/** Addresses Customer Service reads as incoming customer mail: every active
 * support inbox (fetched on every run, ticked or not) plus every ticked
 * mailbox (which can be a personal one the owner opted in). */
export function monitoredMailboxAddresses(connections: MailboxConnection[], watchedIds: string[]): Set<string> {
  const watched = new Set(watchedIds)
  const out = new Set<string>()
  for (const c of connections) {
    const address = (c.email_address || '').trim().toLowerCase()
    if (!address) continue
    if (c.purpose === 'customer_service' || watched.has(c.id)) out.add(address)
  }
  return out
}

/** Where a flag alert goes: the primary personal mailbox, then any other
 * personal mailbox, then the account owner's sign-in email, skipping every
 * address Customer Service reads. null = no safe recipient, so the alert is
 * skipped (the flag still shows on the draft in the queue). */
export function pickFlagAlertRecipient(input: {
  connections: MailboxConnection[]
  watchedIds: string[]
  ownerEmail?: string | null
}): string | null {
  const monitored = monitoredMailboxAddresses(input.connections, input.watchedIds)
  const personal = input.connections
    .filter((c) => c.purpose !== 'customer_service')
    .sort((a, b) => Number(b.is_primary === true) - Number(a.is_primary === true))
  for (const c of personal) {
    const address = (c.email_address || '').trim().toLowerCase()
    if (address && address.includes('@') && !monitored.has(address)) return address
  }
  const owner = extractEmailAddresses(input.ownerEmail ?? '')[0]
  if (owner && !monitored.has(owner)) return owner
  return null
}

/** True when a message was sent by Noli's own notification sender (flag
 * alerts, digests, reminders). Such mail is never a customer message. */
export function isPlatformNotificationSender(fromAddress: unknown, platformFrom: string | null | undefined): boolean {
  const platform = extractEmailAddresses(platformFrom ?? '')[0]
  if (!platform) return false
  return extractEmailAddresses(fromAddress)[0] === platform
}

/** Load the inputs for pickFlagAlertRecipient (tenant and organization
 * scoped) and pick. Never throws; returns null when nothing safe is found. */
export async function resolveFlagAlertRecipient(
  knex: Knex,
  scope: { orgId: string; tenantId: string },
): Promise<string | null> {
  try {
    const connections = (await knex('email_connections')
      .where('organization_id', scope.orgId)
      .where('tenant_id', scope.tenantId)
      .where('is_active', true)
      .whereNull('deleted_at')
      .select('id', 'email_address', 'purpose', 'is_primary')) as MailboxConnection[]
    const settings = await knex('customer_service_settings')
      .where('organization_id', scope.orgId)
      .where('tenant_id', scope.tenantId)
      .select('watched_connection_ids')
      .first()
    const watchedIds = parseWatchedConnectionIds(settings?.watched_connection_ids)

    const fromMailboxes = pickFlagAlertRecipient({ connections, watchedIds, ownerEmail: null })
    if (fromMailboxes) return fromMailboxes

    // No personal mailbox to use: the account owner (the org's first user).
    // users.email is encrypted at rest, so open it before use.
    const owner = await knex('users')
      .where('organization_id', scope.orgId)
      .where('tenant_id', scope.tenantId)
      .whereNull('deleted_at')
      .orderBy('created_at', 'asc')
      .select('id', 'email')
      .first()
    if (!owner?.email) return null
    await decryptRowFields(null, 'auth:user', [owner], ['email'], scope.tenantId, scope.orgId)
    return pickFlagAlertRecipient({ connections, watchedIds, ownerEmail: owner.email })
  } catch (err) {
    console.error('[flag-alert] recipient lookup failed', { orgId: scope.orgId, err })
    return null
  }
}
