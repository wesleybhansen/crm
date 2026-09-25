/**
 * Backend routes that 404 because their module is not enabled in this app
 * (the core `integrations` / `data_sync` / `catalog` modules are off). Old
 * notifications and a few in-app links still point at them, so send people to
 * the page that holds the same thing in the CRM.
 *
 * - Integrations: connections (Stripe, Twilio, calendar, bulk email) live in
 *   Settings.
 * - Products: products and services live on the Payments page.
 *
 * Used by next.config redirects(), so keep it dependency-free.
 */
export type LegacyRedirect = { source: string; destination: string; permanent: boolean }

export const INTEGRATIONS_HOME = '/backend/settings-simple'
export const PRODUCTS_HOME = '/backend/payments'
/** Tasks live on the Contacts page's Tasks tab; there is no /backend/todos page. */
export const TASKS_HOME = '/backend/contacts?tab=tasks'
/** Import is a pop-up on the Contacts page; ?import=1 opens it. */
export const CONTACT_IMPORT_HOME = '/backend/contacts?import=1'

export function legacyBackendRedirects(): LegacyRedirect[] {
  return [
    { source: '/backend/integrations', destination: INTEGRATIONS_HOME, permanent: false },
    { source: '/backend/integrations/:path*', destination: INTEGRATIONS_HOME, permanent: false },
    { source: '/backend/products', destination: PRODUCTS_HOME, permanent: false },
    { source: '/backend/products/:path*', destination: PRODUCTS_HOME, permanent: false },
    // QA 2026-09-25 #12/#13: /backend/todos 404'd, and people/import was
    // read as a person id ("Invalid person id").
    { source: '/backend/todos', destination: TASKS_HOME, permanent: false },
    { source: '/backend/customers/people/import', destination: CONTACT_IMPORT_HOME, permanent: false },
  ]
}
