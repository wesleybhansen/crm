/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server'
import { TRIGGERS } from '../../../pipeline_automation/triggers'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['pipeline_automation.configure'] },
}

export async function GET(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth?.orgId || !auth?.tenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const items = TRIGGERS.map((t) => ({
    key: t.key,
    eventId: t.eventId,
    label: t.label,
    description: t.description,
    supportedEntities: t.supportedEntities,
    filters: t.filterUiSchema,
  }))
  return NextResponse.json({ items })
}

export const openApi = {
  tags: ['Customers'],
  paths: {
    list: { summary: 'List supported pipeline automation triggers', description: 'Static catalog used by the settings UI.' },
  },
}
