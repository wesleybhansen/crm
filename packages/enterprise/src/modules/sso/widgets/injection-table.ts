import type { ModuleInjectionTable } from '@open-mercato/shared/modules/widgets/injection'

/* The legacy 'auth.login:form' injection point was removed when the
 * orphan Mercato login page got deleted in CRM Phase G. SSO via Clerk
 * is now the sign-in path; the hub at app.noliai.com handles it.
 * Re-introduce widget injections here when/if a new auth surface
 * needs them. */
export const injectionTable: ModuleInjectionTable = {}

export default injectionTable
