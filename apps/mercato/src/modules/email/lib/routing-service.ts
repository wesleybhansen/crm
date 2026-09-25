/**
 * Email Routing Service
 * Virtual layer over email_connections + esp_connections tables.
 * Resolves which provider + from address to use for each email purpose.
 */

import type { Knex } from 'knex'
import {
  EMAIL_CONNECTION_SECRETS,
  ESP_CONNECTION_SECRETS,
  openSecretsOnRow,
} from '@open-mercato/shared/lib/encryption/secretColumns'

export const EMAIL_PURPOSES = ['inbox', 'invoices', 'marketing', 'automations', 'transactional'] as const
export type EmailPurpose = (typeof EMAIL_PURPOSES)[number]

export const PURPOSE_LABELS: Record<EmailPurpose, { label: string; description: string }> = {
  inbox: { label: 'Inbox / Personal', description: 'Inbox replies, manual email compose' },
  invoices: { label: 'Invoices & Payments', description: 'Invoice sends, payment receipts' },
  marketing: { label: 'Marketing', description: 'Campaigns, sequences, event broadcasts' },
  automations: { label: 'Automations', description: 'Automation rule emails' },
  transactional: { label: 'Transactional', description: 'Event confirmations, course enrollments, bookings, form notifications' },
}

export interface UnifiedEmailAddress {
  id: string
  type: 'connection' | 'esp'
  provider: string
  email_address: string
  display_label: string
  can_receive: boolean
  sending_domain?: string
}

export interface ResolvedProvider {
  type: 'connection' | 'esp'
  provider: string
  fromName: string | null
  fromAddress: string
  // Full row from the source table — caller uses this for credentials
  connection?: Record<string, any>
  espConnection?: Record<string, any>
}

/**
 * Get all email addresses available for an organization (personal + ESP).
 */
export async function getEmailAddresses(knex: Knex, orgId: string): Promise<UnifiedEmailAddress[]> {
  const addresses: UnifiedEmailAddress[] = []

  // Personal email connections (Gmail, Outlook, SMTP)
  const connections = await knex('email_connections')
    .where('organization_id', orgId)
    .where('is_active', true)
    .select('id', 'provider', 'email_address')
    .orderBy('is_primary', 'desc')

  for (const c of connections) {
    const providerName = c.provider === 'microsoft' ? 'Outlook' : c.provider.charAt(0).toUpperCase() + c.provider.slice(1)
    addresses.push({
      id: c.id,
      type: 'connection',
      provider: c.provider,
      email_address: c.email_address,
      display_label: c.email_address,
      can_receive: true,
    })
  }

  // ESP sender addresses (each is a separate selectable address)
  const senderAddresses = await knex('esp_sender_addresses as sa')
    .join('esp_connections as ec', 'ec.id', 'sa.esp_connection_id')
    .where('sa.organization_id', orgId)
    .where('ec.is_active', true)
    .select('sa.id', 'sa.sender_email', 'sa.sender_name', 'sa.is_default', 'ec.provider')
    .orderBy('sa.is_default', 'desc')
    .orderBy('sa.created_at', 'asc')

  for (const sa of senderAddresses) {
    const providerName = sa.provider.charAt(0).toUpperCase() + sa.provider.slice(1)
    addresses.push({
      id: sa.id,
      type: 'esp',
      provider: sa.provider,
      email_address: sa.sender_email,
      display_label: sa.sender_email,
      can_receive: false,
    })
  }

  // If ESP connected but no sender addresses created yet, show the ESP itself as a fallback option
  if (senderAddresses.length === 0) {
    const esps = await knex('esp_connections')
      .where('organization_id', orgId).where('is_active', true)
      .select('id', 'provider', 'sending_domain', 'default_sender_email')
    for (const e of esps) {
      if (e.default_sender_email) {
        const providerName = e.provider.charAt(0).toUpperCase() + e.provider.slice(1)
        addresses.push({
          id: e.id,
          type: 'esp',
          provider: e.provider,
          email_address: e.default_sender_email,
          display_label: e.default_sender_email,
          can_receive: false,
        })
      }
    }
  }

  return addresses
}

/**
 * Resolve which email provider + from address to use for a given purpose.
 * Checks configured routing first, then falls back to defaults.
 */
export async function getProviderForPurpose(
  knex: Knex,
  orgId: string,
  purpose: EmailPurpose,
  actingUserId: string | null = null,
): Promise<ResolvedProvider | null> {
  const resolved = await resolveProviderForPurpose(knex, orgId, purpose, actingUserId)
  if (!resolved) return null
  // Callers use `connection` / `espConnection` for credentials, so the sealed
  // columns have to be opened here rather than at every send site.
  if (resolved.connection) {
    resolved.connection = (await openSecretsOnRow(
      null,
      resolved.connection.tenant_id,
      resolved.connection,
      EMAIL_CONNECTION_SECRETS,
    )) as Record<string, any>
  }
  if (resolved.espConnection) {
    resolved.espConnection = (await openSecretsOnRow(
      null,
      resolved.espConnection.tenant_id,
      resolved.espConnection,
      ESP_CONNECTION_SECRETS,
    )) as Record<string, any>
  }
  return resolved
}

/**
 * Customer-facing refusal used everywhere Noli would otherwise send on a
 * customer's behalf without their own sending setup (2026-09-24 decision:
 * never fall back to anything else; block and ask them to connect one).
 */
export const EMAIL_NOT_CONNECTED_CODE = 'email_not_connected'
export const EMAIL_NOT_CONNECTED_MESSAGE =
  'Connect an email account in Settings before sending; nothing will be sent until then.'

/**
 * Refusal when the org has mailboxes, but none the send may use: the acting
 * user has no mailbox of their own and nothing is designated for the org.
 */
export const OWN_MAILBOX_REQUIRED_MESSAGE =
  'Connect your own email account in Settings, or ask an admin to set a shared sending account.'

export type SenderMailboxResolution =
  | { connection: Record<string, any>; via: 'own' | 'designated' | 'support' | 'sole_owner' }
  | { connection: null; reason: 'no_mailbox' | 'no_own_mailbox' }

/**
 * Which connected mailbox (Gmail / Outlook / SMTP) a send may go out from.
 * Mail never leaves from a teammate's personal address (2026-09-24):
 *
 * 1. An acting user (someone clicked send / approve) sends from their OWN
 *    active mailbox.
 * 2. Otherwise only a mailbox the org explicitly designated: an email_routing
 *    row for the purpose (Settings > Email routing) or, when allowed, the
 *    dedicated Customer Service mailbox (purpose 'customer_service'), which is
 *    shared by design. `is_primary` is NOT a designation: it is set per user
 *    automatically on each user's first mailbox.
 * 3. A system send (no acting user: sequences, automations, crons) in an org
 *    whose active mailboxes all belong to ONE person uses that person's
 *    mailbox: it is the org's own sender, not a teammate's.
 * 4. Anything else is refused (OWN_MAILBOX_REQUIRED_MESSAGE when mailboxes
 *    exist, EMAIL_NOT_CONNECTED_MESSAGE when none do). ESPs are org-level and
 *    are handled by the purpose routing before this is reached.
 *
 * Reads rows only; never opens sealed credentials.
 */
export async function resolveSenderMailbox(
  knex: Knex,
  orgId: string,
  actingUserId: string | null | undefined,
  options: { routingPurpose?: EmailPurpose; allowSupportMailbox?: boolean } = {},
): Promise<SenderMailboxResolution> {
  if (actingUserId) {
    const mine: Array<Record<string, any>> = await knex('email_connections')
      .where('organization_id', orgId)
      .where('user_id', actingUserId)
      .where('is_active', true)
      .orderBy('is_primary', 'desc')
      .select('*')
    // Personal mailbox (purpose null) before a support mailbox the user set up.
    const own = mine.find((c) => c.purpose == null) ?? mine[0]
    if (own) return { connection: own, via: 'own' }
  }

  if (options.routingPurpose) {
    const routing = await knex('email_routing')
      .where('organization_id', orgId)
      .where('purpose', options.routingPurpose)
      .where('provider_type', 'connection')
      .first()
    if (routing) {
      const conn = await knex('email_connections')
        .where('id', routing.provider_id)
        .where('organization_id', orgId)
        .where('is_active', true)
        .first()
      if (conn) return { connection: conn, via: 'designated' }
    }
  }

  if (options.allowSupportMailbox) {
    const support = await knex('email_connections')
      .where('organization_id', orgId)
      .where('purpose', 'customer_service')
      .where('is_active', true)
      .first()
    if (support) return { connection: support, via: 'support' }
  }

  const active: Array<Record<string, any>> = await knex('email_connections')
    .where('organization_id', orgId)
    .where('is_active', true)
    .orderBy('is_primary', 'desc')
    .select('*')
  if (active.length === 0) return { connection: null, reason: 'no_mailbox' }

  if (!actingUserId) {
    const owners = new Set(active.map((c) => c.user_id ?? null))
    if (owners.size === 1) {
      // Prefer the personal mailbox over a support mailbox.
      const personal = active.find((c) => c.purpose == null) ?? active[0]
      return { connection: personal, via: 'sole_owner' }
    }
  }
  return { connection: null, reason: 'no_own_mailbox' }
}

/** The customer-facing refusal for a failed resolveSenderMailbox. */
export function senderMailboxRefusal(reason: 'no_mailbox' | 'no_own_mailbox'): string {
  return reason === 'no_own_mailbox' ? OWN_MAILBOX_REQUIRED_MESSAGE : EMAIL_NOT_CONNECTED_MESSAGE
}

/**
 * True when the org has its own sending setup for this purpose (a connected
 * mailbox or an ESP with a usable from address): exactly the condition under
 * which sendEmailByPurpose can pick a provider. Reads rows only; never opens
 * sealed credentials and never sends.
 */
export async function hasSendingSetup(
  knex: Knex,
  orgId: string,
  purpose: EmailPurpose,
  actingUserId: string | null = null,
): Promise<boolean> {
  return (await resolveProviderForPurpose(knex, orgId, purpose, actingUserId)) !== null
}

/**
 * A from address that belongs to the customer's own ESP setup (its default
 * sender, else noreply@ its verified sending domain), or null. Direct-ESP
 * senders use this instead of falling back to Noli's EMAIL_FROM; null means
 * do not send.
 */
export function espOwnFromAddress(esp: Record<string, any> | null | undefined): string | null {
  if (!esp) return null
  const own = typeof esp.default_sender_email === 'string' ? esp.default_sender_email.trim() : ''
  if (own && own.includes('@')) return own
  const domain = typeof esp.sending_domain === 'string' ? esp.sending_domain.trim() : ''
  return domain ? `noreply@${domain}` : null
}

/**
 * The from address a purpose-routed send will use, or null when the org has
 * no sending setup. Reads rows only (no sealed credentials opened).
 */
export async function resolveSenderAddress(
  knex: Knex,
  orgId: string,
  purpose: EmailPurpose,
  actingUserId: string | null = null,
): Promise<string | null> {
  return (await resolveProviderForPurpose(knex, orgId, purpose, actingUserId))?.fromAddress ?? null
}

async function resolveProviderForPurpose(
  knex: Knex,
  orgId: string,
  purpose: EmailPurpose,
  actingUserId: string | null = null,
): Promise<ResolvedProvider | null> {
  // 1. Check configured routing
  const routing = await knex('email_routing')
    .where('organization_id', orgId)
    .where('purpose', purpose)
    .first()

  if (routing) {
    if (routing.provider_type === 'connection') {
      const conn = await knex('email_connections').where('id', routing.provider_id).where('is_active', true).first()
      if (conn) {
        return {
          type: 'connection',
          provider: conn.provider,
          fromName: routing.from_name || null,
          fromAddress: conn.email_address,
          connection: conn,
        }
      }
    } else if (routing.provider_type === 'esp') {
      // provider_id could be an esp_sender_addresses ID or an esp_connections ID
      const senderAddr = await knex('esp_sender_addresses').where('id', routing.provider_id).first()
      if (senderAddr) {
        const espConn = await knex('esp_connections').where('id', senderAddr.esp_connection_id).where('is_active', true).first()
        if (espConn) {
          return {
            type: 'esp',
            provider: espConn.provider,
            fromName: routing.from_name || senderAddr.sender_name || null,
            fromAddress: routing.from_address || senderAddr.sender_email,
            espConnection: espConn,
          }
        }
      }
      // Fallback: maybe it's a direct esp_connections ID (legacy)
      const esp = await knex('esp_connections').where('id', routing.provider_id).where('is_active', true).first()
      if (esp) {
        const fromAddr = routing.from_address || esp.default_sender_email
        if (fromAddr) {
          return {
            type: 'esp',
            provider: esp.provider,
            fromName: routing.from_name || esp.default_sender_name || null,
            fromAddress: fromAddr,
            espConnection: esp,
          }
        }
      }
    }
    // Configured provider is inactive or missing — fall through to defaults
  }

  // 2. For inbox, must be a receivable connection (no ESP fallback)
  // Mailbox fallbacks follow resolveSenderMailbox: the acting user's own
  // mailbox, or (system sends) the org's only mailbox owner. Never the first
  // mailbox of whichever teammate happens to sort first.
  if (purpose === 'inbox') {
    const picked = await resolveSenderMailbox(knex, orgId, actingUserId)
    const conn = picked.connection
    if (conn) {
      return { type: 'connection', provider: conn.provider, fromName: null, fromAddress: conn.email_address, connection: conn }
    }
    return null
  }

  // Look up what's available
  const esp = await knex('esp_connections')
    .where('organization_id', orgId).where('is_active', true).first()

  // Check for default sender address from the new table
  const defaultSender = await knex('esp_sender_addresses')
    .where('organization_id', orgId).where('is_default', true).first()

  // Usable from address: sender addresses table → esp default → the ESP's own
  // sending domain. Never Noli's EMAIL_FROM (2026-09-24): a customer's ESP with
  // no from address of the customer's own is not a sending setup, so the org
  // counts as not connected (hasSendingSetup false, sends refused).
  const espFromAddr = defaultSender?.sender_email
    || esp?.default_sender_email
    || (esp?.sending_domain ? `noreply@${esp.sending_domain}` : null)
  const espFromName = defaultSender?.sender_name || esp?.default_sender_name || null

  // 3. ESP with a valid from address — best option for bulk/transactional
  if (esp && espFromAddr) {
    return { type: 'esp', provider: esp.provider, fromName: espFromName, fromAddress: espFromAddr, espConnection: esp }
  }

  // 4. A mailbox this send may use (see resolveSenderMailbox)
  const conn = (await resolveSenderMailbox(knex, orgId, actingUserId)).connection
  if (conn) {
    return { type: 'connection', provider: conn.provider, fromName: null, fromAddress: conn.email_address, connection: conn }
  }

  // 5. Nothing configured
  return null
}
