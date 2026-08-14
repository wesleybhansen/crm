import { Entity, Property, PrimaryKey, Index } from '@mikro-orm/core'
import { randomUUID as uuid } from 'node:crypto'

@Entity({ tableName: 'credit_balances' })
@Index({ properties: ['organizationId'], name: 'credit_balances_org_idx' })
export class CreditBalance {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid', unique: true })
  organizationId!: string

  @Property({ type: 'numeric(10,4)', default: '0' })
  balance: string = '0'

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

@Entity({ tableName: 'credit_transactions' })
@Index({ properties: ['organizationId', 'createdAt'], name: 'credit_transactions_org_date_idx' })
export class CreditTransaction {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ type: 'numeric(10,4)' })
  amount!: string

  @Property({ type: 'text' })
  type!: 'purchase' | 'usage' | 'adjustment' | 'refund'

  @Property({ type: 'text' })
  description!: string

  @Property({ type: 'text', nullable: true })
  service?: 'email' | 'sms' | 'phone' | 'ai' | null

  @Property({ name: 'reference_id', type: 'text', nullable: true })
  referenceId?: string | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()
}

@Entity({ tableName: 'credit_packages' })
export class CreditPackage {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ type: 'text' })
  name!: string

  @Property({ name: 'credit_amount', type: 'numeric(10,4)' })
  creditAmount!: string

  @Property({ type: 'numeric(10,2)' })
  price!: string

  @Property({ name: 'stripe_price_id', type: 'text', nullable: true })
  stripePriceId?: string | null

  @Property({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean = true

  @Property({ name: 'sort_order', type: 'integer', default: 0 })
  sortOrder: number = 0

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()
}
