import { Entity, PrimaryKey, Property, Index, OptionalProps } from '@mikro-orm/core'

/**
 * Mirrors the existing `webhook_subscriptions` table byte-for-byte.
 * One subscription subscribes to ONE event. Users create multiple
 * subscription rows if they want to listen to multiple events.
 */
@Entity({ tableName: 'webhook_subscriptions' })
@Index({ name: 'webhook_subs_org_idx', properties: ['organizationId', 'event'] })
export class WebhookSubscription {
  [OptionalProps]?: 'isActive' | 'createdAt' | 'updatedAt' | 'secret'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

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

/**
 * Mirrors the existing `webhook_deliveries` table byte-for-byte.
 * One row per attempt; `delivered_at` OR `failed_at` is set (never both).
 */
@Entity({ tableName: 'webhook_deliveries' })
@Index({ name: 'webhook_deliveries_sub_idx', properties: ['subscriptionId', 'createdAt'] })
export class WebhookDelivery {
  [OptionalProps]?: 'statusCode' | 'responseBody' | 'deliveredAt' | 'failedAt' | 'attempt' | 'createdAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'subscription_id', type: 'uuid' })
  subscriptionId!: string

  @Property({ type: 'text' })
  event!: string

  @Property({ type: 'json' })
  payload!: Record<string, unknown>

  @Property({ name: 'status_code', type: 'int', nullable: true })
  statusCode?: number | null

  @Property({ name: 'response_body', type: 'text', nullable: true })
  responseBody?: string | null

  @Property({ type: 'int', default: 1 })
  attempt: number = 1

  @Property({ name: 'delivered_at', type: 'timestamptz', nullable: true })
  deliveredAt?: Date | null

  @Property({ name: 'failed_at', type: 'timestamptz', nullable: true })
  failedAt?: Date | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()
}
