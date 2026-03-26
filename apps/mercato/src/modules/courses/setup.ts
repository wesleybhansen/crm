import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
export const setup: ModuleSetupConfig = { defaultRoleFeatures: { admin: ['courses.*'], employee: ['courses.view'] } }
export default setup
