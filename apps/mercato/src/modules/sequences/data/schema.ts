/**
 * Sequences + automation rules ORM entities.
 * Phase 3B of the ORM conversion.
 */
import { Entity, Property, PrimaryKey, Index } from '@mikro-orm/core'
import { v4 as uuid } from 'uuid'

@Entity({ tableName: 'sequences' })
export class Sequence {
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

  @Property({ name: 'trigger_type', type: 'text', default: 'manual' })
  triggerType: string = 'manual'

  @Property({ name: 'trigger_config', type: 'jsonb', nullable: true })
  triggerConfig?: Record<string, unknown> | null

  @Property({ type: 'text', default: 'draft' })
  status: string = 'draft'

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'sequence_steps' })
export class SequenceStep {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'sequence_id', type: 'uuid' })
  sequenceId!: string

  @Property({ name: 'step_order', type: 'integer' })
  stepOrder!: number

  @Property({ name: 'step_type', type: 'text' })
  stepType!: string

  @Property({ type: 'jsonb', default: '{}' })
  config: Record<string, unknown> = {}

  @Property({ name: 'branch_config', type: 'jsonb', nullable: true })
  branchConfig?: Record<string, unknown> | null

  @Property({ name: 'is_goal', type: 'boolean', default: false })
  isGoal: boolean = false

  @Property({ name: 'goal_config', type: 'jsonb', nullable: true })
  goalConfig?: Record<string, unknown> | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()
}

@Entity({ tableName: 'sequence_enrollments' })
export class SequenceEnrollment {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'sequence_id', type: 'uuid' })
  sequenceId!: string

  @Property({ name: 'contact_id', type: 'uuid' })
  contactId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ type: 'text', default: 'active' })
  status: string = 'active'

  @Property({ name: 'current_step_order', type: 'integer', default: 1 })
  currentStepOrder: number = 1

  @Property({ name: 'enrolled_at', type: 'timestamptz', defaultRaw: 'now()' })
  enrolledAt: Date = new Date()

  @Property({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt?: Date | null

  @Property({ name: 'paused_at', type: 'timestamptz', nullable: true })
  pausedAt?: Date | null
}

@Entity({ tableName: 'sequence_step_executions' })
export class SequenceStepExecution {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'enrollment_id', type: 'uuid' })
  enrollmentId!: string

  @Property({ name: 'step_id', type: 'uuid' })
  stepId!: string

  @Property({ type: 'text', default: 'scheduled' })
  status: string = 'scheduled'

  @Property({ name: 'scheduled_for', type: 'timestamptz' })
  scheduledFor!: Date

  @Property({ name: 'executed_at', type: 'timestamptz', nullable: true })
  executedAt?: Date | null

  @Property({ type: 'jsonb', nullable: true })
  result?: Record<string, unknown> | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()
}

@Entity({ tableName: 'automation_rules' })
export class AutomationRule {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ type: 'text' })
  name!: string

  @Property({ name: 'trigger_type', type: 'text' })
  triggerType!: string

  @Property({ name: 'trigger_config', type: 'jsonb', default: '{}' })
  triggerConfig: Record<string, unknown> = {}

  @Property({ name: 'action_type', type: 'text' })
  actionType!: string

  @Property({ name: 'action_config', type: 'jsonb', default: '{}' })
  actionConfig: Record<string, unknown> = {}

  @Property({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean = true

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

@Entity({ tableName: 'automation_rule_logs' })
export class AutomationRuleLog {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'rule_id', type: 'uuid' })
  ruleId!: string

  @Property({ name: 'contact_id', type: 'uuid', nullable: true })
  contactId?: string | null

  @Property({ name: 'trigger_data', type: 'jsonb', nullable: true })
  triggerData?: Record<string, unknown> | null

  @Property({ name: 'action_result', type: 'jsonb', nullable: true })
  actionResult?: Record<string, unknown> | null

  @Property({ type: 'text', default: 'executed' })
  status: string = 'executed'

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()
}

@Entity({ tableName: 'stage_automations' })
export class StageAutomation {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'trigger_stage', type: 'text' })
  triggerStage!: string

  @Property({ name: 'action_type', type: 'text' })
  actionType!: string

  @Property({ name: 'action_config', type: 'jsonb', default: '{}' })
  actionConfig: Record<string, unknown> = {}

  @Property({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean = true

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()
}
