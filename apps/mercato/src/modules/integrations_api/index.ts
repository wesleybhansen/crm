import type { ModuleInfo } from '@open-mercato/shared/modules/registry'
import './commands/ams-crm'
import './commands/ams-crm-authority'

export const metadata: ModuleInfo = {
  name: 'integrations_api',
  title: 'Integration APIs',
  version: '0.1.0',
  description: 'External REST API for LaunchBot agents and Blog-Ops marketing automation.',
  author: 'CRM',
  license: 'MIT',
}
