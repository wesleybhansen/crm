import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

// gtm.approve and gtm.launch are deliberately never granted through a wildcard:
// only the human admin-tier roles receive them (this platform's role model has
// superadmin/admin/employee; admin is the owner-equivalent role). Agent-facing
// or API principals must never hold approve/launch (SPEC-066 section 5).
export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    superadmin: ['gtm.view', 'gtm.edit', 'gtm.approve', 'gtm.launch'],
    admin: ['gtm.view', 'gtm.edit', 'gtm.approve', 'gtm.launch'],
    employee: ['gtm.view'],
  },
}

export default setup
