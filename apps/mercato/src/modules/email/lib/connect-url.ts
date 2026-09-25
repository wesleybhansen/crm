/**
 * Where a customer connects their own mailbox (Gmail, Outlook or any IMAP/SMTP
 * account). It lives in the Noli dashboard's Inbox > Connections tab, which
 * writes the CRM's email connections. The CRM Settings page has no mailbox
 * form, so links there were a dead end.
 *
 * Dependency-free so client components can import it without pulling the
 * server-side email routing code into the browser bundle.
 */
export const EMAIL_CONNECT_URL = 'https://app.noliai.com/dashboard/inbox?tab=connections'
export const EMAIL_CONNECT_LINK_TEXT = 'Connect it in Inbox > Connections.'
