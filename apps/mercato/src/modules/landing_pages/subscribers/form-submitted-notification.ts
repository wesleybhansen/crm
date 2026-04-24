import type { EntityManager } from '@mikro-orm/postgresql'
import { resolveNotificationService } from '@open-mercato/core/modules/notifications/lib/notificationService'
import { buildNotificationFromType } from '@open-mercato/core/modules/notifications/lib/notificationBuilder'
import { notificationTypes } from '../notifications'

export const metadata = {
  event: 'landing_pages.form.submitted',
  persistent: true,
  id: 'landing_pages:form-submitted-notification',
}

type FormSubmittedPayload = {
  tenantId: string
  organizationId?: string | null
  contactId?: string | null
  formId?: string | null
  landingPageId: string
  landingPageTitle?: string | null
  submitterName?: string | null
  isNewContact?: boolean
}

type ResolverContext = {
  resolve: <T = unknown>(name: string) => T
}

export default async function handle(payload: FormSubmittedPayload, ctx: ResolverContext) {
  if (!payload?.tenantId || !payload?.landingPageId) return
  if (payload.isNewContact) return
  try {
    const em = ctx.resolve<EntityManager>('em')
    const knex = em.getKnex()

    const org = await knex('organizations').where('id', payload.organizationId).first()
    const recipientUserId = org?.owner_user_id
      ?? (await knex('users').where('organization_id', payload.organizationId).whereNull('deleted_at').orderBy('created_at', 'asc').first())?.id
    if (!recipientUserId) return

    let pageTitle = payload.landingPageTitle || ''
    if (!pageTitle) {
      const page = await knex('landing_pages').where('id', payload.landingPageId).first()
      pageTitle = page?.title || 'your landing page'
    }

    let submitterName = payload.submitterName || 'A visitor'
    if (!payload.submitterName && payload.contactId) {
      const row = await knex('customer_entities')
        .where('id', payload.contactId)
        .where('organization_id', payload.organizationId ?? null)
        .first()
      if (row?.display_name) {
        let name = row.display_name
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
            name = (dec.display_name as string) || name
          }
        } catch {}
        submitterName = name
      }
    }

    const notificationService = resolveNotificationService(ctx)
    const typeDef = notificationTypes.find((t) => t.type === 'landing_pages.form.submitted')
    if (!typeDef) return

    const linkHref = payload.contactId
      ? `/backend/customers/people/${payload.contactId}`
      : `/backend/landing-pages/${payload.landingPageId}/submissions`

    const notificationInput = buildNotificationFromType(typeDef, {
      recipientUserId,
      bodyVariables: { submitterName, pageTitle },
      sourceEntityType: 'landing_pages:form_submission',
      sourceEntityId: payload.contactId || payload.landingPageId,
      linkHref,
      groupKey: payload.contactId ? `form-submit-${payload.formId ?? payload.landingPageId}-${payload.contactId}` : undefined,
    })

    await notificationService.create(notificationInput, {
      tenantId: payload.tenantId,
      organizationId: payload.organizationId ?? null,
    })
  } catch (err) {
    console.error('[landing_pages:form-submitted-notification] Failed:', err instanceof Error ? err.message : err)
  }
}
