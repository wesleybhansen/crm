/**
 * Calendar module ORM entities — booking pages, bookings, google calendar connections.
 * Phase 3A of the ORM conversion.
 */
import { Entity, Property, PrimaryKey, Index, Unique } from '@mikro-orm/core'
import { v4 as uuid } from 'uuid'

@Entity({ tableName: 'booking_pages' })
export class BookingPage {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ type: 'text' })
  title!: string

  @Property({ type: 'text' })
  slug!: string

  @Property({ type: 'text', nullable: true })
  description?: string | null

  @Property({ name: 'duration_minutes', type: 'integer', default: 30 })
  durationMinutes: number = 30

  @Property({ type: 'jsonb', default: '{}' })
  availability: Record<string, unknown> = {}

  @Property({ name: 'buffer_minutes', type: 'integer', default: 15 })
  bufferMinutes: number = 15

  @Property({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean = true

  @Property({ name: 'owner_user_id', type: 'uuid', nullable: true })
  ownerUserId?: string | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

@Entity({ tableName: 'bookings' })
@Index({ name: 'bookings_org_time_idx', properties: ['organizationId', 'startTime'] })
export class Booking {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'booking_page_id', type: 'uuid', nullable: true })
  bookingPageId?: string | null

  @Property({ name: 'contact_id', type: 'uuid', nullable: true })
  contactId?: string | null

  @Property({ name: 'guest_name', type: 'text' })
  guestName!: string

  @Property({ name: 'guest_email', type: 'text' })
  guestEmail!: string

  @Property({ name: 'guest_phone', type: 'text', nullable: true })
  guestPhone?: string | null

  @Property({ name: 'start_time', type: 'timestamptz' })
  startTime!: Date

  @Property({ name: 'end_time', type: 'timestamptz' })
  endTime!: Date

  @Property({ type: 'text', default: 'confirmed' })
  status: string = 'confirmed'

  @Property({ type: 'text', nullable: true })
  notes?: string | null

  @Property({ name: 'confirmation_token', type: 'text', nullable: true })
  confirmationToken?: string | null

  @Property({ name: 'confirmation_token_expires_at', type: 'timestamptz', nullable: true })
  confirmationTokenExpiresAt?: Date | null

  @Property({ name: 'confirmed_at', type: 'timestamptz', nullable: true })
  confirmedAt?: Date | null

  @Property({ name: 'meeting_type', type: 'text', nullable: true })
  meetingType?: string | null

  @Property({ name: 'meeting_location', type: 'text', nullable: true })
  meetingLocation?: string | null

  @Property({ name: 'recurrence_rule', type: 'jsonb', nullable: true })
  recurrenceRule?: Record<string, unknown> | null

  @Property({ name: 'recurrence_parent_id', type: 'uuid', nullable: true })
  recurrenceParentId?: string | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()
}

@Entity({ tableName: 'google_calendar_connections' })
@Unique({ name: 'google_cal_user_idx', properties: ['userId'] })
export class GoogleCalendarConnection {
  @PrimaryKey({ type: 'uuid' })
  id: string = uuid()

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'user_id', type: 'uuid' })
  userId!: string

  @Property({ name: 'google_email', type: 'text' })
  googleEmail!: string

  @Property({ name: 'access_token', type: 'text' })
  accessToken!: string

  @Property({ name: 'refresh_token', type: 'text' })
  refreshToken!: string

  @Property({ name: 'token_expiry', type: 'timestamptz' })
  tokenExpiry!: Date

  @Property({ name: 'calendar_id', type: 'text', default: 'primary' })
  calendarId: string = 'primary'

  @Property({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean = true

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}
