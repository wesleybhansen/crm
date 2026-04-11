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
