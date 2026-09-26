import type { EntityManager } from '@mikro-orm/postgresql'
import { dispatchAutomationTrigger, loadCompanyEventContext } from '../lib/automation-dispatch'

/**
 * A company was added (the Contacts page Companies tab, the companies API,
 * inbox actions): run `company_created` rules, once per company. The company
 * record is the rule's contact, so Send Email, Add Tag and Create Task act on
 * it. Undoing a delete re-emits the event for the same company; its key is
 * already claimed, so nothing runs twice.
 */
export const metadata = {
  event: 'customers.company.created',
  persistent: true,
  id: 'sequences:automation-company-created',
}

type Payload = { id?: string; organizationId?: string | null; tenantId?: string | null }

export default async function handler(payload: Payload, ctx: { resolve: <T = unknown>(name: string) => T }) {
  if (!payload?.id || !payload.organizationId || !payload.tenantId) return
  try {
    const knex = ctx.resolve<EntityManager>('em').getKnex()
    const scope = { organizationId: payload.organizationId, tenantId: payload.tenantId }
    const company = await loadCompanyEventContext(knex, scope, payload.id)
    if (!company) return
    await dispatchAutomationTrigger(knex, {
      ...scope,
      triggerType: 'company_created',
      eventKey: `company:${company.companyId}`,
      context: { contactId: company.companyId, companyId: company.companyId, source: company.source },
    })
  } catch (err) {
    console.error('[sequences.automation-company-created] dispatch failed', { companyId: payload.id, err })
  }
}
