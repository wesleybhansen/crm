// Central place to enable modules and their source.
// - id: module id (plural snake_case; special cases: 'auth')
// - from: '@open-mercato/core' | '@app' | custom alias/path in future
import { parseBooleanWithDefault } from '@open-mercato/shared/lib/boolean'

export type ModuleEntry = { id: string; from?: '@open-mercato/core' | '@app' | string }

export const enabledModules: ModuleEntry[] = [
  // ── Core infrastructure ──
  { id: 'auth', from: '@open-mercato/core' },
  { id: 'directory', from: '@open-mercato/core' },
  { id: 'staff', from: '@open-mercato/core' },
  { id: 'configs', from: '@open-mercato/core' },
  { id: 'dictionaries', from: '@open-mercato/core' },
  { id: 'currencies', from: '@open-mercato/core' },
  { id: 'entities', from: '@open-mercato/core' },
  { id: 'query_index', from: '@open-mercato/core' },
  { id: 'audit_logs', from: '@open-mercato/core' },
  { id: 'attachments', from: '@open-mercato/core' },
  { id: 'feature_toggles', from: '@open-mercato/core' },
  { id: 'api_keys', from: '@open-mercato/core' },
  { id: 'api_docs', from: '@open-mercato/core' },
  { id: 'search', from: '@open-mercato/search' },
  { id: 'events', from: '@open-mercato/events' },
  { id: 'scheduler', from: '@open-mercato/scheduler' },
  { id: 'progress', from: '@open-mercato/core' },
  { id: 'planner', from: '@open-mercato/core' },      // required by staff module

  // ── CRM ──
  { id: 'customers', from: '@open-mercato/core' },
  { id: 'dashboards', from: '@open-mercato/core' },
  { id: 'notifications', from: '@open-mercato/core' },
  { id: 'messages', from: '@open-mercato/core' },
  { id: 'workflows', from: '@open-mercato/core' },

  // ── User-facing auth & portal ──
  { id: 'customer_accounts', from: '@open-mercato/core' },
  { id: 'portal', from: '@open-mercato/core' },
  { id: 'onboarding', from: '@open-mercato/onboarding' },

  // ── Billing ──
  { id: 'payment_gateways', from: '@open-mercato/core' },
  { id: 'gateway_stripe', from: '@open-mercato/gateway-stripe' },

  // ── Custom CRM modules ──
  { id: 'landing_pages', from: '@app' },
  { id: 'email', from: '@app' },
  { id: 'payments', from: '@app' },
  { id: 'calendar', from: '@app' },
  { id: 'integrations_api', from: '@app' },
  { id: 'billing', from: '@app' },

  // ── Disabled: e-commerce / ERP (not needed for CRM) ──
  // { id: 'catalog', from: '@open-mercato/core' },
  // { id: 'sales', from: '@open-mercato/core' },
  // { id: 'shipping_carriers', from: '@open-mercato/core' },
  // { id: 'sync_akeneo', from: '@open-mercato/sync-akeneo' },
  // { id: 'data_sync', from: '@open-mercato/core' },
  // { id: 'integrations', from: '@open-mercato/core' },
  // { id: 'content', from: '@open-mercato/content' },
  // { id: 'resources', from: '@open-mercato/core' },
  // { id: 'planner', from: '@open-mercato/core' },    // re-enabled above (staff dependency)
  // { id: 'perspectives', from: '@open-mercato/core' },
  // { id: 'translations', from: '@open-mercato/core' },
  // { id: 'business_rules', from: '@open-mercato/core' },
  // { id: 'ai_assistant', from: '@open-mercato/ai-assistant' },
  // { id: 'inbox_ops', from: '@open-mercato/core' },
  // { id: 'example', from: '@app' },
]

const enterpriseModulesEnabled = parseBooleanWithDefault(process.env.OM_ENABLE_ENTERPRISE_MODULES, false)
const enterpriseSsoEnabled = parseBooleanWithDefault(process.env.OM_ENABLE_ENTERPRISE_MODULES_SSO, false)

if (enterpriseModulesEnabled) {
  enabledModules.push(
    { id: 'record_locks', from: '@open-mercato/enterprise' },
    { id: 'system_status_overlays', from: '@open-mercato/enterprise' },
  )
}

if (enterpriseModulesEnabled && enterpriseSsoEnabled) {
  enabledModules.push({ id: 'sso', from: '@open-mercato/enterprise' })
}
