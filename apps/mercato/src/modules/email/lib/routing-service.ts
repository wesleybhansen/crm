/**
 * Email Routing Service
 * Virtual layer over email_connections + esp_connections tables.
 * Resolves which provider + from address to use for each email purpose.
 */

import type { Knex } from 'knex'

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
  if (purpose === 'inbox') {
    const conn = await knex('email_connections')
      .where('organization_id', orgId).where('is_active', true)
      .orderBy('is_primary', 'desc').first()
    if (conn) {
      return { type: 'connection', provider: conn.provider, fromName: null, fromAddress: conn.email_address, connection: conn }
    }
    return null
  }

  // Look up what's available
  const esp = await knex('esp_connections')
    .where('organization_id', orgId).where('is_active', true).first()
  const conn = await knex('email_connections')
    .where('organization_id', orgId).where('is_active', true)
    .orderBy('is_primary', 'desc').first()

  // Check for default sender address from the new table
  const defaultSender = await knex('esp_sender_addresses')
    .where('organization_id', orgId).where('is_default', true).first()

  // Determine usable from address: sender addresses table → esp default → domain-based → env
  const envFrom = process.env.EMAIL_FROM
  const hasValidEnvFrom = envFrom && !envFrom.includes('localhost') && envFrom.includes('@')
  const espFromAddr = defaultSender?.sender_email
    || esp?.default_sender_email
    || (esp?.sending_domain ? `noreply@${esp.sending_domain}` : null)
    || (hasValidEnvFrom ? envFrom : null)
  const espFromName = defaultSender?.sender_name || esp?.default_sender_name || null

  // 3. ESP with a valid from address — best option for bulk/transactional
  if (esp && espFromAddr) {
    return { type: 'esp', provider: esp.provider, fromName: espFromName, fromAddress: espFromAddr, espConnection: esp }
  }

  // 4. Connected email — always has a real from address
  if (conn) {
    return { type: 'connection', provider: conn.provider, fromName: null, fromAddress: conn.email_address, connection: conn }
  }

  // 5. Nothing configured
  return null
}
