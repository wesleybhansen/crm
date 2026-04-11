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
