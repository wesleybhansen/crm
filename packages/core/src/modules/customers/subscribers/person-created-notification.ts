/**
 * Fires when a customer (person) is created by any path — manual add, Scout,
 * Blog-Ops API ingress, form submission, landing page, course enrollment,
 * booking page, CSV import, etc. Surfaces it in the user's notification bell
 * with the source tag so "where did this lead come from?" is one click away.
 */
import type { EntityManager } from '@mikro-orm/postgresql'
import { resolveNotificationService } from '../../notifications/lib/notificationService'
import { buildNotificationFromType } from '../../notifications/lib/notificationBuilder'
import { notificationTypes } from '../notifications'

export const metadata = {
  event: 'customers.person.created',
  persistent: true,
  id: 'customers:person-created-notification',
}

type PersonCreatedPayload = {
  id: string
  tenantId: string
  organizationId?: string | null
}

type ResolverContext = {
  resolve: <T = unknown>(name: string) => T
}

export default async function handle(payload: PersonCreatedPayload, ctx: ResolverContext) {
  if (!payload?.id || !payload?.tenantId) return
  try {
    const em = ctx.resolve<EntityManager>('em')
    const knex = em.getKnex()

    // Pull the org owner — notifications go to them. If there's no explicit
    // owner_user_id, fall back to the first admin user for the org.
    const org = await knex('organizations').where('id', payload.organizationId).first()
    const recipientUserId = org?.owner_user_id
      ?? (await knex('users').where('organization_id', payload.organizationId).whereNull('deleted_at').orderBy('created_at', 'asc').first())?.id
    if (!recipientUserId) return

    // Grab the contact row for display name + source attribution
    const row = await knex('customer_entities')
      .where('id', payload.id)
      .where('organization_id', payload.organizationId ?? null)
      .first()
    if (!row) return

    // Decrypt display_name if encryption is on
    let contactName = row.display_name || 'New contact'
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

    // Look up source tag (from #35) for the contact — most recent source-
    // prefixed tag wins. Added as a friendly "from X" suffix on the body.
    let sourceLabel = ''
    try {
      const srcTag = await knex('customer_tag_assignments as a')
        .join('customer_tags as t', 't.id', 'a.tag_id')
        .where('a.entity_id', payload.id)
        .where('t.slug', 'like', 'source-%')
        .orderBy('a.created_at', 'desc')
        .select('t.label')
        .first()
      if (srcTag?.label) {
        const cleaned = String(srcTag.label).replace(/^source:/, '')
        sourceLabel = cleaned ? `from ${cleaned}` : ''
      }
    } catch {}

    const notificationService = resolveNotificationService(ctx)
    const typeDef = notificationTypes.find((t) => t.type === 'customers.person.created')
    if (!typeDef) return

    const notificationInput = buildNotificationFromType(typeDef, {
      recipientUserId,
      bodyVariables: { contactName, sourceLabel },
      sourceEntityType: 'customers:customer_entity',
      sourceEntityId: payload.id,
      linkHref: `/backend/customers/people/${payload.id}`,
    })

    await notificationService.create(notificationInput, {
      tenantId: payload.tenantId,
      organizationId: payload.organizationId ?? null,
    })
  } catch (err) {
    // Notification failures must not block upstream work
    console.error('[customers:person-created-notification] Failed:', err instanceof Error ? err.message : err)
  }
}
