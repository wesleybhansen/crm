import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { seedCustomerDictionaries, seedCurrencyDictionary, seedCustomerExamples, seedDefaultPipeline } from './cli'
import { seedDefaultRulesForOrg } from './pipeline_automation/seed'

export const setup: ModuleSetupConfig = {
  seedDefaults: async (ctx) => {
    const scope = { tenantId: ctx.tenantId, organizationId: ctx.organizationId }
    await seedCustomerDictionaries(ctx.em, scope)
    await seedCurrencyDictionary(ctx.em, scope)
    await seedDefaultPipeline(ctx.em, scope)
    // SPEC-064 — Seed default pipeline automation rules (idempotent: skips if any rules exist)
    await seedDefaultRulesForOrg((ctx.em as any).getKnex(), scope)
  },

  seedExamples: async (ctx) => {
    const scope = { tenantId: ctx.tenantId, organizationId: ctx.organizationId }
    await seedCustomerExamples(ctx.em, ctx.container, scope)
  },

  defaultRoleFeatures: {
    admin: [
      'customers.*',
      'customers.people.view',
      'customers.people.manage',
      'customers.companies.view',
      'customers.companies.manage',
      'customers.deals.view',
      'customers.deals.manage',
      'customers.pipelines.view',
      'customers.pipelines.manage',
      // SPEC-064 — Pipeline automation
      'pipeline_automation.configure',
      'pipeline_automation.view_history',
    ],
    employee: [
      'customers.*',
      'customers.people.view',
      'customers.people.manage',
      'customers.companies.view',
      'customers.companies.manage',
      'customers.pipelines.view',
      // SPEC-064 — view-only by default; admins can grant configure if needed
      'pipeline_automation.view_history',
    ],
  },
}

export default setup
