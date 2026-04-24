import type { EntityManager } from '@mikro-orm/postgresql'
import { resolveNotificationService } from '@open-mercato/core/modules/notifications/lib/notificationService'
import { buildNotificationFromType } from '@open-mercato/core/modules/notifications/lib/notificationBuilder'
import { notificationTypes } from '../notifications'

export const metadata = {
  event: 'data_sync.run.failed',
  persistent: true,
  id: 'email:sync-failed-notification',
}

type SyncRunFailedPayload = {
  runId: string
  integrationId?: string | null
  entityType?: string | null
  direction?: string | null
  error?: string | null
  tenantId: string
  organizationId?: string | null
}

type ResolverContext = {
  resolve: <T = unknown>(name: string) => T
}

export default async function handle(payload: SyncRunFailedPayload, ctx: ResolverContext) {
  if (!payload?.runId || !payload?.tenantId) return
  try {
    const em = ctx.resolve<EntityManager>('em')
    const knex = em.getKnex()

    const org = await knex('organizations').where('id', payload.organizationId).first()
    const recipientUserId = org?.owner_user_id
      ?? (await knex('users').where('organization_id', payload.organizationId).whereNull('deleted_at').orderBy('created_at', 'asc').first())?.id
    if (!recipientUserId) return

    let integrationLabel = 'an integration'
    if (payload.integrationId) {
      try {
        const integration = await knex('integrations').where('id', payload.integrationId).first()
        integrationLabel = integration?.display_name || integration?.provider_key || integrationLabel
      } catch {}
    }

    const errorSnippet = (payload.error || 'unknown error').toString().slice(0, 160)

    const notificationService = resolveNotificationService(ctx)
    const typeDef = notificationTypes.find((t) => t.type === 'email.sync.failed')
    if (!typeDef) return

    const notificationInput = buildNotificationFromType(typeDef, {
      recipientUserId,
      bodyVariables: { integrationName: integrationLabel, error: errorSnippet },
      sourceEntityType: 'data_sync:run',
      sourceEntityId: payload.runId,
      linkHref: payload.integrationId
        ? `/backend/integrations/${payload.integrationId}`
        : '/backend/integrations',
      groupKey: payload.integrationId ? `sync-failed-${payload.integrationId}` : `sync-failed-${payload.runId}`,
    })

    await notificationService.create(notificationInput, {
      tenantId: payload.tenantId,
      organizationId: payload.organizationId ?? null,
    })
  } catch (err) {
    console.error('[email:sync-failed-notification] Failed:', err instanceof Error ? err.message : err)
  }
}
