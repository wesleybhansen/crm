import { NextResponse } from 'next/server'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { WEBHOOK_EVENTS } from '../../lib/eventRegistry'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['webhooks.view'] },
}

/** Returns the allow-list of webhook events the CRM can dispatch. */
export async function GET() {
  return NextResponse.json({
    ok: true,
    data: WEBHOOK_EVENTS.map((e) => ({
      id: e.id,
      label: e.label,
      category: e.category,
      description: e.description,
    })),
  })
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Webhooks',
  summary: 'Discoverable webhook event catalog',
  methods: { GET: { summary: 'List all events a subscription can listen to', tags: ['Webhooks'] } },
}
