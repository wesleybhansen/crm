import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
export const setup: ModuleSetupConfig = { defaultRoleFeatures: { admin: ['calendar.*'], employee: ['calendar.view'] } }
export default setup
