import type { EntityManager } from '@mikro-orm/postgresql'
import { resolveNotificationService } from '@open-mercato/core/modules/notifications/lib/notificationService'
import { buildNotificationFromType } from '@open-mercato/core/modules/notifications/lib/notificationBuilder'
import { notificationTypes } from '../notifications'

export const metadata = {
  event: 'payment_gateways.payment.captured',
  persistent: true,
  id: 'payments:payment-captured-notification',
}

type PaymentCapturedPayload = {
  transactionId: string
  paymentId?: string | null
  providerKey?: string | null
  organizationId: string
  tenantId: string
}

type ResolverContext = {
  resolve: <T = unknown>(name: string) => T
}

function formatAmount(amount: string | number | null | undefined, currency: string | null | undefined): string {
  if (amount == null) return ''
  const num = typeof amount === 'string' ? Number(amount) : amount
  if (!Number.isFinite(num)) return ''
  const cur = (currency || 'USD').toUpperCase()
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(num)
  } catch {
    return `${num.toFixed(2)} ${cur}`
  }
}

export default async function handle(payload: PaymentCapturedPayload, ctx: ResolverContext) {
  if (!payload?.transactionId || !payload?.tenantId) return
  try {
    const em = ctx.resolve<EntityManager>('em')
    const knex = em.getKnex()

    const tx = await knex('gateway_transactions')
      .where('id', payload.transactionId)
      .where('organization_id', payload.organizationId)
      .first()
    if (!tx) return

    const org = await knex('organizations').where('id', payload.organizationId).first()
    const recipientUserId = org?.owner_user_id
      ?? (await knex('users').where('organization_id', payload.organizationId).whereNull('deleted_at').orderBy('created_at', 'asc').first())?.id
    if (!recipientUserId) return

    const amountLabel = formatAmount(tx.amount, tx.currency_code)
    const providerLabel = payload.providerKey || tx.provider_key || 'Payment gateway'

    const notificationService = resolveNotificationService(ctx)
    const typeDef = notificationTypes.find((t) => t.type === 'payments.payment.received')
    if (!typeDef) return

    const notificationInput = buildNotificationFromType(typeDef, {
      recipientUserId,
      bodyVariables: { amount: amountLabel, provider: providerLabel },
      sourceEntityType: 'payment_gateways:transaction',
      sourceEntityId: payload.transactionId,
      linkHref: '/backend/payments',
      groupKey: `payment-captured-${payload.transactionId}`,
    })

    await notificationService.create(notificationInput, {
      tenantId: payload.tenantId,
      organizationId: payload.organizationId,
    })
  } catch (err) {
    console.error('[payments:payment-captured-notification] Failed:', err instanceof Error ? err.message : err)
  }
}
