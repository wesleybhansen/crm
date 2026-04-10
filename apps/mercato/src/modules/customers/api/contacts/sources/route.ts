export const metadata = { GET: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // Source breakdown: group contacts by the `source` field
    const sourceBreakdown = await knex('customer_entities')
      .select('source')
      .count('* as count')
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .groupBy('source')
      .orderBy('count', 'desc')

    // UTM campaign breakdown from source_details JSONB
    const campaignBreakdown = await knex('customer_entities')
      .select(knex.raw("source_details->>'utm_campaign' as campaign"))
      .count('* as count')
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .whereNotNull('source_details')
      .whereRaw("source_details->>'utm_campaign' IS NOT NULL")
      .groupBy(knex.raw("source_details->>'utm_campaign'"))
      .orderBy('count', 'desc')

    // UTM source breakdown from source_details JSONB
    const utmSourceBreakdown = await knex('customer_entities')
      .select(knex.raw("source_details->>'utm_source' as utm_source"))
      .count('* as count')
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .whereNotNull('source_details')
      .whereRaw("source_details->>'utm_source' IS NOT NULL")
      .groupBy(knex.raw("source_details->>'utm_source'"))
      .orderBy('count', 'desc')

    // UTM medium breakdown
    const utmMediumBreakdown = await knex('customer_entities')
      .select(knex.raw("source_details->>'utm_medium' as utm_medium"))
      .count('* as count')
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .whereNotNull('source_details')
      .whereRaw("source_details->>'utm_medium' IS NOT NULL")
      .groupBy(knex.raw("source_details->>'utm_medium'"))
      .orderBy('count', 'desc')

    // Landing page breakdown
    const landingPageBreakdown = await knex('customer_entities')
      .select(knex.raw("source_details->>'landing_page' as landing_page"))
      .count('* as count')
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .whereNotNull('source_details')
      .whereRaw("source_details->>'landing_page' IS NOT NULL")
      .groupBy(knex.raw("source_details->>'landing_page'"))
      .orderBy('count', 'desc')

    return NextResponse.json({
      ok: true,
      data: {
        sources: sourceBreakdown.map((row: Record<string, unknown>) => ({
          source: row.source || 'unknown',
          count: Number(row.count),
        })),
        campaigns: campaignBreakdown.map((row: Record<string, unknown>) => ({
          campaign: row.campaign,
          count: Number(row.count),
        })),
        utmSources: utmSourceBreakdown.map((row: Record<string, unknown>) => ({
          utmSource: row.utm_source,
          count: Number(row.count),
        })),
        utmMediums: utmMediumBreakdown.map((row: Record<string, unknown>) => ({
          utmMedium: row.utm_medium,
          count: Number(row.count),
        })),
        landingPages: landingPageBreakdown.map((row: Record<string, unknown>) => ({
          landingPage: row.landing_page,
          count: Number(row.count),
        })),
      },
    })
  } catch (error) {
    console.error('[contacts.sources]', error)
    return NextResponse.json({ ok: false, error: 'Failed to fetch source data' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Contacts',
  summary: 'Lead source & UTM attribution breakdown',
  methods: { GET: { summary: 'Get contact source and UTM campaign breakdown', tags: ['Contacts'] } },
}
