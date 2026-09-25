/**
 * Customer Service page tabs, kept in the URL as ?tab= so links (and the
 * /queue shortcut) can open a specific tab.
 */
export type CustomerServiceTab = 'queue' | 'settings' | 'accounts'

export const CUSTOMER_SERVICE_TABS: readonly CustomerServiceTab[] = ['queue', 'settings', 'accounts']
export const DEFAULT_CUSTOMER_SERVICE_TAB: CustomerServiceTab = 'queue'

/** Read the tab from a query string; anything unknown falls back to Queue. */
export function parseCustomerServiceTab(search: string | null | undefined): CustomerServiceTab {
  const raw = new URLSearchParams(search ?? '').get('tab')?.trim().toLowerCase()
  return (CUSTOMER_SERVICE_TABS as readonly string[]).includes(raw ?? '')
    ? (raw as CustomerServiceTab)
    : DEFAULT_CUSTOMER_SERVICE_TAB
}

/** The same URL with ?tab= set, keeping every other query param and the hash. */
export function customerServiceTabHref(pathname: string, search: string, hash: string, tab: CustomerServiceTab): string {
  const params = new URLSearchParams(search)
  params.set('tab', tab)
  return `${pathname}?${params.toString()}${hash}`
}
