import { Entity, Property, PrimaryKey, ManyToOne, OneToMany, Collection, Index } from '@mikro-orm/core'
import { v4 as uuid } from 'uuid'

@Entity({ tableName: 'landing_pages' })
@Index({ properties: ['organizationId', 'slug'], name: 'landing_pages_org_slug_idx' })
export class LandingPage {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ type: 'text', length: 200 })
  title!: string

  @Property({ type: 'text', length: 200 })
  slug!: string

  @Property({ name: 'template_id', type: 'text', length: 100, nullable: true })
  templateId?: string | null

  @Property({ name: 'template_category', type: 'text', length: 50, nullable: true })
  templateCategory?: string | null

  @Property({ type: 'text', default: 'draft' })
  status: 'draft' | 'published' | 'archived' = 'draft'

  @Property({ type: 'jsonb', nullable: true })
  config?: Record<string, any> | null

  @Property({ name: 'custom_domain', type: 'text', nullable: true })
  customDomain?: string | null

  @Property({ name: 'published_html', type: 'text', nullable: true, lazy: true })
  publishedHtml?: string | null

  @Property({ name: 'owner_user_id', type: 'uuid', nullable: true })
  ownerUserId?: string | null

  @Property({ name: 'view_count', type: 'integer', default: 0 })
  viewCount: number = 0

  @Property({ name: 'submission_count', type: 'integer', default: 0 })
  submissionCount: number = 0

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt?: Date | null

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null

  @OneToMany(() => LandingPageForm, (form) => form.landingPage)
  forms = new Collection<LandingPageForm>(this)
}

@Entity({ tableName: 'landing_page_forms' })
export class LandingPageForm {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @ManyToOne(() => LandingPage, { type: 'uuid', fieldName: 'landing_page_id' })
  landingPage!: LandingPage

  @Property({ name: 'landing_page_id', type: 'uuid', persist: false })
  landingPageId!: string

  @Property({ type: 'text', length: 100, default: 'default' })
  name: string = 'default'

  @Property({ type: 'jsonb', default: '[]' })
  fields: Array<{
    name: string
    type: 'text' | 'email' | 'phone' | 'textarea' | 'select' | 'checkbox'
    label: string
    required: boolean
    placeholder?: string
    options?: string[]
  }> = []

  @Property({ name: 'redirect_url', type: 'text', nullable: true })
  redirectUrl?: string | null

  @Property({ name: 'notification_email', type: 'text', nullable: true })
  notificationEmail?: string | null

  @Property({ name: 'success_message', type: 'text', nullable: true })
  successMessage?: string | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

@Entity({ tableName: 'form_submissions' })
@Index({ properties: ['organizationId', 'landingPageId'], name: 'form_submissions_org_page_idx' })
export class FormSubmission {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'form_id', type: 'uuid' })
  formId!: string

  @Property({ name: 'landing_page_id', type: 'uuid' })
  landingPageId!: string

  @Property({ type: 'jsonb' })
  data!: Record<string, any>

  @Property({ name: 'contact_id', type: 'uuid', nullable: true })
  contactId?: string | null

  @Property({ name: 'source_ip', type: 'text', nullable: true })
  sourceIp?: string | null

  @Property({ name: 'user_agent', type: 'text', nullable: true })
  userAgent?: string | null

  @Property({ type: 'text', nullable: true })
  referrer?: string | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()
}

// ===========================================================================
// Funnels (Phase 4B of ORM conversion)
// ===========================================================================

@Entity({ tableName: 'funnels' })
export class Funnel {
  @PrimaryKey({ type: 'uuid' }) id: string = uuid()
  @Property({ name: 'tenant_id', type: 'uuid' }) tenantId!: string
  @Property({ name: 'organization_id', type: 'uuid' }) organizationId!: string
  @Property({ type: 'text' }) name!: string
  @Property({ type: 'text' }) slug!: string
  @Property({ name: 'is_published', type: 'boolean', default: false }) isPublished: boolean = false
  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' }) createdAt: Date = new Date()
  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() }) updatedAt: Date = new Date()
}

@Entity({ tableName: 'funnel_steps' })
export class FunnelStep {
  @PrimaryKey({ type: 'uuid' }) id: string = uuid()
  @Property({ name: 'funnel_id', type: 'uuid' }) funnelId!: string
  @Property({ name: 'step_order', type: 'integer' }) stepOrder!: number
  @Property({ name: 'step_type', type: 'text' }) stepType!: string
  @Property({ name: 'page_id', type: 'uuid', nullable: true }) pageId?: string | null
  @Property({ type: 'jsonb', default: '{}' }) config: Record<string, unknown> = {}
  @Property({ type: 'text', nullable: true }) name?: string | null
  @Property({ name: 'product_id', type: 'uuid', nullable: true }) productId?: string | null
  @Property({ name: 'on_accept_step_id', type: 'uuid', nullable: true }) onAcceptStepId?: string | null
  @Property({ name: 'on_decline_step_id', type: 'uuid', nullable: true }) onDeclineStepId?: string | null
  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' }) createdAt: Date = new Date()
}

@Entity({ tableName: 'funnel_visits' })
export class FunnelVisit {
  @PrimaryKey({ type: 'uuid' }) id: string = uuid()
  @Property({ name: 'funnel_id', type: 'uuid' }) funnelId!: string
  @Property({ name: 'step_id', type: 'uuid' }) stepId!: string
  @Property({ name: 'contact_id', type: 'uuid', nullable: true }) contactId?: string | null
  @Property({ name: 'visitor_id', type: 'text', nullable: true }) visitorId?: string | null
  @Property({ name: 'session_id', type: 'text', nullable: true }) sessionId?: string | null
  @Property({ type: 'text', nullable: true }) action?: string | null
  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' }) createdAt: Date = new Date()
}

@Entity({ tableName: 'funnel_sessions' })
export class FunnelSession {
  @PrimaryKey({ type: 'uuid' }) id: string = uuid()
  @Property({ name: 'funnel_id', type: 'uuid' }) funnelId!: string
  @Property({ name: 'organization_id', type: 'uuid' }) organizationId!: string
  @Property({ name: 'visitor_id', type: 'text' }) visitorId!: string
  @Property({ name: 'contact_id', type: 'uuid', nullable: true }) contactId?: string | null
  @Property({ type: 'text', nullable: true }) email?: string | null
  @Property({ name: 'stripe_customer_id', type: 'text', nullable: true }) stripeCustomerId?: string | null
  @Property({ name: 'stripe_payment_method_id', type: 'text', nullable: true }) stripePaymentMethodId?: string | null
  @Property({ name: 'current_step_id', type: 'uuid', nullable: true }) currentStepId?: string | null
  @Property({ type: 'text' }) status!: string
  @Property({ name: 'total_revenue', type: 'numeric', nullable: true }) totalRevenue?: string | null
  @Property({ name: 'started_at', type: 'timestamptz', defaultRaw: 'now()' }) startedAt: Date = new Date()
  @Property({ name: 'completed_at', type: 'timestamptz', nullable: true }) completedAt?: Date | null
  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() }) updatedAt: Date = new Date()
}

@Entity({ tableName: 'funnel_orders' })
export class FunnelOrder {
  @PrimaryKey({ type: 'uuid' }) id: string = uuid()
  @Property({ name: 'session_id', type: 'uuid' }) sessionId!: string
  @Property({ name: 'funnel_id', type: 'uuid' }) funnelId!: string
  @Property({ name: 'step_id', type: 'uuid' }) stepId!: string
  @Property({ name: 'product_id', type: 'uuid', nullable: true }) productId?: string | null
  @Property({ type: 'numeric' }) amount!: string
  @Property({ type: 'text' }) currency!: string
  @Property({ name: 'order_type', type: 'text' }) orderType!: string
  @Property({ name: 'stripe_payment_intent_id', type: 'text', nullable: true }) stripePaymentIntentId?: string | null
  @Property({ name: 'stripe_checkout_session_id', type: 'text', nullable: true }) stripeCheckoutSessionId?: string | null
  @Property({ type: 'text' }) status!: string
  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' }) createdAt: Date = new Date()
}
