import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export const metadata = {
  path: '/ext/deals',
  GET: { requireAuth: true, requireFeatures: ['integrations_api.access'] },
  PUT: { requireAuth: true, requireFeatures: ['integrations_api.access'] },
}

export async function GET(req: Request, ctx: any) {
  const auth = ctx?.auth
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const url = new URL(req.url)

    const stage = url.searchParams.get('stage')
    const status = url.searchParams.get('status')
    const page = parseInt(url.searchParams.get('page') || '1')
    const pageSize = Math.min(parseInt(url.searchParams.get('pageSize') || '50'), 100)

    let query = knex('customer_deals')
      .where('tenant_id', auth.tenantId)
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')

    if (stage) query = query.where('pipeline_stage', stage)
    if (status) query = query.where('status', status)

    const [{ count }] = await query.clone().count()
    const deals = await query.select('*').orderBy('created_at', 'desc').limit(pageSize).offset((page - 1) * pageSize)

    return NextResponse.json({ ok: true, data: deals, pagination: { page, pageSize, total: Number(count) } })
  } catch (error) {
    console.error('[ext.deals.list]', error)
    return NextResponse.json({ ok: false, error: 'Failed to list deals' }, { status: 500 })
  }
}

export async function PUT(req: Request, ctx: any) {
  const auth = ctx?.auth
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const body = await req.json()
    const { id, pipeline_stage, status } = body

    if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })

    const deal = await knex('customer_deals')
      .where('id', id)
      .where('tenant_id', auth.tenantId)
      .where('organization_id', auth.orgId)
      .first()
    if (!deal) return NextResponse.json({ ok: false, error: 'Deal not found' }, { status: 404 })

    const updates: Record<string, unknown> = { updated_at: new Date() }
    if (pipeline_stage !== undefined) updates.pipeline_stage = pipeline_stage
    if (status !== undefined) updates.status = status

    await knex('customer_deals').where('id', id).update(updates)

    // Emit stage_changed event so notification subscribers + webhooks fire.
    // The full CRUD command emits this, but this ext route bypasses that
    // path — so the pipeline drag-drop (which hits here) wouldn't trigger
    // notifications without this explicit emission.
    if (pipeline_stage !== undefined && pipeline_stage !== deal.pipeline_stage) {
      try {
        const bus = container.resolve('eventBus') as any
        if (bus?.emitEvent) {
          await bus.emitEvent('customers.deal.stage_changed', {
            id,
            organizationId: auth.orgId,
            tenantId: auth.tenantId,
            title: deal.title,
            stage: pipeline_stage,
            previousStage: deal.pipeline_stage,
            status: status ?? deal.status,
          }, { persistent: true })
        }
      } catch {}
    }

    // Affiliate deal-win attribution: when the deal transitions to won,
    // convert any pending affiliate referral for the deal's linked contacts
    // using the deal value. Non-fatal by design.
    const winStatuses = ['win', 'won']
    const wasWon = winStatuses.includes(String(deal.status || '').toLowerCase())
    const stageLooksWon = pipeline_stage !== undefined
      && /\b(won|closed[\s_-]*won)\b/i.test(String(pipeline_stage))
    // A win is: status flipped to won, OR the deal was dragged into a
    // won-named pipeline stage (the primary way deals close in the UI, which
    // sends pipeline_stage but no status).
    const becameWon = !wasWon
      && ((status !== undefined && winStatuses.includes(String(status).toLowerCase())) || stageLooksWon)
    if (becameWon) {
      try {
        const { attributeDealWin } = await import('@/modules/customers/api/affiliates/deal-attribution')
        const dealValue = Number(deal.value_amount) || 0
        const people = await knex('customer_deal_people as cdp')
          .join('customer_entities as ce', 'ce.id', 'cdp.person_entity_id')
          .where('cdp.deal_id', id)
          .where('ce.organization_id', auth.orgId)
          .whereNull('ce.deleted_at')
          .select('ce.id', 'ce.primary_email')
          .limit(10)
        // One deal pays ONE commission: stop at the first linked contact whose
        // referral actually converts (else a multi-contact deal pays 2-3x).
        for (const person of people) {
          const converted = await attributeDealWin(knex, auth.orgId, auth.tenantId, {
            contactId: person.id,
            email: person.primary_email || null,
            dealValue,
          })
          if (converted) break
        }
      } catch (attrErr) {
        console.error('[ext.deals.update] affiliate deal-win attribution failed (non-fatal):', attrErr)
      }
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[ext.deals.update]', error)
    return NextResponse.json({ ok: false, error: 'Failed to update deal' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'External API', summary: 'Deals (external)',
  methods: { GET: { summary: 'List deals', tags: ['External API'] } },
}
