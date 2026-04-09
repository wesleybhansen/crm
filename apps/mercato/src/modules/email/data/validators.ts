/**
 * Tier 1 zod validators for the email module (SPEC-061 mercato rebuild).
 *
 * Pattern reference: packages/core/src/modules/customers/data/validators.ts
 * (the canonical tier 0 example).
 *
 * Each entity that has a CRUD-shaped UI gets create/update/delete schemas.
 * Append-only entities (EmailMessage, EmailCampaignRecipient, EmailUnsubscribe)
 * are mostly created by system code (send pipeline, webhook) and have
 * narrower schemas focused on the actual mutation surface.
 */

import { z } from 'zod'

const uuid = () => z.string().uuid()

const scopedSchema = z.object({
  organizationId: uuid(),
  tenantId: uuid(),
})

// ===========================================================================
// EmailAccount (existing entity, gets validators in tier 1)
// ===========================================================================

export const emailAccountCreateSchema = scopedSchema.extend({
  emailAddress: z.string().trim().email().max(320),
  displayName: z.string().trim().max(200).optional().nullable(),
  provider: z.enum(['resend', 'smtp']).optional(),
  config: z.record(z.unknown()).optional().nullable(),
  isDefault: z.boolean().optional(),
  sendingDomain: z.string().trim().max(253).optional().nullable(),
})

export const emailAccountUpdateSchema = z.object({
  id: uuid(),
  organizationId: uuid(),
  tenantId: uuid(),
  emailAddress: z.string().trim().email().max(320).optional(),
  displayName: z.string().trim().max(200).optional().nullable(),
  provider: z.enum(['resend', 'smtp']).optional(),
  config: z.record(z.unknown()).optional().nullable(),
  isDefault: z.boolean().optional(),
  sendingDomain: z.string().trim().max(253).optional().nullable(),
})

export const emailAccountDeleteSchema = z.object({
  id: uuid(),
  organizationId: uuid(),
  tenantId: uuid(),
})

export type EmailAccountCreateInput = z.infer<typeof emailAccountCreateSchema>
export type EmailAccountUpdateInput = z.infer<typeof emailAccountUpdateSchema>
export type EmailAccountDeleteInput = z.infer<typeof emailAccountDeleteSchema>

// ===========================================================================
// EmailMessage (existing entity — mostly system-created via send pipeline,
// but the API does have create + update for drafts and status updates)
// ===========================================================================

export const emailMessageStatusEnum = z.enum([
  'draft', 'queued', 'sent', 'delivered', 'opened', 'clicked', 'bounced', 'failed',
])

export const emailMessageCreateSchema = scopedSchema.extend({
  accountId: uuid().optional().nullable(),
  direction: z.enum(['inbound', 'outbound']),
  fromAddress: z.string().trim().email().max(320),
  toAddress: z.string().trim().max(2000),  // can be a comma-separated list
  cc: z.string().trim().max(2000).optional().nullable(),
  bcc: z.string().trim().max(2000).optional().nullable(),
  subject: z.string().trim().max(998),  // RFC 2822 max line length
  bodyHtml: z.string().max(10_000_000),  // 10 MB cap
  bodyText: z.string().max(10_000_000).optional().nullable(),
  threadId: z.string().trim().max(500).optional().nullable(),
  contactId: uuid().optional().nullable(),
  dealId: uuid().optional().nullable(),
  campaignId: uuid().optional().nullable(),
  status: emailMessageStatusEnum.optional(),
  metadata: z.record(z.unknown()).optional().nullable(),
  sentiment: z.string().trim().max(50).optional().nullable(),
})

export const emailMessageUpdateSchema = z.object({
  id: uuid(),
  organizationId: uuid(),
  tenantId: uuid(),
  status: emailMessageStatusEnum.optional(),
  openedAt: z.coerce.date().optional().nullable(),
  clickedAt: z.coerce.date().optional().nullable(),
  bouncedAt: z.coerce.date().optional().nullable(),
  sentAt: z.coerce.date().optional().nullable(),
  sentiment: z.string().trim().max(50).optional().nullable(),
  metadata: z.record(z.unknown()).optional().nullable(),
})

export const emailMessageDeleteSchema = z.object({
  id: uuid(),
  organizationId: uuid(),
  tenantId: uuid(),
})

export type EmailMessageCreateInput = z.infer<typeof emailMessageCreateSchema>
export type EmailMessageUpdateInput = z.infer<typeof emailMessageUpdateSchema>
export type EmailMessageDeleteInput = z.infer<typeof emailMessageDeleteSchema>

// ===========================================================================
// EmailTemplate (existing entity)
// ===========================================================================

export const emailTemplateCategoryEnum = z.enum(['transactional', 'marketing', 'sequence'])

export const emailTemplateCreateSchema = scopedSchema.extend({
  name: z.string().trim().min(1).max(200),
  subject: z.string().trim().min(1).max(998),
  bodyHtml: z.string().min(1).max(10_000_000),
  category: emailTemplateCategoryEnum.optional(),
})

export const emailTemplateUpdateSchema = z.object({
  id: uuid(),
  organizationId: uuid(),
  tenantId: uuid(),
  name: z.string().trim().min(1).max(200).optional(),
  subject: z.string().trim().min(1).max(998).optional(),
  bodyHtml: z.string().min(1).max(10_000_000).optional(),
  category: emailTemplateCategoryEnum.optional(),
})

export const emailTemplateDeleteSchema = z.object({
  id: uuid(),
  organizationId: uuid(),
  tenantId: uuid(),
})

export type EmailTemplateCreateInput = z.infer<typeof emailTemplateCreateSchema>
export type EmailTemplateUpdateInput = z.infer<typeof emailTemplateUpdateSchema>
export type EmailTemplateDeleteInput = z.infer<typeof emailTemplateDeleteSchema>

// ===========================================================================
// EmailCampaign (existing entity)
// ===========================================================================

export const emailCampaignStatusEnum = z.enum(['draft', 'scheduled', 'sending', 'sent', 'cancelled'])

export const emailCampaignSegmentFilterSchema = z.object({
  type: z.enum(['list', 'tag', 'all', 'custom']),
  listId: uuid().optional(),
  tag: z.string().trim().max(100).optional(),
  custom: z.record(z.unknown()).optional(),
}).passthrough()

export const emailCampaignCreateSchema = scopedSchema.extend({
  name: z.string().trim().min(1).max(200),
  templateId: uuid().optional().nullable(),
  subject: z.string().trim().max(998).optional().nullable(),
  bodyHtml: z.string().max(10_000_000).optional().nullable(),
  status: emailCampaignStatusEnum.optional(),
  segmentFilter: emailCampaignSegmentFilterSchema.optional().nullable(),
  category: z.string().trim().max(100).optional().nullable(),
  scheduledAt: z.coerce.date().optional().nullable(),
  scheduledFor: z.coerce.date().optional().nullable(),
})

export const emailCampaignUpdateSchema = z.object({
  id: uuid(),
  organizationId: uuid(),
  tenantId: uuid(),
  name: z.string().trim().min(1).max(200).optional(),
  templateId: uuid().optional().nullable(),
  subject: z.string().trim().max(998).optional().nullable(),
  bodyHtml: z.string().max(10_000_000).optional().nullable(),
  status: emailCampaignStatusEnum.optional(),
  segmentFilter: emailCampaignSegmentFilterSchema.optional().nullable(),
  category: z.string().trim().max(100).optional().nullable(),
  scheduledAt: z.coerce.date().optional().nullable(),
  scheduledFor: z.coerce.date().optional().nullable(),
  stats: z.record(z.unknown()).optional(),
  sentAt: z.coerce.date().optional().nullable(),
})

export const emailCampaignDeleteSchema = z.object({
  id: uuid(),
  organizationId: uuid(),
  tenantId: uuid(),
})

export type EmailCampaignCreateInput = z.infer<typeof emailCampaignCreateSchema>
export type EmailCampaignUpdateInput = z.infer<typeof emailCampaignUpdateSchema>
export type EmailCampaignDeleteInput = z.infer<typeof emailCampaignDeleteSchema>

// ===========================================================================
// EmailCampaignRecipient (now with tenant_id, organization_id per Decision 1)
// Mostly system-created during campaign send. Update is webhook-driven.
// ===========================================================================

export const emailCampaignRecipientStatusEnum = z.enum([
  'pending', 'sent', 'delivered', 'opened', 'clicked', 'bounced', 'unsubscribed',
])

export const emailCampaignRecipientCreateSchema = scopedSchema.extend({
  campaignId: uuid(),
  contactId: uuid(),
  email: z.string().trim().email().max(320),
  status: emailCampaignRecipientStatusEnum.optional(),
})

export const emailCampaignRecipientUpdateSchema = z.object({
  id: uuid(),
  organizationId: uuid(),
  tenantId: uuid(),
  status: emailCampaignRecipientStatusEnum.optional(),
  sentAt: z.coerce.date().optional().nullable(),
  openedAt: z.coerce.date().optional().nullable(),
  clickedAt: z.coerce.date().optional().nullable(),
})

export type EmailCampaignRecipientCreateInput = z.infer<typeof emailCampaignRecipientCreateSchema>
export type EmailCampaignRecipientUpdateInput = z.infer<typeof emailCampaignRecipientUpdateSchema>

// ===========================================================================
// EmailUnsubscribe (existing — webhook-managed, narrow create-only schema)
// ===========================================================================

export const emailUnsubscribeCreateSchema = scopedSchema.extend({
  email: z.string().trim().email().max(320),
  contactId: uuid().optional().nullable(),
})

export type EmailUnsubscribeCreateInput = z.infer<typeof emailUnsubscribeCreateSchema>

// ===========================================================================
// EmailPreferenceCategory
// ===========================================================================

export const emailPreferenceCategoryCreateSchema = scopedSchema.extend({
  name: z.string().trim().min(1).max(200),
  slug: z.string().trim().min(1).max(100).regex(/^[a-z0-9_-]+$/, 'slug must be lowercase alphanumeric with - or _'),
  description: z.string().trim().max(2000).optional().nullable(),
  isDefault: z.boolean().optional(),
})

export const emailPreferenceCategoryUpdateSchema = z.object({
  id: uuid(),
  organizationId: uuid(),
  tenantId: uuid(),
  name: z.string().trim().min(1).max(200).optional(),
  slug: z.string().trim().min(1).max(100).regex(/^[a-z0-9_-]+$/).optional(),
  description: z.string().trim().max(2000).optional().nullable(),
  isDefault: z.boolean().optional(),
})

export const emailPreferenceCategoryDeleteSchema = z.object({
  id: uuid(),
  organizationId: uuid(),
  tenantId: uuid(),
})

export type EmailPreferenceCategoryCreateInput = z.infer<typeof emailPreferenceCategoryCreateSchema>
export type EmailPreferenceCategoryUpdateInput = z.infer<typeof emailPreferenceCategoryUpdateSchema>
export type EmailPreferenceCategoryDeleteInput = z.infer<typeof emailPreferenceCategoryDeleteSchema>

// ===========================================================================
// EmailPreference (per-contact opt-in/out — upsert pattern)
// ===========================================================================

export const emailPreferenceUpsertSchema = scopedSchema.extend({
  contactId: uuid(),
  categorySlug: z.string().trim().min(1).max(100),
  optedIn: z.boolean(),
})

export const emailPreferenceDeleteSchema = z.object({
  id: uuid(),
  organizationId: uuid(),
  tenantId: uuid(),
})

export type EmailPreferenceUpsertInput = z.infer<typeof emailPreferenceUpsertSchema>
export type EmailPreferenceDeleteInput = z.infer<typeof emailPreferenceDeleteSchema>

// ===========================================================================
// EmailStyleTemplate
// ===========================================================================

export const emailStyleTemplateCreateSchema = scopedSchema.extend({
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(100).optional(),
  htmlTemplate: z.string().min(1).max(10_000_000),
  thumbnailUrl: z.string().trim().url().max(2000).optional().nullable(),
  isDefault: z.boolean().optional(),
  createdBy: uuid().optional().nullable(),
})

export const emailStyleTemplateUpdateSchema = z.object({
  id: uuid(),
  organizationId: uuid(),
  tenantId: uuid(),
  name: z.string().trim().min(1).max(200).optional(),
  category: z.string().trim().min(1).max(100).optional(),
  htmlTemplate: z.string().min(1).max(10_000_000).optional(),
  thumbnailUrl: z.string().trim().url().max(2000).optional().nullable(),
  isDefault: z.boolean().optional(),
})

export const emailStyleTemplateDeleteSchema = z.object({
  id: uuid(),
  organizationId: uuid(),
  tenantId: uuid(),
})

export type EmailStyleTemplateCreateInput = z.infer<typeof emailStyleTemplateCreateSchema>
export type EmailStyleTemplateUpdateInput = z.infer<typeof emailStyleTemplateUpdateSchema>
export type EmailStyleTemplateDeleteInput = z.infer<typeof emailStyleTemplateDeleteSchema>

// ===========================================================================
// EmailConnection (per-user Gmail/Outlook OAuth or SMTP credentials)
// ===========================================================================

export const emailConnectionProviderEnum = z.enum(['gmail', 'outlook', 'smtp', 'imap'])

export const emailConnectionCreateSchema = scopedSchema.extend({
  userId: uuid(),
  provider: emailConnectionProviderEnum,
  emailAddress: z.string().trim().email().max(320),
  // OAuth fields
  accessToken: z.string().max(10_000).optional().nullable(),
  refreshToken: z.string().max(10_000).optional().nullable(),
  tokenExpiry: z.coerce.date().optional().nullable(),
  // SMTP fields
  smtpHost: z.string().trim().max(253).optional().nullable(),
  smtpPort: z.number().int().min(1).max(65_535).optional().nullable(),
  smtpUser: z.string().trim().max(320).optional().nullable(),
  smtpPass: z.string().max(1000).optional().nullable(),
  isPrimary: z.boolean().optional(),
  isActive: z.boolean().optional(),
})

export const emailConnectionUpdateSchema = z.object({
  id: uuid(),
  organizationId: uuid(),
  tenantId: uuid(),
  accessToken: z.string().max(10_000).optional().nullable(),
  refreshToken: z.string().max(10_000).optional().nullable(),
  tokenExpiry: z.coerce.date().optional().nullable(),
  smtpHost: z.string().trim().max(253).optional().nullable(),
  smtpPort: z.number().int().min(1).max(65_535).optional().nullable(),
  smtpUser: z.string().trim().max(320).optional().nullable(),
  smtpPass: z.string().max(1000).optional().nullable(),
  isPrimary: z.boolean().optional(),
  isActive: z.boolean().optional(),
})

export const emailConnectionDeleteSchema = z.object({
  id: uuid(),
  organizationId: uuid(),
  tenantId: uuid(),
})

export type EmailConnectionCreateInput = z.infer<typeof emailConnectionCreateSchema>
export type EmailConnectionUpdateInput = z.infer<typeof emailConnectionUpdateSchema>
export type EmailConnectionDeleteInput = z.infer<typeof emailConnectionDeleteSchema>

// ===========================================================================
// EspConnection (org-wide bulk ESP — Resend/SendGrid/SES/Mailgun)
// ===========================================================================

export const espProviderEnum = z.enum(['resend', 'sendgrid', 'ses', 'mailgun'])

export const espConnectionUpsertSchema = scopedSchema.extend({
  provider: espProviderEnum,
  apiKey: z.string().min(1).max(1000),
  sendingDomain: z.string().trim().max(253).optional().nullable(),
  defaultSenderEmail: z.string().trim().email().max(320).optional().nullable(),
  defaultSenderName: z.string().trim().max(200).optional().nullable(),
  isActive: z.boolean().optional(),
})

export const espConnectionDeleteSchema = z.object({
  id: uuid(),
  organizationId: uuid(),
  tenantId: uuid(),
})

export type EspConnectionUpsertInput = z.infer<typeof espConnectionUpsertSchema>
export type EspConnectionDeleteInput = z.infer<typeof espConnectionDeleteSchema>

// ===========================================================================
// EspSenderAddress
// ===========================================================================

export const espSenderAddressCreateSchema = scopedSchema.extend({
  espConnectionId: uuid(),
  senderEmail: z.string().trim().email().max(320),
  senderName: z.string().trim().max(200).optional().nullable(),
  isDefault: z.boolean().optional(),
})

export const espSenderAddressUpdateSchema = z.object({
  id: uuid(),
  organizationId: uuid(),
  tenantId: uuid(),
  senderName: z.string().trim().max(200).optional().nullable(),
  isDefault: z.boolean().optional(),
})

export const espSenderAddressDeleteSchema = z.object({
  id: uuid(),
  organizationId: uuid(),
  tenantId: uuid(),
})

export type EspSenderAddressCreateInput = z.infer<typeof espSenderAddressCreateSchema>
export type EspSenderAddressUpdateInput = z.infer<typeof espSenderAddressUpdateSchema>
export type EspSenderAddressDeleteInput = z.infer<typeof espSenderAddressDeleteSchema>

// ===========================================================================
// EmailList
// ===========================================================================

export const emailListSourceTypeEnum = z.enum([
  'manual',
  'form_submitted',
  'product_purchased',
  'tag_added',
  'booking_created',
  'invoice_paid',
])

export const emailListCreateSchema = scopedSchema.extend({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional().nullable(),
  sourceType: emailListSourceTypeEnum.optional(),
  sourceId: uuid().optional().nullable(),
})

export const emailListUpdateSchema = z.object({
  id: uuid(),
  organizationId: uuid(),
  tenantId: uuid(),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).optional().nullable(),
  sourceType: emailListSourceTypeEnum.optional(),
  sourceId: uuid().optional().nullable(),
})

export const emailListDeleteSchema = z.object({
  id: uuid(),
  organizationId: uuid(),
  tenantId: uuid(),
})

export type EmailListCreateInput = z.infer<typeof emailListCreateSchema>
export type EmailListUpdateInput = z.infer<typeof emailListUpdateSchema>
export type EmailListDeleteInput = z.infer<typeof emailListDeleteSchema>

// ===========================================================================
// EmailListMember (now with tenant_id, organization_id per Decision 1)
// ===========================================================================

export const emailListMemberCreateSchema = scopedSchema.extend({
  listId: uuid(),
  contactId: uuid(),
})

export const emailListMemberDeleteSchema = z.object({
  id: uuid(),
  organizationId: uuid(),
  tenantId: uuid(),
})

export type EmailListMemberCreateInput = z.infer<typeof emailListMemberCreateSchema>
export type EmailListMemberDeleteInput = z.infer<typeof emailListMemberDeleteSchema>

// ===========================================================================
// EmailRouting (polymorphic provider_type discriminator)
// ===========================================================================

export const emailRoutingPurposeEnum = z.enum([
  'inbox', 'invoices', 'marketing', 'automations', 'transactional',
])

export const emailRoutingProviderTypeEnum = z.enum(['connection', 'esp'])

export const emailRoutingUpsertSchema = scopedSchema.extend({
  purpose: emailRoutingPurposeEnum,
  providerType: emailRoutingProviderTypeEnum,
  providerId: uuid(),
  fromName: z.string().trim().max(200).optional().nullable(),
  fromAddress: z.string().trim().email().max(320).optional().nullable(),
})

export const emailRoutingDeleteSchema = z.object({
  id: uuid(),
  organizationId: uuid(),
  tenantId: uuid(),
})

export type EmailRoutingUpsertInput = z.infer<typeof emailRoutingUpsertSchema>
export type EmailRoutingDeleteInput = z.infer<typeof emailRoutingDeleteSchema>

// ===========================================================================
// EmailIntelligenceSettings (per-user Gmail/Outlook sync settings)
// 1:1 per (organization, user) — upsert pattern, no create/delete
// ===========================================================================

export const emailIntelligenceSettingsUpsertSchema = scopedSchema.extend({
  userId: uuid(),
  isEnabled: z.boolean().optional(),
  autoCreateContacts: z.boolean().optional(),
  autoUpdateTimeline: z.boolean().optional(),
  autoUpdateEngagement: z.boolean().optional(),
  autoAdvanceStage: z.boolean().optional(),
  lastGmailHistoryId: z.string().trim().max(500).optional().nullable(),
  lastOutlookDeltaLink: z.string().trim().max(2000).optional().nullable(),
  lastSyncAt: z.coerce.date().optional().nullable(),
  lastSyncStatus: z.string().trim().max(100).optional().nullable(),
  lastSyncError: z.string().trim().max(2000).optional().nullable(),
  emailsProcessedTotal: z.number().int().min(0).optional(),
  contactsCreatedTotal: z.number().int().min(0).optional(),
})

export type EmailIntelligenceSettingsUpsertInput = z.infer<typeof emailIntelligenceSettingsUpsertSchema>
