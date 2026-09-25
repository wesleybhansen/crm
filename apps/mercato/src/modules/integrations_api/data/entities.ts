import { Entity, Index, OptionalProps, PrimaryKey, Property, Unique } from '@mikro-orm/core'

@Entity({ tableName: 'integrations_api_ams_commands' })
@Index({ name: 'integrations_api_ams_commands_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
@Unique({ name: 'integrations_api_ams_commands_command_unique', properties: ['organizationId', 'tenantId', 'commandId'] })
@Unique({ name: 'integrations_api_ams_commands_idempotency_unique', properties: ['organizationId', 'tenantId', 'idempotencyDigest'] })
@Unique({ name: 'integrations_api_ams_commands_nonce_unique', properties: ['organizationId', 'tenantId', 'nonceDigest'] })
export class IntegrationsApiAmsCommand {
  [OptionalProps]?: 'id' | 'state' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'source_organization_id', type: 'uuid' })
  sourceOrganizationId!: string

  @Property({ name: 'principal_ref', type: 'uuid' })
  principalRef!: string

  @Property({ name: 'command_id', type: 'uuid' })
  commandId!: string

  @Property({ name: 'command_type', type: 'text' })
  commandType!: string

  @Property({ name: 'command_ref', type: 'text' })
  commandRef!: string

  @Property({ name: 'idempotency_digest', type: 'text' })
  idempotencyDigest!: string

  @Property({ name: 'nonce_digest', type: 'text' })
  nonceDigest!: string

  @Property({ name: 'canonical_hash', type: 'text' })
  canonicalHash!: string

  @Property({ name: 'payload_digest', type: 'text' })
  payloadDigest!: string

  @Property({ type: 'text' })
  issuer!: string

  @Property({ type: 'text' })
  audience!: string

  @Property({ name: 'contract_version', type: 'text' })
  contractVersion!: string

  @Property({ name: 'schema_version', type: 'integer' })
  schemaVersion!: number

  @Property({ name: 'key_version', type: 'text' })
  keyVersion!: string

  @Property({ name: 'issued_at', type: 'timestamptz' })
  issuedAt!: Date

  @Property({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date

  @Property({ type: 'text', default: 'shadow_validated' })
  state: string = 'shadow_validated'

  @Property({ name: 'safe_failure_code', type: 'text', nullable: true })
  safeFailureCode?: string | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'integrations_api_consent_versions' })
@Index({ name: 'integrations_api_consent_versions_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
@Unique({ name: 'integrations_api_consent_versions_subject_unique', properties: ['organizationId', 'tenantId', 'crmContactRef', 'purpose', 'version'] })
export class IntegrationsApiConsentVersion {
  [OptionalProps]?: 'id' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'crm_contact_ref', type: 'text' })
  crmContactRef!: string

  @Property({ type: 'text' })
  purpose!: string

  @Property({ type: 'bigint' })
  version!: string

  @Property({ type: 'text' })
  state!: string

  @Property({ name: 'policy_ref', type: 'text' })
  policyRef!: string

  @Property({ name: 'source_ref', type: 'text' })
  sourceRef!: string

  @Property({ name: 'effective_at', type: 'timestamptz' })
  effectiveAt!: Date

  @Property({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt?: Date | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'integrations_api_suppression_versions' })
@Index({ name: 'integrations_api_suppression_versions_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
@Unique({ name: 'integrations_api_suppression_versions_subject_unique', properties: ['organizationId', 'tenantId', 'crmContactRef', 'channel', 'version'] })
export class IntegrationsApiSuppressionVersion {
  [OptionalProps]?: 'id' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'crm_contact_ref', type: 'text' })
  crmContactRef!: string

  @Property({ type: 'text' })
  channel!: string

  @Property({ type: 'bigint' })
  version!: string

  @Property({ type: 'boolean' })
  active!: boolean

  @Property({ name: 'reason_code', type: 'text' })
  reasonCode!: string

  @Property({ name: 'effective_at', type: 'timestamptz' })
  effectiveAt!: Date

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'integrations_api_ams_events' })
@Index({ name: 'integrations_api_ams_events_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
@Unique({ name: 'integrations_api_ams_events_event_unique', properties: ['organizationId', 'tenantId', 'eventId'] })
@Unique({ name: 'integrations_api_ams_events_nonce_unique', properties: ['organizationId', 'tenantId', 'nonceDigest'] })
@Unique({ name: 'integrations_api_ams_events_projection_unique', properties: ['organizationId', 'tenantId', 'projectionDigest'] })
export class IntegrationsApiAmsEvent {
  [OptionalProps]?: 'id' | 'state' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'source_organization_id', type: 'uuid' })
  sourceOrganizationId!: string

  @Property({ name: 'event_id', type: 'uuid' })
  eventId!: string

  @Property({ name: 'event_type', type: 'text' })
  eventType!: string

  @Property({ name: 'contract_version', type: 'text' })
  contractVersion!: string

  @Property({ name: 'schema_version', type: 'integer' })
  schemaVersion!: number

  @Property({ type: 'text' })
  issuer!: string

  @Property({ type: 'text' })
  audience!: string

  @Property({ name: 'canonical_hash', type: 'text' })
  canonicalHash!: string

  @Property({ name: 'payload_digest', type: 'text' })
  payloadDigest!: string

  @Property({ name: 'nonce_digest', type: 'text' })
  nonceDigest!: string

  @Property({ name: 'projection_digest', type: 'text', nullable: true })
  projectionDigest?: string | null

  @Property({ name: 'signed_envelope', type: 'jsonb', nullable: true })
  signedEnvelope?: Record<string, unknown> | null

  @Property({ name: 'key_version', type: 'text' })
  keyVersion!: string

  @Property({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date

  @Property({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date

  @Property({ type: 'text', default: 'held_dark' })
  state: string = 'held_dark'

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

/**
 * Outbox for events the CRM delivers to other Noli apps (today: a closed deal
 * to the marketing app). One row per event, written by a subscriber and sent
 * by lib/outbound-events.ts with retries and backoff, so a slow or failing
 * receiver never holds up the write that caused the event. The subject unique
 * key is the dedupe: one `deal.closed` row per deal, ever. Rows hold ids only;
 * the payload is built (and decrypted) at send time.
 */
@Entity({ tableName: 'integrations_api_outbound_events' })
@Index({ name: 'integrations_api_outbound_events_due_idx', properties: ['status', 'nextAttemptAt'] })
@Unique({ name: 'integrations_api_outbound_events_subject_unique', properties: ['organizationId', 'eventType', 'subjectId'] })
@Unique({ name: 'integrations_api_outbound_events_event_id_unique', properties: ['eventId'] })
export class IntegrationsApiOutboundEvent {
  [OptionalProps]?: 'id' | 'status' | 'attempts' | 'nextAttemptAt' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'event_type', type: 'text' })
  eventType!: string

  @Property({ name: 'subject_id', type: 'uuid' })
  subjectId!: string

  @Property({ name: 'event_id', type: 'text' })
  eventId!: string

  @Property({ type: 'text' })
  target!: string

  @Property({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date

  @Property({ type: 'text', default: 'pending' })
  status: string = 'pending'

  @Property({ type: 'integer', default: 0 })
  attempts: number = 0

  @Property({ name: 'next_attempt_at', type: 'timestamptz', defaultRaw: 'now()' })
  nextAttemptAt: Date = new Date()

  @Property({ name: 'last_status_code', type: 'integer', nullable: true })
  lastStatusCode?: number | null

  @Property({ name: 'last_error', type: 'text', nullable: true })
  lastError?: string | null

  @Property({ name: 'delivered_at', type: 'timestamptz', nullable: true })
  deliveredAt?: Date | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}
