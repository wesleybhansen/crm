/**
 * Courses module ORM entities.
 * Phase 4A of the ORM conversion.
 */
import { Entity, Property, PrimaryKey, Index, Unique } from '@mikro-orm/core'
import { v4 as uuid } from 'uuid'

@Entity({ tableName: 'courses' })
export class Course {
  @PrimaryKey({ type: 'uuid' }) id: string = uuid()
  @Property({ name: 'tenant_id', type: 'uuid' }) tenantId!: string
  @Property({ name: 'organization_id', type: 'uuid' }) organizationId!: string
  @Property({ type: 'text' }) title!: string
  @Property({ type: 'text', nullable: true }) description?: string | null
  @Property({ type: 'text' }) slug!: string
  @Property({ type: 'numeric', nullable: true }) price?: string | null
  @Property({ type: 'text', default: 'USD' }) currency: string = 'USD'
  @Property({ name: 'is_free', type: 'boolean', default: false }) isFree: boolean = false
  @Property({ name: 'is_published', type: 'boolean', default: false }) isPublished: boolean = false
  @Property({ name: 'image_url', type: 'text', nullable: true }) imageUrl?: string | null
  @Property({ name: 'teaching_style', type: 'text', nullable: true }) teachingStyle?: string | null
  @Property({ name: 'target_audience', type: 'text', nullable: true }) targetAudience?: string | null
  @Property({ name: 'generation_status', type: 'text', nullable: true }) generationStatus?: string | null
  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' }) createdAt: Date = new Date()
  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() }) updatedAt: Date = new Date()
  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true }) deletedAt?: Date | null
}

@Entity({ tableName: 'course_modules' })
export class CourseModule {
  @PrimaryKey({ type: 'uuid' }) id: string = uuid()
  @Property({ name: 'course_id', type: 'uuid' }) courseId!: string
  @Property({ type: 'text' }) title!: string
  @Property({ type: 'text', nullable: true }) description?: string | null
  @Property({ name: 'sort_order', type: 'integer', default: 0 }) sortOrder: number = 0
  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' }) createdAt: Date = new Date()
}

@Entity({ tableName: 'course_lessons' })
export class CourseLesson {
  @PrimaryKey({ type: 'uuid' }) id: string = uuid()
  @Property({ name: 'module_id', type: 'uuid' }) moduleId!: string
  @Property({ type: 'text' }) title!: string
  @Property({ name: 'content_type', type: 'text', default: 'text' }) contentType: string = 'text'
  @Property({ type: 'text', nullable: true }) content?: string | null
  @Property({ name: 'video_url', type: 'text', nullable: true }) videoUrl?: string | null
  @Property({ name: 'duration_minutes', type: 'integer', nullable: true }) durationMinutes?: number | null
  @Property({ name: 'sort_order', type: 'integer', default: 0 }) sortOrder: number = 0
  @Property({ name: 'is_free_preview', type: 'boolean', default: false }) isFreePreview: boolean = false
  @Property({ name: 'drip_days', type: 'integer', nullable: true }) dripDays?: number | null
  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' }) createdAt: Date = new Date()
}

@Entity({ tableName: 'course_enrollments' })
export class CourseEnrollment {
  @PrimaryKey({ type: 'uuid' }) id: string = uuid()
  @Property({ name: 'tenant_id', type: 'uuid' }) tenantId!: string
  @Property({ name: 'organization_id', type: 'uuid' }) organizationId!: string
  @Property({ name: 'course_id', type: 'uuid' }) courseId!: string
  @Property({ name: 'contact_id', type: 'uuid', nullable: true }) contactId?: string | null
  @Property({ name: 'student_name', type: 'text' }) studentName!: string
  @Property({ name: 'student_email', type: 'text' }) studentEmail!: string
  @Property({ name: 'enrolled_at', type: 'timestamptz', defaultRaw: 'now()' }) enrolledAt: Date = new Date()
  @Property({ name: 'completed_at', type: 'timestamptz', nullable: true }) completedAt?: Date | null
  @Property({ name: 'payment_id', type: 'uuid', nullable: true }) paymentId?: string | null
  @Property({ type: 'text', default: 'active' }) status: string = 'active'
}

@Entity({ tableName: 'course_magic_tokens' })
export class CourseMagicToken {
  @PrimaryKey({ type: 'uuid' }) id: string = uuid()
  @Property({ name: 'organization_id', type: 'uuid' }) organizationId!: string
  @Property({ type: 'text' }) email!: string
  @Property({ type: 'text' }) token!: string
  @Property({ name: 'expires_at', type: 'timestamptz' }) expiresAt!: Date
  @Property({ name: 'used_at', type: 'timestamptz', nullable: true }) usedAt?: Date | null
  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' }) createdAt: Date = new Date()
}

@Entity({ tableName: 'course_student_sessions' })
export class CourseStudentSession {
  @PrimaryKey({ type: 'uuid' }) id: string = uuid()
  @Property({ name: 'organization_id', type: 'uuid' }) organizationId!: string
  @Property({ type: 'text' }) email!: string
  @Property({ name: 'session_token', type: 'text' }) sessionToken!: string
  @Property({ name: 'expires_at', type: 'timestamptz' }) expiresAt!: Date
  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' }) createdAt: Date = new Date()
}
