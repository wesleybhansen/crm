/**
 * Email intelligence settings — per-user feature toggles.
 *
 * Replaces legacy /api/email-intelligence/settings (GET+PUT).
 * Sync and cron routes remain on legacy paths.
 *
 * New URL: /api/email/intelligence-settings
 */
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { EmailIntelligenceSettings } from '../../data/schema'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { z } from 'zod'

export const metadata = {
  GET: { requireAuth: true },
  PUT: { requireAuth: true },
}

function serializeSettings(s: EmailIntelligenceSettings | null) {
  if (!s) {
    return {
      is_enabled: false,
      auto_create_contacts: false,
      auto_update_timeline: false,
      auto_update_engagement: false,
      auto_advance_stage: false,
      last_sync_at: null,
      last_sync_status: null,
      last_sync_error: null,
      emails_processed_total: 0,
      contacts_created_total: 0,
    }
  }
  return {
    is_enabled: s.isEnabled ?? false,
    auto_create_contacts: s.autoCreateContacts ?? false,
    auto_update_timeline: s.autoUpdateTimeline ?? false,
    auto_update_engagement: s.autoUpdateEngagement ?? false,
    auto_advance_stage: s.autoAdvanceStage ?? false,
    last_sync_at: s.lastSyncAt ?? null,
    last_sync_status: s.lastSyncStatus ?? null,
    last_sync_error: s.lastSyncError ?? null,
    emails_processed_total: s.emailsProcessedTotal ?? 0,
    contacts_created_total: s.contactsCreatedTotal ?? 0,
  }
}

export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId || !auth?.sub) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
    const settings = await em.findOne(EmailIntelligenceSettings, {
      organizationId: auth.orgId,
      userId: auth.sub,
    })
    return NextResponse.json({ ok: true, data: serializeSettings(settings) })
  } catch (error) {
    console.error('[email.intelligence-settings.get]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId || !auth?.sub) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const body = await req.json()
    const container = await createRequestContainer()
    const commandBus = container.resolve('commandBus') as CommandBus

    await commandBus.execute('email.intelligence.upsert', {
      input: {
        tenantId: auth.tenantId,
        organizationId: auth.orgId,
        userId: auth.sub,
        isEnabled: body.is_enabled,
        autoCreateContacts: body.auto_create_contacts,
        autoUpdateTimeline: body.auto_update_timeline,
        autoUpdateEngagement: body.auto_update_engagement,
        autoAdvanceStage: body.auto_advance_stage,
      },
      ctx: {
        tenantId: auth.tenantId,
        organizationId: auth.orgId,
        userId: auth.sub,
        container,
      },
    })

    // Re-fetch to return updated state
    const em = (container.resolve('em') as EntityManager).fork()
    const updated = await em.findOne(EmailIntelligenceSettings, {
      organizationId: auth.orgId,
      userId: auth.sub,
    })
    return NextResponse.json({ ok: true, data: serializeSettings(updated) })
  } catch (error) {
    console.error('[email.intelligence-settings.put]', error)
    return NextResponse.json({ ok: false, error: 'Failed to update settings' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Email intelligence settings',
  description: 'Per-user email intelligence feature toggles (auto-create contacts, timeline tracking, engagement scoring, stage advancement).',
  methods: {
    GET: {
      summary: 'Get email intelligence settings',
      tags: ['Email'],
      responses: [{ status: 200, description: 'Settings', schema: z.object({ ok: z.literal(true), data: z.object({}) }) }],
    },
    PUT: {
      summary: 'Update email intelligence settings',
      tags: ['Email'],
      responses: [{ status: 200, description: 'Updated', schema: z.object({ ok: z.literal(true), data: z.object({}) }) }],
    },
  },
}
