/**
 * Forms module ORM entity.
 * Phase 3D of the ORM conversion.
 */
import { Entity, Property, PrimaryKey, Index } from '@mikro-orm/core'
import { v4 as uuid } from 'uuid'

@Entity({ tableName: 'forms' })
@Index({ name: 'forms_org_slug_idx', properties: ['organizationId', 'slug'] })
export class Form {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()
  @Property({ name: 'tenant_id', type: 'uuid' }) tenantId!: string
  @Property({ name: 'organization_id', type: 'uuid' }) organizationId!: string
  @Property({ type: 'text' }) name!: string
  @Property({ type: 'text' }) slug!: string
  @Property({ type: 'text', nullable: true }) description?: string | null
  @Property({ name: 'template_id', type: 'text', nullable: true }) templateId?: string | null
  @Property({ type: 'jsonb', default: '[]' }) fields: unknown[] = []
  @Property({ type: 'jsonb', default: '{}' }) theme: Record<string, unknown> = {}
  @Property({ type: 'jsonb', default: '{}' }) settings: Record<string, unknown> = {}
  @Property({ type: 'text', default: 'draft' }) status: string = 'draft'
  @Property({ name: 'owner_user_id', type: 'uuid', nullable: true }) ownerUserId?: string | null
  @Property({ name: 'view_count', type: 'integer', default: 0 }) viewCount: number = 0
  @Property({ name: 'submission_count', type: 'integer', default: 0 }) submissionCount: number = 0
  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' }) createdAt: Date = new Date()
  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() }) updatedAt: Date = new Date()
  @Property({ name: 'published_at', type: 'timestamptz', nullable: true }) publishedAt?: Date | null
  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true }) deletedAt?: Date | null
  @Property({ name: 'is_active', type: 'boolean', default: true }) isActive: boolean = true
}
