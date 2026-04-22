/**
 * Surfaces deal stage transitions in the notification bell so the user can
 * see Scout (or anyone else) moving deals through the pipeline in real time.
 * Won/Lost status changes already have their own dedicated notifications
 * from the deal command — we skip those here to avoid duplicates.
 */
import type { EntityManager } from '@mikro-orm/postgresql'
import { resolveNotificationService } from '../../notifications/lib/notificationService'
import { buildNotificationFromType } from '../../notifications/lib/notificationBuilder'
import { notificationTypes } from '../notifications'

export const metadata = {
  event: 'customers.deal.stage_changed',
  persistent: true,
  id: 'customers:deal-stage-changed-notification',
}

type DealStageChangedPayload = {
  id: string
  organizationId?: string | null
  tenantId: string
  title?: string | null
  stage?: string | null
  previousStage?: string | null
  status?: string | null
}

type ResolverContext = {
  resolve: <T = unknown>(name: string) => T
}

export default async function handle(payload: DealStageChangedPayload, ctx: ResolverContext) {
  if (!payload?.id || !payload?.tenantId) return
  // Won/Lost get their own dedicated notification from the deal command
  const normalized = payload.status === 'win' ? 'won' : payload.status === 'loose' ? 'lost' : payload.status
  if (normalized === 'won' || normalized === 'lost') return
  if (!payload.stage) return

  try {
    const em = ctx.resolve<EntityManager>('em')
    const knex = em.getKnex()

    const org = await knex('organizations').where('id', payload.organizationId).first()
    const recipientUserId = org?.owner_user_id
      ?? (await knex('users').where('organization_id', payload.organizationId).whereNull('deleted_at').orderBy('created_at', 'asc').first())?.id
    if (!recipientUserId) return

    // Decrypt the deal title if encryption is on — raw payload.title is
    // ciphertext when the title was written via the encrypted ORM path.
    let dealTitle = payload.title || 'Deal'
    try {
      const { TenantDataEncryptionService } = await import('@open-mercato/shared/lib/encryption/tenantDataEncryptionService')
      const { isTenantDataEncryptionEnabled } = await import('@open-mercato/shared/lib/encryption/toggles')
      const { createKmsService } = await import('@open-mercato/shared/lib/encryption/kms')
      if (isTenantDataEncryptionEnabled() && payload.title) {
        const svc = new TenantDataEncryptionService(em as any, { kms: createKmsService() })
        const dec = await svc.decryptEntityPayload(
          'customers:customer_deal',
          { title: payload.title },
          payload.tenantId,
          payload.organizationId ?? null,
        )
        dealTitle = (dec.title as string) || dealTitle
      }
    } catch {}

    const notificationService = resolveNotificationService(ctx)
    const typeDef = notificationTypes.find((t) => t.type === 'customers.deal.stage_changed')
    if (!typeDef) return

    const notificationInput = buildNotificationFromType(typeDef, {
      recipientUserId,
      bodyVariables: { dealTitle, stage: payload.stage },
      sourceEntityType: 'customers:customer_deal',
      sourceEntityId: payload.id,
      linkHref: `/backend/customers/deals/${payload.id}`,
      // Dedupe: rapid back-and-forth stage changes collapse into one entry
      groupKey: `deal-stage-${payload.id}`,
    })

    await notificationService.create(notificationInput, {
      tenantId: payload.tenantId,
      organizationId: payload.organizationId ?? null,
    })
  } catch (err) {
    console.error('[customers:deal-stage-changed-notification] Failed:', err instanceof Error ? err.message : err)
  }
}
