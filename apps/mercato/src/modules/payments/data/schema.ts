/**
 * Payments module ORM entities — invoices, products, payment records, stripe connections.
 * Phase 3C of the ORM conversion.
 */
import { Entity, Property, PrimaryKey, Index, Unique } from '@mikro-orm/core'
import { v4 as uuid } from 'uuid'

@Entity({ tableName: 'invoices' })
export class Invoice {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()
  @Property({ name: 'tenant_id', type: 'uuid' }) tenantId!: string
  @Property({ name: 'organization_id', type: 'uuid' }) organizationId!: string
  @Property({ name: 'invoice_number', type: 'text' }) invoiceNumber!: string
  @Property({ name: 'contact_id', type: 'uuid', nullable: true }) contactId?: string | null
  @Property({ name: 'deal_id', type: 'uuid', nullable: true }) dealId?: string | null
  @Property({ type: 'text', default: 'draft' }) status: string = 'draft'
  @Property({ name: 'line_items', type: 'jsonb', default: '[]' }) lineItems: unknown[] = []
  @Property({ type: 'numeric(10,2)', default: '0' }) subtotal: string = '0'
  @Property({ type: 'numeric(10,2)', default: '0' }) tax: string = '0'
  @Property({ type: 'numeric(10,2)', default: '0' }) total: string = '0'
  @Property({ type: 'text', default: 'USD' }) currency: string = 'USD'
  @Property({ name: 'due_date', type: 'timestamptz', nullable: true }) dueDate?: Date | null
  @Property({ type: 'text', nullable: true }) notes?: string | null
  @Property({ name: 'stripe_payment_link', type: 'text', nullable: true }) stripePaymentLink?: string | null
  @Property({ name: 'stripe_invoice_id', type: 'text', nullable: true }) stripeInvoiceId?: string | null
  @Property({ name: 'sent_at', type: 'timestamptz', nullable: true }) sentAt?: Date | null
  @Property({ name: 'paid_at', type: 'timestamptz', nullable: true }) paidAt?: Date | null
  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' }) createdAt: Date = new Date()
  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() }) updatedAt: Date = new Date()
  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true }) deletedAt?: Date | null
}

@Entity({ tableName: 'products' })
export class Product {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()
  @Property({ name: 'tenant_id', type: 'uuid' }) tenantId!: string
  @Property({ name: 'organization_id', type: 'uuid' }) organizationId!: string
  @Property({ type: 'text' }) name!: string
  @Property({ type: 'text', nullable: true }) description?: string | null
  @Property({ type: 'numeric(10,2)' }) price!: string
  @Property({ type: 'text', default: 'USD' }) currency: string = 'USD'
  @Property({ name: 'billing_type', type: 'text', default: 'one_time' }) billingType: string = 'one_time'
  @Property({ name: 'recurring_interval', type: 'text', nullable: true }) recurringInterval?: string | null
  @Property({ name: 'stripe_price_id', type: 'text', nullable: true }) stripePriceId?: string | null
  @Property({ name: 'stripe_product_id', type: 'text', nullable: true }) stripeProductId?: string | null
  @Property({ name: 'trial_days', type: 'integer', nullable: true }) trialDays?: number | null
  @Property({ name: 'terms_url', type: 'text', nullable: true }) termsUrl?: string | null
  @Property({ name: 'requires_shipping', type: 'boolean', default: false }) requiresShipping: boolean = false
  @Property({ name: 'collect_phone', type: 'boolean', default: false }) collectPhone: boolean = false
  @Property({ name: 'product_type', type: 'text', nullable: true }) productType?: string | null
  @Property({ name: 'course_ids', type: 'jsonb', nullable: true }) courseIds?: unknown[] | null
  @Property({ name: 'is_active', type: 'boolean', default: true }) isActive: boolean = true
  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' }) createdAt: Date = new Date()
  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() }) updatedAt: Date = new Date()
  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true }) deletedAt?: Date | null
}

@Entity({ tableName: 'payment_records' })
@Index({ name: 'payment_records_org_idx', properties: ['organizationId', 'createdAt'] })
export class PaymentRecord {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()
  @Property({ name: 'tenant_id', type: 'uuid' }) tenantId!: string
  @Property({ name: 'organization_id', type: 'uuid' }) organizationId!: string
  @Property({ name: 'invoice_id', type: 'uuid', nullable: true }) invoiceId?: string | null
  @Property({ name: 'contact_id', type: 'uuid', nullable: true }) contactId?: string | null
  @Property({ type: 'numeric(10,2)' }) amount!: string
  @Property({ type: 'text', default: 'USD' }) currency: string = 'USD'
  @Property({ type: 'text', default: 'pending' }) status: string = 'pending'
  @Property({ name: 'stripe_payment_intent_id', type: 'text', nullable: true }) stripePaymentIntentId?: string | null
  @Property({ name: 'stripe_checkout_session_id', type: 'text', nullable: true }) stripeCheckoutSessionId?: string | null
  @Property({ name: 'stripe_subscription_id', type: 'text', nullable: true }) stripeSubscriptionId?: string | null
  @Property({ name: 'refunded_amount', type: 'numeric(10,2)', nullable: true }) refundedAmount?: string | null
  @Property({ type: 'jsonb', nullable: true }) metadata?: Record<string, unknown> | null
  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' }) createdAt: Date = new Date()
}

@Entity({ tableName: 'stripe_connections' })
@Unique({ name: 'stripe_conn_org_idx', properties: ['organizationId'] })
export class StripeConnection {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()
  @Property({ name: 'tenant_id', type: 'uuid' }) tenantId!: string
  @Property({ name: 'organization_id', type: 'uuid' }) organizationId!: string
  @Property({ name: 'stripe_account_id', type: 'text' }) stripeAccountId!: string
  @Property({ name: 'access_token', type: 'text', nullable: true }) accessToken?: string | null
  @Property({ name: 'refresh_token', type: 'text', nullable: true }) refreshToken?: string | null
  @Property({ name: 'business_name', type: 'text', nullable: true }) businessName?: string | null
  @Property({ name: 'is_active', type: 'boolean', default: true }) isActive: boolean = true
  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' }) createdAt: Date = new Date()
  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() }) updatedAt: Date = new Date()
}
