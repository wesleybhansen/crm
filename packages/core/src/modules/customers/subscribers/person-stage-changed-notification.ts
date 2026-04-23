/**
 * Customer Journey mode stage changes — fired by /api/pipeline/journey PUT
 * whenever a contact's lifecycle_stage changes (either via drag-drop on
 * the Journey board or via Scout's move_contact_stage tool).
 *
 * Deal-mode stage changes have their own subscriber at
 * deal-stage-changed-notification.ts.
 */
import type { EntityManager } from '@mikro-orm/postgresql'
import { resolveNotificationService } from '../../notifications/lib/notificationService'
import { buildNotificationFromType } from '../../notifications/lib/notificationBuilder'
import { notificationTypes } from '../notifications'

export const metadata = {
  event: 'customers.person.stage_changed',
  persistent: true,
  id: 'customers:person-stage-changed-notification',
}

type PersonStageChangedPayload = {
  id: string
  organizationId?: string | null
  tenantId: string
  stage?: string | null
  previousStage?: string | null
}

type ResolverContext = {
  resolve: <T = unknown>(name: string) => T
}

export default async function handle(payload: PersonStageChangedPayload, ctx: ResolverContext) {
  if (!payload?.id || !payload?.tenantId) return
  // Clearing the stage (remove_contact_from_pipeline) is a different action
  // than moving between stages — skip the notification for explicit removals
  // to avoid noise; the UI already shows them disappearing from the board.
  if (!payload.stage) return

  try {
    const em = ctx.resolve<EntityManager>('em')
    const knex = em.getKnex()

    const org = await knex('organizations').where('id', payload.organizationId).first()
    const recipientUserId = org?.owner_user_id
      ?? (await knex('users').where('organization_id', payload.organizationId).whereNull('deleted_at').orderBy('created_at', 'asc').first())?.id
    if (!recipientUserId) return

    // Decrypt display_name — the contact row's name is encrypted at rest.
    const row = await knex('customer_entities')
      .where('id', payload.id)
      .where('organization_id', payload.organizationId ?? null)
      .first()
    if (!row) return

    let contactName = row.display_name || 'Contact'
    try {
      const { TenantDataEncryptionService } = await import('@open-mercato/shared/lib/encryption/tenantDataEncryptionService')
      const { isTenantDataEncryptionEnabled } = await import('@open-mercato/shared/lib/encryption/toggles')
      const { createKmsService } = await import('@open-mercato/shared/lib/encryption/kms')
      if (isTenantDataEncryptionEnabled()) {
        const svc = new TenantDataEncryptionService(em as any, { kms: createKmsService() })
        const dec = await svc.decryptEntityPayload(
          'customers:customer_entity',
          { display_name: row.display_name },
          payload.tenantId,
          payload.organizationId ?? null,
        )
        contactName = (dec.display_name as string) || contactName
      }
    } catch {}

    const notificationService = resolveNotificationService(ctx)
    const typeDef = notificationTypes.find((t) => t.type === 'customers.person.stage_changed')
    if (!typeDef) return

    const notificationInput = buildNotificationFromType(typeDef, {
      recipientUserId,
      bodyVariables: { contactName, stage: payload.stage },
      sourceEntityType: 'customers:customer_entity',
      sourceEntityId: payload.id,
      linkHref: `/backend/customers/people/${payload.id}`,
      // Rapid back-and-forth moves collapse into one bell entry
      groupKey: `person-stage-${payload.id}`,
    })

    await notificationService.create(notificationInput, {
      tenantId: payload.tenantId,
      organizationId: payload.organizationId ?? null,
    })
  } catch (err) {
    console.error('[customers:person-stage-changed-notification] Failed:', err instanceof Error ? err.message : err)
  }
}
