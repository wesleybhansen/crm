import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { TenantDataEncryptionService } from '@open-mercato/shared/lib/encryption/tenantDataEncryptionService'
import { isTenantDataEncryptionEnabled } from '@open-mercato/shared/lib/encryption/toggles'
import { createKmsService } from '@open-mercato/shared/lib/encryption/kms'
import { decryptRowFields, CONTACT_ENTITY_KEY } from '@open-mercato/shared/lib/encryption/decryptRows'
import { isEncryptedEnvelope } from '@open-mercato/shared/lib/encryption/envelopeFormat'
import {
  canonicalDealStatus,
  dealStatusOutcome,
  statusForStageMove,
} from '@open-mercato/core/modules/customers/lib/dealStatus'

type Knex = ReturnType<EntityManager['getKnex']>

/**
 * The bell notification for a deal that just became won or lost, as the deal
 * command sends it. Goes to the deal's owner, else to the organization owner
 * (who got the stage-changed bell for this drag before won/lost set the
 * status). Never throws.
 */
async function notifyDealOutcome(
  container: { resolve: (name: string) => unknown },
  knex: Knex,
  deal: {
    id: string
    organizationId: string
    tenantId: string
    outcome: 'won' | 'lost' | 'open'
    title: string | null
    ownerUserId: string | null
    valueAmount: string | number | null
    valueCurrency: string | null
  },
): Promise<void> {
  if (deal.outcome === 'open') return
  try {
    let recipientUserId = deal.ownerUserId
    if (!recipientUserId) {
      const org = await knex('organizations').where('id', deal.organizationId).first('owner_user_id')
      recipientUserId = org?.owner_user_id ?? null
    }
    if (!recipientUserId) {
      const first = await knex('users')
        .where('organization_id', deal.organizationId)
        .whereNull('deleted_at')
        .orderBy('created_at', 'asc')
        .first('id')
      recipientUserId = first?.id ?? null
    }
    if (!recipientUserId) return
    const [{ resolveNotificationService }, { buildNotificationFromType }, { notificationTypes }] = await Promise.all([
      import('@open-mercato/core/modules/notifications/lib/notificationService'),
      import('@open-mercato/core/modules/notifications/lib/notificationBuilder'),
      import('@open-mercato/core/modules/customers/notifications'),
    ])
    const type = deal.outcome === 'won' ? 'customers.deal.won' : 'customers.deal.lost'
    const typeDef = notificationTypes.find((entry) => entry.type === type)
    if (!typeDef) return
    const valueDisplay = deal.valueAmount && deal.valueCurrency ? `${deal.valueCurrency} ${deal.valueAmount}` : ''
    const input = buildNotificationFromType(typeDef, {
      recipientUserId,
      bodyVariables: { dealTitle: deal.title || 'Deal', dealValue: valueDisplay },
      sourceEntityType: 'customers:customer_deal',
      sourceEntityId: deal.id,
      linkHref: `/backend/customers/deals/${deal.id}`,
    })
    await resolveNotificationService(container).create(input, {
      tenantId: deal.tenantId,
      organizationId: deal.organizationId,
    })
  } catch (err) {
    console.error('[ext.deals.update] won/lost notification failed (non-fatal):', err instanceof Error ? err.message : err)
  }
}

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
    // `status` may list several values: `status=win,lost`.
    if (status) {
      const statuses = status.split(',').map((value) => value.trim()).filter(Boolean)
      query = statuses.length > 1 ? query.whereIn('status', statuses) : query.where('status', statuses[0] ?? status)
    }

    const [{ count }] = await query.clone().count()
    const deals = await query.select('*').orderBy('created_at', 'desc').limit(pageSize).offset((page - 1) * pageSize)

    // Deal title/description are encrypted at rest and this route reads through
    // raw knex, which skips the ORM subscriber that would decrypt them. Without
    // this, every consumer of the external API (the Chief of Staff included)
    // gets `iv:ct:tag:v1` ciphertext where the deal name should be.
    if (isTenantDataEncryptionEnabled() && auth.tenantId) {
      const svc = new TenantDataEncryptionService(em as any, { kms: createKmsService() })
      for (const deal of deals) {
        try {
          const { payload: dec } = await svc.decryptEntityPayloadForDisplay(
            'customers:customer_deal',
            { title: deal.title, description: deal.description },
            auth.tenantId,
            auth.orgId,
          )
          deal.title = dec.title ?? deal.title
          deal.description = dec.description ?? deal.description
        } catch {
          /* leave the stored value alone: a single unreadable row must not fail the page */
        }
      }
    }

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

    // The status this write stores. A sent status is stored in its canonical
    // spelling ('won' -> 'win', 'loose'/'lose' -> 'lost', the values reports
    // count). A move with no status takes the stage's meaning: into a won
    // stage marks the deal won, into a lost stage lost, and back to an
    // ordinary stage reopens it. The pipeline board sends only the stage.
    let nextStatus: unknown = status
    if (typeof status === 'string') {
      nextStatus = canonicalDealStatus(status)
    } else if (status === undefined && pipeline_stage !== undefined) {
      nextStatus = statusForStageMove(deal.status ?? null, pipeline_stage) ?? undefined
    }
    const finalStatus = nextStatus !== undefined ? nextStatus : (deal.status ?? null)
    const finalStage = pipeline_stage !== undefined ? pipeline_stage : (deal.pipeline_stage ?? null)

    const updates: Record<string, unknown> = { updated_at: new Date() }
    if (pipeline_stage !== undefined) updates.pipeline_stage = pipeline_stage
    if (nextStatus !== undefined) updates.status = nextStatus

    await knex('customer_deals')
      .where('id', id)
      .where('tenant_id', auth.tenantId)
      .where('organization_id', auth.orgId)
      .update(updates)

    const stageChanged = pipeline_stage !== undefined && pipeline_stage !== deal.pipeline_stage
    const previousOutcome = dealStatusOutcome(deal.status ?? null)
    const nextOutcome = dealStatusOutcome(typeof finalStatus === 'string' ? finalStatus : null)
    const outcomeChanged = nextOutcome !== previousOutcome && nextOutcome !== 'open'

    // deal.title is encrypted at rest and this is a raw read; the events and
    // notifications below show it (deal-stage-webhook sends it as `name`), so
    // decrypt it once and never ship ciphertext.
    let title: string | null = null
    if (stageChanged || outcomeChanged) {
      try {
        const { DEAL_ENTITY_KEY } = await import('@open-mercato/shared/lib/encryption/decryptRows')
        const { UNDECRYPTABLE_DISPLAY_TEXT } = await import('@open-mercato/shared/lib/encryption/tenantDataEncryptionService')
        const titled: { title: unknown } = { title: deal.title }
        await decryptRowFields(em, DEAL_ENTITY_KEY, [titled], ['title'], auth.tenantId, auth.orgId)
        title = typeof titled.title === 'string' && !isEncryptedEnvelope(titled.title)
          && titled.title !== UNDECRYPTABLE_DISPLAY_TEXT ? titled.title : null
      } catch {}
    }

    // Emit stage_changed event so notification subscribers + webhooks fire.
    // The full CRUD command emits this, but this ext route bypasses that
    // path — so the pipeline drag-drop (which hits here) wouldn't trigger
    // notifications without this explicit emission.
    if (stageChanged) {
      try {
        const bus = container.resolve('eventBus') as any
        if (bus?.emitEvent) {
          await bus.emitEvent('customers.deal.stage_changed', {
            id,
            organizationId: auth.orgId,
            tenantId: auth.tenantId,
            title,
            stage: pipeline_stage,
            previousStage: deal.pipeline_stage,
            status: finalStatus,
            changedAt: new Date().toISOString(),
          }, { persistent: true })
        }
      } catch {}
    }

    // Won/lost get their own bell notification (the stage-changed one skips
    // them, expecting the deal command to send it; this route bypasses the
    // command, so it sends it here).
    if (outcomeChanged) {
      await notifyDealOutcome(container, knex, {
        id,
        organizationId: auth.orgId,
        tenantId: auth.tenantId,
        outcome: nextOutcome,
        title,
        ownerUserId: deal.owner_user_id ?? null,
        valueAmount: deal.value_amount ?? null,
        valueCurrency: deal.value_currency ?? null,
      })
    }

    // One `customers.deal.closed` per move into a won/closed status or stage
    // (the marketing app's "just closed" handoff listens for it).
    // Likewise one `customers.deal.lost` per move into a lost status or stage
    // (automations with a "Deal Lost" trigger run on it).
    try {
      const { emitDealClosedIfTransitioned, emitDealLostIfTransitioned } = await import('@open-mercato/core/modules/customers/lib/dealClosed')
      const bus = container.resolve('eventBus') as Parameters<typeof emitDealClosedIfTransitioned>[0]
      const transition = {
        id,
        organizationId: auth.orgId,
        tenantId: auth.tenantId,
        before: { status: deal.status ?? null, pipelineStage: deal.pipeline_stage ?? null },
        after: {
          status: typeof finalStatus === 'string' ? finalStatus : null,
          pipelineStage: finalStage,
        },
      }
      await emitDealClosedIfTransitioned(bus, transition)
      await emitDealLostIfTransitioned(bus, transition)
    } catch {}

    // Affiliate deal-win attribution: when the deal transitions to won,
    // convert any pending affiliate referral for the deal's linked contacts
    // using the deal value. Non-fatal by design.
    const wasWon = previousOutcome === 'won'
    const stageLooksWon = pipeline_stage !== undefined
      && /\b(won|closed[\s_-]*won)\b/i.test(String(pipeline_stage))
    // A win is: status flipped to won (sent, or implied by a drag into a won
    // stage, the primary way deals close in the UI), OR a won-named stage
    // alongside an explicit non-won status.
    const becameWon = !wasWon && (nextOutcome === 'won' || stageLooksWon)
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
        // primary_email is encrypted at rest; the referral fallback compares
        // it with referred_email, so it must be the plaintext address.
        await decryptRowFields(em, CONTACT_ENTITY_KEY, people, ['primary_email'], auth.tenantId, auth.orgId)
        // One deal pays ONE commission: stop at the first linked contact whose
        // referral actually converts (else a multi-contact deal pays 2-3x).
        for (const person of people) {
          const converted = await attributeDealWin(knex, auth.orgId, auth.tenantId, {
            contactId: person.id,
            email: person.primary_email && !isEncryptedEnvelope(person.primary_email) ? person.primary_email : null,
            dealValue,
          })
          if (converted) break
        }
      } catch (attrErr) {
        console.error('[ext.deals.update] affiliate deal-win attribution failed (non-fatal):', attrErr)
      }
    }

    return NextResponse.json({
      ok: true,
      data: { id, pipeline_stage: finalStage, status: finalStatus },
    })
  } catch (error) {
    console.error('[ext.deals.update]', error)
    return NextResponse.json({ ok: false, error: 'Failed to update deal' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'External API', summary: 'Deals (external)',
  methods: { GET: { summary: 'List deals', tags: ['External API'] } },
}
