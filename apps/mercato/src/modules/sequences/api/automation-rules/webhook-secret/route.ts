import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import {
  revealWebhookSecretOnce,
  rotateWebhookSecret,
  webhookSecretStatus,
} from '@/modules/sequences/lib/automation-webhook'

/**
 * The automation webhook signing secret (lib/automation-webhook.ts), for the
 * Webhook step in the automation builder.
 *
 * GET  -> { exists, createdAt, revealed }. Never the secret.
 * POST { action: 'rotate' } -> a new secret (the old one stops working), in
 *      the response and nowhere else, ever again.
 * POST { action: 'reveal' } -> a secret that was made on the spot by a
 *      webhook send and never shown, once. 409 when there is nothing to show.
 *
 * The caller's own organization and tenant only; managing automations is an
 * admin feature (sequences.manage).
 */
export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['sequences.manage'] },
  POST: { requireAuth: true, requireFeatures: ['sequences.manage'] },
}

type Ctx = { auth?: { tenantId?: string | null; orgId?: string | null } | null }

function scopeOf(ctx: Ctx | undefined): { organizationId: string; tenantId: string } | null {
  const auth = ctx?.auth
  if (!auth?.tenantId || !auth?.orgId) return null
  return { organizationId: auth.orgId, tenantId: auth.tenantId }
}

const noStore = { 'Cache-Control': 'no-store' }

export async function GET(_req: Request, ctx: Ctx) {
  const scope = scopeOf(ctx)
  if (!scope) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    return NextResponse.json({ ok: true, data: await webhookSecretStatus(knex, scope) }, { headers: noStore })
  } catch (err) {
    console.error('[automation-rules.webhook-secret] GET failed', err instanceof Error ? err.message : err)
    return NextResponse.json({ ok: false, error: 'Could not load the signing secret status' }, { status: 500 })
  }
}

export async function POST(req: Request, ctx: Ctx) {
  const scope = scopeOf(ctx)
  if (!scope) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({})) as { action?: unknown }
  const action = body?.action
  if (action !== 'rotate' && action !== 'reveal') {
    return NextResponse.json({ ok: false, error: "action must be 'rotate' or 'reveal'" }, { status: 400 })
  }
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    if (action === 'rotate') {
      const secret = await rotateWebhookSecret(knex, scope)
      return NextResponse.json({ ok: true, data: { secret, status: await webhookSecretStatus(knex, scope) } }, { headers: noStore })
    }
    const secret = await revealWebhookSecretOnce(knex, scope)
    if (!secret) {
      return NextResponse.json(
        { ok: false, error: 'This secret was already shown once. Replace it to get a new one.' },
        { status: 409, headers: noStore },
      )
    }
    return NextResponse.json({ ok: true, data: { secret, status: await webhookSecretStatus(knex, scope) } }, { headers: noStore })
  } catch (err) {
    console.error('[automation-rules.webhook-secret] POST failed', err instanceof Error ? err.message : err)
    return NextResponse.json({ ok: false, error: 'Could not update the signing secret' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Automation Rules',
  summary: 'Automation webhook signing secret',
  methods: {
    GET: { summary: 'Whether a webhook signing secret exists (never returns it)', tags: ['Automation Rules'] },
    POST: { summary: 'Replace the signing secret, or show a never-shown one once', tags: ['Automation Rules'] },
  },
}
