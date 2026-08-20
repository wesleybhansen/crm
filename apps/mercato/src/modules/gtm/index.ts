import './commands/campaign'
import './commands/reconciliation'
import './commands/mailbox'
import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'gtm',
  title: 'GTM Engineer',
  version: '0.1.0',
  description:
    'Durable GTM Engineer domain: workspaces, research, campaigns, approvals, execution, inbound events, provider reconciliation, suppression, and privacy lifecycle (SPEC-067).',
  author: 'CRM',
  license: 'MIT',
}
