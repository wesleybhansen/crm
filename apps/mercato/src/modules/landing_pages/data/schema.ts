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
