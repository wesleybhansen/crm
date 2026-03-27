import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    admin: ['sequences.*'],
    employee: ['sequences.view', 'sequences.enroll'],
  },
}

export default setup
