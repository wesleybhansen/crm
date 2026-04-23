import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'webhooks',
  title: 'Outbound Webhooks',
  version: '0.1.0',
  description: 'Subscribe external URLs to CRM domain events. HMAC-signed, retried, with delivery log.',
  author: 'Open Mercato Team',
  license: 'Proprietary',
  ejectable: true,
}

export { features } from './acl'
