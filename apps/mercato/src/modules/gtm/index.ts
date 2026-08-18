import './commands/campaign'
import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'gtm',
  title: 'GTM Engineer',
  version: '0.1.0',
  description:
    'Durable GTM Engineer domain: workspaces, ICP/voice versions, plays, research runs, candidates, campaigns, approval versions, enrollments, send attempts, replies, suppression, provider-operation shadows, and audit events (SPEC-066).',
  author: 'CRM',
  license: 'MIT',
}
