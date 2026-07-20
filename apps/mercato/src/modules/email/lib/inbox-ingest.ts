/**
 * Inbox ingest — shared IMAP fetch-and-upsert core.
 *
 * Pulls inbound mail from an IMAP mailbox and lands it in the CRM the same way
 * the personal Inbox Intelligence sync does: dedup by provider message id,
 * find-or-create the sender contact, insert an inbound `email_messages` row, and
 * upsert the unified `inbox_conversations` record so the message surfaces in the
 * inbox / Customer Service queue.
 *
 * This is the small, reusable middle layer. The personal Inbox sync
 * (intelligence-sync/route.ts) keeps its extra behaviour (engagement scoring,
 * timeline logging, lifecycle-stage advance, automated-mail filtering). The
 * Customer Service processor uses this directly so a dedicated support mailbox's
 * mail flows into the CS queue without reimplementing IMAP.
 */

import type { Knex } from 'knex'
import crypto from 'crypto'
import { fetchImapInbox } from '@/modules/email/lib/imap-service'
import { upsertInboxConversation } from '@/lib/inbox-conversation'

export interface ImapConnectionRow {
  id: string
  email_address: string | null
  imap_host: string | null
  imap_port: number | null
  imap_secure: boolean | null
  smtp_user: string | null
  smtp_pass: string | null
  /** Mailbox role: 'customer_service' for the CS support inbox, null for personal. */
  purpose?: string | null
}

export interface IngestOptions {
  /** Only fetch mail received on/after this date. */
  sinceDate: Date
  /** Per-connection cap on messages pulled in one run. */
  maxMessages?: number
  /** Create a contact for unknown senders. Dedicated CS inboxes default true. */
  autoCreateContacts?: boolean
  /** Tag written into email_messages.metadata.source so callers are distinguishable. */
  source?: string
  /** Skip mail sent from these addresses (e.g. the org's own connected mailboxes). */
  ownEmails?: Set<string>
}

export interface IngestResult {
  emailsProcessed: number
  contactsCreated: number
  errors: string[]
}

const sanitize = (s: string | null | undefined) => (s ? s.replace(/\0/g, '') : null)

/**
 * Find an existing contact by sender email, optionally creating one. Mirrors
 * intelligence-sync's findOrCreateContact (kind=person, source tag, prospect
 * stage) so contact creation stays consistent across both ingest paths.
 */
async function findOrCreateContact(
  knex: Knex,
  orgId: string,
  tenantId: string,
  email: string,
  senderName: string,
  autoCreate: boolean,
  source: string,
): Promise<{ contactId: string | null; created: boolean }> {
  const existing = await knex('customer_entities')
    .where('organization_id', orgId)
    .where('primary_email', email.toLowerCase())
    .whereNull('deleted_at')
    .first()

  if (existing) return { contactId: existing.id, created: false }
  if (!autoCreate) return { contactId: null, created: false }

  const entityId = crypto.randomUUID()
  const personId = crypto.randomUUID()
  const nameParts = (senderName || '').trim().split(/\s+/).filter(Boolean)
  const firstName = nameParts[0] || email.split('@')[0]
  const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : ''
  const displayName = (senderName || '').trim() || email.split('@')[0]
  const now = new Date()

  await knex('customer_entities').insert({
    id: entityId,
    tenant_id: tenantId,
    organization_id: orgId,
    kind: 'person',
    display_name: displayName,
    primary_email: email.toLowerCase(),
    source,
    status: 'active',
    lifecycle_stage: 'prospect',
    is_active: true,
    created_at: now,
    updated_at: now,
  })

  await knex('customer_people').insert({
    id: personId,
    tenant_id: tenantId,
    organization_id: orgId,
    entity_id: entityId,
    first_name: firstName,
    last_name: lastName,
    created_at: now,
    updated_at: now,
  })

  return { contactId: entityId, created: true }
}

/**
 * Fetch new inbound mail from a single IMAP connection and land it in the CRM.
 * Caller is responsible for org-scoping the connection row it passes in.
 */
export async function ingestImapConnection(
  knex: Knex,
  orgId: string,
  tenantId: string,
  conn: ImapConnectionRow,
  opts: IngestOptions,
): Promise<IngestResult> {
  const maxMessages = opts.maxMessages ?? 100
  const autoCreate = opts.autoCreateContacts ?? true
  const source = opts.source ?? 'inbox_ingest'
  const ownEmails = opts.ownEmails ?? new Set<string>()
  const errors: string[] = []
  let emailsProcessed = 0
  let contactsCreated = 0

  if (!conn.imap_host) {
    return { emailsProcessed: 0, contactsCreated: 0, errors: ['Connection has no IMAP host'] }
  }

  const imapConfig = {
    host: conn.imap_host,
    port: conn.imap_port || 993,
    secure: conn.imap_secure ?? true,
    user: conn.smtp_user || conn.email_address || '',
    pass: conn.smtp_pass || '',
  }

  const fetched = await fetchImapInbox(imapConfig, opts.sinceDate, maxMessages)

  for (const email of fetched) {
    try {
      if (!email.fromEmail) continue
      if (ownEmails.has(email.fromEmail.toLowerCase())) continue

      // Dedup by provider message id (same key intelligence-sync uses).
      const existingMsg = await knex('email_messages')
        .where('organization_id', orgId)
        .whereRaw(`metadata->>'provider_message_id' = ?`, [String(email.messageId)])
        .first()
      if (existingMsg) continue

      const { contactId, created } = await findOrCreateContact(
        knex, orgId, tenantId, email.fromEmail, email.fromName, autoCreate, source,
      )
      if (created) contactsCreated++
      // When auto-create is OFF (personal inbox) and the sender isn't a known
      // contact, STILL ingest the message with a null contact — the inbox shows ALL
      // mail and the conversation keys off the email address. Previously this
      // `continue`d, silently dropping every message from a non-contact (newsletters,
      // receipts, first-time senders), which is why new inbox mail never appeared.
      // (CS ingest passes autoCreate=true, so contactId is always set there.)

      const msgId = crypto.randomUUID()
      const safeSub = sanitize(email.subject) || '(no subject)'
      const safeHtml = sanitize(email.bodyHtml) || ''
      const safeText = sanitize(email.bodyText) || null
      const safeFrom = sanitize(email.fromEmail) || 'unknown'
      const safeTo = sanitize(email.toAddress) || 'unknown'
      const safeCc = sanitize(email.ccAddress) || null
      const sentAt = email.receivedAt || new Date()

      await knex('email_messages').insert({
        id: msgId,
        tenant_id: tenantId,
        organization_id: orgId,
        account_id: conn.id,
        direction: 'inbound',
        from_address: safeFrom,
        to_address: safeTo,
        cc: safeCc,
        subject: safeSub,
        body_html: safeHtml,
        body_text: safeText,
        thread_id: email.threadRef || null,
        contact_id: contactId,
        status: 'received',
        metadata: JSON.stringify({
          provider_message_id: String(email.messageId),
          source,
          // Keep the small header allow-list so downstream automated/bulk-mail
          // detection (Customer Service skip) has Precedence/Auto-Submitted/
          // List-Unsubscribe/List-Id without re-fetching from IMAP.
          headers: email.headers && Object.keys(email.headers).length ? email.headers : undefined,
        }),
        created_at: new Date(),
        sent_at: sentAt,
      })

      await upsertInboxConversation(knex, orgId, tenantId, {
        contactId,
        channel: 'email',
        preview: safeSub,
        direction: 'inbound',
        displayName: email.fromName || email.fromEmail,
        avatarEmail: safeFrom,
        // Tag the originating mailbox so CS support mail stays out of the
        // personal inbox list. CS connections carry purpose='customer_service'.
        sourceMailboxPurpose: conn.purpose ?? null,
      })

      emailsProcessed++
    } catch (err: any) {
      errors.push(`Email ${email.messageId}: ${err?.message || 'unknown'}`)
    }
  }

  return { emailsProcessed, contactsCreated, errors }
}
