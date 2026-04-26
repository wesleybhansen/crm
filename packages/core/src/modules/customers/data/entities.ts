import {
  Entity,
  PrimaryKey,
  Property,
  Index,
  Unique,
  OneToOne,
  OneToMany,
  ManyToOne,
  Collection,
  OptionalProps,
} from '@mikro-orm/core'

export type CustomerEntityKind = 'person' | 'company'
export type CustomerAddressFormat = 'line_first' | 'street_first'

@Entity({ tableName: 'customer_entities' })
@Index({ name: 'customer_entities_org_tenant_kind_idx', properties: ['organizationId', 'tenantId', 'kind'] })
@Index({
  name: 'idx_ce_tenant_org_person_id',
  expression:
    `create index "idx_ce_tenant_org_person_id" on "customer_entities" ("tenant_id", "organization_id", "id") where deleted_at is null and kind = 'person'`,
})
@Index({
  name: 'idx_ce_tenant_org_company_id',
  expression:
    `create index "idx_ce_tenant_org_company_id" on "customer_entities" ("tenant_id", "organization_id", "id") where deleted_at is null and kind = 'company'`,
})
@Index({
  name: 'idx_ce_tenant_company_id',
  expression:
    `create index "idx_ce_tenant_company_id" on "customer_entities" ("tenant_id", "id") where deleted_at is null and kind = 'company'`,
})
@Index({
  name: 'idx_ce_tenant_person_id',
  expression:
    `create index "idx_ce_tenant_person_id" on "customer_entities" ("tenant_id", "id") where deleted_at is null and kind = 'person'`,
})
export class CustomerEntity {
  [OptionalProps]?: 'isActive' | 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ type: 'text' })
  kind!: CustomerEntityKind

  @Property({ name: 'display_name', type: 'text' })
  displayName!: string

  @Property({ type: 'text', nullable: true })
  description?: string | null

  @Property({ name: 'owner_user_id', type: 'uuid', nullable: true })
  ownerUserId?: string | null

  @Property({ name: 'primary_email', type: 'text', nullable: true })
  primaryEmail?: string | null

  @Property({ name: 'primary_phone', type: 'text', nullable: true })
  primaryPhone?: string | null

  @Property({ name: 'status', type: 'text', nullable: true })
  status?: string | null

  @Property({ name: 'lifecycle_stage', type: 'text', nullable: true })
  lifecycleStage?: string | null

  @Property({ name: 'source', type: 'text', nullable: true })
  source?: string | null

  @Property({ name: 'next_interaction_at', type: Date, nullable: true })
  nextInteractionAt?: Date | null

  @Property({ name: 'next_interaction_name', type: 'text', nullable: true })
  nextInteractionName?: string | null

  @Property({ name: 'next_interaction_ref_id', type: 'text', nullable: true })
  nextInteractionRefId?: string | null

  @Property({ name: 'next_interaction_icon', type: 'text', nullable: true })
  nextInteractionIcon?: string | null

  @Property({ name: 'next_interaction_color', type: 'text', nullable: true })
  nextInteractionColor?: string | null

  @Property({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean = true

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null

  @OneToOne(() => CustomerPersonProfile, (profile) => profile.entity, { nullable: true, mappedBy: 'entity' })
  personProfile?: CustomerPersonProfile | null

  @OneToOne(() => CustomerCompanyProfile, (profile) => profile.entity, { nullable: true, mappedBy: 'entity' })
  companyProfile?: CustomerCompanyProfile | null

  @OneToMany(() => CustomerAddress, (address) => address.entity)
  addresses = new Collection<CustomerAddress>(this)

  @OneToMany(() => CustomerActivity, (activity) => activity.entity)
  activities = new Collection<CustomerActivity>(this)

  @OneToMany(() => CustomerComment, (comment) => comment.entity)
  comments = new Collection<CustomerComment>(this)

  @OneToMany(() => CustomerTagAssignment, (assignment) => assignment.entity)
  tagAssignments = new Collection<CustomerTagAssignment>(this)

  @OneToMany(() => CustomerTodoLink, (link) => link.entity)
  todoLinks = new Collection<CustomerTodoLink>(this)

  @OneToMany(() => CustomerDealPersonLink, (link) => link.person)
  dealPersonLinks = new Collection<CustomerDealPersonLink>(this)

  @OneToMany(() => CustomerDealCompanyLink, (link) => link.company)
  dealCompanyLinks = new Collection<CustomerDealCompanyLink>(this)

  @OneToMany(() => CustomerPersonProfile, (person) => person.company)
  companyMembers = new Collection<CustomerPersonProfile>(this)
}

@Entity({ tableName: 'customer_people' })
@Index({ name: 'customer_people_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
@Index({
  name: 'idx_customer_people_entity_id',
  expression:
    `create index "idx_customer_people_entity_id" on "customer_people" ("entity_id")`,
})
export class CustomerPersonProfile {
  [OptionalProps]?: 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'first_name', type: 'text', nullable: true })
  firstName?: string | null

  @Property({ name: 'last_name', type: 'text', nullable: true })
  lastName?: string | null

  @Property({ name: 'preferred_name', type: 'text', nullable: true })
  preferredName?: string | null

  @Property({ name: 'job_title', type: 'text', nullable: true })
  jobTitle?: string | null

  @Property({ name: 'department', type: 'text', nullable: true })
  department?: string | null

  @Property({ name: 'seniority', type: 'text', nullable: true })
  seniority?: string | null

  @Property({ name: 'timezone', type: 'text', nullable: true })
  timezone?: string | null

  @Property({ name: 'linked_in_url', type: 'text', nullable: true })
  linkedInUrl?: string | null

  @Property({ name: 'twitter_url', type: 'text', nullable: true })
  twitterUrl?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @OneToOne(() => CustomerEntity, (entity) => entity.personProfile, {
    fieldName: 'entity_id',
    owner: true,
  })
  entity!: CustomerEntity

  @ManyToOne(() => CustomerEntity, {
    fieldName: 'company_entity_id',
    nullable: true,
  })
  company?: CustomerEntity | null
}

@Entity({ tableName: 'customer_companies' })
@Index({ name: 'customer_companies_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
@Index({
  name: 'idx_customer_companies_entity_id',
  expression:
    `create index "idx_customer_companies_entity_id" on "customer_companies" ("entity_id")`,
})
export class CustomerCompanyProfile {
  [OptionalProps]?: 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'legal_name', type: 'text', nullable: true })
  legalName?: string | null

  @Property({ name: 'brand_name', type: 'text', nullable: true })
  brandName?: string | null

  @Property({ name: 'domain', type: 'text', nullable: true })
  domain?: string | null

  @Property({ name: 'website_url', type: 'text', nullable: true })
  websiteUrl?: string | null

  @Property({ name: 'industry', type: 'text', nullable: true })
  industry?: string | null

  @Property({ name: 'size_bucket', type: 'text', nullable: true })
  sizeBucket?: string | null

  @Property({ name: 'annual_revenue', type: 'numeric', precision: 16, scale: 2, nullable: true })
  annualRevenue?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @OneToOne(() => CustomerEntity, (entity) => entity.companyProfile, {
    fieldName: 'entity_id',
    owner: true,
  })
  entity!: CustomerEntity

}

@Entity({ tableName: 'customer_deals' })
@Index({ name: 'customer_deals_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
export class CustomerDeal {
  [OptionalProps]?: 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ type: 'text' })
  title!: string

  @Property({ type: 'text', nullable: true })
  description?: string | null

  @Property({ name: 'status', type: 'text', default: 'open' })
  status: string = 'open'

  @Property({ name: 'pipeline_stage', type: 'text', nullable: true })
  pipelineStage?: string | null

  @Property({ name: 'pipeline_id', type: 'uuid', nullable: true })
  pipelineId?: string | null

  @Property({ name: 'pipeline_stage_id', type: 'uuid', nullable: true })
  pipelineStageId?: string | null

  @Property({ name: 'value_amount', type: 'numeric', precision: 14, scale: 2, nullable: true })
  valueAmount?: string | null

  @Property({ name: 'value_currency', type: 'text', nullable: true })
  valueCurrency?: string | null

  @Property({ name: 'probability', type: 'int', nullable: true })
  probability?: number | null

  @Property({ name: 'expected_close_at', type: Date, nullable: true })
  expectedCloseAt?: Date | null

  @Property({ name: 'owner_user_id', type: 'uuid', nullable: true })
  ownerUserId?: string | null

  @Property({ name: 'source', type: 'text', nullable: true })
  source?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null

  @OneToMany(() => CustomerDealPersonLink, (link) => link.deal)
  people = new Collection<CustomerDealPersonLink>(this)

  @OneToMany(() => CustomerDealCompanyLink, (link) => link.deal)
  companies = new Collection<CustomerDealCompanyLink>(this)

  @OneToMany(() => CustomerActivity, (activity) => activity.deal)
  activities = new Collection<CustomerActivity>(this)

  @OneToMany(() => CustomerComment, (comment) => comment.deal)
  comments = new Collection<CustomerComment>(this)
}

@Entity({ tableName: 'customer_deal_people' })
@Index({ name: 'customer_deal_people_deal_idx', properties: ['deal'] })
@Index({ name: 'customer_deal_people_person_idx', properties: ['person'] })
@Unique({ name: 'customer_deal_people_unique', properties: ['deal', 'person'] })
export class CustomerDealPersonLink {
  [OptionalProps]?: 'createdAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'role', type: 'text', nullable: true })
  participantRole?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @ManyToOne(() => CustomerDeal, { fieldName: 'deal_id' })
  deal!: CustomerDeal

  @ManyToOne(() => CustomerEntity, { fieldName: 'person_entity_id' })
  person!: CustomerEntity
}

@Entity({ tableName: 'customer_deal_companies' })
@Index({ name: 'customer_deal_companies_deal_idx', properties: ['deal'] })
@Index({ name: 'customer_deal_companies_company_idx', properties: ['company'] })
@Unique({ name: 'customer_deal_companies_unique', properties: ['deal', 'company'] })
export class CustomerDealCompanyLink {
  [OptionalProps]?: 'createdAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @ManyToOne(() => CustomerDeal, { fieldName: 'deal_id' })
  deal!: CustomerDeal

  @ManyToOne(() => CustomerEntity, { fieldName: 'company_entity_id' })
  company!: CustomerEntity
}

@Entity({ tableName: 'customer_activities' })
@Index({ name: 'customer_activities_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'customer_activities_entity_idx', properties: ['entity'] })
@Index({ name: 'customer_activities_entity_occurred_created_idx', properties: ['entity', 'occurredAt', 'createdAt'] })
export class CustomerActivity {
  [OptionalProps]?: 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'activity_type', type: 'text' })
  activityType!: string

  @Property({ name: 'subject', type: 'text', nullable: true })
  subject?: string | null

  @Property({ name: 'body', type: 'text', nullable: true })
  body?: string | null

  @Property({ name: 'occurred_at', type: Date, nullable: true })
  occurredAt?: Date | null

  @Property({ name: 'author_user_id', type: 'uuid', nullable: true })
  authorUserId?: string | null

  @Property({ name: 'appearance_icon', type: 'text', nullable: true })
  appearanceIcon?: string | null

  @Property({ name: 'appearance_color', type: 'text', nullable: true })
  appearanceColor?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @ManyToOne(() => CustomerEntity, { fieldName: 'entity_id' })
  entity!: CustomerEntity

  @ManyToOne(() => CustomerDeal, { fieldName: 'deal_id', nullable: true })
  deal?: CustomerDeal | null
}

@Entity({ tableName: 'customer_comments' })
@Index({ name: 'customer_comments_entity_idx', properties: ['entity'] })
@Index({ name: 'customer_comments_entity_created_idx', properties: ['entity', 'createdAt'] })
export class CustomerComment {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'body', type: 'text' })
  body!: string

  @Property({ name: 'author_user_id', type: 'uuid', nullable: true })
  authorUserId?: string | null

  @Property({ name: 'appearance_icon', type: 'text', nullable: true })
  appearanceIcon?: string | null

  @Property({ name: 'appearance_color', type: 'text', nullable: true })
  appearanceColor?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null

  @ManyToOne(() => CustomerEntity, { fieldName: 'entity_id' })
  entity!: CustomerEntity

  @ManyToOne(() => CustomerDeal, { fieldName: 'deal_id', nullable: true })
  deal?: CustomerDeal | null
}

@Entity({ tableName: 'customer_addresses' })
@Index({ name: 'customer_addresses_entity_idx', properties: ['entity'] })
export class CustomerAddress {
  [OptionalProps]?: 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'name', type: 'text', nullable: true })
  name?: string | null

  @Property({ name: 'purpose', type: 'text', nullable: true })
  purpose?: string | null

  @Property({ name: 'company_name', type: 'text', nullable: true })
  companyName?: string | null

  @Property({ name: 'address_line1', type: 'text' })
  addressLine1!: string

  @Property({ name: 'address_line2', type: 'text', nullable: true })
  addressLine2?: string | null

  @Property({ name: 'city', type: 'text', nullable: true })
  city?: string | null

  @Property({ name: 'region', type: 'text', nullable: true })
  region?: string | null

  @Property({ name: 'postal_code', type: 'text', nullable: true })
  postalCode?: string | null

  @Property({ name: 'country', type: 'text', nullable: true })
  country?: string | null

  @Property({ name: 'building_number', type: 'text', nullable: true })
  buildingNumber?: string | null

  @Property({ name: 'flat_number', type: 'text', nullable: true })
  flatNumber?: string | null

  @Property({ name: 'latitude', type: 'float', nullable: true })
  latitude?: number | null

  @Property({ name: 'longitude', type: 'float', nullable: true })
  longitude?: number | null

  @Property({ name: 'is_primary', type: 'boolean', default: false })
  isPrimary: boolean = false

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @ManyToOne(() => CustomerEntity, { fieldName: 'entity_id' })
  entity!: CustomerEntity
}

@Entity({ tableName: 'customer_settings' })
@Unique({ name: 'customer_settings_scope_unique', properties: ['organizationId', 'tenantId'] })
export class CustomerSettings {
  [OptionalProps]?: 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'address_format', type: 'text', default: 'line_first' })
  addressFormat: CustomerAddressFormat = 'line_first'

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

@Entity({ tableName: 'customer_tags' })
@Index({ name: 'customer_tags_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
@Unique({ name: 'customer_tags_org_slug_unique', properties: ['organizationId', 'tenantId', 'slug'] })
export class CustomerTag {
  [OptionalProps]?: 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ type: 'text' })
  slug!: string

  @Property({ type: 'text' })
  label!: string

  @Property({ name: 'color', type: 'text', nullable: true })
  color?: string | null

  @Property({ name: 'description', type: 'text', nullable: true })
  description?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @OneToMany(() => CustomerTagAssignment, (assignment) => assignment.tag)
  assignments = new Collection<CustomerTagAssignment>(this)
}

@Entity({ tableName: 'customer_tag_assignments' })
@Index({ name: 'customer_tag_assignments_entity_idx', properties: ['entity'] })
@Unique({ name: 'customer_tag_assignments_unique', properties: ['tag', 'entity'] })
export class CustomerTagAssignment {
  [OptionalProps]?: 'createdAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @ManyToOne(() => CustomerTag, { fieldName: 'tag_id' })
  tag!: CustomerTag

@ManyToOne(() => CustomerEntity, { fieldName: 'entity_id' })
  entity!: CustomerEntity
}

@Entity({ tableName: 'customer_dictionary_entries' })
@Index({ name: 'customer_dictionary_entries_scope_idx', properties: ['organizationId', 'tenantId', 'kind'] })
@Unique({ name: 'customer_dictionary_entries_unique', properties: ['organizationId', 'tenantId', 'kind', 'normalizedValue'] })
export class CustomerDictionaryEntry {
  [OptionalProps]?: 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ type: 'text' })
  kind!: string

  @Property({ type: 'text' })
  value!: string

  @Property({ name: 'normalized_value', type: 'text' })
  normalizedValue!: string

  @Property({ type: 'text' })
  label!: string

  @Property({ type: 'text', nullable: true })
  color?: string | null

  @Property({ type: 'text', nullable: true })
  icon?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

@Entity({ tableName: 'customer_pipelines' })
@Index({ name: 'customer_pipelines_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
export class CustomerPipeline {
  [OptionalProps]?: 'isDefault' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ type: 'text' })
  name!: string

  @Property({ name: 'is_default', type: 'boolean', default: false })
  isDefault: boolean = false

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

@Entity({ tableName: 'customer_pipeline_stages' })
@Index({ name: 'customer_pipeline_stages_pipeline_position_idx', properties: ['pipelineId', 'order'] })
@Index({ name: 'customer_pipeline_stages_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
export class CustomerPipelineStage {
  [OptionalProps]?: 'order' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'pipeline_id', type: 'uuid' })
  pipelineId!: string

  @Property({ name: 'name', type: 'text' })
  label!: string

  @Property({ name: 'position', type: 'int', default: 0 })
  order: number = 0

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

@Entity({ tableName: 'customer_todo_links' })
@Index({ name: 'customer_todo_links_entity_idx', properties: ['entity'] })
@Index({ name: 'customer_todo_links_entity_created_idx', properties: ['entity', 'createdAt'] })
@Unique({ name: 'customer_todo_links_unique', properties: ['entity', 'todoId', 'todoSource'] })
export class CustomerTodoLink {
  [OptionalProps]?: 'createdAt' | 'createdByUserId'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'todo_id', type: 'uuid' })
  todoId!: string

  @Property({ name: 'todo_source', type: 'text', default: 'example:todo' })
  todoSource: string = 'example:todo'

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId?: string | null

  @ManyToOne(() => CustomerEntity, { fieldName: 'entity_id' })
  entity!: CustomerEntity
}

// ---------------------------------------------------------------------------
// Tier 0 entities migrated from raw-knex routes (SPEC-061 mercato rebuild).
// All of these previously lived as hand-maintained tables in setup-tables.sql
// and were queried via raw `apps/mercato/src/app/api/**` route handlers. They
// are now ORM-managed under the customers module so they get tenant scoping,
// audit logs, the query index, AI/Scout visibility, and the rest of the
// mercato platform contract.
//
// Schema notes (where the ORM entity does NOT match setup-tables.sql exactly):
//   - tasks: + deleted_at (added for soft-delete consistency)
//   - contact_notes: + deleted_at
//   - contact_attachments: + updated_at, + deleted_at
//   - contact_engagement_scores: + created_at (was missing entirely)
//   - engagement_events: + tenant_id (was missing — multi-tenant safety fix)
//   - contact_open_times: + tenant_id (was missing — multi-tenant safety fix)
//   - reminders: + updated_at, + deleted_at
//   - task_templates: + deleted_at
//   - business_profiles: kept as-is (~29 columns of mixed concerns; refactor
//     into focused entities is out of scope for tier 0)
//
// Polymorphic note: `reminders` use entity_type/entity_id to link to contact,
// deal, or task. Modeled as plain @Property columns (not @ManyToOne) because
// the parent type is not statically known.
// ---------------------------------------------------------------------------

@Entity({ tableName: 'tasks' })
@Index({ name: 'tasks_org_done_idx', properties: ['organizationId', 'isDone', 'dueDate'] })
export class CustomerTask {
  [OptionalProps]?: 'isDone' | 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ type: 'text' })
  title!: string

  @Property({ type: 'text', nullable: true })
  description?: string | null

  @Property({ name: 'contact_id', type: 'uuid', nullable: true })
  contactId?: string | null

  @Property({ name: 'deal_id', type: 'uuid', nullable: true })
  dealId?: string | null

  @Property({ name: 'due_date', type: Date, nullable: true })
  dueDate?: Date | null

  @Property({ name: 'is_done', type: 'boolean', default: false })
  isDone: boolean = false

  @Property({ name: 'completed_at', type: Date, nullable: true })
  completedAt?: Date | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'contact_notes' })
@Index({ name: 'contact_notes_contact_idx', properties: ['contactId', 'createdAt'] })
export class CustomerContactNote {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'contact_id', type: 'uuid' })
  contactId!: string

  @Property({ type: 'text' })
  content!: string

  @Property({ name: 'author_user_id', type: 'uuid', nullable: true })
  authorUserId?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'contact_attachments' })
@Index({
  name: 'attachments_contact_idx',
  expression:
    `create index "attachments_contact_idx" on "contact_attachments" ("contact_id", "created_at" desc)`,
})
export class CustomerContactAttachment {
  [OptionalProps]?: 'fileSize' | 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'contact_id', type: 'uuid' })
  contactId!: string

  @Property({ type: 'text' })
  filename!: string

  @Property({ name: 'file_url', type: 'text' })
  fileUrl!: string

  @Property({ name: 'file_size', type: 'int', default: 0 })
  fileSize: number = 0

  @Property({ name: 'mime_type', type: 'text', nullable: true })
  mimeType?: string | null

  @Property({ name: 'uploaded_by', type: 'uuid', nullable: true })
  uploadedBy?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'contact_engagement_scores' })
@Unique({ name: 'engagement_scores_contact_idx', properties: ['contactId'] })
@Index({
  name: 'engagement_scores_org_score_idx',
  expression:
    `create index "engagement_scores_org_score_idx" on "contact_engagement_scores" ("organization_id", "score" desc)`,
})
export class CustomerContactEngagementScore {
  [OptionalProps]?: 'score' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'contact_id', type: 'uuid' })
  contactId!: string

  @Property({ type: 'int', default: 0 })
  score: number = 0

  @Property({ name: 'last_activity_at', type: Date, nullable: true })
  lastActivityAt?: Date | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

@Entity({ tableName: 'engagement_events' })
@Index({
  name: 'engagement_events_contact_idx',
  expression:
    `create index "engagement_events_contact_idx" on "engagement_events" ("contact_id", "created_at" desc)`,
})
export class CustomerEngagementEvent {
  [OptionalProps]?: 'createdAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'contact_id', type: 'uuid' })
  contactId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'event_type', type: 'text' })
  eventType!: string

  @Property({ type: 'int' })
  points!: number

  @Property({ type: 'json', nullable: true })
  metadata?: Record<string, unknown> | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}

@Entity({ tableName: 'contact_open_times' })
@Index({ name: 'open_times_contact_idx', properties: ['contactId'] })
export class CustomerContactOpenTime {
  [OptionalProps]?: 'createdAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'contact_id', type: 'uuid' })
  contactId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'hour_of_day', type: 'int' })
  hourOfDay!: number

  @Property({ name: 'day_of_week', type: 'int' })
  dayOfWeek!: number

  @Property({ name: 'opened_at', type: Date })
  openedAt!: Date

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}

@Entity({ tableName: 'reminders' })
@Index({
  name: 'reminders_due_idx',
  expression:
    `create index "reminders_due_idx" on "reminders" ("remind_at", "sent") where sent = false`,
})
@Index({ name: 'reminders_org_idx', properties: ['organizationId', 'userId'] })
export class CustomerReminder {
  [OptionalProps]?: 'sent' | 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'user_id', type: 'uuid' })
  userId!: string

  @Property({ name: 'entity_type', type: 'text' })
  entityType!: string

  @Property({ name: 'entity_id', type: 'uuid' })
  entityId!: string

  @Property({ type: 'text' })
  message!: string

  @Property({ name: 'remind_at', type: Date })
  remindAt!: Date

  @Property({ type: 'boolean', default: false })
  sent: boolean = false

  @Property({ name: 'sent_at', type: Date, nullable: true })
  sentAt?: Date | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'task_templates' })
@Index({ name: 'task_templates_org_idx', properties: ['organizationId'] })
export class CustomerTaskTemplate {
  [OptionalProps]?: 'triggerType' | 'tasks' | 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ type: 'text' })
  name!: string

  @Property({ type: 'text', nullable: true })
  description?: string | null

  @Property({ name: 'trigger_type', type: 'text', default: 'manual' })
  triggerType: string = 'manual'

  @Property({ name: 'trigger_config', type: 'json', nullable: true })
  triggerConfig?: Record<string, unknown> | null

  @Property({ type: 'json' })
  tasks: unknown[] = []

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'business_profiles' })
@Unique({ name: 'business_profiles_organization_id_key', properties: ['organizationId'] })
export class CustomerBusinessProfile {
  [OptionalProps]?:
    | 'clientSources'
    | 'pipelineStages'
    | 'aiPersonaName'
    | 'aiPersonaStyle'
    | 'pipelineMode'
    | 'digestFrequency'
    | 'digestDay'
    | 'emailIntakeMode'
    | 'interfaceMode'
    | 'onboardingComplete'
    | 'createdAt'
    | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'business_name', type: 'text', nullable: true })
  businessName?: string | null

  @Property({ name: 'business_type', type: 'text', nullable: true })
  businessType?: string | null

  @Property({ name: 'business_description', type: 'text', nullable: true })
  businessDescription?: string | null

  @Property({ name: 'main_offer', type: 'text', nullable: true })
  mainOffer?: string | null

  @Property({ name: 'ideal_clients', type: 'text', nullable: true })
  idealClients?: string | null

  @Property({ name: 'team_size', type: 'text', nullable: true })
  teamSize?: string | null

  @Property({ name: 'client_sources', type: 'json', nullable: true })
  clientSources?: unknown[] | null

  @Property({ name: 'pipeline_stages', type: 'json', nullable: true })
  pipelineStages?: unknown[] | null

  @Property({ name: 'ai_persona_name', type: 'text', nullable: true, default: 'Scout' })
  aiPersonaName?: string | null

  @Property({ name: 'ai_persona_style', type: 'text', nullable: true, default: 'professional' })
  aiPersonaStyle?: string | null

  @Property({ name: 'ai_custom_instructions', type: 'text', nullable: true })
  aiCustomInstructions?: string | null

  @Property({ name: 'website_url', type: 'text', nullable: true })
  websiteUrl?: string | null

  @Property({ name: 'brand_colors', type: 'json', nullable: true })
  brandColors?: Record<string, unknown> | null

  @Property({ name: 'social_links', type: 'json', nullable: true })
  socialLinks?: Record<string, unknown> | null

  @Property({ name: 'detected_services', type: 'json', nullable: true })
  detectedServices?: unknown | null

  @Property({ name: 'pipeline_mode', type: 'text', nullable: true, default: 'deals' })
  pipelineMode?: string | null

  @Property({ name: 'digest_frequency', type: 'text', nullable: true, default: 'weekly' })
  digestFrequency?: string | null

  @Property({ name: 'digest_day', type: 'int', nullable: true, default: 1 })
  digestDay?: number | null

  @Property({ name: 'email_intake_mode', type: 'text', nullable: true, default: 'suggest' })
  emailIntakeMode?: string | null

  @Property({ name: 'interface_mode', type: 'text', nullable: true, default: 'simple' })
  interfaceMode?: string | null

  @Property({ name: 'onboarding_complete', type: 'boolean', nullable: true, default: false })
  onboardingComplete?: boolean | null

  @Property({ name: 'brand_voice_profile', type: 'json', nullable: true })
  brandVoiceProfile?: Record<string, unknown> | null

  @Property({ name: 'brand_voice_updated_at', type: Date, nullable: true })
  brandVoiceUpdatedAt?: Date | null

  @Property({ name: 'brand_voice_source', type: 'text', nullable: true })
  brandVoiceSource?: string | null

  @Property({ name: 'ams_url', type: 'text', nullable: true })
  amsUrl?: string | null

  @Property({ name: 'ams_webhook_secret', type: 'text', nullable: true })
  amsWebhookSecret?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

export type PipelineAutomationTargetEntity = 'deal' | 'person'
export type PipelineAutomationTargetAction = 'set_stage' | 'advance_one' | 'set_lifecycle'
export type PipelineAutomationRunOutcome =
  | 'applied'
  | 'skipped_backward'
  | 'skipped_idempotent'
  | 'skipped_filter'
  | 'failed'

@Entity({ tableName: 'customer_pipeline_automation_rules' })
@Index({ name: 'customer_pipeline_automation_rules_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
@Index({
  name: 'customer_pipeline_automation_rules_trigger_active_idx',
  expression:
    `create index "customer_pipeline_automation_rules_trigger_active_idx" on "customer_pipeline_automation_rules" ("trigger_key") where is_active = true and deleted_at is null`,
})
export class PipelineAutomationRule {
  [OptionalProps]?:
    | 'filters'
    | 'allowBackward'
    | 'isActive'
    | 'createdAt'
    | 'updatedAt'
    | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ type: 'text' })
  name!: string

  @Property({ name: 'trigger_key', type: 'text' })
  triggerKey!: string

  @Property({ type: 'json', default: '{}' })
  filters: Record<string, unknown> = {}

  @Property({ name: 'target_entity', type: 'text' })
  targetEntity!: PipelineAutomationTargetEntity

  @Property({ name: 'target_pipeline_id', type: 'uuid', nullable: true })
  targetPipelineId?: string | null

  @Property({ name: 'target_stage_id', type: 'uuid', nullable: true })
  targetStageId?: string | null

  @Property({ name: 'target_lifecycle_stage', type: 'text', nullable: true })
  targetLifecycleStage?: string | null

  @Property({ name: 'target_action', type: 'text' })
  targetAction!: PipelineAutomationTargetAction

  @Property({ name: 'allow_backward', type: 'boolean', default: false })
  allowBackward: boolean = false

  @Property({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean = true

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'customer_pipeline_automation_runs' })
@Index({ name: 'customer_pipeline_automation_runs_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'customer_pipeline_automation_runs_idempotency_idx', properties: ['ruleId', 'entityId', 'triggerEventId'] })
@Index({ name: 'customer_pipeline_automation_runs_entity_idx', properties: ['entityType', 'entityId', 'ranAt'] })
export class PipelineAutomationRun {
  [OptionalProps]?: 'fromStage' | 'toStage' | 'error' | 'ranAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'rule_id', type: 'uuid' })
  ruleId!: string

  @Property({ name: 'trigger_event_id', type: 'text' })
  triggerEventId!: string

  @Property({ name: 'trigger_event_key', type: 'text' })
  triggerEventKey!: string

  @Property({ name: 'entity_type', type: 'text' })
  entityType!: PipelineAutomationTargetEntity

  @Property({ name: 'entity_id', type: 'uuid' })
  entityId!: string

  @Property({ name: 'from_stage', type: 'text', nullable: true })
  fromStage?: string | null

  @Property({ name: 'to_stage', type: 'text', nullable: true })
  toStage?: string | null

  @Property({ type: 'text' })
  outcome!: PipelineAutomationRunOutcome

  @Property({ type: 'text', nullable: true })
  error?: string | null

  @Property({ name: 'ran_at', type: Date, onCreate: () => new Date() })
  ranAt: Date = new Date()
}
