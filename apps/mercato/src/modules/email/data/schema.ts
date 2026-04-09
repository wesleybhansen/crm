import { Entity, Property, PrimaryKey, Index } from '@mikro-orm/core'
import { v4 as uuid } from 'uuid'

@Entity({ tableName: 'email_accounts' })
export class EmailAccount {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'email_address', type: 'text' })
  emailAddress!: string

  @Property({ name: 'display_name', type: 'text', nullable: true })
  displayName?: string | null

  @Property({ type: 'text', default: 'resend' })
  provider: 'resend' | 'smtp' = 'resend'

  @Property({ type: 'jsonb', nullable: true })
  config?: Record<string, any> | null

  @Property({ name: 'is_default', type: 'boolean', default: true })
  isDefault: boolean = true

  @Property({ name: 'sending_domain', type: 'text', nullable: true })
  sendingDomain?: string | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

@Entity({ tableName: 'email_messages' })
@Index({ properties: ['organizationId', 'contactId'], name: 'email_messages_org_contact_idx' })
@Index({ properties: ['trackingId'], name: 'email_messages_tracking_idx' })
export class EmailMessage {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'account_id', type: 'uuid', nullable: true })
  accountId?: string | null

  @Property({ type: 'text' })
  direction!: 'inbound' | 'outbound'

  @Property({ name: 'from_address', type: 'text' })
  fromAddress!: string

  @Property({ name: 'to_address', type: 'text' })
  toAddress!: string

  @Property({ type: 'text', nullable: true })
  cc?: string | null

  @Property({ type: 'text', nullable: true })
  bcc?: string | null

  @Property({ type: 'text' })
  subject!: string

  @Property({ name: 'body_html', type: 'text' })
  bodyHtml!: string

  @Property({ name: 'body_text', type: 'text', nullable: true })
  bodyText?: string | null

  @Property({ name: 'thread_id', type: 'text', nullable: true })
  threadId?: string | null

  @Property({ name: 'contact_id', type: 'uuid', nullable: true })
  contactId?: string | null

  @Property({ name: 'deal_id', type: 'uuid', nullable: true })
  dealId?: string | null

  @Property({ name: 'campaign_id', type: 'uuid', nullable: true })
  campaignId?: string | null

  @Property({ type: 'text', default: 'draft' })
  status: 'draft' | 'queued' | 'sent' | 'delivered' | 'opened' | 'clicked' | 'bounced' | 'failed' = 'draft'

  @Property({ name: 'tracking_id', type: 'uuid' })
  trackingId: string = uuid()

  @Property({ name: 'opened_at', type: 'timestamptz', nullable: true })
  openedAt?: Date | null

  @Property({ name: 'clicked_at', type: 'timestamptz', nullable: true })
  clickedAt?: Date | null

  @Property({ name: 'bounced_at', type: 'timestamptz', nullable: true })
  bouncedAt?: Date | null

  @Property({ type: 'jsonb', nullable: true })
  metadata?: Record<string, any> | null

  @Property({ type: 'text', nullable: true })
  sentiment?: string | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'sent_at', type: 'timestamptz', nullable: true })
  sentAt?: Date | null

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'email_templates' })
export class EmailTemplate {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ type: 'text' })
  name!: string

  @Property({ type: 'text' })
  subject!: string

  @Property({ name: 'body_html', type: 'text' })
  bodyHtml!: string

  @Property({ type: 'text', default: 'transactional' })
  category: 'transactional' | 'marketing' | 'sequence' = 'transactional'

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'email_campaigns' })
export class EmailCampaign {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ type: 'text' })
  name!: string

  @Property({ name: 'template_id', type: 'uuid', nullable: true })
  templateId?: string | null

  @Property({ type: 'text', nullable: true })
  subject?: string | null

  @Property({ name: 'body_html', type: 'text', nullable: true })
  bodyHtml?: string | null

  @Property({ type: 'text', default: 'draft' })
  status: 'draft' | 'scheduled' | 'sending' | 'sent' | 'cancelled' = 'draft'

  @Property({ name: 'segment_filter', type: 'jsonb', nullable: true })
  segmentFilter?: Record<string, any> | null

  @Property({ type: 'text', nullable: true })
  category?: string | null

  @Property({ name: 'scheduled_at', type: 'timestamptz', nullable: true })
  scheduledAt?: Date | null

  @Property({ name: 'scheduled_for', type: 'timestamptz', nullable: true })
  scheduledFor?: Date | null

  @Property({ type: 'jsonb', default: '{}' })
  stats: Record<string, any> = {}

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', nullable: true, onUpdate: () => new Date() })
  updatedAt?: Date | null

  @Property({ name: 'sent_at', type: 'timestamptz', nullable: true })
  sentAt?: Date | null

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'email_campaign_recipients' })
@Index({ properties: ['campaignId', 'contactId'], name: 'email_campaign_recipients_idx' })
export class EmailCampaignRecipient {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  // SPEC-061 tier 1: tenant_id and organization_id added for multi-tenant
  // safety. Previously inherited only via the parent campaign — high risk
  // of cross-tenant data leak. The migration backfills these from
  // email_campaigns on the (currently empty) prod table; new rows must
  // populate them at insert time.
  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'campaign_id', type: 'uuid' })
  campaignId!: string

  @Property({ name: 'contact_id', type: 'uuid' })
  contactId!: string

  @Property({ type: 'text' })
  email!: string

  @Property({ type: 'text', default: 'pending' })
  status: 'pending' | 'sent' | 'delivered' | 'opened' | 'clicked' | 'bounced' | 'unsubscribed' = 'pending'

  @Property({ name: 'sent_at', type: 'timestamptz', nullable: true })
  sentAt?: Date | null

  @Property({ name: 'opened_at', type: 'timestamptz', nullable: true })
  openedAt?: Date | null

  @Property({ name: 'clicked_at', type: 'timestamptz', nullable: true })
  clickedAt?: Date | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'email_unsubscribes' })
@Index({ properties: ['organizationId', 'email'], name: 'email_unsubscribes_org_email_idx' })
export class EmailUnsubscribe {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ type: 'text' })
  email!: string

  @Property({ name: 'contact_id', type: 'uuid', nullable: true })
  contactId?: string | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()
}

// ---------------------------------------------------------------------------
// Tier 1 entities (SPEC-061 mercato rebuild) — promoted from raw-knex routes.
// All previously lived as hand-maintained tables in setup-tables.sql and were
// queried via raw `apps/mercato/src/app/api/email/**` route handlers. Now
// ORM-managed under the email module so they get tenant scoping, audit logs,
// the query index, AI/Scout visibility, and the rest of the mercato platform
// contract.
//
// Schema additions (where the entity does NOT match setup-tables.sql exactly):
//   - email_messages: + sentiment, + updated_at, + deleted_at
//   - email_campaigns: + category, + scheduled_for, + updated_at (existing
//     column the entity didn't know about), + deleted_at (already on entity)
//   - email_campaign_recipients: + tenant_id, + organization_id (multi-tenant
//     safety fix), + created_at, + updated_at, + deleted_at
//   - email_list_members: + tenant_id, + organization_id, + created_at,
//     + updated_at, + deleted_at (multi-tenant safety fix)
//   - email_preferences: + tenant_id (multi-tenant safety fix), + created_at,
//     + deleted_at
//   - email_preference_categories: + updated_at, + deleted_at
//   - email_style_templates: + deleted_at
//   - email_connections: + deleted_at
//   - esp_connections: + deleted_at
//   - esp_sender_addresses: + updated_at, + deleted_at
//   - email_lists: + deleted_at
//   - email_routing: + deleted_at
//   - email_intelligence_settings: brought under ORM management; the lazy
//     ENSURE_TABLE block in /api/email-intelligence/settings/route.ts can
//     be deleted in cutover Chunk C
//
// Cross-module note: many entities have plain `contact_id: uuid` (not
// @ManyToOne) for the same reason as tier 0 — avoiding eager-loading
// concerns in the CRUD factory. The DB still enforces FK relationships
// at the schema level.
// ---------------------------------------------------------------------------

@Entity({ tableName: 'email_preference_categories' })
@Index({ properties: ['organizationId', 'slug'], name: 'pref_cat_org_slug_idx' })
export class EmailPreferenceCategory {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ type: 'text' })
  name!: string

  @Property({ type: 'text' })
  slug!: string

  @Property({ type: 'text', nullable: true })
  description?: string | null

  @Property({ name: 'is_default', type: 'boolean', default: false })
  isDefault: boolean = false

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'email_preferences' })
@Index({ properties: ['contactId', 'organizationId', 'categorySlug'], name: 'email_pref_contact_cat_idx' })
export class EmailPreference {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  // tier 1 multi-tenant safety fix — previously only had organization_id
  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'contact_id', type: 'uuid' })
  contactId!: string

  @Property({ name: 'category_slug', type: 'text' })
  categorySlug!: string

  @Property({ name: 'opted_in', type: 'boolean', default: true })
  optedIn: boolean = true

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'email_style_templates' })
@Index({ properties: ['organizationId', 'category'], name: 'email_templates_org_idx' })
export class EmailStyleTemplate {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ type: 'text' })
  name!: string

  @Property({ type: 'text', default: 'general' })
  category: string = 'general'

  @Property({ name: 'html_template', type: 'text' })
  htmlTemplate!: string

  @Property({ name: 'thumbnail_url', type: 'text', nullable: true })
  thumbnailUrl?: string | null

  @Property({ name: 'is_default', type: 'boolean', default: false })
  isDefault: boolean = false

  @Property({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy?: string | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'email_connections' })
@Index({ properties: ['organizationId', 'userId', 'provider'], name: 'email_conn_org_user_provider_idx' })
export class EmailConnection {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'user_id', type: 'uuid' })
  userId!: string

  @Property({ type: 'text' })
  provider!: string

  @Property({ name: 'email_address', type: 'text' })
  emailAddress!: string

  // OAuth credentials (Gmail, Outlook)
  @Property({ name: 'access_token', type: 'text', nullable: true })
  accessToken?: string | null

  @Property({ name: 'refresh_token', type: 'text', nullable: true })
  refreshToken?: string | null

  @Property({ name: 'token_expiry', type: 'timestamptz', nullable: true })
  tokenExpiry?: Date | null

  // SMTP credentials (alternative to OAuth)
  @Property({ name: 'smtp_host', type: 'text', nullable: true })
  smtpHost?: string | null

  @Property({ name: 'smtp_port', type: 'int', nullable: true })
  smtpPort?: number | null

  @Property({ name: 'smtp_user', type: 'text', nullable: true })
  smtpUser?: string | null

  @Property({ name: 'smtp_pass', type: 'text', nullable: true })
  smtpPass?: string | null

  @Property({ name: 'is_primary', type: 'boolean', default: false })
  isPrimary: boolean = false

  @Property({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean = true

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'esp_connections' })
@Index({ properties: ['organizationId', 'provider'], name: 'esp_conn_org_provider_idx' })
export class EspConnection {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ type: 'text' })
  provider!: string

  // KNOWN SECURITY GAP: api_key is stored as plaintext. Encryption-at-rest
  // is deferred to a security hardening sprint per SPEC-061 tier 1
  // Decision 4. When that sprint runs, change this column to use
  // findWithDecryption / findOneWithDecryption.
  @Property({ name: 'api_key', type: 'text' })
  apiKey!: string

  @Property({ name: 'sending_domain', type: 'text', nullable: true })
  sendingDomain?: string | null

  @Property({ name: 'default_sender_email', type: 'text', nullable: true })
  defaultSenderEmail?: string | null

  @Property({ name: 'default_sender_name', type: 'text', nullable: true })
  defaultSenderName?: string | null

  @Property({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean = true

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'esp_sender_addresses' })
@Index({ properties: ['organizationId', 'senderEmail'], name: 'esp_sender_addr_org_email_idx' })
export class EspSenderAddress {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'esp_connection_id', type: 'uuid' })
  espConnectionId!: string

  @Property({ name: 'sender_name', type: 'text', nullable: true })
  senderName?: string | null

  @Property({ name: 'sender_email', type: 'text' })
  senderEmail!: string

  @Property({ name: 'is_default', type: 'boolean', default: false })
  isDefault: boolean = false

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'email_lists' })
@Index({ properties: ['organizationId'], name: 'email_lists_org_idx' })
export class EmailList {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ type: 'text' })
  name!: string

  @Property({ type: 'text', nullable: true })
  description?: string | null

  // 'manual' or trigger types: form_submitted, product_purchased,
  // tag_added, booking_created, invoice_paid
  @Property({ name: 'source_type', type: 'text', default: 'manual' })
  sourceType: string = 'manual'

  @Property({ name: 'source_id', type: 'uuid', nullable: true })
  sourceId?: string | null

  @Property({ name: 'member_count', type: 'int', default: 0 })
  memberCount: number = 0

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', nullable: true, onUpdate: () => new Date() })
  updatedAt?: Date | null

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'email_list_members' })
@Index({ properties: ['listId'], name: 'email_list_members_list_idx' })
export class EmailListMember {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  // tier 1 multi-tenant safety fix — previously inherited only via parent list
  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'list_id', type: 'uuid' })
  listId!: string

  @Property({ name: 'contact_id', type: 'uuid' })
  contactId!: string

  @Property({ name: 'added_at', type: 'timestamptz', defaultRaw: 'now()' })
  addedAt: Date = new Date()

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'email_routing' })
@Index({ properties: ['organizationId', 'purpose'], name: 'email_routing_org_purpose_idx' })
export class EmailRouting {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  // Purpose: inbox | invoices | marketing | automations | transactional
  @Property({ type: 'text' })
  purpose!: string

  // Polymorphic discriminator: 'connection' (→ email_connections) or 'esp' (→ esp_sender_addresses)
  @Property({ name: 'provider_type', type: 'text' })
  providerType!: string

  @Property({ name: 'provider_id', type: 'uuid' })
  providerId!: string

  @Property({ name: 'from_name', type: 'text', nullable: true })
  fromName?: string | null

  @Property({ name: 'from_address', type: 'text', nullable: true })
  fromAddress?: string | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'email_intelligence_settings' })
export class EmailIntelligenceSettings {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'user_id', type: 'uuid' })
  userId!: string

  @Property({ name: 'is_enabled', type: 'boolean', default: false })
  isEnabled: boolean = false

  @Property({ name: 'auto_create_contacts', type: 'boolean', default: true })
  autoCreateContacts: boolean = true

  @Property({ name: 'auto_update_timeline', type: 'boolean', default: true })
  autoUpdateTimeline: boolean = true

  @Property({ name: 'auto_update_engagement', type: 'boolean', default: true })
  autoUpdateEngagement: boolean = true

  @Property({ name: 'auto_advance_stage', type: 'boolean', default: true })
  autoAdvanceStage: boolean = true

  @Property({ name: 'last_gmail_history_id', type: 'text', nullable: true })
  lastGmailHistoryId?: string | null

  @Property({ name: 'last_outlook_delta_link', type: 'text', nullable: true })
  lastOutlookDeltaLink?: string | null

  @Property({ name: 'last_sync_at', type: 'timestamptz', nullable: true })
  lastSyncAt?: Date | null

  @Property({ name: 'last_sync_status', type: 'text', nullable: true })
  lastSyncStatus?: string | null

  @Property({ name: 'last_sync_error', type: 'text', nullable: true })
  lastSyncError?: string | null

  @Property({ name: 'emails_processed_total', type: 'int', default: 0 })
  emailsProcessedTotal: number = 0

  @Property({ name: 'contacts_created_total', type: 'int', default: 0 })
  contactsCreatedTotal: number = 0

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}
