import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { randomUUID } from 'node:crypto'

function parseArgs(rest: string[]): Record<string, string> {
  const args: Record<string, string> = {}
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.replace(/^--/, '')
    const value = rest[i + 1]
    if (key) args[key] = value ?? ''
  }
  return args
}

const testNotifications: ModuleCli = {
  command: 'test-notifications',
  async run(rest) {
    const args = parseArgs(rest)
    const orgId = args.orgId || args.organizationId
    const tenantId = args.tenantId

    if (!orgId || !tenantId) {
      console.error('Usage: mercato payments test-notifications --orgId <uuid> --tenantId <uuid>')
      console.error('')
      console.error('Fires synthetic payment.captured, payment.failed, and data_sync.run.failed events')
      console.error('against your org so the bell subscribers produce real notifications in the DB.')
      return
    }

    const { resolve } = await createRequestContainer()
    const em = resolve('em') as any
    const knex = em.getKnex()
    const bus = resolve('eventBus') as any

    const org = await knex('organizations').where('id', orgId).first()
    if (!org) {
      console.error('Organization not found:', orgId)
      return
    }

    const txId = randomUUID()
    const runId = randomUUID()

    console.log('[1/3] Inserting synthetic gateway_transactions row…')
    await knex('gateway_transactions').insert({
      id: txId,
      tenant_id: tenantId,
      organization_id: orgId,
      provider_key: 'stripe',
      payment_id: randomUUID(),
      amount: '49.99',
      currency_code: 'USD',
      unified_status: 'captured',
      gateway_status: 'succeeded',
      created_at: new Date(),
      updated_at: new Date(),
    })

    console.log('[2/3] Emitting payment_gateways.payment.captured…')
    await bus.emitEvent('payment_gateways.payment.captured', {
      transactionId: txId,
      paymentId: null,
      providerKey: 'stripe',
      organizationId: orgId,
      tenantId,
    }, { persistent: true })

    console.log('[2/3] Emitting payment_gateways.payment.failed…')
    await bus.emitEvent('payment_gateways.payment.failed', {
      transactionId: txId,
      paymentId: null,
      providerKey: 'stripe',
      organizationId: orgId,
      tenantId,
    }, { persistent: true })

    console.log('[3/3] Emitting data_sync.run.failed…')
    await bus.emitEvent('data_sync.run.failed', {
      runId,
      integrationId: null,
      entityType: 'email',
      direction: 'inbound',
      error: 'Synthetic test — gmail token invalid',
      tenantId,
      organizationId: orgId,
    }, { persistent: true })

    // Let persistent subscribers drain before we clean up the temp row.
    await new Promise((r) => setTimeout(r, 2500))

    console.log('Cleaning up synthetic gateway_transactions row…')
    await knex('gateway_transactions').where('id', txId).delete()

    console.log('')
    console.log('Done. Check the bell for:')
    console.log('  • Payment received — You received $49.99 via stripe')
    console.log('  • Payment failed — A $49.99 charge via stripe failed')
    console.log('  • Email sync failed — Sync with an integration failed — Synthetic test…')
  },
}

export default [testNotifications]
