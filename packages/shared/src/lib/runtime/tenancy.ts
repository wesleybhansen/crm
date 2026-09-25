import { parseBooleanToken } from '../boolean'

/**
 * Runtime switches for the move to one tenant per customer.
 *
 * CRM_TENANT_PER_CUSTOMER=1  New Noli customers get their own tenant (and
 *                            key) instead of joining the one shared tenant.
 *                            Off (the default) keeps today's behaviour
 *                            exactly, so deploying the code changes nothing.
 * MAINTENANCE=1              Write requests answer 503 and sign-in does not
 *                            provision. Set for the tenant-split cutover so
 *                            no row is written under a tenant while its org
 *                            is being moved.
 *
 * Relative imports only: reachable from worker bundles and scripts.
 */

export const TENANT_PER_CUSTOMER_ENV = 'CRM_TENANT_PER_CUSTOMER'
export const MAINTENANCE_ENV = 'MAINTENANCE'
/** Tenant whose feature-toggle overrides a new customer tenant starts from. */
export const TENANT_TEMPLATE_ENV = 'CRM_TENANT_TEMPLATE_ID'

export function isTenantPerCustomerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBooleanToken(env[TENANT_PER_CUSTOMER_ENV] ?? '') === true
}

export function isMaintenanceMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBooleanToken(env[MAINTENANCE_ENV] ?? '') === true
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** True when this request must be refused because the app is in maintenance. */
export function isBlockedByMaintenance(method: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isMaintenanceMode(env)) return false
  return !READ_METHODS.has(String(method || 'GET').toUpperCase())
}

export const MAINTENANCE_RETRY_AFTER_SECONDS = 300

export function templateTenantId(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env[TENANT_TEMPLATE_ENV] ?? '').trim()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw) ? raw.toLowerCase() : null
}
