import { NextResponse } from 'next/server'
import crypto from 'crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['integrations_api.access'] },
  PUT: { requireAuth: true, requireFeatures: ['integrations_api.access'] },
  POST: { requireAuth: true, requireFeatures: ['integrations_api.access'] },
  DELETE: { requireAuth: true, requireFeatures: ['integrations_api.access'] },
}

function getScope(ctx: any) {
  const auth = ctx?.auth
  if (!auth?.orgId) return null
  return { tenantId: auth.tenantId, orgId: auth.orgId }
}

// GET: Return AMS config status
export async function GET(req: Request, ctx: any) {
  const scope = getScope(ctx)
  if (!scope) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const profile = await knex('business_profiles').where('organization_id', scope.orgId).first()
    return NextResponse.json({
      ok: true,
      data: {
        connected: !!(profile?.ams_url && profile?.ams_webhook_secret),
        amsUrl: profile?.ams_url || null,
      },
    })
  } catch (error) {
    console.error('[ams.config.get]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

// PUT: Save AMS URL and generate webhook secret, register webhook subscriptions
export async function PUT(req: Request, ctx: any) {
  const scope = getScope(ctx)
  if (!scope) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { amsUrl } = body

    if (!amsUrl?.trim()) {
      return NextResponse.json({ ok: false, error: 'AMS URL is required' }, { status: 400 })
    }

    const cleanUrl = amsUrl.trim().replace(/\/$/, '')
    const webhookSecret = crypto.randomBytes(32).toString('hex')
    const webhookUrl = `${cleanUrl}/api/crm/webhook`

    await knex('business_profiles').where('organization_id', scope.orgId).update({
      ams_url: cleanUrl,
      ams_webhook_secret: webhookSecret,
    })

    // Register webhook subscriptions for all AMS-relevant events
    const amsEvents = [
      'contact.created',
      'deal.stage_changed',
      'email.opened',
      'email.bounced',
      'form.submitted',
    ]

    for (const event of amsEvents) {
      const existing = await knex('webhook_subscriptions')
        .where('organization_id', scope.orgId)
        .where('event', event)
        .where('target_url', webhookUrl)
        .first()

      if (!existing) {
        await knex('webhook_subscriptions').insert({
          id: crypto.randomUUID(),
          organization_id: scope.orgId,
          tenant_id: scope.tenantId,
          event,
          target_url: webhookUrl,
          secret: webhookSecret,
          is_active: true,
          created_at: new Date(),
          updated_at: new Date(),
        })
      } else {
        await knex('webhook_subscriptions')
          .where('id', existing.id)
          .update({ secret: webhookSecret, is_active: true, updated_at: new Date() })
      }
    }

    return NextResponse.json({
      ok: true,
      data: { amsUrl: cleanUrl, webhookSecret, webhookUrl },
    })
  } catch (error) {
    console.error('[ams.config.put]', error)
    return NextResponse.json({ ok: false, error: 'Failed to save AMS config' }, { status: 500 })
  }
}

// POST: Test the AMS connection
export async function POST(req: Request, ctx: any) {
  const scope = getScope(ctx)
  if (!scope) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const profile = await knex('business_profiles').where('organization_id', scope.orgId).first()

    if (!profile?.ams_url) {
      return NextResponse.json({ ok: false, error: 'AMS not configured' }, { status: 400 })
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)

    try {
      const res = await fetch(`${profile.ams_url}/api/crm/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'ping', data: { source: 'crm-test' }, timestamp: new Date().toISOString() }),
        signal: controller.signal,
      })
      clearTimeout(timeout)
      // AMS returns 400 for unknown events but that still means it's reachable
      if (res.status < 500) {
        return NextResponse.json({ ok: true, data: { connected: true } })
      }
      return NextResponse.json({ ok: false, error: `AMS returned ${res.status}` }, { status: 400 })
    } catch (fetchError: any) {
      clearTimeout(timeout)
      if (fetchError?.name === 'AbortError') {
        return NextResponse.json({ ok: false, error: 'Connection timed out' }, { status: 408 })
      }
      return NextResponse.json({ ok: false, error: 'Could not reach AMS' }, { status: 400 })
    }
  } catch (error) {
    console.error('[ams.config.test]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

// DELETE: Disconnect AMS
export async function DELETE(req: Request, ctx: any) {
  const scope = getScope(ctx)
  if (!scope) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const profile = await knex('business_profiles').where('organization_id', scope.orgId).first()
    if (profile?.ams_url) {
      const webhookUrl = `${profile.ams_url}/api/crm/webhook`
      await knex('webhook_subscriptions')
        .where('organization_id', scope.orgId)
        .where('target_url', webhookUrl)
        .update({ is_active: false, updated_at: new Date() })
    }

    await knex('business_profiles').where('organization_id', scope.orgId).update({
      ams_url: null,
      ams_webhook_secret: null,
    })

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[ams.config.delete]', error)
    return NextResponse.json({ ok: false, error: 'Failed to disconnect' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Integrations', summary: 'AMS integration config',
  methods: {
    GET: { summary: 'Get AMS connection status', tags: ['Integrations'] },
    PUT: { summary: 'Connect AMS', tags: ['Integrations'] },
    POST: { summary: 'Test AMS connection', tags: ['Integrations'] },
    DELETE: { summary: 'Disconnect AMS', tags: ['Integrations'] },
  },
}
