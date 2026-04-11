/**
 * App-level entity definitions for tables used by the customers module extension.
 * These supplement the core entities in packages/core/src/modules/customers/data/entities.ts.
 *
 * Phase 2 of the ORM conversion — adding entities for tables that were
 * previously only accessed via raw knex.
 */
import { Entity, Property, PrimaryKey, Index, Unique } from '@mikro-orm/core'
import { v4 as uuid } from 'uuid'

// ===========================================================================
// Surveys
// ===========================================================================

@Entity({ tableName: 'surveys' })
@Unique({ name: 'surveys_org_slug_idx', properties: ['organizationId', 'slug'] })
export class Survey {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ type: 'text' })
  title!: string

  @Property({ type: 'text', nullable: true })
  description?: string | null

  @Property({ type: 'text' })
  slug!: string

  @Property({ type: 'jsonb', default: '[]' })
  fields: unknown[] = []

  @Property({ name: 'thank_you_message', type: 'text', nullable: true, default: 'Thank you for your response!' })
  thankYouMessage?: string | null

  @Property({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean = true

  @Property({ name: 'response_count', type: 'integer', default: 0 })
  responseCount: number = 0

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

@Entity({ tableName: 'survey_responses' })
@Index({ name: 'survey_responses_survey_idx', properties: ['surveyId', 'createdAt'] })
export class SurveyResponse {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'survey_id', type: 'uuid' })
  surveyId!: string

  @Property({ name: 'contact_id', type: 'uuid', nullable: true })
  contactId?: string | null

  @Property({ name: 'respondent_email', type: 'text', nullable: true })
  respondentEmail?: string | null

  @Property({ name: 'respondent_name', type: 'text', nullable: true })
  respondentName?: string | null

  @Property({ type: 'jsonb', default: '{}' })
  responses: Record<string, unknown> = {}

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()
}

// ===========================================================================
// Affiliates
// ===========================================================================

@Entity({ tableName: 'affiliate_campaigns' })
@Index({ name: 'affiliate_campaigns_org_idx', properties: ['organizationId', 'status'] })
export class AffiliateCampaign {
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

  @Property({ name: 'product_ids', type: 'jsonb', default: '[]' })
  productIds: unknown[] = []

  @Property({ name: 'commission_rate', type: 'numeric(10,2)', default: '10.00' })
  commissionRate: string = '10.00'

  @Property({ name: 'commission_type', type: 'text', default: 'percentage' })
  commissionType: string = 'percentage'

  @Property({ name: 'customer_discount', type: 'numeric(10,2)', nullable: true, default: '0' })
  customerDiscount?: string | null

  @Property({ name: 'customer_discount_type', type: 'text', nullable: true, default: 'percentage' })
  customerDiscountType?: string | null

  @Property({ name: 'cookie_duration_days', type: 'integer', default: 30 })
  cookieDurationDays: number = 30

  @Property({ name: 'auto_approve', type: 'boolean', default: false })
  autoApprove: boolean = false

  @Property({ name: 'stripe_coupon_id', type: 'text', nullable: true })
  stripeCouponId?: string | null

  @Property({ name: 'signup_page_enabled', type: 'boolean', default: true })
  signupPageEnabled: boolean = true

  @Property({ type: 'text', default: 'active' })
  status: string = 'active'

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

@Entity({ tableName: 'affiliates' })
@Unique({ name: 'affiliates_org_code_idx', properties: ['organizationId', 'affiliateCode'] })
@Index({ name: 'affiliates_org_idx', properties: ['organizationId', 'status'] })
export class Affiliate {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'contact_id', type: 'uuid', nullable: true })
  contactId?: string | null

  @Property({ type: 'text' })
  name!: string

  @Property({ type: 'text' })
  email!: string

  @Property({ name: 'affiliate_code', type: 'text' })
  affiliateCode!: string

  @Property({ name: 'commission_rate', type: 'numeric(10,2)', default: '10.00' })
  commissionRate: string = '10.00'

  @Property({ name: 'commission_type', type: 'text', default: 'percentage' })
  commissionType: string = 'percentage'

  @Property({ name: 'campaign_id', type: 'uuid', nullable: true })
  campaignId?: string | null

  @Property({ name: 'stripe_promo_code_id', type: 'text', nullable: true })
  stripePromoCodeId?: string | null

  @Property({ name: 'stripe_promo_code', type: 'text', nullable: true })
  stripePromoCode?: string | null

  @Property({ type: 'text', nullable: true })
  website?: string | null

  @Property({ name: 'promotion_method', type: 'text', nullable: true })
  promotionMethod?: string | null

  @Property({ type: 'text', default: 'active' })
  status: string = 'active'

  @Property({ name: 'approved_at', type: 'timestamptz', nullable: true })
  approvedAt?: Date | null

  @Property({ name: 'total_referrals', type: 'integer', default: 0 })
  totalReferrals: number = 0

  @Property({ name: 'total_conversions', type: 'integer', default: 0 })
  totalConversions: number = 0

  @Property({ name: 'total_earned', type: 'numeric(10,2)', default: '0' })
  totalEarned: string = '0'

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

@Entity({ tableName: 'affiliate_referrals' })
@Index({ name: 'referrals_affiliate_idx', properties: ['affiliateId', 'referredAt'] })
export class AffiliateReferral {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'affiliate_id', type: 'uuid' })
  affiliateId!: string

  @Property({ name: 'referred_contact_id', type: 'uuid', nullable: true })
  referredContactId?: string | null

  @Property({ name: 'referred_email', type: 'text', nullable: true })
  referredEmail?: string | null

  @Property({ name: 'referral_source', type: 'text', nullable: true })
  referralSource?: string | null

  @Property({ type: 'boolean', default: false })
  converted: boolean = false

  @Property({ name: 'conversion_value', type: 'numeric(10,2)', nullable: true })
  conversionValue?: string | null

  @Property({ name: 'commission_amount', type: 'numeric(10,2)', nullable: true })
  commissionAmount?: string | null

  @Property({ name: 'campaign_id', type: 'uuid', nullable: true })
  campaignId?: string | null

  @Property({ name: 'stripe_session_id', type: 'text', nullable: true })
  stripeSessionId?: string | null

  @Property({ name: 'stripe_payment_intent_id', type: 'text', nullable: true })
  stripePaymentIntentId?: string | null

  @Property({ name: 'referred_at', type: 'timestamptz', defaultRaw: 'now()' })
  referredAt: Date = new Date()

  @Property({ name: 'converted_at', type: 'timestamptz', nullable: true })
  convertedAt?: Date | null
}

@Entity({ tableName: 'affiliate_payouts' })
@Index({ name: 'payouts_affiliate_idx', properties: ['affiliateId', 'createdAt'] })
export class AffiliatePayout {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'affiliate_id', type: 'uuid' })
  affiliateId!: string

  @Property({ type: 'numeric(10,2)' })
  amount!: string

  @Property({ name: 'period_start', type: 'timestamptz' })
  periodStart!: Date

  @Property({ name: 'period_end', type: 'timestamptz' })
  periodEnd!: Date

  @Property({ type: 'text', default: 'pending' })
  status: string = 'pending'

  @Property({ name: 'paid_at', type: 'timestamptz', nullable: true })
  paidAt?: Date | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()
}

// ===========================================================================
// Inbox
// ===========================================================================

@Entity({ tableName: 'inbox_conversations' })
@Index({ name: 'inbox_conv_org_status_idx', properties: ['organizationId', 'status', 'lastMessageAt'] })
export class InboxConversation {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'contact_id', type: 'uuid', nullable: true })
  contactId?: string | null

  @Property({ name: 'chat_conversation_id', type: 'uuid', nullable: true })
  chatConversationId?: string | null

  @Property({ type: 'text', default: 'open' })
  status: string = 'open'

  @Property({ name: 'unread_count', type: 'integer', default: 0 })
  unreadCount: number = 0

  @Property({ name: 'last_message_at', type: 'timestamptz', nullable: true })
  lastMessageAt?: Date | null

  @Property({ name: 'last_message_channel', type: 'text', nullable: true })
  lastMessageChannel?: string | null

  @Property({ name: 'last_message_preview', type: 'text', nullable: true })
  lastMessagePreview?: string | null

  @Property({ name: 'last_message_direction', type: 'text', nullable: true })
  lastMessageDirection?: string | null

  @Property({ name: 'display_name', type: 'text', nullable: true })
  displayName?: string | null

  @Property({ name: 'avatar_email', type: 'text', nullable: true })
  avatarEmail?: string | null

  @Property({ name: 'avatar_phone', type: 'text', nullable: true })
  avatarPhone?: string | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

@Entity({ tableName: 'inbox_notes' })
@Index({ name: 'inbox_notes_conv_idx', properties: ['inboxConversationId', 'createdAt'] })
export class InboxNote {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'inbox_conversation_id', type: 'uuid' })
  inboxConversationId!: string

  @Property({ name: 'user_id', type: 'uuid' })
  userId!: string

  @Property({ name: 'user_name', type: 'text', nullable: true })
  userName?: string | null

  @Property({ type: 'text' })
  content!: string

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()
}

@Entity({ tableName: 'inbox_ai_settings' })
@Unique({ name: 'inbox_ai_settings_organization_id_key', properties: ['organizationId'] })
export class InboxAiSettings {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ type: 'boolean', default: false })
  enabled: boolean = false

  @Property({ name: 'knowledge_base', type: 'text', nullable: true })
  knowledgeBase?: string | null

  @Property({ type: 'text', nullable: true, default: 'professional' })
  tone?: string | null

  @Property({ type: 'text', nullable: true })
  instructions?: string | null

  @Property({ name: 'business_name', type: 'text', nullable: true })
  businessName?: string | null

  @Property({ name: 'business_description', type: 'text', nullable: true })
  businessDescription?: string | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

// ===========================================================================
// Chat
// ===========================================================================

@Entity({ tableName: 'chat_widgets' })
@Unique({ name: 'chat_widgets_org_slug_idx', properties: ['organizationId', 'slug'] })
export class ChatWidget {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ type: 'text' })
  name!: string

  @Property({ name: 'greeting_message', type: 'text', nullable: true })
  greetingMessage?: string | null

  @Property({ type: 'jsonb', default: '{}' })
  config: Record<string, unknown> = {}

  @Property({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean = true

  @Property({ type: 'text', nullable: true })
  slug?: string | null

  @Property({ type: 'text', nullable: true })
  description?: string | null

  @Property({ name: 'brand_color', type: 'text', nullable: true })
  brandColor?: string | null

  @Property({ name: 'welcome_message', type: 'text', nullable: true })
  welcomeMessage?: string | null

  @Property({ name: 'business_name', type: 'text', nullable: true })
  businessName?: string | null

  @Property({ name: 'public_page_enabled', type: 'boolean', default: true })
  publicPageEnabled: boolean = true

  @Property({ name: 'bot_enabled', type: 'boolean', default: false })
  botEnabled: boolean = false

  @Property({ name: 'bot_knowledge_base', type: 'text', nullable: true })
  botKnowledgeBase?: string | null

  @Property({ name: 'bot_personality', type: 'text', nullable: true })
  botPersonality?: string | null

  @Property({ name: 'bot_instructions', type: 'text', nullable: true })
  botInstructions?: string | null

  @Property({ name: 'bot_guardrails', type: 'text', nullable: true })
  botGuardrails?: string | null

  @Property({ name: 'bot_handoff_message', type: 'text', nullable: true })
  botHandoffMessage?: string | null

  @Property({ name: 'bot_max_responses', type: 'integer', nullable: true })
  botMaxResponses?: number | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

@Entity({ tableName: 'chat_conversations' })
@Index({ name: 'chat_conv_org_idx', properties: ['organizationId', 'status', 'updatedAt'] })
export class ChatConversation {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'widget_id', type: 'uuid' })
  widgetId!: string

  @Property({ name: 'contact_id', type: 'uuid', nullable: true })
  contactId?: string | null

  @Property({ name: 'visitor_name', type: 'text', nullable: true })
  visitorName?: string | null

  @Property({ name: 'visitor_email', type: 'text', nullable: true })
  visitorEmail?: string | null

  @Property({ type: 'text', default: 'open' })
  status: string = 'open'

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

@Entity({ tableName: 'chat_messages' })
@Index({ name: 'chat_msg_conv_idx', properties: ['conversationId', 'createdAt'] })
export class ChatMessage {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'conversation_id', type: 'uuid' })
  conversationId!: string

  @Property({ name: 'sender_type', type: 'text', default: 'visitor' })
  senderType: string = 'visitor'

  @Property({ type: 'text' })
  message!: string

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()
}

// ===========================================================================
// Response Templates
// ===========================================================================

@Entity({ tableName: 'response_templates' })
@Index({ name: 'response_templates_org_idx', properties: ['organizationId', 'category'] })
export class ResponseTemplate {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ type: 'text' })
  name!: string

  @Property({ type: 'text', nullable: true })
  subject?: string | null

  @Property({ name: 'body_text', type: 'text' })
  bodyText!: string

  @Property({ type: 'text', default: 'general' })
  category: string = 'general'

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

// ===========================================================================
// Webhooks
// ===========================================================================

@Entity({ tableName: 'webhook_subscriptions' })
@Index({ name: 'webhook_subs_org_idx', properties: ['organizationId', 'event'] })
export class WebhookSubscription {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ type: 'text' })
  event!: string

  @Property({ name: 'target_url', type: 'text' })
  targetUrl!: string

  @Property({ type: 'text', nullable: true })
  secret?: string | null

  @Property({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean = true

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

@Entity({ tableName: 'webhook_deliveries' })
@Index({ name: 'webhook_deliveries_sub_idx', properties: ['subscriptionId', 'createdAt'] })
export class WebhookDelivery {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'subscription_id', type: 'uuid' })
  subscriptionId!: string

  @Property({ type: 'text' })
  event!: string

  @Property({ type: 'jsonb' })
  payload!: Record<string, unknown>

  @Property({ name: 'status_code', type: 'integer', nullable: true })
  statusCode?: number | null

  @Property({ name: 'response_body', type: 'text', nullable: true })
  responseBody?: string | null

  @Property({ type: 'integer', default: 1 })
  attempt: number = 1

  @Property({ name: 'delivered_at', type: 'timestamptz', nullable: true })
  deliveredAt?: Date | null

  @Property({ name: 'failed_at', type: 'timestamptz', nullable: true })
  failedAt?: Date | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()
}
